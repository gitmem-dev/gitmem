/**
 * Thread Deduplication Service (Phase 3)
 *
 * Pure functions for detecting duplicate threads by embedding similarity,
 * token overlap, or normalized text equality. Zero I/O — all Supabase
 * and embedding calls live in the caller (create-thread.ts).
 *
 * Strategy:
 *   1. If embedding available: cosine similarity > 0.85 → duplicate
 *   2. Token overlap coefficient > 0.6 → duplicate (no API key needed)
 *      - Lowered to 0.4 when both threads share an issue prefix (e.g., OD-692:)
 *   3. Normalized text equality → duplicate
 *   4. If no existing threads: skip check
 */

import type { ThreadObject } from "../types/index.js";

// ---------- Types ----------

export interface ThreadWithEmbedding {
  thread_id: string;
  text: string;
  embedding: number[] | null;
}

export interface DedupResult {
  is_duplicate: boolean;
  matched_thread_id: string | null;
  matched_text: string | null;
  similarity: number | null;
  method: "embedding" | "token_overlap" | "text_normalization" | "skipped";
}

// ---------- Constants ----------

export const DEDUP_SIMILARITY_THRESHOLD = 0.85;
export const TOKEN_OVERLAP_THRESHOLD = 0.6;
export const TOKEN_OVERLAP_ISSUE_PREFIX_THRESHOLD = 0.4;

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "be", "as", "was", "are",
  "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "that", "this", "not", "no", "so", "if", "its", "also", "into",
  "than", "then", "can", "just", "about", "up", "out", "still",
]);

// ---------- Core ----------

/**
 * Check if new thread text is a semantic duplicate of any existing open thread.
 *
 * @param newText - Trimmed thread text
 * @param newEmbedding - Normalized embedding vector, or null if unavailable
 * @param existingThreads - Open threads with optional embeddings
 */
export function checkDuplicate(
  newText: string,
  newEmbedding: number[] | null,
  existingThreads: ThreadWithEmbedding[]
): DedupResult {
  if (existingThreads.length === 0) {
    return {
      is_duplicate: false,
      matched_thread_id: null,
      matched_text: null,
      similarity: null,
      method: "skipped",
    };
  }

  // Embedding-based comparison
  if (newEmbedding !== null) {
    let bestSimilarity = -1;
    let bestThread: ThreadWithEmbedding | null = null;

    for (const thread of existingThreads) {
      if (thread.embedding === null) continue;

      const sim = cosineSimilarity(newEmbedding, thread.embedding);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestThread = thread;
      }
    }

    if (bestThread && bestSimilarity > DEDUP_SIMILARITY_THRESHOLD) {
      return {
        is_duplicate: true,
        matched_thread_id: bestThread.thread_id,
        matched_text: bestThread.text,
        similarity: round(bestSimilarity, 4),
        method: "embedding",
      };
    }

    return {
      is_duplicate: false,
      matched_thread_id: null,
      matched_text: null,
      similarity: bestSimilarity >= 0 ? round(bestSimilarity, 4) : null,
      method: "embedding",
    };
  }

  // Token overlap check (works without any API key)
  const newTokens = tokenize(newText);
  const newPrefix = extractIssuePrefix(newText);

  if (newTokens.size > 0) {
    let bestOverlap = -1;
    let bestThread: ThreadWithEmbedding | null = null;

    for (const thread of existingThreads) {
      const existingTokens = tokenize(thread.text);
      if (existingTokens.size === 0) continue;

      const overlap = tokenOverlap(newTokens, existingTokens);
      const existingPrefix = extractIssuePrefix(thread.text);
      const threshold =
        newPrefix && existingPrefix && newPrefix === existingPrefix
          ? TOKEN_OVERLAP_ISSUE_PREFIX_THRESHOLD
          : TOKEN_OVERLAP_THRESHOLD;

      if (overlap > threshold && overlap > bestOverlap) {
        bestOverlap = overlap;
        bestThread = thread;
      }
    }

    if (bestThread && bestOverlap > 0) {
      return {
        is_duplicate: true,
        matched_thread_id: bestThread.thread_id,
        matched_text: bestThread.text,
        similarity: round(bestOverlap, 4),
        method: "token_overlap",
      };
    }
  }

  // Text normalization fallback (conservative: exact match only)
  const normalizedNew = normalizeText(newText);

  for (const thread of existingThreads) {
    if (normalizeText(thread.text) === normalizedNew) {
      return {
        is_duplicate: true,
        matched_thread_id: thread.thread_id,
        matched_text: thread.text,
        similarity: null,
        method: "text_normalization",
      };
    }
  }

  return {
    is_duplicate: false,
    matched_thread_id: null,
    matched_text: null,
    similarity: null,
    method: "text_normalization",
  };
}

// ---------- Helpers ----------

/**
 * Cosine similarity between two normalized vectors.
 * Assumes vectors are already L2-normalized (dot product = cosine similarity).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
  }
  return dotProduct;
}

/**
 * Normalize text for conservative text-only comparison.
 * Lowercase, collapse whitespace, trim, strip trailing punctuation.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?;:]+$/, "");
}

/**
 * Tokenize text into content words for overlap comparison.
 * Lowercase, split on non-alphanumeric boundaries, remove stop words.
 */
export function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  return new Set(words);
}

/**
 * Overlap coefficient: |intersection| / min(|A|, |B|).
 * Handles the common case where one thread is a shorter variant of another.
 * Returns 0 if either set is empty.
 */
export function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;

  for (const word of smaller) {
    if (larger.has(word)) intersection++;
  }

  return intersection / Math.min(a.size, b.size);
}

/**
 * Extract issue prefix like "OD-692" or "PROJ-123" from thread text.
 * Returns null if no prefix found.
 */
export function extractIssuePrefix(text: string): string | null {
  const match = text.match(/^([A-Z]+-\d+)/i);
  return match ? match[1].toUpperCase() : null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// ---------- List Deduplication ----------

/**
 * Deduplicate a thread list by ID, normalized text, and token overlap.
 * First-seen wins. Skips empty-text threads. Does not mutate input.
 *
 * Applied at every thread loading/merging exit point to guarantee
 * no duplicates escape regardless of upstream logic.
 */
export function deduplicateThreadList(threads: ThreadObject[]): ThreadObject[] {
  const seenIds = new Set<string>();
  const result: ThreadObject[] = [];
  // Track accepted threads with their tokens for overlap comparison
  const accepted: { text: string; tokens: Set<string>; prefix: string | null }[] = [];

  for (const thread of threads) {
    const text = thread.text || "";
    const key = normalizeText(text);

    // Skip empty-text threads
    if (!key) continue;

    // Skip if we've seen this ID
    if (seenIds.has(thread.id)) continue;

    // Check exact text match against accepted threads
    const tokens = tokenize(text);
    const prefix = extractIssuePrefix(text);
    let isDuplicate = false;

    for (const prev of accepted) {
      // Exact normalized text match
      if (normalizeText(prev.text) === key) {
        isDuplicate = true;
        break;
      }
      // Token overlap match
      if (tokens.size > 0 && prev.tokens.size > 0) {
        const overlap = tokenOverlap(tokens, prev.tokens);
        const threshold =
          prefix && prev.prefix && prefix === prev.prefix
            ? TOKEN_OVERLAP_ISSUE_PREFIX_THRESHOLD
            : TOKEN_OVERLAP_THRESHOLD;
        if (overlap > threshold) {
          isDuplicate = true;
          break;
        }
      }
    }

    if (isDuplicate) continue;

    seenIds.add(thread.id);
    accepted.push({ text, tokens, prefix });
    result.push(thread);
  }

  return result;
}

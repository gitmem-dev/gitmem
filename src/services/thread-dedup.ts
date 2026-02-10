/**
 * Thread Deduplication Service (Phase 3)
 *
 * Pure functions for detecting duplicate threads by embedding similarity
 * or normalized text equality. Zero I/O — all Supabase and embedding
 * calls live in the caller (create-thread.ts).
 *
 * Strategy:
 *   1. If embedding available: cosine similarity > 0.85 → duplicate
 *   2. If embedding unavailable: normalized text equality → duplicate
 *   3. If no existing threads: skip check
 */

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
  method: "embedding" | "text_normalization" | "skipped";
}

// ---------- Constants ----------

export const DEDUP_SIMILARITY_THRESHOLD = 0.85;

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

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

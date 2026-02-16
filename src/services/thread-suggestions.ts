/**
 * Thread Suggestions Service (Phase 5: Implicit Thread Detection)
 *
 * Detects recurring session topics not captured by existing threads.
 * Core detection is pure (no I/O). File persistence and Supabase
 * queries are separate functions called by the session lifecycle.
 *
 * Algorithm:
 *   1. Compare current session embedding against recent sessions
 *   2. If 3+ sessions are similar AND no matching open thread exists
 *      → create a thread suggestion
 *   3. Suggestions surfaced at session_start, managed via promote/dismiss
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { getGitmemDir } from "./gitmem-dir.js";
import { directQuery } from "./supabase-client.js";
import { hasSupabase, getTableName } from "./tier.js";
import { cosineSimilarity } from "./thread-dedup.js";
import type { ThreadWithEmbedding } from "./thread-dedup.js";
import type { ThreadSuggestion, Project } from "../types/index.js";

// ---------- Constants ----------

export const SESSION_SIMILARITY_THRESHOLD = 0.70;
export const THREAD_MATCH_THRESHOLD = 0.80;
export const SUGGESTION_MATCH_THRESHOLD = 0.80;
export const MIN_EVIDENCE_SESSIONS = 3;

const SUGGESTIONS_FILENAME = "suggested-threads.json";

// ---------- Types ----------

export interface SessionEmbeddingRecord {
  session_id: string;
  session_title: string;
  embedding: number[];
}

// ---------- Pure Detection ----------

/**
 * Detect suggested threads from session embedding clustering.
 * Pure function — no I/O, no side effects.
 *
 * Returns the full updated suggestions list (existing + any new/updated).
 */
export function detectSuggestedThreads(
  currentSession: { session_id: string; title: string; embedding: number[] },
  recentSessions: SessionEmbeddingRecord[],
  openThreadEmbeddings: ThreadWithEmbedding[],
  existingSuggestions: ThreadSuggestion[]
): ThreadSuggestion[] {
  const now = new Date().toISOString();

  // Step 1: Find historical sessions similar to current
  const similarSessions: SessionEmbeddingRecord[] = [];
  let totalSimilarity = 0;

  for (const session of recentSessions) {
    // Skip self
    if (session.session_id === currentSession.session_id) continue;

    const sim = cosineSimilarity(currentSession.embedding, session.embedding);
    if (sim >= SESSION_SIMILARITY_THRESHOLD) {
      similarSessions.push(session);
      totalSimilarity += sim;
    }
  }

  // Step 2: Need at least 2 similar historical sessions (3+ total including current)
  if (similarSessions.length < MIN_EVIDENCE_SESSIONS - 1) {
    return existingSuggestions;
  }

  const avgSimilarity = totalSimilarity / similarSessions.length;

  // Step 3: Check if any open thread already covers this topic
  for (const thread of openThreadEmbeddings) {
    if (thread.embedding === null) continue;
    const sim = cosineSimilarity(currentSession.embedding, thread.embedding);
    if (sim >= THREAD_MATCH_THRESHOLD) {
      // Topic is already captured by an existing thread — no suggestion
      return existingSuggestions;
    }
  }

  // Step 4: Check if any existing pending suggestion matches
  const updated = [...existingSuggestions];
  for (const suggestion of updated) {
    if (suggestion.status !== "pending") continue;
    if (suggestion.embedding === null) continue;

    const sim = cosineSimilarity(currentSession.embedding, suggestion.embedding);
    if (sim >= SUGGESTION_MATCH_THRESHOLD) {
      // Update existing suggestion with new evidence
      if (!suggestion.evidence_sessions.includes(currentSession.session_id)) {
        suggestion.evidence_sessions.push(currentSession.session_id);
        suggestion.similarity_score = round(
          (suggestion.similarity_score + avgSimilarity) / 2,
          4
        );
        suggestion.updated_at = now;
      }
      return updated;
    }
  }

  // Step 5: No existing match — create new suggestion
  const evidenceIds = [
    currentSession.session_id,
    ...similarSessions.map((s) => s.session_id),
  ];

  const newSuggestion: ThreadSuggestion = {
    id: generateSuggestionId(),
    text: currentSession.title,
    embedding: currentSession.embedding,
    evidence_sessions: evidenceIds,
    similarity_score: round(avgSimilarity, 4),
    status: "pending",
    dismissed_count: 0,
    created_at: now,
    updated_at: now,
  };

  updated.push(newSuggestion);
  return updated;
}

// ---------- State Management (Pure) ----------

/**
 * Promote a suggestion to an open thread.
 * Mutates the suggestion in-place and returns it, or null if not found.
 */
export function promoteSuggestionById(
  id: string,
  threadId: string,
  suggestions: ThreadSuggestion[]
): ThreadSuggestion | null {
  const suggestion = suggestions.find((s) => s.id === id);
  if (!suggestion) return null;

  suggestion.status = "promoted";
  suggestion.promoted_thread_id = threadId;
  suggestion.updated_at = new Date().toISOString();
  return suggestion;
}

/**
 * Dismiss a suggestion. Increments dismissed_count.
 * Mutates the suggestion in-place and returns it, or null if not found.
 */
export function dismissSuggestionById(
  id: string,
  suggestions: ThreadSuggestion[]
): ThreadSuggestion | null {
  const suggestion = suggestions.find((s) => s.id === id);
  if (!suggestion) return null;

  suggestion.status = "dismissed";
  suggestion.dismissed_count += 1;
  suggestion.updated_at = new Date().toISOString();
  return suggestion;
}

/**
 * Filter to only pending suggestions (not promoted/dismissed).
 * Excludes suggestions dismissed 3+ times (permanently suppressed).
 */
export function getPendingSuggestions(
  suggestions: ThreadSuggestion[]
): ThreadSuggestion[] {
  return suggestions.filter(
    (s) => s.status === "pending" && s.dismissed_count < 3
  );
}

// ---------- File I/O ----------

/**
 * Load suggestions from .gitmem/suggested-threads.json.
 * Returns empty array if file doesn't exist or is corrupted.
 */
export function loadSuggestions(): ThreadSuggestion[] {
  try {
    const gitmemDir = getGitmemDir();
    const filePath = path.join(gitmemDir, SUGGESTIONS_FILENAME);
    if (!fs.existsSync(filePath)) return [];

    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

/**
 * Save suggestions to .gitmem/suggested-threads.json.
 */
export function saveSuggestions(suggestions: ThreadSuggestion[]): void {
  try {
    const gitmemDir = getGitmemDir();
    if (!fs.existsSync(gitmemDir)) {
      fs.mkdirSync(gitmemDir, { recursive: true });
    }
    const filePath = path.join(gitmemDir, SUGGESTIONS_FILENAME);
    fs.writeFileSync(filePath, JSON.stringify(suggestions, null, 2), "utf-8");
  } catch (error) {
    console.error(
      "[thread-suggestions] Failed to save suggestions:",
      error instanceof Error ? error.message : error
    );
  }
}

// ---------- Supabase Query ----------

/**
 * Parse embedding from Supabase REST response.
 * REST returns vector columns as JSON strings, not arrays.
 */
function parseEmbedding(raw: string | number[] | null | undefined): number[] | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Invalid JSON
    }
  }
  return null;
}

/**
 * Fetch recent session embeddings from Supabase for clustering comparison.
 * Returns null if Supabase is unavailable.
 */
export async function loadRecentSessionEmbeddings(
  project: Project = "default",
  days: number = 30,
  limit: number = 20
): Promise<SessionEmbeddingRecord[] | null> {
  if (!hasSupabase()) {
    return null;
  }

  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().split("T")[0]; // YYYY-MM-DD

    const rows = await directQuery<{
      id: string;
      session_title: string | null;
      embedding: string | number[] | null;
    }>(getTableName("sessions"), {
      select: "id,session_title,embedding",
      filters: {
        project,
        session_date: `gte.${cutoffStr}`,
      },
      order: "created_at.desc",
      limit,
    });

    // Filter to rows that have embeddings
    const records: SessionEmbeddingRecord[] = [];
    for (const row of rows) {
      const emb = parseEmbedding(row.embedding);
      if (emb && row.session_title) {
        records.push({
          session_id: row.id,
          session_title: row.session_title,
          embedding: emb,
        });
      }
    }

    console.error(
      `[thread-suggestions] Loaded ${records.length} session embeddings (${rows.length} rows, last ${days} days)`
    );
    return records;
  } catch (error) {
    console.error(
      "[thread-suggestions] Failed to load session embeddings:",
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

// ---------- Helpers ----------

export function generateSuggestionId(): string {
  return "ts-" + crypto.randomBytes(4).toString("hex");
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

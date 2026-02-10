/**
 * Unit tests for Thread Suggestions Service (Phase 5: Implicit Thread Detection)
 *
 * Pure function tests — no mocks, no filesystem, no network.
 * Tests detectSuggestedThreads, promoteSuggestionById, dismissSuggestionById,
 * and getPendingSuggestions.
 */

import { describe, it, expect } from "vitest";
import {
  detectSuggestedThreads,
  promoteSuggestionById,
  dismissSuggestionById,
  getPendingSuggestions,
  generateSuggestionId,
  SESSION_SIMILARITY_THRESHOLD,
  THREAD_MATCH_THRESHOLD,
  MIN_EVIDENCE_SESSIONS,
} from "../../../src/services/thread-suggestions.js";
import type { SessionEmbeddingRecord } from "../../../src/services/thread-suggestions.js";
import type { ThreadSuggestion } from "../../../src/types/index.js";
import type { ThreadWithEmbedding } from "../../../src/services/thread-dedup.js";

// ---------- Helpers ----------

/**
 * Create a synthetic unit vector in a given "direction" dimension.
 * Vectors pointing in the same dimension have cosine similarity ~1.0,
 * orthogonal dimensions have similarity ~0.0.
 */
function makeEmbedding(direction: number, dims: number = 16): number[] {
  const vec = new Array(dims).fill(0);
  vec[direction % dims] = 1.0;
  return vec;
}

/**
 * Create an embedding that is similar to the given direction with some noise.
 * Similarity is approximately (1 - spread).
 */
function makeSimilarEmbedding(
  direction: number,
  spread: number = 0.1,
  dims: number = 16
): number[] {
  const vec = new Array(dims).fill(spread / Math.sqrt(dims));
  vec[direction % dims] = 1.0;
  // Normalize
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / mag);
}

function makeSession(
  id: string,
  title: string,
  direction: number,
  spread: number = 0.1
): SessionEmbeddingRecord {
  return {
    session_id: id,
    session_title: title,
    embedding: makeSimilarEmbedding(direction, spread),
  };
}

function makeSuggestion(
  overrides: Partial<ThreadSuggestion> = {}
): ThreadSuggestion {
  return {
    id: "ts-test0001",
    text: "Test suggestion",
    embedding: makeEmbedding(0),
    evidence_sessions: ["s1", "s2", "s3"],
    similarity_score: 0.85,
    status: "pending",
    dismissed_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ===========================================================================
// 1. detectSuggestedThreads
// ===========================================================================

describe("detectSuggestedThreads", () => {
  it("creates a suggestion when 3+ similar sessions exist and no matching thread", () => {
    const current = {
      session_id: "s-current",
      title: "Auth timeout debugging",
      embedding: makeSimilarEmbedding(0, 0.05),
    };

    // 3 historical sessions similar to current (all in direction 0)
    const recentSessions: SessionEmbeddingRecord[] = [
      makeSession("s-1", "Auth timeout fix", 0, 0.05),
      makeSession("s-2", "Auth timeout investigation", 0, 0.08),
      makeSession("s-3", "Auth timeout root cause", 0, 0.06),
    ];

    const openThreads: ThreadWithEmbedding[] = [
      // A thread in a different direction — no match
      { thread_id: "t-1", text: "Unrelated topic", embedding: makeEmbedding(5) },
    ];

    const result = detectSuggestedThreads(current, recentSessions, openThreads, []);

    expect(result.length).toBe(1);
    expect(result[0].text).toBe("Auth timeout debugging");
    expect(result[0].status).toBe("pending");
    expect(result[0].evidence_sessions).toContain("s-current");
    expect(result[0].evidence_sessions.length).toBeGreaterThanOrEqual(MIN_EVIDENCE_SESSIONS);
    expect(result[0].id).toMatch(/^ts-/);
  });

  it("returns existing suggestions unchanged when too few similar sessions", () => {
    const current = {
      session_id: "s-current",
      title: "Auth timeout debugging",
      embedding: makeSimilarEmbedding(0, 0.05),
    };

    // Only 1 similar session (need 2+ for threshold)
    const recentSessions: SessionEmbeddingRecord[] = [
      makeSession("s-1", "Auth timeout fix", 0, 0.05),
      makeSession("s-2", "Totally different topic", 7, 0.05), // orthogonal
    ];

    const existing = [makeSuggestion({ id: "ts-existing" })];
    const result = detectSuggestedThreads(current, recentSessions, [], existing);

    // Should return existing unchanged
    expect(result).toBe(existing);
  });

  it("returns existing suggestions when a matching open thread exists", () => {
    const current = {
      session_id: "s-current",
      title: "Auth timeout debugging",
      embedding: makeSimilarEmbedding(0, 0.05),
    };

    const recentSessions: SessionEmbeddingRecord[] = [
      makeSession("s-1", "Auth timeout fix", 0, 0.05),
      makeSession("s-2", "Auth timeout investigation", 0, 0.08),
      makeSession("s-3", "Auth timeout root cause", 0, 0.06),
    ];

    // Open thread that matches this topic (same direction, very close)
    const openThreads: ThreadWithEmbedding[] = [
      {
        thread_id: "t-auth",
        text: "Auth timeout thread",
        embedding: makeSimilarEmbedding(0, 0.02),
      },
    ];

    const existing = [makeSuggestion({ id: "ts-other", embedding: makeEmbedding(9) })];
    const result = detectSuggestedThreads(current, recentSessions, openThreads, existing);

    // Should return existing unchanged — topic already covered by thread
    expect(result).toBe(existing);
  });

  it("updates existing pending suggestion when it matches the topic", () => {
    const current = {
      session_id: "s-current",
      title: "Auth timeout debugging",
      embedding: makeSimilarEmbedding(0, 0.05),
    };

    const recentSessions: SessionEmbeddingRecord[] = [
      makeSession("s-1", "Auth timeout fix", 0, 0.05),
      makeSession("s-2", "Auth timeout investigation", 0, 0.08),
      makeSession("s-3", "Auth timeout root cause", 0, 0.06),
    ];

    const openThreads: ThreadWithEmbedding[] = [];

    // Existing suggestion that matches this topic
    const existingSuggestion = makeSuggestion({
      id: "ts-match",
      text: "Auth timeout recurring",
      embedding: makeSimilarEmbedding(0, 0.03),
      evidence_sessions: ["s-old-1", "s-old-2", "s-old-3"],
    });

    const result = detectSuggestedThreads(
      current,
      recentSessions,
      openThreads,
      [existingSuggestion]
    );

    expect(result.length).toBe(1);
    expect(result[0].id).toBe("ts-match");
    expect(result[0].evidence_sessions).toContain("s-current");
    expect(result[0].evidence_sessions.length).toBe(4); // 3 old + 1 new
  });

  it("returns existing suggestions when all sessions are dissimilar", () => {
    const current = {
      session_id: "s-current",
      title: "Auth timeout debugging",
      embedding: makeEmbedding(0), // Pure direction 0
    };

    // All sessions in completely different directions
    const recentSessions: SessionEmbeddingRecord[] = [
      makeSession("s-1", "Topic A", 3, 0.0),
      makeSession("s-2", "Topic B", 5, 0.0),
      makeSession("s-3", "Topic C", 7, 0.0),
      makeSession("s-4", "Topic D", 9, 0.0),
    ];

    const result = detectSuggestedThreads(current, recentSessions, [], []);
    expect(result.length).toBe(0);
  });

  it("skips self session when comparing", () => {
    const current = {
      session_id: "s-current",
      title: "Auth timeout debugging",
      embedding: makeSimilarEmbedding(0, 0.05),
    };

    // Include self in recent sessions + only 1 other similar
    const recentSessions: SessionEmbeddingRecord[] = [
      { session_id: "s-current", session_title: "Self", embedding: makeSimilarEmbedding(0, 0.05) },
      makeSession("s-1", "Auth timeout fix", 0, 0.05),
      // Only 1 similar after excluding self — below threshold
    ];

    const result = detectSuggestedThreads(current, recentSessions, [], []);
    expect(result.length).toBe(0);
  });
});

// ===========================================================================
// 2. promoteSuggestionById
// ===========================================================================

describe("promoteSuggestionById", () => {
  it("promotes a suggestion and sets promoted_thread_id", () => {
    const suggestions = [
      makeSuggestion({ id: "ts-001" }),
      makeSuggestion({ id: "ts-002" }),
    ];

    const result = promoteSuggestionById("ts-001", "t-newthread", suggestions);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("promoted");
    expect(result!.promoted_thread_id).toBe("t-newthread");
    expect(result!.updated_at).not.toBe("2026-01-01T00:00:00.000Z");
  });

  it("returns null for non-existent ID", () => {
    const suggestions = [makeSuggestion({ id: "ts-001" })];
    const result = promoteSuggestionById("ts-nonexistent", "t-thread", suggestions);
    expect(result).toBeNull();
  });
});

// ===========================================================================
// 3. dismissSuggestionById
// ===========================================================================

describe("dismissSuggestionById", () => {
  it("dismisses a suggestion and increments dismissed_count", () => {
    const suggestions = [makeSuggestion({ id: "ts-001", dismissed_count: 0 })];

    const result = dismissSuggestionById("ts-001", suggestions);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("dismissed");
    expect(result!.dismissed_count).toBe(1);
  });

  it("returns null for non-existent ID", () => {
    const suggestions = [makeSuggestion({ id: "ts-001" })];
    const result = dismissSuggestionById("ts-nonexistent", suggestions);
    expect(result).toBeNull();
  });
});

// ===========================================================================
// 4. getPendingSuggestions
// ===========================================================================

describe("getPendingSuggestions", () => {
  it("filters to only pending suggestions under dismiss threshold", () => {
    const suggestions: ThreadSuggestion[] = [
      makeSuggestion({ id: "ts-1", status: "pending", dismissed_count: 0 }),
      makeSuggestion({ id: "ts-2", status: "promoted", dismissed_count: 0 }),
      makeSuggestion({ id: "ts-3", status: "dismissed", dismissed_count: 1 }),
      makeSuggestion({ id: "ts-4", status: "pending", dismissed_count: 3 }), // permanently suppressed
      makeSuggestion({ id: "ts-5", status: "pending", dismissed_count: 2 }),
    ];

    const pending = getPendingSuggestions(suggestions);

    expect(pending.length).toBe(2);
    expect(pending.map((s) => s.id).sort()).toEqual(["ts-1", "ts-5"]);
  });
});

// ===========================================================================
// 5. generateSuggestionId
// ===========================================================================

describe("generateSuggestionId", () => {
  it("generates IDs with ts- prefix", () => {
    const id = generateSuggestionId();
    expect(id).toMatch(/^ts-[0-9a-f]{8}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateSuggestionId()));
    expect(ids.size).toBe(10);
  });
});

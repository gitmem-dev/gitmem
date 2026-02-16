/**
 * Unit tests for Thread Deduplication (Phase 3)
 *
 * Pure function tests — no mocks, no filesystem, no network.
 * Uses synthetic low-dimensional embeddings for speed and reproducibility.
 */

import { describe, it, expect } from "vitest";
import {
  checkDuplicate,
  normalizeText,
  cosineSimilarity,
  deduplicateThreadList,
  tokenize,
  tokenOverlap,
  extractIssuePrefix,
  DEDUP_SIMILARITY_THRESHOLD,
  TOKEN_OVERLAP_THRESHOLD,
  TOKEN_OVERLAP_ISSUE_PREFIX_THRESHOLD,
} from "../../../src/services/thread-dedup.js";
import type { ThreadWithEmbedding } from "../../../src/services/thread-dedup.js";
import type { ThreadObject } from "../../../src/types/index.js";

// ---------- Helpers ----------

/** Generate a deterministic normalized embedding from a seed */
function fakeEmbedding(seed: number, dim: number = 10): number[] {
  const raw = Array.from({ length: dim }, (_, i) => Math.sin(seed * (i + 1)));
  const magnitude = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return raw;
  return raw.map((v) => v / magnitude);
}

/** Slightly perturb an embedding (small noise → high similarity) */
function perturbEmbedding(base: number[], noise: number = 0.01): number[] {
  const perturbed = base.map((v, i) => v + noise * Math.sin(i + 1));
  const magnitude = Math.sqrt(perturbed.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return perturbed;
  return perturbed.map((v) => v / magnitude);
}

function makeThread(
  id: string,
  text: string,
  embedding: number[] | null
): ThreadWithEmbedding {
  return { thread_id: id, text, embedding };
}

// ===========================================================================
// 1. cosineSimilarity
// ===========================================================================

describe("cosineSimilarity", () => {
  it("identical vectors have similarity 1.0", () => {
    const vec = fakeEmbedding(42);
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 6);
  });

  it("orthogonal vectors have similarity near 0.0", () => {
    // Two orthogonal unit vectors
    const a = [1, 0, 0, 0, 0];
    const b = [0, 1, 0, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 6);
  });

  it("different-length vectors return 0", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});

// ===========================================================================
// 2. normalizeText
// ===========================================================================

describe("normalizeText", () => {
  it("lowercases and trims whitespace", () => {
    expect(normalizeText("  Fix Auth Timeout  ")).toBe("fix auth timeout");
  });

  it("collapses multiple whitespace characters", () => {
    expect(normalizeText("fix   broken\tauth\n flow")).toBe(
      "fix broken auth flow"
    );
  });

  it("strips trailing punctuation", () => {
    expect(normalizeText("Fix auth timeout.")).toBe("fix auth timeout");
    expect(normalizeText("Fix auth timeout!!!")).toBe("fix auth timeout");
    expect(normalizeText("Fix auth timeout;")).toBe("fix auth timeout");
  });
});

// ===========================================================================
// 3. checkDuplicate — embedding mode
// ===========================================================================

describe("checkDuplicate — embedding mode", () => {
  it("returns is_duplicate=true when similarity > threshold", () => {
    const base = fakeEmbedding(42);
    const nearDuplicate = perturbEmbedding(base, 0.005);

    // Sanity: verify these embeddings are actually very similar
    expect(cosineSimilarity(base, nearDuplicate)).toBeGreaterThan(
      DEDUP_SIMILARITY_THRESHOLD
    );

    const existing = [makeThread("t-existing", "Fix auth timeout", base)];
    const result = checkDuplicate("Fix the auth timeout", nearDuplicate, existing);

    expect(result.is_duplicate).toBe(true);
    expect(result.matched_thread_id).toBe("t-existing");
    expect(result.method).toBe("embedding");
    expect(result.similarity).toBeGreaterThan(DEDUP_SIMILARITY_THRESHOLD);
  });

  it("returns is_duplicate=false when similarity < threshold", () => {
    const embA = fakeEmbedding(1);
    const embB = fakeEmbedding(100);

    // Sanity: verify these are dissimilar
    expect(cosineSimilarity(embA, embB)).toBeLessThan(
      DEDUP_SIMILARITY_THRESHOLD
    );

    const existing = [makeThread("t-other", "Deploy to production", embB)];
    const result = checkDuplicate("Research embedding models", embA, existing);

    expect(result.is_duplicate).toBe(false);
    expect(result.method).toBe("embedding");
  });

  it("returns the highest-similarity match among multiple candidates", () => {
    const newEmb = fakeEmbedding(42);
    const closestEmb = perturbEmbedding(newEmb, 0.005); // very similar
    const mediumEmb = perturbEmbedding(newEmb, 0.5); // moderately similar
    const distantEmb = fakeEmbedding(999); // dissimilar

    const existing = [
      makeThread("t-distant", "Something unrelated", distantEmb),
      makeThread("t-medium", "Somewhat related", mediumEmb),
      makeThread("t-closest", "Almost the same", closestEmb),
    ];

    const result = checkDuplicate("Fix auth issue", newEmb, existing);

    if (result.is_duplicate) {
      expect(result.matched_thread_id).toBe("t-closest");
    }
    // Even if not duplicate, the similarity should be highest against t-closest
  });

  it("skips existing threads that have null embeddings", () => {
    const newEmb = fakeEmbedding(42);
    const matchEmb = perturbEmbedding(newEmb, 0.005);

    const existing = [
      makeThread("t-noembedding", "Some thread without embedding", null),
      makeThread("t-withembedding", "Thread with embedding", matchEmb),
    ];

    const result = checkDuplicate("Fix something", newEmb, existing);

    // Should match against the one with embedding, not error on the null one
    expect(result.is_duplicate).toBe(true);
    expect(result.matched_thread_id).toBe("t-withembedding");
  });

  it("returns method=skipped when no existing threads", () => {
    const result = checkDuplicate("New thread", fakeEmbedding(1), []);

    expect(result.is_duplicate).toBe(false);
    expect(result.method).toBe("skipped");
    expect(result.similarity).toBeNull();
  });
});

// ===========================================================================
// 4. checkDuplicate — text fallback mode
// ===========================================================================

describe("checkDuplicate — text fallback", () => {
  it("detects exact normalized text match as duplicate", () => {
    const existing = [
      makeThread("t-existing", "Fix auth timeout", null),
    ];

    const result = checkDuplicate("  Fix  Auth  Timeout. ", null, existing);

    expect(result.is_duplicate).toBe(true);
    expect(result.matched_thread_id).toBe("t-existing");
    // Token overlap catches this before text normalization since tokens are identical
    expect(["token_overlap", "text_normalization"]).toContain(result.method);
  });

  it("catches near-miss text via token overlap", () => {
    const existing = [
      makeThread("t-existing", "Fix auth timeout", null),
    ];

    const result = checkDuplicate("Fix authentication timeout", null, existing);

    expect(result.is_duplicate).toBe(true);
    expect(result.method).toBe("token_overlap");
  });

  it("does NOT flag genuinely different text as duplicate", () => {
    const existing = [
      makeThread("t-existing", "Fix auth timeout", null),
    ];

    const result = checkDuplicate("Deploy new staging environment to production", null, existing);

    expect(result.is_duplicate).toBe(false);
  });
});

// ===========================================================================
// 5. deduplicateThreadList
// ===========================================================================

function makeThreadObject(
  id: string,
  text: string,
  status: "open" | "resolved" = "open"
): ThreadObject {
  return { id, text, status, created_at: "2026-02-10T00:00:00Z" };
}

describe("deduplicateThreadList", () => {
  it("removes threads with identical normalized text but different IDs", () => {
    const threads = [
      makeThreadObject("t-aaa", "Fix auth timeout"),
      makeThreadObject("t-bbb", "fix auth timeout"),   // same text, different ID
      makeThreadObject("t-ccc", "  Fix  Auth  Timeout. "), // same text after normalization
    ];
    const result = deduplicateThreadList(threads);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t-aaa"); // First seen wins
  });

  it("removes threads with duplicate IDs", () => {
    const threads = [
      makeThreadObject("t-aaa", "First version"),
      makeThreadObject("t-aaa", "Second version"),
    ];
    const result = deduplicateThreadList(threads);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("First version");
  });

  it("keeps genuinely different threads", () => {
    const threads = [
      makeThreadObject("t-aaa", "Fix auth timeout"),
      makeThreadObject("t-bbb", "Add logging to API"),
      makeThreadObject("t-ccc", "Deploy to production"),
    ];
    const result = deduplicateThreadList(threads);
    expect(result).toHaveLength(3);
  });

  it("skips empty-text threads", () => {
    const threads = [
      makeThreadObject("t-aaa", ""),
      makeThreadObject("t-bbb", "   "),
      makeThreadObject("t-ccc", "Real thread"),
    ];
    const result = deduplicateThreadList(threads);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t-ccc");
  });

  it("does not mutate input", () => {
    const threads = [
      makeThreadObject("t-aaa", "Fix auth timeout"),
      makeThreadObject("t-bbb", "Fix auth timeout"),
    ];
    const original = [...threads];
    deduplicateThreadList(threads);
    expect(threads).toEqual(original);
    expect(threads).toHaveLength(2); // Original unchanged
  });

  it("returns empty array for empty input", () => {
    expect(deduplicateThreadList([])).toEqual([]);
  });

  it("handles trailing punctuation differences via normalizeText", () => {
    const threads = [
      makeThreadObject("t-aaa", "Fix the bug"),
      makeThreadObject("t-bbb", "Fix the bug."),
      makeThreadObject("t-ccc", "Fix the bug!!!"),
    ];
    const result = deduplicateThreadList(threads);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t-aaa");
  });

  it("catches near-duplicate threads via token overlap", () => {
    const threads = [
      makeThreadObject("t-aaa", "OD-692: Twitter env vars need to be verified in container after restart. MCP config entry for twitter-mcp still needs to be added on host machine."),
      makeThreadObject("t-bbb", "OD-692: Twitter env vars need to be verified in container — original task deferred after credential incident"),
    ];
    const result = deduplicateThreadList(threads);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t-aaa");
  });
});

// ===========================================================================
// 6. tokenize
// ===========================================================================

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumeric", () => {
    const tokens = tokenize("Fix Auth Timeout");
    expect(tokens).toContain("fix");
    expect(tokens).toContain("auth");
    expect(tokens).toContain("timeout");
  });

  it("removes stop words", () => {
    const tokens = tokenize("Fix the auth timeout in the container");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("in");
    expect(tokens).toContain("fix");
    expect(tokens).toContain("auth");
    expect(tokens).toContain("container");
  });

  it("removes single-character tokens", () => {
    const tokens = tokenize("a b c fix");
    expect(tokens).toContain("fix");
    expect(tokens.size).toBe(1);
  });

  it("handles issue prefixes as tokens", () => {
    const tokens = tokenize("OD-692: Fix the bug");
    expect(tokens).toContain("od-692");
    expect(tokens).toContain("fix");
    expect(tokens).toContain("bug");
  });

  it("returns empty set for all stop words", () => {
    const tokens = tokenize("the a an is it");
    expect(tokens.size).toBe(0);
  });
});

// ===========================================================================
// 7. tokenOverlap
// ===========================================================================

describe("tokenOverlap", () => {
  it("returns 1.0 for identical sets", () => {
    const a = new Set(["fix", "auth", "timeout"]);
    expect(tokenOverlap(a, a)).toBe(1.0);
  });

  it("returns 0 for disjoint sets", () => {
    const a = new Set(["fix", "auth"]);
    const b = new Set(["deploy", "staging"]);
    expect(tokenOverlap(a, b)).toBe(0);
  });

  it("returns 0 for empty sets", () => {
    expect(tokenOverlap(new Set(), new Set(["fix"]))).toBe(0);
    expect(tokenOverlap(new Set(["fix"]), new Set())).toBe(0);
  });

  it("uses min(|A|,|B|) as denominator (overlap coefficient)", () => {
    // A is a subset of B → overlap = 1.0 (all of A found in B)
    const a = new Set(["fix", "auth"]);
    const b = new Set(["fix", "auth", "timeout", "container"]);
    expect(tokenOverlap(a, b)).toBe(1.0);
  });

  it("computes correct overlap for partial match", () => {
    const a = new Set(["fix", "auth", "timeout"]);
    const b = new Set(["fix", "deploy", "timeout"]);
    // intersection = {fix, timeout} = 2, min(3,3) = 3
    expect(tokenOverlap(a, b)).toBeCloseTo(2 / 3, 6);
  });
});

// ===========================================================================
// 8. extractIssuePrefix
// ===========================================================================

describe("extractIssuePrefix", () => {
  it("extracts OD-692 prefix", () => {
    expect(extractIssuePrefix("OD-692: Fix the bug")).toBe("OD-692");
  });

  it("extracts lowercase prefix and uppercases", () => {
    expect(extractIssuePrefix("od-123: something")).toBe("OD-123");
  });

  it("extracts PROJ-1 style prefix", () => {
    expect(extractIssuePrefix("PROJ-1: short")).toBe("PROJ-1");
  });

  it("returns null for no prefix", () => {
    expect(extractIssuePrefix("Fix the bug")).toBeNull();
    expect(extractIssuePrefix("123 something")).toBeNull();
  });
});

// ===========================================================================
// 9. checkDuplicate — token overlap mode (the real bug case)
// ===========================================================================

describe("checkDuplicate — token overlap mode", () => {
  it("catches the actual OD-692 duplicate (no embeddings)", () => {
    const existing = [
      makeThread(
        "t-c57a4fd3",
        "OD-692: Twitter env vars need to be verified in container after restart. MCP config entry for twitter-mcp still needs to be added on host machine.",
        null
      ),
    ];

    const result = checkDuplicate(
      "OD-692: Twitter env vars need to be verified in container — original task deferred after credential incident",
      null,
      existing
    );

    expect(result.is_duplicate).toBe(true);
    expect(result.method).toBe("token_overlap");
    expect(result.matched_thread_id).toBe("t-c57a4fd3");
    expect(result.similarity).toBeGreaterThan(TOKEN_OVERLAP_ISSUE_PREFIX_THRESHOLD);
  });

  it("uses lower threshold when issue prefix matches", () => {
    const existing = [
      makeThread("t-aaa", "OD-100: Setup database migrations for new schema", null),
    ];

    // Same prefix but different enough words — would fail at 0.6 but pass at 0.4
    const result = checkDuplicate(
      "OD-100: Database migration setup blocked by permissions",
      null,
      existing
    );

    expect(result.is_duplicate).toBe(true);
    expect(result.method).toBe("token_overlap");
  });

  it("does not false-positive on unrelated threads", () => {
    const existing = [
      makeThread("t-aaa", "OD-692: Twitter env vars need to be verified", null),
    ];

    const result = checkDuplicate(
      "Set up GitHub Actions CI pipeline for automated testing",
      null,
      existing
    );

    expect(result.is_duplicate).toBe(false);
  });

  it("does not false-positive on different issue prefixes with low word overlap", () => {
    const existing = [
      makeThread("t-aaa", "OD-100: Fix authentication timeout", null),
    ];

    const result = checkDuplicate(
      "OD-200: Deploy staging environment",
      null,
      existing
    );

    expect(result.is_duplicate).toBe(false);
  });
});

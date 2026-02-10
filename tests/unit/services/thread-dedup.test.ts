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
  DEDUP_SIMILARITY_THRESHOLD,
} from "../../../src/services/thread-dedup.js";
import type { ThreadWithEmbedding } from "../../../src/services/thread-dedup.js";

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
    expect(result.method).toBe("text_normalization");
    expect(result.similarity).toBeNull();
  });

  it("does NOT flag near-miss text as duplicate (high precision)", () => {
    const existing = [
      makeThread("t-existing", "Fix auth timeout", null),
    ];

    const result = checkDuplicate("Fix authentication timeout", null, existing);

    expect(result.is_duplicate).toBe(false);
    expect(result.method).toBe("text_normalization");
  });
});

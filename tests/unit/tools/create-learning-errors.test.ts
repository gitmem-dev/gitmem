/**
 * Unit tests for create_learning error surfacing (OD-554)
 *
 * Verifies that validation errors and DB errors are returned
 * in the errors[] field instead of being silently swallowed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock dependencies ---

const mockDirectUpsert = vi.fn(() => Promise.resolve({ id: "test-learning-id" }));

vi.mock("../../../src/services/supabase-client.js", () => ({
  isConfigured: vi.fn(() => true),
  directUpsert: (...args: unknown[]) => mockDirectUpsert(...args),
}));

vi.mock("../../../src/services/tier.js", () => ({
  hasSupabase: vi.fn(() => true),
}));

vi.mock("../../../src/services/embedding.js", () => ({
  embed: vi.fn(() => Promise.resolve(null)),
  isEmbeddingAvailable: vi.fn(() => false),
}));

vi.mock("../../../src/services/agent-detection.js", () => ({
  getAgentIdentity: vi.fn(() => "CLI"),
}));

vi.mock("../../../src/services/display-protocol.js", () => ({
  wrapDisplay: vi.fn((msg: string) => msg),
  TYPE: { scar: "S", win: "W", pattern: "P", anti_pattern: "A" },
  SEV: { critical: "!", high: "H", medium: "M", low: "L" },
}));

vi.mock("../../../src/services/startup.js", () => ({
  flushCache: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../src/services/triple-writer.js", () => ({
  writeTriplesForLearning: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../src/services/effect-tracker.js", () => ({
  getEffectTracker: vi.fn(() => ({
    track: vi.fn((_cat: string, _label: string, fn: () => Promise<void>) => fn()),
  })),
}));

vi.mock("../../../src/services/storage.js", () => ({
  getStorage: vi.fn(() => ({
    upsert: vi.fn(() => Promise.resolve()),
  })),
}));

vi.mock("../../../src/services/session-state.js", () => ({
  getProject: vi.fn(() => "test-project"),
}));

vi.mock("../../../src/services/metrics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/services/metrics.js")>();
  return {
    ...actual,
    recordMetrics: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("uuid", () => ({
  v4: vi.fn(() => "test-uuid-learning"),
}));

import { createLearning } from "../../../src/tools/create-learning.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockDirectUpsert.mockResolvedValue({ id: "test-learning-id" });
});

describe("create_learning: validation error surfacing (OD-554)", () => {
  it("returns errors[] when scar is missing severity", async () => {
    const result = await createLearning({
      learning_type: "scar",
      title: "Test Scar",
      description: "Missing severity field",
      counter_arguments: ["arg1", "arg2"],
      // severity intentionally omitted
    });

    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    expect(result.errors!.some(e => e.includes("severity"))).toBe(true);
  });

  it("returns errors[] when scar has insufficient counter_arguments", async () => {
    const result = await createLearning({
      learning_type: "scar",
      title: "Test Scar",
      description: "Not enough counter args",
      severity: "high",
      counter_arguments: ["only one"],
    });

    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.some(e => e.includes("counter_arguments"))).toBe(true);
  });

  it("returns multiple validation errors when both severity and counter_arguments are missing", async () => {
    const result = await createLearning({
      learning_type: "scar",
      title: "Test Scar",
      description: "Missing everything",
      // severity omitted, counter_arguments omitted
    });

    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBe(2);
  });

  it("includes validation errors in display message", async () => {
    const result = await createLearning({
      learning_type: "scar",
      title: "Test Scar",
      description: "Missing severity",
      counter_arguments: ["arg1", "arg2"],
    });

    expect(result.display).toBeDefined();
    expect(result.display).toContain("severity");
  });
});

describe("create_learning: DB error surfacing (OD-554)", () => {
  it("returns error message when directUpsert throws", async () => {
    mockDirectUpsert.mockRejectedValue(new Error("duplicate key violates unique constraint"));

    const result = await createLearning({
      learning_type: "win",
      title: "Test Win",
      description: "Should fail on DB write",
    });

    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBe(1);
    expect(result.errors![0]).toContain("duplicate key");
  });

  it("returns stringified error for non-Error throws", async () => {
    mockDirectUpsert.mockRejectedValue("raw string error");

    const result = await createLearning({
      learning_type: "pattern",
      title: "Test Pattern",
      description: "Should handle non-Error throws",
    });

    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors![0]).toContain("raw string error");
  });

  it("includes error in display message on DB failure", async () => {
    mockDirectUpsert.mockRejectedValue(new Error("connection refused"));

    const result = await createLearning({
      learning_type: "win",
      title: "Test Win",
      description: "DB connection error",
    });

    expect(result.display).toContain("connection refused");
  });

  it("does NOT include errors[] on success", async () => {
    const result = await createLearning({
      learning_type: "win",
      title: "Successful Win",
      description: "This should work",
    });

    expect(result.success).toBe(true);
    expect(result.errors).toBeUndefined();
  });
});

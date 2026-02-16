/**
 * Unit tests for absorb_observations tool
 *
 * Tests observation ingestion, scar candidate detection,
 * Supabase persistence, and performance data.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock dependencies ---

vi.mock("../../../src/services/supabase-client.js", () => ({
  isConfigured: vi.fn(() => true),
  directUpsert: vi.fn(() => Promise.resolve({})),
}));

vi.mock("../../../src/services/tier.js", () => ({
  hasSupabase: vi.fn(() => true),
  getTableName: vi.fn((base: string) => `orchestra_${base}`),
}));

vi.mock("../../../src/services/metrics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/services/metrics.js")>();
  return {
    ...actual,
    recordMetrics: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("uuid", () => ({
  v4: vi.fn(() => "test-uuid-absorb"),
}));

// Mock session-state with real-ish behavior
const mockObservations: unknown[] = [];
vi.mock("../../../src/services/session-state.js", () => ({
  addObservations: vi.fn((obs: unknown[]) => {
    mockObservations.push(...obs);
    return obs.length;
  }),
  getObservations: vi.fn(() => mockObservations),
  getCurrentSession: vi.fn(() => ({
    sessionId: "test-session-id",
    agent: "CLI",
    startedAt: new Date(),
    surfacedScars: [],
    observations: mockObservations,
    children: [],
  })),
}));

import { absorbObservations } from "../../../src/tools/absorb-observations.js";
import * as supabase from "../../../src/services/supabase-client.js";
import { hasSupabase } from "../../../src/services/tier.js";
import { getCurrentSession } from "../../../src/services/session-state.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockObservations.length = 0;
});

describe("absorb_observations: basic ingestion", () => {
  it("absorbs observations and returns count", async () => {
    const result = await absorbObservations({
      observations: [
        { source: "Sub-Agent: reviewer", text: "Code looks clean", severity: "info" },
        { source: "Sub-Agent: tester", text: "All tests pass", severity: "info" },
      ],
    });

    expect(result.absorbed).toBe(2);
    expect(result.format).toBeUndefined(); // not a format-based tool
  });

  it("accepts task_id parameter", async () => {
    const result = await absorbObservations({
      task_id: "PROJ-595",
      observations: [
        { source: "Sub-Agent: explorer", text: "Found config file", severity: "info" },
      ],
    });

    expect(result.absorbed).toBe(1);
  });

  it("accumulates across multiple calls", async () => {
    await absorbObservations({
      observations: [{ source: "agent1", text: "first", severity: "info" }],
    });

    const result = await absorbObservations({
      observations: [{ source: "agent2", text: "second", severity: "info" }],
    });

    expect(result.absorbed).toBe(1); // this call absorbed 1
    expect(mockObservations.length).toBe(2); // total is 2
  });
});

describe("absorb_observations: scar candidate detection", () => {
  it("detects explicit scar_candidate severity", async () => {
    const result = await absorbObservations({
      observations: [
        { source: "agent", text: "Normal finding", severity: "scar_candidate" },
      ],
    });

    expect(result.scar_candidates).toBe(1);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toContain("Consider creating a scar");
  });

  it("detects pattern-based scar candidates from warning text", async () => {
    const result = await absorbObservations({
      observations: [
        { source: "agent", text: "This failed silently without any error", severity: "warning" },
      ],
    });

    expect(result.scar_candidates).toBe(1);
    expect(result.suggestions[0]).toContain("failed silently");
  });

  it("detects 'unexpected' pattern", async () => {
    const result = await absorbObservations({
      observations: [
        { source: "agent", text: "Found an unexpected null value in response", severity: "info" },
      ],
    });

    expect(result.scar_candidates).toBe(1);
  });

  it("detects 'no tests' pattern", async () => {
    const result = await absorbObservations({
      observations: [
        { source: "agent", text: "This module has no tests at all", severity: "warning" },
      ],
    });

    expect(result.scar_candidates).toBe(1);
  });

  it("detects 'assumed' pattern", async () => {
    const result = await absorbObservations({
      observations: [
        { source: "agent", text: "I assumed the API would return JSON but it returned XML", severity: "info" },
      ],
    });

    expect(result.scar_candidates).toBe(1);
  });

  it("does not flag normal info observations", async () => {
    const result = await absorbObservations({
      observations: [
        { source: "agent", text: "Successfully reviewed 5 files", severity: "info" },
        { source: "agent", text: "All endpoints return correct status codes", severity: "info" },
      ],
    });

    expect(result.scar_candidates).toBe(0);
    expect(result.suggestions).toHaveLength(0);
  });

  it("includes context in suggestion when present", async () => {
    const result = await absorbObservations({
      observations: [
        {
          source: "Sub-Agent: reviewer",
          text: "Missing error handling",
          severity: "scar_candidate",
          context: "src/routes/api/foo.ts",
        },
      ],
    });

    expect(result.suggestions[0]).toContain("src/routes/api/foo.ts");
    expect(result.suggestions[0]).toContain("Sub-Agent: reviewer");
  });
});

describe("absorb_observations: Supabase persistence", () => {
  it("persists to Supabase when configured", async () => {
    vi.mocked(hasSupabase).mockReturnValue(true);
    vi.mocked(supabase.isConfigured).mockReturnValue(true);

    await absorbObservations({
      observations: [{ source: "agent", text: "test", severity: "info" }],
    });

    expect(supabase.directUpsert).toHaveBeenCalledWith(
      "orchestra_sessions",
      expect.objectContaining({
        id: "test-session-id",
        task_observations: expect.any(Array),
      })
    );
  });

  it("skips Supabase when not configured", async () => {
    vi.mocked(hasSupabase).mockReturnValue(false);

    const result = await absorbObservations({
      observations: [{ source: "agent", text: "test", severity: "info" }],
    });

    expect(supabase.directUpsert).not.toHaveBeenCalled();
    expect(result.absorbed).toBe(1); // still works in memory
  });

  it("skips Supabase when no active session", async () => {
    vi.mocked(getCurrentSession).mockReturnValue(null);

    await absorbObservations({
      observations: [{ source: "agent", text: "test", severity: "info" }],
    });

    expect(supabase.directUpsert).not.toHaveBeenCalled();
  });

  it("handles Supabase error gracefully (non-fatal)", async () => {
    vi.mocked(supabase.directUpsert).mockRejectedValue(new Error("network error"));

    const result = await absorbObservations({
      observations: [{ source: "agent", text: "test", severity: "info" }],
    });

    // Should not throw — fire-and-forget
    expect(result.absorbed).toBe(1);
  });
});

describe("absorb_observations: performance data", () => {
  it("includes performance data in response", async () => {
    const result = await absorbObservations({
      observations: [{ source: "agent", text: "test", severity: "info" }],
    });

    expect(result.performance).toBeDefined();
    expect(result.performance.latency_ms).toBeGreaterThanOrEqual(0);
    expect(typeof result.performance.meets_target).toBe("boolean");
    expect(result.performance.result_count).toBe(1);
  });
});

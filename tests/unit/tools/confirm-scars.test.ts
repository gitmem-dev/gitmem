/**
 * Tests for confirm_scars validation fixes:
 * 1. Previously-confirmed scars should not be required in subsequent calls
 * 2. Future-tense regex should only catch first-person forward-looking language
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We test the validation logic directly by importing the module internals
// Since validateConfirmation and FUTURE_PATTERNS are not exported,
// we test through the public confirmScars function

// Mock dependencies
vi.mock("../../../src/services/session-state.js", () => {
  let _session: any = null;
  let _surfacedScars: any[] = [];
  let _confirmations: any[] = [];

  return {
    getCurrentSession: () => _session,
    getSurfacedScars: () => _surfacedScars,
    addConfirmations: (confs: any[]) => {
      for (const conf of confs) {
        const idx = _confirmations.findIndex((c: any) => c.scar_id === conf.scar_id);
        if (idx >= 0) {
          _confirmations[idx] = conf;
        } else {
          _confirmations.push(conf);
        }
      }
    },
    getConfirmations: () => _confirmations,
    // Test helpers
    __setSession: (s: any) => { _session = s; },
    __setSurfacedScars: (scars: any[]) => { _surfacedScars = scars; },
    __setConfirmations: (confs: any[]) => { _confirmations = confs; },
    __reset: () => {
      _session = null;
      _surfacedScars = [];
      _confirmations = [];
    },
  };
});

vi.mock("../../../src/services/metrics.js", () => ({
  Timer: class { elapsed() { return 10; } },
  buildPerformanceData: (tool: string, elapsed: number, count: number) => ({
    tool, elapsed_ms: elapsed, items_processed: count,
  }),
}));

vi.mock("../../../src/services/gitmem-dir.js", () => ({
  getSessionPath: (sessionId: string, file: string) => `/tmp/.gitmem/sessions/${sessionId}/${file}`,
}));

vi.mock("../../../src/services/display-protocol.js", () => ({
  wrapDisplay: (content: string) => content,
}));

vi.mock("fs", () => ({
  existsSync: () => false,
  readFileSync: () => "{}",
  writeFileSync: () => {},
}));

import { confirmScars } from "../../../src/tools/confirm-scars.js";

const mockState = await import("../../../src/services/session-state.js") as any;

function makeScar(id: string, title: string) {
  return {
    scar_id: id,
    scar_title: title,
    scar_severity: "medium",
    surfaced_at: new Date().toISOString(),
    source: "recall" as const,
  };
}

describe("confirm_scars: incremental confirmation (Bug 1 fix)", () => {
  beforeEach(() => {
    mockState.__reset();
    mockState.__setSession({ sessionId: "test-session" });
  });

  it("accepts confirmation of only new scars when prior scars already confirmed", async () => {
    const scar1 = makeScar("scar-1", "First scar");
    const scar2 = makeScar("scar-2", "Second scar");

    // Both scars surfaced
    mockState.__setSurfacedScars([scar1, scar2]);

    // Scar 1 was already confirmed in a previous call
    mockState.__setConfirmations([{
      scar_id: "scar-1",
      scar_title: "First scar",
      decision: "APPLYING",
      evidence: "Already addressed this scar with evidence that is long enough to pass validation checks in the previous call.",
      confirmed_at: new Date().toISOString(),
      relevance: "high",
    }]);

    // Only confirm scar 2 — scar 1 should be credited from prior confirmation
    const result = await confirmScars({
      confirmations: [{
        scar_id: "scar-2",
        decision: "N_A",
        evidence: "This scar does not apply to the current scenario because the context is completely different from what the scar describes.",
      }],
    });

    expect(result.valid).toBe(true);
    expect(result.missing_scars).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("still rejects when neither current nor prior confirmations cover a scar", async () => {
    const scar1 = makeScar("scar-1", "First scar");
    const scar2 = makeScar("scar-2", "Second scar");
    const scar3 = makeScar("scar-3", "Third scar");

    mockState.__setSurfacedScars([scar1, scar2, scar3]);

    // Only scar 1 previously confirmed
    mockState.__setConfirmations([{
      scar_id: "scar-1",
      scar_title: "First scar",
      decision: "APPLYING",
      evidence: "Already addressed this scar with proper past-tense evidence and artifact reference in the previous call.",
      confirmed_at: new Date().toISOString(),
      relevance: "high",
    }]);

    // Only confirm scar 2 — scar 3 is missing
    const result = await confirmScars({
      confirmations: [{
        scar_id: "scar-2",
        decision: "N_A",
        evidence: "This scar does not apply because the scenario described is completely different from the current task context.",
      }],
    });

    expect(result.valid).toBe(false);
    expect(result.missing_scars).toContain("Third scar");
  });

  it("accepts when all scars confirmed across multiple calls", async () => {
    const scar1 = makeScar("scar-1", "First scar");
    const scar2 = makeScar("scar-2", "Second scar");
    const scar3 = makeScar("scar-3", "Third scar");

    mockState.__setSurfacedScars([scar1, scar2, scar3]);

    // Scars 1 and 2 previously confirmed
    mockState.__setConfirmations([
      {
        scar_id: "scar-1",
        scar_title: "First scar",
        decision: "APPLYING",
        evidence: "Addressed this scar with proper past-tense evidence and artifact reference in a previous confirmation call.",
        confirmed_at: new Date().toISOString(),
        relevance: "high",
      },
      {
        scar_id: "scar-2",
        scar_title: "Second scar",
        decision: "N_A",
        evidence: "This scar described a scenario that did not apply because the context was completely different from the current work.",
        confirmed_at: new Date().toISOString(),
        relevance: "low",
      },
    ]);

    // Only confirm scar 3
    const result = await confirmScars({
      confirmations: [{
        scar_id: "scar-3",
        decision: "REFUTED",
        evidence: "Acknowledged the risk of overriding this scar. The trade-off was acceptable because the situation warranted a different approach despite the warning.",
      }],
    });

    expect(result.valid).toBe(true);
    expect(result.missing_scars).toEqual([]);
  });
});

describe("confirm_scars: future-tense regex (Bug 2 fix)", () => {
  beforeEach(() => {
    mockState.__reset();
    mockState.__setSession({ sessionId: "test-session" });
  });

  it("rejects first-person future-tense in APPLYING evidence", async () => {
    const scar = makeScar("scar-1", "Test scar");
    mockState.__setSurfacedScars([scar]);

    const result = await confirmScars({
      confirmations: [{
        scar_id: "scar-1",
        decision: "APPLYING",
        evidence: "I will verify the output after running the tests and check that everything passes correctly.",
      }],
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("past-tense");
  });

  it("rejects we'll in APPLYING evidence", async () => {
    const scar = makeScar("scar-1", "Test scar");
    mockState.__setSurfacedScars([scar]);

    const result = await confirmScars({
      confirmations: [{
        scar_id: "scar-1",
        decision: "APPLYING",
        evidence: "We'll handle this in the next step by implementing the proper validation and error handling.",
      }],
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("past-tense");
  });

  it("allows third-person 'will' in APPLYING evidence", async () => {
    const scar = makeScar("scar-1", "Test scar");
    mockState.__setSurfacedScars([scar]);

    const result = await confirmScars({
      confirmations: [{
        scar_id: "scar-1",
        decision: "APPLYING",
        evidence: "The system will benefit from this approach. Verified the implementation matched the scar's guidance by reading the source code.",
      }],
    });

    expect(result.valid).toBe(true);
  });

  it("allows 'will' in non-first-person context in APPLYING", async () => {
    const scar = makeScar("scar-1", "Test scar");
    mockState.__setSurfacedScars([scar]);

    const result = await confirmScars({
      confirmations: [{
        scar_id: "scar-1",
        decision: "APPLYING",
        evidence: "This approach will work for the use case. Confirmed by reviewing the existing test suite which passed all assertions.",
      }],
    });

    expect(result.valid).toBe(true);
  });

  it("allows 'goodwill' and other words containing 'will'", async () => {
    const scar = makeScar("scar-1", "Test scar");
    mockState.__setSurfacedScars([scar]);

    const result = await confirmScars({
      confirmations: [{
        scar_id: "scar-1",
        decision: "APPLYING",
        evidence: "Built goodwill with the team by following the established pattern. The implementation matched expectations from the scar guidance.",
      }],
    });

    expect(result.valid).toBe(true);
  });

  it("still rejects I'll in APPLYING evidence", async () => {
    const scar = makeScar("scar-1", "Test scar");
    mockState.__setSurfacedScars([scar]);

    const result = await confirmScars({
      confirmations: [{
        scar_id: "scar-1",
        decision: "APPLYING",
        evidence: "Reviewed the code and I'll make sure to follow the pattern described in the scar when implementing the fix.",
      }],
    });

    expect(result.valid).toBe(false);
  });

  it("does not check future-tense for N_A decisions", async () => {
    const scar = makeScar("scar-1", "Test scar");
    mockState.__setSurfacedScars([scar]);

    const result = await confirmScars({
      confirmations: [{
        scar_id: "scar-1",
        decision: "N_A",
        evidence: "This scar describes a deployment scenario. I will not be deploying anything — the current task is purely a code review exercise.",
      }],
    });

    expect(result.valid).toBe(true);
  });
});

describe("confirm_scars: evidence length validation", () => {
  beforeEach(() => {
    mockState.__reset();
    mockState.__setSession({ sessionId: "test-session" });
  });

  it("rejects evidence shorter than 50 characters", async () => {
    const scar = makeScar("scar-1", "Test scar");
    mockState.__setSurfacedScars([scar]);

    const result = await confirmScars({
      confirmations: [{
        scar_id: "scar-1",
        decision: "APPLYING",
        evidence: "Did it.",
      }],
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Evidence too short");
  });
});

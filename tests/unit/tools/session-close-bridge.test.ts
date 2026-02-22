/**
 * Tests for auto-bridge scar usage logic in session_close.
 *
 * Verifies:
 * - execution_successful values: APPLYING→true, N_A→true, REFUTED→undefined
 * - Pass 2 Q6 text match → execution_successful: true
 * - Pass 3 unaddressed scars → execution_successful: false
 * - Auto-bridge fires when Q6 is empty but surfaced scars exist
 * - Display shows scar titles with +/! indicators
 *
 * NOTE: scars_to_record from auto-bridge are passed to recordScarUsageBatch
 * via effect tracker (fire-and-forget), not stored in the session record.
 * We verify through the display output (which uses params.scars_to_record)
 * and through a custom effect tracker mock that captures the batch call args.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock all dependencies before importing session-close ---

vi.mock("../../../src/services/agent-detection.js", () => ({
  detectAgent: () => ({ agent: "CLI", entrypoint: "cli", docker: true, hostname: "test" }),
}));

vi.mock("../../../src/services/supabase-client.js", () => ({
  listRecords: vi.fn(),
  getRecord: vi.fn(),
  directUpsert: vi.fn(),
  directPatch: vi.fn(),
}));

vi.mock("../../../src/services/embedding.js", () => ({
  embed: () => Promise.resolve(null),
  isEmbeddingAvailable: () => false,
}));

vi.mock("../../../src/services/tier.js", () => ({
  hasSupabase: vi.fn(),
  hasBatchOperations: () => true,
  hasTranscripts: () => false,
  hasCacheManagement: () => true,
  hasVariants: () => true,
  hasCompliance: () => false,
  hasEmbeddings: () => true,
  hasMetrics: () => true,
  getTier: () => "pro",
  resetTier: () => {},
  hasAdvancedAgentDetection: () => false,
  hasMultiProject: () => false,
  hasEnforcementFields: () => false,
  getTablePrefix: () => "orchestra_",
  getTableName: (base: string) => `orchestra_${base}`,
}));

vi.mock("../../../src/services/storage.js", () => ({
  getStorage: () => ({
    get: () => Promise.resolve(null),
    upsert: () => Promise.resolve(undefined),
  }),
}));

// Session state mock — controls surfaced scars, confirmations, reflections
vi.mock("../../../src/services/session-state.js", () => ({
  clearCurrentSession: () => {},
  getSurfacedScars: vi.fn().mockReturnValue([]),
  getConfirmations: vi.fn().mockReturnValue([]),
  getReflections: vi.fn().mockReturnValue([]),
  getObservations: () => [],
  getChildren: () => [],
  getThreads: () => [],
  getSessionActivity: () => null,
}));

vi.mock("../../../src/services/thread-manager.js", () => ({
  normalizeThreads: () => [],
  mergeThreadStates: () => [],
  migrateStringThread: () => ({
    id: "t-test", text: "test", status: "open", created_at: new Date().toISOString(),
  }),
  saveThreadsFile: () => {},
}));

vi.mock("../../../src/services/thread-dedup.js", () => ({
  deduplicateThreadList: (threads: unknown[]) => threads,
}));

vi.mock("../../../src/services/thread-supabase.js", () => ({
  syncThreadsToSupabase: () => Promise.resolve(undefined),
  loadOpenThreadEmbeddings: () => Promise.resolve([]),
}));

vi.mock("../../../src/services/compliance-validator.js", () => ({
  validateSessionClose: () => ({ valid: true, errors: [], warnings: [] }),
  buildCloseCompliance: () => ({
    close_type: "standard",
    agent: "CLI",
    checklist_displayed: true,
    questions_answered_by_agent: true,
    human_asked_for_corrections: true,
    learnings_stored: 0,
    scars_applied: 0,
  }),
}));

vi.mock("../../../src/services/metrics.js", () => ({
  Timer: class { stop() { return 100; } },
  recordMetrics: () => Promise.resolve(undefined),
  buildPerformanceData: (_name: string, latency: number, count: number) => ({
    latency_ms: latency,
    target_ms: 3000,
    meets_target: latency < 3000,
    result_count: count,
  }),
  updateRelevanceData: () => Promise.resolve(undefined),
}));

vi.mock("../../../src/tools/record-scar-usage-batch.js", () => ({
  recordScarUsageBatch: vi.fn().mockResolvedValue({ success: true }),
}));

// Effect tracker — capture scar_usage track calls to verify bridge output
let capturedScarBatchArgs: unknown = null;
vi.mock("../../../src/services/effect-tracker.js", () => ({
  getEffectTracker: () => ({
    track: (category: string, _source: string, fn: () => Promise<unknown>) => {
      if (category === "scar_usage") {
        // Execute the function to capture the args
        fn();
      }
    },
    formatSummary: () => "No tracked effects this session.",
    getHealthReport: () => ({
      overall: { attempted: 0, succeeded: 0, failed: 0, successRate: "N/A", paths_with_failures: [] },
      byPath: {},
      recentFailures: [],
    }),
  }),
}));

vi.mock("../../../src/tools/save-transcript.js", () => ({
  saveTranscript: () => Promise.resolve({ success: false }),
}));

vi.mock("../../../src/services/transcript-chunker.js", () => ({
  processTranscript: () => Promise.resolve({ success: false }),
}));

vi.mock("../../../src/services/gitmem-dir.js", () => ({
  getGitmemPath: (filename: string) => `/tmp/.gitmem/${filename}`,
  getGitmemDir: () => "/tmp/.gitmem",
  getSessionPath: (sid: string, filename: string) => `/tmp/.gitmem/sessions/${sid}/${filename}`,
  getSessionDir: (sid: string) => `/tmp/.gitmem/sessions/${sid}`,
}));

vi.mock("../../../src/services/active-sessions.js", () => ({
  unregisterSession: () => {},
  findSessionByHostPid: () => null,
}));

vi.mock("../../../src/services/thread-suggestions.js", () => ({
  loadSuggestions: () => [],
  saveSuggestions: () => {},
  detectSuggestedThreads: () => [],
  loadRecentSessionEmbeddings: () => Promise.resolve(null),
}));

// --- Import after mocks ---
import { sessionClose } from "../../../src/tools/session-close.js";
import * as supabase from "../../../src/services/supabase-client.js";
import { hasSupabase } from "../../../src/services/tier.js";
import { getSurfacedScars, getConfirmations, getReflections } from "../../../src/services/session-state.js";
import { recordScarUsageBatch } from "../../../src/tools/record-scar-usage-batch.js";

const VALID_UUID = "393adb34-a80c-4c3a-b71a-bc0053b7a7ea";

function createMockSession(overrides?: Record<string, unknown>) {
  const now = new Date().toISOString();
  return {
    id: VALID_UUID,
    agent: "CLI",
    project: "test-project",
    session_title: "Interactive Session",
    session_date: now.split("T")[0],
    created_at: now,
    close_compliance: null,
    open_threads: [],
    embedding: null,
    ...overrides,
  };
}

// Helpers for building test scars and confirmations
function makeSurfacedScar(id: string, title: string, source: "recall" | "session_start" = "recall") {
  return {
    scar_id: id,
    scar_title: title,
    title,
    severity: "high",
    surfaced_at: new Date().toISOString(),
    source,
    variant_id: `variant-${id.slice(0, 8)}`,
  };
}

function makeConfirmation(id: string, title: string, decision: "APPLYING" | "N_A" | "REFUTED") {
  return {
    scar_id: id,
    scar_title: title,
    decision,
    evidence: "Substantive evidence text that meets the minimum length requirement for validation.",
    confirmed_at: new Date().toISOString(),
    relevance: decision === "APPLYING" ? "high" as const : "low" as const,
  };
}

function makeReflection(id: string, outcome: "OBEYED" | "REFUTED") {
  return {
    scar_id: id,
    outcome,
    evidence: "Substantive reflection evidence that demonstrates compliance or explains refutation.",
    reflected_at: new Date().toISOString(),
  };
}

function standardReflection(scarsApplied: string[] = []) {
  return {
    what_broke: "Nothing", what_took_longer: "N/A",
    do_differently: "N/A", what_worked: "Good session",
    wrong_assumption: "None", scars_applied: scarsApplied,
  };
}

describe("session_close auto-bridge", () => {
  beforeEach(() => {
    vi.mocked(hasSupabase).mockReturnValue(true);
    vi.mocked(supabase.getRecord).mockResolvedValue(createMockSession());
    vi.mocked(supabase.directUpsert).mockResolvedValue(undefined);
    vi.mocked(supabase.directPatch).mockResolvedValue(undefined);
    vi.mocked(supabase.listRecords).mockResolvedValue([]);
    vi.mocked(getSurfacedScars).mockReturnValue([]);
    vi.mocked(getConfirmations).mockReturnValue([]);
    vi.mocked(getReflections).mockReturnValue([]);
    vi.mocked(recordScarUsageBatch).mockResolvedValue({ success: true } as never);
    capturedScarBatchArgs = null;
  });

  // Helper: extract scars from recordScarUsageBatch mock calls
  function getBatchedScars(): Array<Record<string, unknown>> {
    const calls = vi.mocked(recordScarUsageBatch).mock.calls;
    if (calls.length === 0) return [];
    const args = calls[0][0] as { scars: Array<Record<string, unknown>> };
    return args.scars || [];
  }

  describe("execution_successful values (Pass 1: confirmations)", () => {
    const SCAR_ID_1 = "aaaaaaaa-1111-1111-1111-111111111111";
    const SCAR_ID_2 = "bbbbbbbb-2222-2222-2222-222222222222";
    const SCAR_ID_3 = "cccccccc-3333-3333-3333-333333333333";

    it("APPLYING confirmation → execution_successful: true", async () => {
      vi.mocked(getSurfacedScars).mockReturnValue([
        makeSurfacedScar(SCAR_ID_1, "Trace execution path first"),
      ]);
      vi.mocked(getConfirmations).mockReturnValue([
        makeConfirmation(SCAR_ID_1, "Trace execution path first", "APPLYING"),
      ]);

      const result = await sessionClose({
        session_id: VALID_UUID,
        close_type: "standard",
        closing_reflection: standardReflection(),
      });

      expect(result.success).toBe(true);
      const scars = getBatchedScars();
      expect(scars.length).toBe(1);
      expect(scars[0].execution_successful).toBe(true);
      expect(scars[0].reference_type).toBe("explicit");
    });

    it("N_A confirmation → execution_successful: true (not undefined)", async () => {
      vi.mocked(getSurfacedScars).mockReturnValue([
        makeSurfacedScar(SCAR_ID_2, "Done != Deployed"),
      ]);
      vi.mocked(getConfirmations).mockReturnValue([
        makeConfirmation(SCAR_ID_2, "Done != Deployed", "N_A"),
      ]);

      const result = await sessionClose({
        session_id: VALID_UUID,
        close_type: "standard",
        closing_reflection: standardReflection(),
      });

      expect(result.success).toBe(true);
      const scars = getBatchedScars();
      expect(scars.length).toBe(1);
      expect(scars[0].execution_successful).toBe(true); // N_A → true, NOT undefined
    });

    it("REFUTED confirmation → execution_successful: undefined", async () => {
      vi.mocked(getSurfacedScars).mockReturnValue([
        makeSurfacedScar(SCAR_ID_3, "Check existing code first"),
      ]);
      vi.mocked(getConfirmations).mockReturnValue([
        makeConfirmation(SCAR_ID_3, "Check existing code first", "REFUTED"),
      ]);

      const result = await sessionClose({
        session_id: VALID_UUID,
        close_type: "standard",
        closing_reflection: standardReflection(),
      });

      expect(result.success).toBe(true);
      const scars = getBatchedScars();
      expect(scars.length).toBe(1);
      expect(scars[0].execution_successful).toBeUndefined();
    });

    it("reflection OBEYED overrides confirmation → execution_successful: true", async () => {
      vi.mocked(getSurfacedScars).mockReturnValue([
        makeSurfacedScar(SCAR_ID_1, "Trace execution path first"),
      ]);
      vi.mocked(getConfirmations).mockReturnValue([
        makeConfirmation(SCAR_ID_1, "Trace execution path first", "APPLYING"),
      ]);
      vi.mocked(getReflections).mockReturnValue([
        makeReflection(SCAR_ID_1, "OBEYED"),
      ]);

      const result = await sessionClose({
        session_id: VALID_UUID,
        close_type: "standard",
        closing_reflection: standardReflection(),
      });

      expect(result.success).toBe(true);
      const scars = getBatchedScars();
      expect(scars[0].execution_successful).toBe(true);
      expect(scars[0].reference_context).toContain("OBEYED");
    });

    it("reflection REFUTED → execution_successful: false", async () => {
      vi.mocked(getSurfacedScars).mockReturnValue([
        makeSurfacedScar(SCAR_ID_1, "Trace execution path first"),
      ]);
      vi.mocked(getConfirmations).mockReturnValue([
        makeConfirmation(SCAR_ID_1, "Trace execution path first", "APPLYING"),
      ]);
      vi.mocked(getReflections).mockReturnValue([
        makeReflection(SCAR_ID_1, "REFUTED"),
      ]);

      const result = await sessionClose({
        session_id: VALID_UUID,
        close_type: "standard",
        closing_reflection: standardReflection(),
      });

      expect(result.success).toBe(true);
      const scars = getBatchedScars();
      expect(scars[0].execution_successful).toBe(false);
      expect(scars[0].reference_context).toContain("REFUTED");
    });
  });

  describe("Pass 2: Q6 text matching", () => {
    const SCAR_ID = "dddddddd-4444-4444-4444-444444444444";

    it("Q6 match → execution_successful: true and reference_type: acknowledged", async () => {
      vi.mocked(getSurfacedScars).mockReturnValue([
        makeSurfacedScar(SCAR_ID, "Done != Deployed"),
      ]);
      vi.mocked(getConfirmations).mockReturnValue([]);

      const result = await sessionClose({
        session_id: VALID_UUID,
        close_type: "standard",
        closing_reflection: standardReflection(["Done != Deployed"]),
      });

      expect(result.success).toBe(true);
      const scars = getBatchedScars();
      expect(scars.length).toBe(1);
      expect(scars[0].execution_successful).toBe(true);
      expect(scars[0].reference_type).toBe("acknowledged");
      expect(scars[0].reference_context).toContain("Done != Deployed");
      expect(scars[0].reference_context).toContain("Q6 match");
    });
  });

  describe("Pass 3: unaddressed scars", () => {
    const SCAR_ID = "eeeeeeee-5555-5555-5555-555555555555";

    it("unaddressed scar → execution_successful: false and reference_type: none", async () => {
      vi.mocked(getSurfacedScars).mockReturnValue([
        makeSurfacedScar(SCAR_ID, "gitmem-pc before agent spawn"),
      ]);
      vi.mocked(getConfirmations).mockReturnValue([]);

      const result = await sessionClose({
        session_id: VALID_UUID,
        close_type: "standard",
        closing_reflection: standardReflection(),
      });

      expect(result.success).toBe(true);
      const scars = getBatchedScars();
      expect(scars.length).toBe(1);
      expect(scars[0].execution_successful).toBe(false);
      expect(scars[0].reference_type).toBe("none");
      expect(scars[0].reference_context).toContain("gitmem-pc before agent spawn");
      expect(scars[0].reference_context).toContain("not addressed");
    });
  });

  describe("auto-bridge trigger condition", () => {
    const SCAR_ID = "ffffffff-6666-6666-6666-666666666666";

    it("fires even when Q6 scars_applied is empty", async () => {
      vi.mocked(getSurfacedScars).mockReturnValue([
        makeSurfacedScar(SCAR_ID, "Trace execution path first"),
      ]);
      vi.mocked(getConfirmations).mockReturnValue([
        makeConfirmation(SCAR_ID, "Trace execution path first", "APPLYING"),
      ]);

      const result = await sessionClose({
        session_id: VALID_UUID,
        close_type: "standard",
        closing_reflection: standardReflection([]), // Empty Q6
      });

      expect(result.success).toBe(true);
      const scars = getBatchedScars();
      expect(scars.length).toBe(1);
      expect(scars[0].reference_type).toBe("explicit"); // From Pass 1 confirmation
    });

    it("does not fire when explicit scars_to_record provided", async () => {
      vi.mocked(getSurfacedScars).mockReturnValue([
        makeSurfacedScar(SCAR_ID, "Trace execution path first"),
      ]);

      const result = await sessionClose({
        session_id: VALID_UUID,
        close_type: "standard",
        scars_to_record: [{
          scar_identifier: SCAR_ID,
          session_id: VALID_UUID,
          agent: "CLI",
          surfaced_at: new Date().toISOString(),
          reference_type: "explicit",
          reference_context: "Manual record",
          execution_successful: true,
        }],
        closing_reflection: standardReflection(),
      });

      expect(result.success).toBe(true);
      // Display should contain "Manual record" from the explicit scar, not auto-bridged
      // recordScarUsageBatch is called with the explicit scar
      const scars = getBatchedScars();
      expect(scars.length).toBe(1);
      expect(scars[0].reference_context).toBe("Manual record");
    });
  });

  describe("display format", () => {
    const SCAR_ID_1 = "11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const SCAR_ID_2 = "22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    it("shows scar titles in display output for applied scars", async () => {
      vi.mocked(getSurfacedScars).mockReturnValue([
        makeSurfacedScar(SCAR_ID_1, "Trace execution path first"),
      ]);
      vi.mocked(getConfirmations).mockReturnValue([
        makeConfirmation(SCAR_ID_1, "Trace execution path first", "APPLYING"),
      ]);

      const result = await sessionClose({
        session_id: VALID_UUID,
        close_type: "standard",
        closing_reflection: standardReflection(),
      });

      expect(result.success).toBe(true);
      expect(result.display).toContain("Trace execution path first");
      expect(result.display).toContain("1 scars applied");
    });

    it("reference_context leads with scar title, not boilerplate", async () => {
      vi.mocked(getSurfacedScars).mockReturnValue([
        makeSurfacedScar(SCAR_ID_1, "Trace execution path first"),
      ]);
      vi.mocked(getConfirmations).mockReturnValue([
        makeConfirmation(SCAR_ID_1, "Trace execution path first", "APPLYING"),
      ]);

      const result = await sessionClose({
        session_id: VALID_UUID,
        close_type: "standard",
        closing_reflection: standardReflection(),
      });

      const scars = getBatchedScars();
      const context = scars[0].reference_context as string;
      // Should start with scar title, not "Confirmed via confirm_scars"
      expect(context).toMatch(/^Trace execution path first/);
    });
  });

  describe("multi-scar scenario", () => {
    const SCAR_A = "aaa11111-1111-1111-1111-111111111111";
    const SCAR_B = "bbb22222-2222-2222-2222-222222222222";
    const SCAR_C = "ccc33333-3333-3333-3333-333333333333";

    it("handles mix of confirmed, Q6-matched, and unaddressed scars", async () => {
      vi.mocked(getSurfacedScars).mockReturnValue([
        makeSurfacedScar(SCAR_A, "Trace execution path first"),
        makeSurfacedScar(SCAR_B, "Done != Deployed"),
        makeSurfacedScar(SCAR_C, "gitmem-pc before agent spawn"),
      ]);
      // Only SCAR_A has a confirmation
      vi.mocked(getConfirmations).mockReturnValue([
        makeConfirmation(SCAR_A, "Trace execution path first", "APPLYING"),
      ]);

      const result = await sessionClose({
        session_id: VALID_UUID,
        close_type: "standard",
        closing_reflection: standardReflection(["Done != Deployed"]),
      });

      expect(result.success).toBe(true);
      const scars = getBatchedScars();
      expect(scars.length).toBe(3);

      // SCAR_A: confirmed APPLYING → explicit, exec=true
      const scarA = scars.find(s => s.scar_identifier === SCAR_A);
      expect(scarA).toBeDefined();
      expect(scarA!.reference_type).toBe("explicit");
      expect(scarA!.execution_successful).toBe(true);

      // SCAR_B: Q6 match → acknowledged, exec=true
      const scarB = scars.find(s => s.scar_identifier === SCAR_B);
      expect(scarB).toBeDefined();
      expect(scarB!.reference_type).toBe("acknowledged");
      expect(scarB!.execution_successful).toBe(true);

      // SCAR_C: unaddressed → none, exec=false
      const scarC = scars.find(s => s.scar_identifier === SCAR_C);
      expect(scarC).toBeDefined();
      expect(scarC!.reference_type).toBe("none");
      expect(scarC!.execution_successful).toBe(false);
    });
  });
});

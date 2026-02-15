/**
 * Tests for session_close Supabase path (pro/dev tier).
 *
 * The existing session-close-validation tests mock hasSupabase: () => false,
 * which only exercises the free-tier path (sessionCloseFree). This file tests
 * the main Supabase path that runs when hasSupabase() returns true.
 *
 * NOTE: vitest.config.ts has `restoreMocks: true`, so vi.fn().mockReturnValue()
 * implementations are cleared between tests. Use plain functions for constant mocks,
 * and re-establish spy implementations in beforeEach.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock all dependencies before importing session-close ---
// Use plain functions (not vi.fn()) for mocks we don't need to spy on.
// restoreMocks: true in vitest config clears vi.fn() implementations between tests.

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

vi.mock("../../../src/services/session-state.js", () => ({
  clearCurrentSession: () => {},
  getSurfacedScars: () => [],
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
  buildCloseCompliance: (_params: unknown, _agent: string, _learningsCount: number) => ({
    close_type: "quick",
    agent: "CLI",
    checklist_displayed: true,
    questions_answered_by_agent: false,
    human_asked_for_corrections: false,
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
  recordScarUsageBatch: () => Promise.resolve({ success: true }),
}));

vi.mock("../../../src/services/effect-tracker.js", () => ({
  getEffectTracker: () => ({
    track: () => {},
    formatSummary: () => "No tracked effects this session.",
    getHealthReport: () => ({ overall: { attempted: 0, succeeded: 0, failed: 0, successRate: "N/A", paths_with_failures: [] }, byPath: {}, recentFailures: [] }),
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

const VALID_UUID = "393adb34-a80c-4c3a-b71a-bc0053b7a7ea";

function createMockSession(overrides?: Record<string, unknown>) {
  const now = new Date().toISOString();
  const today = now.split("T")[0];
  return {
    id: VALID_UUID,
    agent: "CLI",
    project: "orchestra_dev",
    session_title: "Interactive Session",
    session_date: today,
    created_at: now,
    close_compliance: null,
    open_threads: [],
    embedding: null,
    ...overrides,
  };
}

describe("session_close Supabase path", () => {
  beforeEach(() => {
    // Re-establish spy implementations cleared by restoreMocks: true
    vi.mocked(hasSupabase).mockReturnValue(true);
    vi.mocked(supabase.listRecords).mockResolvedValue([]);
    vi.mocked(supabase.getRecord).mockResolvedValue(null);
    vi.mocked(supabase.directUpsert).mockResolvedValue(undefined);
    vi.mocked(supabase.directPatch).mockResolvedValue(undefined);
  });

  describe("happy path: existing session", () => {
    it("successfully closes when session exists in Supabase", async () => {
      const mockSession = createMockSession();
      vi.mocked(supabase.getRecord).mockResolvedValue(mockSession);

      const result = await sessionClose({
        session_id: VALID_UUID,
        close_type: "quick",
      });

      expect(result.success).toBe(true);
      expect(result.session_id).toBe(VALID_UUID);
      expect(supabase.getRecord).toHaveBeenCalledWith("orchestra_sessions", VALID_UUID);
      expect(supabase.directUpsert).toHaveBeenCalledWith(
        "orchestra_sessions",
        expect.objectContaining({ id: VALID_UUID, close_compliance: expect.any(Object) })
      );
    });

    it("includes closing_reflection in persisted data", async () => {
      vi.mocked(supabase.getRecord).mockResolvedValue(createMockSession());

      const result = await sessionClose({
        session_id: VALID_UUID,
        close_type: "standard",
        closing_reflection: {
          what_broke: "Nothing",
          what_took_longer: "Tests",
          do_differently: "Plan better",
          what_worked: "Communication",
          wrong_assumption: "None",
          scars_applied: ["scar-1"],
        },
      });

      expect(result.success).toBe(true);
      const upsertedData = vi.mocked(supabase.directUpsert).mock.calls[0][1] as Record<string, unknown>;
      expect(upsertedData.closing_reflection).toBeDefined();
      expect((upsertedData.closing_reflection as Record<string, unknown>).what_worked).toBe("Communication");
    });

    it("strips embedding from existing session before merge", async () => {
      vi.mocked(supabase.getRecord).mockResolvedValue(
        createMockSession({ embedding: [0.1, 0.2, 0.3] })
      );

      await sessionClose({ session_id: VALID_UUID, close_type: "quick" });

      const upsertedData = vi.mocked(supabase.directUpsert).mock.calls[0][1] as Record<string, unknown>;
      expect(upsertedData.embedding).toBeUndefined();
    });
  });

  describe("session not found", () => {
    it("returns error when session does not exist in Supabase", async () => {
      vi.mocked(supabase.getRecord).mockResolvedValue(null);

      const result = await sessionClose({
        session_id: VALID_UUID,
        close_type: "quick",
      });

      expect(result.success).toBe(false);
      expect(result.validation_errors).toBeDefined();
      expect(result.validation_errors![0]).toContain("not found");
    });
  });

  describe("retroactive close", () => {
    it("creates new session without looking up existing", async () => {
      const result = await sessionClose({
        session_id: VALID_UUID,
        close_type: "retroactive",
        closing_reflection: {
          what_broke: "Nothing",
          what_took_longer: "Tests",
          do_differently: "Plan better",
          what_worked: "Communication",
          wrong_assumption: "None",
          scars_applied: [],
        },
      });

      expect(result.success).toBe(true);
      // Retroactive generates a new UUID
      expect(result.session_id).toBeDefined();
      // Should NOT call getRecord (retroactive skips session lookup)
      expect(supabase.getRecord).not.toHaveBeenCalled();
      expect(supabase.directUpsert).toHaveBeenCalledWith(
        "orchestra_sessions",
        expect.objectContaining({
          session_title: expect.any(String),
          close_compliance: expect.any(Object),
        })
      );
    });
  });

  describe("Supabase persistence failure", () => {
    it("returns error when directUpsert fails", async () => {
      vi.mocked(supabase.getRecord).mockResolvedValue(createMockSession());
      vi.mocked(supabase.directUpsert).mockRejectedValue(new Error("Connection refused"));

      const result = await sessionClose({
        session_id: VALID_UUID,
        close_type: "quick",
      });

      expect(result.success).toBe(false);
      expect(result.validation_errors![0]).toContain("Connection refused");
    });
  });

  describe("rapport summary (OD-666)", () => {
    it("builds rapport_summary from Q8+Q9 answers", async () => {
      vi.mocked(supabase.getRecord).mockResolvedValue(createMockSession());

      await sessionClose({
        session_id: VALID_UUID,
        close_type: "standard",
        closing_reflection: {
          what_broke: "Nothing",
          what_took_longer: "Tests",
          do_differently: "Plan better",
          what_worked: "Communication",
          wrong_assumption: "None",
          scars_applied: [],
          collaborative_dynamic: "Direct and fast-paced",
          rapport_notes: "Push-back welcomed",
        },
      });

      const upsertedData = vi.mocked(supabase.directUpsert).mock.calls[0][1] as Record<string, unknown>;
      expect(upsertedData.rapport_summary).toBe("Direct and fast-paced | Push-back welcomed");
    });

    it("omits rapport_summary when Q8/Q9 not provided", async () => {
      vi.mocked(supabase.getRecord).mockResolvedValue(createMockSession());

      await sessionClose({ session_id: VALID_UUID, close_type: "quick" });

      const upsertedData = vi.mocked(supabase.directUpsert).mock.calls[0][1] as Record<string, unknown>;
      expect(upsertedData.rapport_summary).toBeUndefined();
    });
  });

  describe("session title update", () => {
    it("updates generic title with Linear issue + decision", async () => {
      vi.mocked(supabase.getRecord).mockResolvedValue(
        createMockSession({ session_title: "Interactive Session" })
      );

      await sessionClose({
        session_id: VALID_UUID,
        close_type: "standard",
        linear_issue: "OD-123",
        decisions: [{ title: "Chose X over Y", decision: "X", rationale: "because" }],
      });

      const upsertedData = vi.mocked(supabase.directUpsert).mock.calls[0][1] as Record<string, unknown>;
      expect(upsertedData.session_title).toBe("OD-123 - Chose X over Y");
    });

    it("preserves custom session title", async () => {
      vi.mocked(supabase.getRecord).mockResolvedValue(
        createMockSession({ session_title: "Custom Title From Session Start" })
      );

      await sessionClose({
        session_id: VALID_UUID,
        close_type: "standard",
        linear_issue: "OD-123",
        decisions: [{ title: "Chose X over Y", decision: "X", rationale: "because" }],
      });

      const upsertedData = vi.mocked(supabase.directUpsert).mock.calls[0][1] as Record<string, unknown>;
      expect(upsertedData.session_title).toBe("Custom Title From Session Start");
    });
  });

  describe("decisions persistence", () => {
    it("persists decision titles to session data", async () => {
      vi.mocked(supabase.getRecord).mockResolvedValue(createMockSession());

      await sessionClose({
        session_id: VALID_UUID,
        close_type: "standard",
        decisions: [
          { title: "Decision A", decision: "Chose A", rationale: "faster" },
          { title: "Decision B", decision: "Chose B", rationale: "simpler" },
        ],
      });

      const upsertedData = vi.mocked(supabase.directUpsert).mock.calls[0][1] as Record<string, unknown>;
      expect(upsertedData.decisions).toEqual(["Decision A", "Decision B"]);
    });
  });

  describe("linear_issue persistence", () => {
    it("adds linear_issue to session data", async () => {
      vi.mocked(supabase.getRecord).mockResolvedValue(createMockSession());

      await sessionClose({
        session_id: VALID_UUID,
        close_type: "quick",
        linear_issue: "OD-999",
      });

      const upsertedData = vi.mocked(supabase.directUpsert).mock.calls[0][1] as Record<string, unknown>;
      expect(upsertedData.linear_issue).toBe("OD-999");
    });
  });

  describe("ceremony_duration_ms", () => {
    it("passes through to close_compliance", async () => {
      vi.mocked(supabase.getRecord).mockResolvedValue(createMockSession());

      const result = await sessionClose({
        session_id: VALID_UUID,
        close_type: "quick",
        ceremony_duration_ms: 5000,
      });

      expect(result.success).toBe(true);
      expect(result.close_compliance.ceremony_duration_ms).toBe(5000);
    });
  });
});

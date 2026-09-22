/**
 * GIT-99: a standard close with neither closing-payload.json nor an inline
 * reflection names the path it looked at.
 *
 * The agent has usually written the payload — to a .gitmem root this server
 * does not read. It used to get "requires task_completion" / "requires
 * closing_reflection with N answers", which sends it to rewrite answers it
 * already wrote instead of to the path mismatch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const root = vi.hoisted(() => ({ dir: "" }));

// Mock dependencies before importing session-close
vi.mock("../../../src/services/agent-detection.js", () => ({
  detectAgent: () => ({ agent: "CLI", entrypoint: "cli", docker: true, hostname: "test" }),
}));

vi.mock("../../../src/services/supabase-client.js", () => ({
  listRecords: vi.fn().mockResolvedValue([]),
  getRecord: vi.fn().mockResolvedValue(null),
  directUpsert: vi.fn().mockResolvedValue(undefined),
  directPatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/services/embedding.js", () => ({
  embed: vi.fn().mockResolvedValue(null),
  isEmbeddingAvailable: () => false,
}));

vi.mock("../../../src/services/tier.js", () => ({
  hasSupabase: () => false,
  hasBatchOperations: () => false,
  hasTranscripts: () => false,
  hasCacheManagement: () => false,
  getTableName: (base: string) => `orchestra_${base}`,
  hasProInsights: () => false,
}));

vi.mock("../../../src/services/analytics.js", () => ({
  queryScarUsageByDateRange: vi.fn().mockResolvedValue([]),
  enrichScarUsageTitles: vi.fn().mockResolvedValue([]),
  formatBlindspotSnippet: vi.fn().mockReturnValue(null),
  querySessionsByDateRange: vi.fn().mockResolvedValue([]),
  computeLightweightSummary: vi.fn().mockReturnValue(null),
}));

vi.mock("../../../src/services/storage.js", () => ({
  getStorage: () => ({
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../../../src/services/session-state.js", () => ({
  clearCurrentSession: vi.fn(),
  getSurfacedScars: () => [],
  getObservations: () => [],
  getChildren: () => [],
  getThreads: () => [],
  getSessionActivity: () => null,
  isRecallCalled: () => true,
}));

vi.mock("../../../src/services/thread-manager.js", () => ({
  normalizeThreads: vi.fn().mockReturnValue([]),
  mergeThreadStates: vi.fn().mockReturnValue([]),
  migrateStringThread: vi.fn().mockReturnValue({ id: "t-test", text: "test", status: "open", created_at: new Date().toISOString() }),
  saveThreadsFile: vi.fn(),
}));

vi.mock("../../../src/services/thread-dedup.js", () => ({
  deduplicateThreadList: vi.fn().mockImplementation((threads) => threads),
}));

vi.mock("../../../src/services/thread-supabase.js", () => ({
  syncThreadsToSupabase: vi.fn().mockResolvedValue(undefined),
  loadOpenThreadEmbeddings: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../src/services/compliance-validator.js", () => ({
  validateSessionClose: () => ({ valid: true, errors: [], warnings: [] }),
  buildCloseCompliance: vi.fn().mockReturnValue({
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
  recordMetrics: vi.fn().mockResolvedValue(undefined),
  buildPerformanceData: (name: string, latency: number, count: number) => ({
    latency_ms: latency,
    target_ms: 3000,
    meets_target: latency < 3000,
    result_count: count,
  }),
  updateRelevanceData: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/tools/record-scar-usage-batch.js", () => ({
  recordScarUsageBatch: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("../../../src/services/effect-tracker.js", () => ({
  getEffectTracker: () => ({
    track: vi.fn(),
    formatSummary: () => "No tracked effects this session.",
    getHealthReport: () => ({ overall: { attempted: 0, succeeded: 0, failed: 0, successRate: "N/A", paths_with_failures: [] }, byPath: {}, recentFailures: [] }),
  }),
}));

vi.mock("../../../src/tools/save-transcript.js", () => ({
  saveTranscript: vi.fn().mockResolvedValue({ success: false }),
}));

vi.mock("../../../src/services/transcript-chunker.js", () => ({
  processTranscript: vi.fn().mockResolvedValue({ success: false }),
}));

vi.mock("../../../src/services/gitmem-dir.js", () => ({
  getGitmemPath: (filename: string) => `${root.dir}/${filename}`,
  getGitmemDir: () => root.dir,
  getSessionPath: (sid: string, filename: string) => `${root.dir}/sessions/${sid}/${filename}`,
}));

vi.mock("../../../src/services/active-sessions.js", () => ({
  unregisterSession: vi.fn(),
  findSessionByHostPid: vi.fn().mockReturnValue(null),
  findSessionById: vi.fn().mockReturnValue(null), // GIT-86: session-close's registry fallback looks up by id
}));

vi.mock("../../../src/services/thread-suggestions.js", () => ({
  loadSuggestions: vi.fn().mockReturnValue([]),
  saveSuggestions: vi.fn(),
  detectSuggestedThreads: vi.fn().mockReturnValue([]),
  loadRecentSessionEmbeddings: vi.fn().mockResolvedValue(null),
}));

import { sessionClose } from "../../../src/tools/session-close.js";

const SID = "393adb34-a80c-4c3a-b71a-bc0053b7a7ea";
const payloadFile = () => path.join(root.dir, "closing-payload.json");

beforeEach(() => {
  vi.clearAllMocks();
  root.dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-git99-"));
});

afterEach(() => {
  fs.rmSync(root.dir, { recursive: true, force: true });
});

describe("session_close missing payload (GIT-99)", () => {
  it("standard close, no payload, no inline reflection: names the absolute path", async () => {
    const result = await sessionClose({ session_id: SID, close_type: "standard" });

    expect(result.success).toBe(false);
    expect(result.validation_errors).toHaveLength(1);
    expect(result.validation_errors![0]).toBe(
      `closing-payload.json not found at ${payloadFile()}. ` +
      `Write the closing payload to exactly that path (or pass closing_reflection inline), then call session_close again.`
    );
    expect(path.isAbsolute(result.validation_errors![0].split(" not found at ")[1].split(". Write")[0])).toBe(true);
    expect(result.validation_errors!.join(" ")).not.toMatch(/answers|task_completion|recall\(\)/);
  });

  it("an unparseable payload is reported as found-but-unreadable, at its path", async () => {
    fs.writeFileSync(payloadFile(), "{ not json");
    const result = await sessionClose({ session_id: SID, close_type: "standard" });

    expect(result.success).toBe(false);
    expect(result.validation_errors![0]).toContain(`closing-payload.json at ${payloadFile()} could not be read:`);
  });

  it("an inline reflection is enough — no payload file needed", async () => {
    const result = await sessionClose({
      session_id: SID,
      close_type: "standard",
      closing_reflection: { what_broke: "x", what_worked: "y", scars_applied: [] },
    });
    expect((result.validation_errors || []).join(" ")).not.toContain("closing-payload.json not found");
  });

  it("a payload at the path is consumed", async () => {
    fs.writeFileSync(payloadFile(), JSON.stringify({ closing_reflection: { what_broke: "x", what_worked: "y", scars_applied: [] } }));
    const result = await sessionClose({ session_id: SID, close_type: "standard" });
    expect((result.validation_errors || []).join(" ")).not.toContain("closing-payload.json");
  });

  it("quick close never needs a payload", async () => {
    const result = await sessionClose({ session_id: SID, close_type: "quick" });
    expect((result.validation_errors || []).join(" ")).not.toContain("closing-payload.json");
  });
});

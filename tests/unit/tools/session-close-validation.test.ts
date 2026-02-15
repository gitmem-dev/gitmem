/**
 * Tests for OD-548 (session_id UUID validation) and OD-640 (project enum removal)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  }),
}));

vi.mock("../../../src/tools/save-transcript.js", () => ({
  saveTranscript: vi.fn().mockResolvedValue({ success: false }),
}));

vi.mock("../../../src/services/transcript-chunker.js", () => ({
  processTranscript: vi.fn().mockResolvedValue({ success: false }),
}));

vi.mock("../../../src/services/gitmem-dir.js", () => ({
  getGitmemPath: (filename: string) => `/tmp/.gitmem/${filename}`,
  getGitmemDir: () => "/tmp/.gitmem",
  getSessionPath: (sid: string, filename: string) => `/tmp/.gitmem/sessions/${sid}/${filename}`,
}));

vi.mock("../../../src/services/active-sessions.js", () => ({
  unregisterSession: vi.fn(),
  findSessionByHostPid: vi.fn().mockReturnValue(null),
}));

vi.mock("../../../src/services/thread-suggestions.js", () => ({
  loadSuggestions: vi.fn().mockReturnValue([]),
  saveSuggestions: vi.fn(),
  detectSuggestedThreads: vi.fn().mockReturnValue([]),
  loadRecentSessionEmbeddings: vi.fn().mockResolvedValue(null),
}));

import { sessionClose } from "../../../src/tools/session-close.js";

describe("OD-548: session_close UUID validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects garbage string as session_id", async () => {
    const result = await sessionClose({
      session_id: "not-a-uuid-at-all",
      close_type: "quick",
    });

    expect(result.success).toBe(false);
    expect(result.validation_errors).toBeDefined();
    expect(result.validation_errors![0]).toContain("Invalid session_id format");
    expect(result.validation_errors![0]).toContain("not-a-uuid-at-all");
    expect(result.validation_errors![0]).toContain("Run session_start first");
  });

  it("rejects partial UUID as session_id", async () => {
    const result = await sessionClose({
      session_id: "393adb34-a80c",
      close_type: "quick",
    });

    expect(result.success).toBe(false);
    expect(result.validation_errors).toBeDefined();
    expect(result.validation_errors![0]).toContain("Invalid session_id format");
  });

  it("rejects English words as session_id", async () => {
    const result = await sessionClose({
      session_id: "my-session",
      close_type: "quick",
    });

    expect(result.success).toBe(false);
    expect(result.validation_errors![0]).toContain("Invalid session_id format");
  });

  it("accepts valid full UUID as session_id", async () => {
    const result = await sessionClose({
      session_id: "393adb34-a80c-4c3a-b71a-bc0053b7a7ea",
      close_type: "quick",
    });

    // Will succeed (free tier) or fail for other reasons — but NOT for format validation
    if (!result.success && result.validation_errors) {
      expect(result.validation_errors[0]).not.toContain("Invalid session_id format");
    }
  });

  it("accepts valid short ID (8 hex chars) as session_id", async () => {
    const result = await sessionClose({
      session_id: "393adb34",
      close_type: "quick",
    });

    // Should not fail with format validation error
    if (!result.success && result.validation_errors) {
      expect(result.validation_errors[0]).not.toContain("Invalid session_id format");
    }
  });

  it("accepts uppercase UUID", async () => {
    const result = await sessionClose({
      session_id: "393ADB34-A80C-4C3A-B71A-BC0053B7A7EA",
      close_type: "quick",
    });

    if (!result.success && result.validation_errors) {
      expect(result.validation_errors[0]).not.toContain("Invalid session_id format");
    }
  });

  it("rejects UUID with extra characters", async () => {
    const result = await sessionClose({
      session_id: "393adb34-a80c-4c3a-b71a-bc0053b7a7ea-extra",
      close_type: "quick",
    });

    expect(result.success).toBe(false);
    expect(result.validation_errors![0]).toContain("Invalid session_id format");
  });
});

describe("scars_applied string vs array handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not crash when scars_applied is prose string", async () => {
    const result = await sessionClose({
      session_id: "393adb34-a80c-4c3a-b71a-bc0053b7a7ea",
      close_type: "quick",
      closing_reflection: {
        what_broke: "Nothing",
        what_took_longer: "Tests",
        do_differently: "Plan better",
        what_worked: "Communication",
        wrong_assumption: "None",
        scars_applied: "Scar A — APPLIED. Scar B — N/A; Scar C — APPLIED",
      },
    });

    // Should not crash — that was the bug
    expect(result).toBeDefined();
  });

  it("does not crash when scars_applied is a single string without delimiters", async () => {
    const result = await sessionClose({
      session_id: "393adb34-a80c-4c3a-b71a-bc0053b7a7ea",
      close_type: "quick",
      closing_reflection: {
        what_broke: "Nothing",
        what_took_longer: "Tests",
        do_differently: "Plan better",
        what_worked: "Communication",
        wrong_assumption: "None",
        scars_applied: "Applied the Done != Deployed scar",
      },
    });

    expect(result).toBeDefined();
  });

  it("does not crash when scars_applied is an array", async () => {
    const result = await sessionClose({
      session_id: "393adb34-a80c-4c3a-b71a-bc0053b7a7ea",
      close_type: "quick",
      closing_reflection: {
        what_broke: "Nothing",
        what_took_longer: "Tests",
        do_differently: "Plan better",
        what_worked: "Communication",
        wrong_assumption: "None",
        scars_applied: ["scar-1", "scar-2"],
      },
    });

    expect(result).toBeDefined();
  });

  it("does not crash when scars_applied is undefined", async () => {
    const result = await sessionClose({
      session_id: "393adb34-a80c-4c3a-b71a-bc0053b7a7ea",
      close_type: "quick",
      closing_reflection: {
        what_broke: "Nothing",
        what_took_longer: "Tests",
        do_differently: "Plan better",
        what_worked: "Communication",
        wrong_assumption: "None",
      },
    });

    expect(result).toBeDefined();
  });
});

describe("OD-640: project parameter accepts arbitrary strings", () => {
  it("definitions.ts project fields have no enum restriction", async () => {
    // Import tool definitions and verify no project field has an enum
    const { TOOLS } = await import("../../../src/tools/definitions.js");

    for (const tool of TOOLS) {
      const projectProp = (tool.inputSchema.properties as Record<string, any>)?.project;
      if (projectProp) {
        expect(projectProp.enum).toBeUndefined();
        expect(projectProp.type).toBe("string");
      }
    }
  });

  it("ProjectSchema in common.ts accepts custom project names", async () => {
    const { ProjectSchema } = await import("../../../src/schemas/common.js");

    // Should accept any string
    expect(ProjectSchema.safeParse("my-custom-project").success).toBe(true);
    expect(ProjectSchema.safeParse("orchestra_dev").success).toBe(true);
    expect(ProjectSchema.safeParse("weekend_warrior").success).toBe(true);
    expect(ProjectSchema.safeParse("acme-corp-internal").success).toBe(true);
    expect(ProjectSchema.safeParse("test-project-123").success).toBe(true);
  });

  it("Project type in types/index.ts is string", async () => {
    // This is a compile-time check — if Project were a union type,
    // assigning an arbitrary string would fail at compile time.
    // At runtime, we verify the type export exists and is used as string.
    const types = await import("../../../src/types/index.js");
    // Project is a type alias — we can't inspect it at runtime,
    // but we can verify the schema accepts arbitrary strings
    const { ProjectSchema } = await import("../../../src/schemas/common.js");
    const result = ProjectSchema.safeParse("completely-new-project-name");
    expect(result.success).toBe(true);
  });
});

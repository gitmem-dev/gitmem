/**
 * Shared Supabase mock factory for pro/dev tier tests.
 *
 * Usage:
 *   import { SUPABASE_TIER_MOCKS, createMockSession } from "../../helpers/supabase-mocks.js";
 *
 *   // In your vi.mock("../../../src/services/tier.js", ...) block:
 *   vi.mock("../../../src/services/tier.js", () => SUPABASE_TIER_MOCKS);
 */

import { vi } from "vitest";

// ---------- Tier mocks (pro tier: Supabase enabled) ----------
export const SUPABASE_TIER_MOCKS = {
  hasSupabase: vi.fn(() => true),
  hasBatchOperations: vi.fn(() => true),
  hasTranscripts: vi.fn(() => false), // Avoid transcript capture complexity in most tests
  hasCacheManagement: vi.fn(() => true),
  hasVariants: vi.fn(() => true),
  hasCompliance: vi.fn(() => false),
  hasEmbeddings: vi.fn(() => true),
  hasMetrics: vi.fn(() => true),
  getTier: vi.fn(() => "pro" as const),
  resetTier: vi.fn(),
  hasAdvancedAgentDetection: vi.fn(() => false),
  hasMultiProject: vi.fn(() => false),
  hasEnforcementFields: vi.fn(() => false),
  getTablePrefix: vi.fn(() => "orchestra_"),
  getTableName: vi.fn((base: string) => `orchestra_${base}`),
};

// ---------- Factory: Supabase client mocks ----------
export function createSupabaseMocks(overrides?: {
  listRecords?: unknown;
  getRecord?: unknown;
  directUpsert?: unknown;
  directPatch?: unknown;
}) {
  return {
    listRecords: vi.fn().mockResolvedValue(overrides?.listRecords ?? []),
    getRecord: vi.fn().mockResolvedValue(overrides?.getRecord ?? null),
    directUpsert: vi.fn().mockResolvedValue(overrides?.directUpsert ?? undefined),
    directPatch: vi.fn().mockResolvedValue(overrides?.directPatch ?? undefined),
  };
}

// ---------- Factory: Mock session record ----------
export function createMockSession(overrides?: Partial<{
  id: string;
  agent: string;
  project: string;
  session_title: string;
  session_date: string;
  created_at: string;
  close_compliance: unknown;
  open_threads: unknown[];
  embedding: number[];
}>) {
  const now = new Date().toISOString();
  const today = now.split("T")[0];
  return {
    id: "393adb34-a80c-4c3a-b71a-bc0053b7a7ea",
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

// ---------- Common mock blocks (copy-paste into vi.mock) ----------
export const COMMON_SERVICE_MOCKS = {
  agentDetection: {
    detectAgent: () => ({ agent: "CLI", entrypoint: "cli", docker: true, hostname: "test" }),
  },
  embedding: {
    embed: vi.fn().mockResolvedValue(null),
    isEmbeddingAvailable: () => false,
  },
  storage: {
    getStorage: () => ({
      get: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(undefined),
    }),
  },
  sessionState: {
    clearCurrentSession: vi.fn(),
    getSurfacedScars: () => [],
    getObservations: () => [],
    getChildren: () => [],
    getThreads: () => [],
    getSessionActivity: () => null,
  },
  threadManager: {
    normalizeThreads: vi.fn().mockReturnValue([]),
    mergeThreadStates: vi.fn().mockReturnValue([]),
    migrateStringThread: vi.fn().mockReturnValue({
      id: "t-test",
      text: "test",
      status: "open",
      created_at: new Date().toISOString(),
    }),
    saveThreadsFile: vi.fn(),
  },
  threadDedup: {
    deduplicateThreadList: vi.fn().mockImplementation((threads: unknown[]) => threads),
  },
  threadSupabase: {
    syncThreadsToSupabase: vi.fn().mockResolvedValue(undefined),
    loadOpenThreadEmbeddings: vi.fn().mockResolvedValue([]),
  },
  complianceValidator: {
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
  },
  metrics: {
    Timer: class { stop() { return 100; } },
    recordMetrics: vi.fn().mockResolvedValue(undefined),
    buildPerformanceData: (_name: string, latency: number, count: number) => ({
      latency_ms: latency,
      target_ms: 3000,
      meets_target: latency < 3000,
      result_count: count,
    }),
    updateRelevanceData: vi.fn().mockResolvedValue(undefined),
  },
  scarUsageBatch: {
    recordScarUsageBatch: vi.fn().mockResolvedValue({ success: true }),
  },
  effectTracker: {
    getEffectTracker: () => ({
      track: vi.fn(),
      formatSummary: () => "No tracked effects this session.",
    }),
  },
  saveTranscript: {
    saveTranscript: vi.fn().mockResolvedValue({ success: false }),
  },
  transcriptChunker: {
    processTranscript: vi.fn().mockResolvedValue({ success: false }),
  },
  gitmemDir: {
    getGitmemPath: (filename: string) => `/tmp/.gitmem/${filename}`,
    getGitmemDir: () => "/tmp/.gitmem",
    getSessionPath: (sid: string, filename: string) => `/tmp/.gitmem/sessions/${sid}/${filename}`,
  },
  activeSessions: {
    unregisterSession: vi.fn(),
    findSessionByHostPid: vi.fn().mockReturnValue(null),
  },
  threadSuggestions: {
    loadSuggestions: vi.fn().mockReturnValue([]),
    saveSuggestions: vi.fn(),
    detectSuggestedThreads: vi.fn().mockReturnValue([]),
    loadRecentSessionEmbeddings: vi.fn().mockResolvedValue(null),
  },
};

/**
 * GIT-89: recall and confirm_scars must fail together.
 *
 * recall used to return scars under a soft "No active session" banner while
 * silently dropping them from tracking; confirm_scars hard-rejected the same
 * condition, and a later confirm reported "no scars to confirm" — green output
 * for scars that had just been discarded (scar 810a1624). Nothing in recall's
 * response let an agent tell a tracked recall from an untracked one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { recall } from "../../../src/tools/recall.js";
import * as supabase from "../../../src/services/supabase-client.js";
import { setGitmemDir, clearGitmemDirCache } from "../../../src/services/gitmem-dir.js";
import { setCurrentSession, clearCurrentSession } from "../../../src/services/session-state.js";

// Plain functions, not vi.fn().mockReturnValue(...). vi.mock factories are
// hoisted above the imports, and a mockReturnValue chained inside one resolves
// to undefined at call time — which silently drops recall onto its free-tier
// branch instead of the Supabase branch these tests stage.
vi.mock("../../../src/services/tier.js", () => ({
  getTier: () => "pro",
  hasSupabase: () => true,
  hasVariants: () => false,
  hasMetrics: () => false,
  hasCacheManagement: () => true,
  hasCompliance: () => false,
  hasTranscripts: () => false,
  hasBatchOperations: () => false,
  hasEmbeddings: () => true,
  hasAdvancedAgentDetection: () => false,
  hasMultiProject: () => false,
  hasEnforcementFields: () => false,
  hasProInsights: () => false,
  getTablePrefix: () => "gitmem_",
  getTableName: (base: string) => `gitmem_${base}`,
}));

vi.mock("../../../src/services/supabase-client.js", () => ({
  isConfigured: vi.fn(),
  cachedScarSearch: vi.fn(),
  upsertRecord: async () => undefined,
  directUpsert: async () => undefined,
  fetchRelatedTriples: async () => new Map(),
}));

// Force the Supabase branch. Otherwise recall prefers the local vector cache,
// whose results are not what these tests are staging.
vi.mock("../../../src/services/local-vector-search.js", () => ({
  isLocalSearchReady: () => false,
  localScarSearch: async () => [],
}));

const ONE_SCAR = {
  results: [
    {
      id: "test-scar-1",
      title: "Test Scar",
      description: "This is a test scar about deployment",
      severity: "high",
      counter_arguments: ["You might think it's easy"],
      applies_when: ["deploying"],
      similarity: 0.85,
    },
  ],
  cache_hit: false,
};

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-git89-recall-"));
  setGitmemDir(tmpDir);
  clearCurrentSession();
});

afterEach(() => {
  clearCurrentSession();
  clearGitmemDirCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a session.json as session_start would. */
function seedSession(sessionId: string, overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(tmpDir, "sessions", sessionId), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "sessions", sessionId, "session.json"),
    JSON.stringify({
      session_id: sessionId,
      agent: "cli",
      started_at: new Date().toISOString(),
      hostname: os.hostname(),
      pid: process.pid,
      project: "orchestra_dev",
      surfaced_scars: [],
      ...overrides,
    })
  );
}

describe("recall surfacing-tracked signal (GIT-89)", () => {
  it("warns that surfacing was not tracked when there is no session", async () => {
    vi.mocked(supabase.isConfigured).mockReturnValue(true);
    vi.mocked(supabase.cachedScarSearch).mockResolvedValue(ONE_SCAR);

    const result = await recall({ plan: "deploy to production" });

    expect(result.scars).toHaveLength(1);
    expect(result.formatted_response).toContain("SURFACING NOT TRACKED");
    expect(result.formatted_response).toContain("confirm_scars will reject them");
  });

  it("stays silent when the scars were tracked", async () => {
    // Zero token cost on the healthy path — the notice marks the broken case,
    // it does not decorate every recall (scar 55dd6d73: audit payload weight).
    vi.mocked(supabase.isConfigured).mockReturnValue(true);
    vi.mocked(supabase.cachedScarSearch).mockResolvedValue(ONE_SCAR);

    const sessionId = "11111111-1111-1111-1111-111111111111";
    seedSession(sessionId);
    setCurrentSession({ sessionId, project: "orchestra_dev", startedAt: new Date() });

    const result = await recall({ plan: "deploy to production" });

    expect(result.scars).toHaveLength(1);
    expect(result.formatted_response).not.toContain("SURFACING NOT TRACKED");
  });

  it("stays silent when the session was recovered after an MCP restart", async () => {
    // The production shape: in-memory state died with the old process, the
    // session file is intact, and identity resolves from disk. Surfacing is
    // tracked, so there is nothing to warn about.
    vi.mocked(supabase.isConfigured).mockReturnValue(true);
    vi.mocked(supabase.cachedScarSearch).mockResolvedValue(ONE_SCAR);

    seedSession("22222222-2222-2222-2222-222222222222", { pid: 99999999 });

    const result = await recall({ plan: "deploy to production" });

    expect(result.formatted_response).not.toContain("SURFACING NOT TRACKED");
  });

  it("persists the surfaced scars to the session file", async () => {
    vi.mocked(supabase.isConfigured).mockReturnValue(true);
    vi.mocked(supabase.cachedScarSearch).mockResolvedValue(ONE_SCAR);

    const sessionId = "33333333-3333-3333-3333-333333333333";
    seedSession(sessionId);
    setCurrentSession({ sessionId, project: "orchestra_dev", startedAt: new Date() });

    await recall({ plan: "deploy to production" });

    const data = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "sessions", sessionId, "session.json"), "utf-8")
    );
    expect(data.surfaced_scars).toHaveLength(1);
    expect(data.surfaced_scars[0].scar_id).toBe("test-scar-1");
  });

  it("does not warn when there were no scars to surface", async () => {
    // Nothing was discarded, so there is nothing to warn about.
    vi.mocked(supabase.isConfigured).mockReturnValue(true);
    vi.mocked(supabase.cachedScarSearch).mockResolvedValue({ results: [], cache_hit: false });

    const result = await recall({ plan: "unique task with no history" });

    expect(result.formatted_response).not.toContain("SURFACING NOT TRACKED");
  });
});

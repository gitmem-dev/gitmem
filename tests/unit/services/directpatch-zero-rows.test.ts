/**
 * GIT-119: a PATCH that matched no row is not a write.
 *
 * PostgREST answers 200 with [] when a PATCH's filter matches nothing (a wrong
 * id, a row not created yet, RLS). directPatch returned that array and all 8
 * callers ignored it, so each reported or assumed success for a write that did
 * not happen. directPatch now returns { count, rows } and every caller treats
 * count 0 as not durable, each in the way its result can carry it.
 *
 * One parameterized test over all 8 callers. The store is stubbed at fetch:
 * every PATCH answers 200 [], every GET answers the rows the caller needs to
 * reach its PATCH.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const env = vi.hoisted(() => {
  const keys = ["GITMEM_TIER", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GITMEM_DIR"];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const dir = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "gitmem-git119-"));
  Object.assign(process.env, {
    GITMEM_TIER: "pro",
    SUPABASE_URL: "https://stubbed.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "stub",
    GITMEM_DIR: dir,
  });
  return { before, dir };
});

import { resetTier } from "../../../src/services/tier.js";
import { archiveLearning } from "../../../src/tools/archive-learning.js";
import { saveSessionEmbedding } from "../../../src/tools/session-close.js";
import { markSessionSuperseded } from "../../../src/tools/session-start.js";
import { resolveThreadInSupabase, touchThreadsInSupabase, archiveDormantThreads } from "../../../src/services/thread-supabase.js";
import { updateRelevanceData } from "../../../src/services/metrics.js";
import { saveTranscript } from "../../../src/services/supabase-client.js";
import { getEffectTracker } from "../../../src/services/effect-tracker.js";

const UUID = "a501c95e-1234-4678-9abc-def012345678";
const SCAR = "b1111111-2222-4333-8444-555555555555";
const patches: string[] = [];

/** Rows a GET returns, by table, so each caller reaches its PATCH. */
function getRows(url: URL): unknown[] {
  const table = url.pathname.split("/").pop() ?? "";
  if (url.searchParams.get("limit") === "1" && url.searchParams.get("select") === "archived_at") return [{ archived_at: null }]; // column probe
  if (table.endsWith("sessions")) return [{ close_compliance: null }];
  if (table.endsWith("threads")) {
    if (url.searchParams.get("status") === "eq.dormant") {
      return [{ id: UUID, thread_id: "t-dormant", metadata: { dormant_since: new Date(Date.now() - 60 * 86400_000).toISOString() } }];
    }
    return [{ id: UUID, thread_id: "t-x", touch_count: 1, created_at: new Date().toISOString(), thread_class: "backlog", status: "active" }];
  }
  if (table === "gitmem_query_metrics") return [{ id: UUID, memories_surfaced: [SCAR], metadata: {} }];
  return [];
}

beforeAll(() => {
  resetTier();
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = method === "PATCH" ? (patches.push(url.pathname), []) : method === "GET" ? getRows(url) : { Key: "ok" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
});

afterAll(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(env.before)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  resetTier();
  require("fs").rmSync(env.dir, { recursive: true, force: true });
});

beforeEach(() => { patches.length = 0; });

/** A background write's failure is visible in stderr or the effect tracker. */
const errorsLogged = () => (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c.join(" ")).join("\n");
const trackerFailures = (path: string) => getEffectTracker().getHealthReport().byPath[path]?.failed ?? 0;

type Case = { caller: string; run: () => Promise<void> };

const CASES: Case[] = [
  { caller: "archive_learning (full UUID)", run: async () => {
    const r = await archiveLearning({ id: UUID });
    expect(r.success).toBe(false);
    expect(r.durable).toBe(false);
  } },
  { caller: "session_close: session embedding", run: async () => {
    await expect(saveSessionEmbedding(UUID, "[0.1]")).rejects.toThrow(/updated no row/);
  } },
  { caller: "session_start: mark superseded", run: async () => {
    await markSessionSuperseded(UUID, SCAR);
    expect(errorsLogged()).toMatch(/Failed to mark session .* superseded[\s\S]*no session row/);
  } },
  { caller: "thread resolve", run: async () => {
    expect(await resolveThreadInSupabase("t-x")).toBe(false);
  } },
  { caller: "thread touch", run: async () => {
    await touchThreadsInSupabase(["t-x"]);
    expect(errorsLogged()).toMatch(/Failed to touch thread t-x[\s\S]*updated no row/);
  } },
  { caller: "thread auto-archive", run: async () => {
    const r = await archiveDormantThreads("default", 30);
    expect(r.archived_count).toBe(0);
    expect(r.archived_ids).toEqual([]);
  } },
  { caller: "relevance update (metrics)", run: async () => {
    const before = trackerFailures("relevance_update");
    await updateRelevanceData(UUID, [SCAR], { [SCAR]: "high" });
    expect(trackerFailures("relevance_update")).toBe(before + 1);
  } },
  { caller: "saveTranscript: transcript_path", run: async () => {
    const r = await saveTranscript(UUID, "hello");
    expect(r.patch_warning).toMatch(/no session row/);
  } },
];

describe("GIT-119: every directPatch caller treats 0 rows as not durable", () => {
  it("covers all 8 callers", () => {
    expect(CASES).toHaveLength(8);
  });

  it.each(CASES)("$caller", async ({ run }) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await run();
    expect(patches.length).toBeGreaterThan(0); // the PATCH was really sent
    vi.restoreAllMocks();
  });
});

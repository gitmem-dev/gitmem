/**
 * GIT-143: confirm_scars in one chat demanded scars recalled by another.
 *
 * One gitmem server served every chat in the Claude desktop app. The process
 * has one current session (the last session_start), so every chat's recall()
 * landed in that session's list. On 2026-11-22 a gitmem Brain chat recalled 4
 * scars, confirmed 4, and was rejected on 5 Weekend Warrior scars another chat
 * had recalled; its own 4 had been written into the Weekend Warrior session.
 *
 * Real recall() and confirm_scars() over a real session store in a temp dir.
 * Only the scar search is staged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { recall } from "../../../src/tools/recall.js";
import { confirmScars } from "../../../src/tools/confirm-scars.js";
import * as supabase from "../../../src/services/supabase-client.js";
import { setGitmemDir, clearGitmemDirCache } from "../../../src/services/gitmem-dir.js";
import {
  setCurrentSession,
  clearCurrentSession,
  getSurfacedScars,
  hasUnconfirmedScars,
} from "../../../src/services/session-state.js";
import { resolveCallerSessionId, sameSessionId, ownerOf } from "../../../src/services/scar-ownership.js";
import { resetProcessIdentityForTests } from "../../../src/services/process-identity.js";

vi.mock("../../../src/services/tier.js", () => ({
  getTier: () => "pro",
  hasSupabase: () => true,
  hasVariants: () => false,
  hasMetrics: () => false,
  hasCacheManagement: () => true,
  hasTranscripts: () => false,
  hasBatchOperations: () => false,
  hasEmbeddings: () => true,
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

vi.mock("../../../src/services/local-vector-search.js", () => ({
  isLocalSearchReady: () => false,
  localScarSearch: async () => [],
}));

// The server's current session: the Weekend Warrior chat started last.
const WW = "a36541ed-0000-4000-8000-000000000001";
// The gitmem chat, served by the same process.
const GM = "8e6e6407-6df0-4ac6-963b-5efbdb304f21";

const scarRow = (id: string, title: string) => ({
  id,
  title,
  description: `${title} — description`,
  severity: "high",
  counter_arguments: ["You might think otherwise"],
  applies_when: ["always"],
  similarity: 0.9,
});
const KELL = scarRow("4650131b-0000-4000-8000-000000000001", "Kell cycle exit");
const MS1 = scarRow("d213d180-0000-4000-8000-000000000002", "MS-1 whole system");
const LICENCE = scarRow("eecb8728-0000-4000-8000-000000000003", "Licence admin CLI already exists");
const SHARED = scarRow("a16f7782-0000-4000-8000-000000000004", "Cloud Brain sessions get no gitmem hooks");

const EVIDENCE = "Compared the scenario in this scar with the current task; it does not apply to this work.";
const na = (id: string) => ({ scar_id: id, decision: "N_A" as const, evidence: EVIDENCE });

let tmpDir: string;

function seedSession(sessionId: string, project: string): void {
  fs.mkdirSync(path.join(tmpDir, "sessions", sessionId), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "sessions", sessionId, "session.json"),
    JSON.stringify({
      session_id: sessionId,
      agent: "cloud",
      started_at: new Date().toISOString(),
      hostname: os.hostname(),
      pid: process.pid,
      project,
      surfaced_scars: [],
    }),
  );
}

function sessionFile(sessionId: string) {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, "sessions", sessionId, "session.json"), "utf8"));
}

/** Stage what the next recall() search returns. */
function nextSearch(...rows: ReturnType<typeof scarRow>[]) {
  vi.mocked(supabase.cachedScarSearch).mockResolvedValueOnce({ results: rows, cache_hit: false } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset, not just clear: a staged result a test never consumed must not
  // leak into the next test's recall.
  vi.mocked(supabase.cachedScarSearch).mockReset();
  vi.mocked(supabase.isConfigured).mockReturnValue(true);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-git143-"));
  setGitmemDir(tmpDir);
  clearCurrentSession();
  resetProcessIdentityForTests();
  seedSession(GM, "gitmem");
  seedSession(WW, "weekend_warrior");
  // The WW chat ran session_start last, so it is this process's current session.
  setCurrentSession({ sessionId: WW, agent: "cloud", project: "weekend_warrior", startedAt: new Date() });
});

afterEach(() => {
  clearCurrentSession();
  clearGitmemDirCache();
  resetProcessIdentityForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GIT-143: recall records which session recalled each scar", () => {
  it("stamps scars with the caller's session id when it passes one", async () => {
    nextSearch(LICENCE);
    await recall({ plan: "licence work", gitmem_session_id: GM });

    const [entry] = getSurfacedScars();
    expect(entry.session_id).toBe(GM);
    expect(sessionFile(WW).surfaced_scars[0].session_id).toBe(GM);
  });

  it("stamps scars with the process's current session when no id is passed", async () => {
    nextSearch(KELL);
    await recall({ plan: "study work" });
    expect(getSurfacedScars()[0].session_id).toBe(WW);
  });

  it("expands a short id to the current session's full id", async () => {
    nextSearch(KELL);
    await recall({ plan: "study work", session_id: WW.slice(0, 8) });
    expect(getSurfacedScars()[0].session_id).toBe(WW);
  });

  it("refuses two different ids and records nothing", async () => {
    const result = await recall({ plan: "x", session_id: WW, gitmem_session_id: GM });
    expect(result.formatted_response).toContain("name different sessions");
    expect(result.scars).toHaveLength(0);
    expect(getSurfacedScars()).toHaveLength(0);
    expect(supabase.cachedScarSearch).not.toHaveBeenCalled();
  });

  it("keeps one entry per session when two sessions recall the same scar", async () => {
    nextSearch(SHARED);
    await recall({ plan: "a" });
    nextSearch(SHARED);
    await recall({ plan: "b", gitmem_session_id: GM });

    const entries = getSurfacedScars().filter((s) => s.scar_id === SHARED.id);
    expect(entries.map((s) => s.session_id).sort()).toEqual([GM, WW].sort());
  });
});

describe("GIT-143: the 2026-11-22 sequence", () => {
  async function replay() {
    // WW chat recalls its study scars (no id, as Brain does today).
    nextSearch(KELL, MS1);
    await recall({ plan: "study cycle exits" });
    // gitmem chat recalls under its own id; the server writes into WW's list.
    nextSearch(LICENCE);
    await recall({ plan: "licence check", gitmem_session_id: GM });
  }

  it("accepts the gitmem chat confirming only its own scar", async () => {
    await replay();
    const result = await confirmScars({ confirmations: [na(LICENCE.id)], gitmem_session_id: GM });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.missing_scars).toEqual([]);
    expect(result.confirmations.map((c) => c.session_id)).toEqual([GM]);
  });

  it("does not let the gitmem chat clear the WW chat's scars", async () => {
    await replay();
    const result = await confirmScars({
      confirmations: [na(LICENCE.id), na(KELL.id)],
      gitmem_session_id: GM,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("Kell cycle exit: recalled by session a36541ed, not by session 8e6e6407");
    // Nothing recorded, so WW's gate is untouched.
    expect(sessionFile(WW).confirmations ?? []).toEqual([]);
    expect(hasUnconfirmedScars()).toBe(true);
  });

  it("holds the WW chat to its own scars when it names its session", async () => {
    await replay();
    const result = await confirmScars({ confirmations: [na(KELL.id), na(MS1.id)], session_id: WW });
    expect(result.valid).toBe(true);
  });

  it("gate clears only when each session has confirmed its own", async () => {
    await replay();
    await confirmScars({ confirmations: [na(LICENCE.id)], gitmem_session_id: GM });
    expect(hasUnconfirmedScars()).toBe(true); // WW's two are still open

    await confirmScars({ confirmations: [na(KELL.id), na(MS1.id)], session_id: WW });
    expect(hasUnconfirmedScars()).toBe(false);
  });

  it("without an id, keeps asking for every scar and names whose each one is", async () => {
    await replay();
    const result = await confirmScars({ confirmations: [na(KELL.id), na(MS1.id)] });
    expect(result.valid).toBe(false);
    expect(result.missing_scars).toEqual([LICENCE.title]);
    expect(result.formatted_response).toContain(`${LICENCE.title} (recalled by session 8e6e6407)`);
    expect(result.formatted_response).toContain("pass your session id as gitmem_session_id");
  });

  it("marks the caller's own pending scars as this session's", async () => {
    await replay();
    const result = await confirmScars({ confirmations: [na(KELL.id)], session_id: WW });
    expect(result.valid).toBe(false);
    expect(result.formatted_response).toContain(`${MS1.title} (recalled by session a36541ed, this session)`);
    expect(result.formatted_response).not.toContain(LICENCE.title);
  });
});

describe("GIT-143: same scar recalled by two sessions", () => {
  it("one session confirming it does not clear the other's entry", async () => {
    nextSearch(SHARED);
    await recall({ plan: "a" });
    nextSearch(SHARED);
    await recall({ plan: "b", gitmem_session_id: GM });

    const gm = await confirmScars({ confirmations: [na(SHARED.id)], gitmem_session_id: GM });
    expect(gm.valid).toBe(true);
    expect(hasUnconfirmedScars()).toBe(true);

    // WW is still asked for it, and is not credited with GM's confirmation.
    const wwEmpty = await confirmScars({ confirmations: [], session_id: WW });
    expect(wwEmpty.valid).toBe(false);
    expect(wwEmpty.missing_scars).toEqual([SHARED.title]);
  });

  it("without an id, one confirmation covers every entry for that scar", async () => {
    nextSearch(SHARED);
    await recall({ plan: "a" });
    nextSearch(SHARED);
    await recall({ plan: "b", gitmem_session_id: GM });

    const result = await confirmScars({ confirmations: [na(SHARED.id)] });
    expect(result.valid).toBe(true);
    expect(result.confirmations.map((c) => c.session_id).sort()).toEqual([GM, WW].sort());
    expect(result.formatted_response.match(/Cloud Brain sessions get no gitmem hooks/g)).toHaveLength(1);
    expect(hasUnconfirmedScars()).toBe(false);
  });
});

describe("GIT-143: refusals and edge cases", () => {
  it("refuses a session id this server does not know", async () => {
    nextSearch(KELL);
    await recall({ plan: "x" });
    const result = await confirmScars({ confirmations: [], gitmem_session_id: "deadbeef-0000-4000-8000-000000000000" });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("is not known to this gitmem server");
  });

  it("refuses two different ids", async () => {
    const result = await confirmScars({ confirmations: [], session_id: WW, gitmem_session_id: GM });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("name different sessions");
  });

  it("says when a named session has none but other sessions do", async () => {
    nextSearch(LICENCE);
    await recall({ plan: "licence", gitmem_session_id: GM });
    const result = await confirmScars({ confirmations: [], session_id: WW });
    expect(result.valid).toBe(true);
    expect(result.formatted_response).toContain("None were recalled by session a36541ed");
    expect(result.formatted_response).toContain("8e6e6407");
  });

  it("treats entries written before GIT-143 as the holding session's own", async () => {
    // A scar recorded by an older server: no session_id stamp.
    const file = path.join(tmpDir, "sessions", WW, "session.json");
    const data = sessionFile(WW);
    data.surfaced_scars = [{
      scar_id: KELL.id, scar_title: KELL.title, scar_severity: "high",
      surfaced_at: new Date().toISOString(), source: "recall",
    }];
    fs.writeFileSync(file, JSON.stringify(data));
    clearCurrentSession();
    setCurrentSession({ sessionId: WW, agent: "cloud", project: "weekend_warrior", startedAt: new Date() });

    const asWw = await confirmScars({ confirmations: [], session_id: WW });
    expect(asWw.missing_scars).toEqual([KELL.title]);
    expect(hasUnconfirmedScars()).toBe(true);

    const confirmed = await confirmScars({ confirmations: [na(KELL.id)], session_id: WW });
    expect(confirmed.valid).toBe(true);
    expect(hasUnconfirmedScars()).toBe(false);
  });
});

describe("GIT-143: scar-ownership helpers", () => {
  it("matches full and short ids either way round, ignoring case", () => {
    expect(sameSessionId(GM, GM.toUpperCase())).toBe(true);
    expect(sameSessionId("8e6e6407", GM)).toBe(true);
    expect(sameSessionId(GM, "8e6e6407")).toBe(true);
    expect(sameSessionId("8e6e6408", GM)).toBe(false);
  });

  it("resolves the alias, rejects bad shapes, and prefers the full id", () => {
    expect(resolveCallerSessionId({})).toEqual({ ok: true });
    expect(resolveCallerSessionId({ gitmem_session_id: GM })).toEqual({ ok: true, id: GM });
    expect(resolveCallerSessionId({ session_id: "8e6e6407", gitmem_session_id: GM })).toEqual({ ok: true, id: GM });
    expect(resolveCallerSessionId({ session_id: "../etc" }).ok).toBe(false);
  });

  it("gives an unstamped entry to its holder", () => {
    expect(ownerOf({}, WW)).toBe(WW);
    expect(ownerOf({ session_id: GM }, WW)).toBe(GM);
  });
});

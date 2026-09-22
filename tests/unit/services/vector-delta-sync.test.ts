/**
 * GIT-98: per-row delta sync.
 *
 * A fingerprint miss used to cost the whole index. On a Pro store it misses on
 * nearly every session_start, because refresh_scar_behavioral_scores() bumps
 * updated_at on every scar with enough recent usage. Now a miss with a cache
 * from this store downloads the manifest (id, updated_at) and only the rows
 * whose updated_at moved.
 *
 * Real filesystem cache, isolated GITMEM_DIR; the store is mocked at the
 * supabase-client boundary so each call can be counted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const store = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; title: string; updated_at: string; embedding: number[] }>,
  manifestFails: false,
  calls: { fingerprint: 0, manifest: 0, byIds: [] as string[][], bulk: 0 },
}));

const active = () => [...store.rows].sort((a, b) => b.updated_at.localeCompare(a.updated_at));

vi.mock("../../../src/services/supabase-client.js", () => ({
  isConfigured: () => true,
  getSupabaseUrl: () => "https://venue.example.supabase.co",
  getLearningsFingerprint: vi.fn(async () => {
    store.calls.fingerprint++;
    const rows = active();
    return { count: rows.length, latestUpdatedAt: rows[0]?.updated_at ?? null };
  }),
  loadLearningsManifest: vi.fn(async () => {
    store.calls.manifest++;
    if (store.manifestFails) throw new Error("manifest 500");
    return active().map(({ id, updated_at }) => ({ id, updated_at }));
  }),
  loadLearningsByIds: vi.fn(async (ids: string[]) => {
    store.calls.byIds.push(ids);
    return active().filter((r) => ids.includes(r.id)).map((r) => ({ ...r }));
  }),
  loadScarsWithEmbeddings: vi.fn(async () => {
    store.calls.bulk++;
    return active().map((r) => ({ ...r }));
  }),
}));

import { loadScarsFromSupabase } from "../../../src/services/startup.js";
import { planDelta, assembleDelta } from "../../../src/services/vector-disk-cache.js";

let dir: string;
const ts = (n: number) => new Date(Date.UTC(2026, 8, 21, 0, 0, n)).toISOString();
const vec = (i: number) => Array.from({ length: 8 }, (_, k) => i + k / 10);

function seed(n: number) {
  store.rows = Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(3, "0")}`, title: `t${i}`, updated_at: ts(i), embedding: vec(i) }));
}
/** What refresh_scar_behavioral_scores() does to a scar: new score, new updated_at. */
function rewrite(ids: string[], at: number) {
  for (const r of store.rows) if (ids.includes(r.id)) { r.updated_at = ts(at); r.title = `${r.title}*`; r.embedding = vec(1000 + at); }
}
const resetCalls = () => { store.calls = { fingerprint: 0, manifest: 0, byIds: [], bulk: 0 }; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-vdelta-"));
  vi.stubEnv("GITMEM_DIR", dir);
  vi.stubEnv("GITMEM_VECTOR_DISK_CACHE", "");
  store.manifestFails = false;
  seed(250);
  resetCalls();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("planDelta / assembleDelta", () => {
  const cached = [
    { id: "a", updated_at: "1", v: "a-old" },
    { id: "b", updated_at: "1", v: "b-old" },
    { id: "gone", updated_at: "1", v: "gone" },
    { id: "no-ts", v: "no-ts" },
  ];
  const manifest = [
    { id: "new", updated_at: "3" },
    { id: "b", updated_at: "2" },
    { id: "a", updated_at: "1" },
    { id: "no-ts", updated_at: "1" },
  ];

  it("reuses only id+updated_at matches, fetches changed, new and timestamp-less rows, counts dropped ones", () => {
    const plan = planDelta(cached as never[], manifest);
    expect([...plan.reuse.keys()]).toEqual(["a"]);
    expect(plan.fetchIds).toEqual(["new", "b", "no-ts"]);
    expect(plan.dropped).toBe(1);
  });

  it("assembles in manifest order and omits ids that vanished before the fetch", () => {
    const plan = planDelta(cached as never[], manifest);
    const rows = assembleDelta(manifest, plan, [{ id: "b", v: "b-new" }, { id: "no-ts", v: "no-ts-new" }] as never[]);
    expect(rows.map((r: { v: string }) => r.v)).toEqual(["b-new", "a-old", "no-ts-new"]);
  });
});

describe("loadScarsFromSupabase delta sync (GIT-98)", () => {
  it("cold start: one full download, then a warm start costs only the fingerprint", async () => {
    const cold = await loadScarsFromSupabase();
    expect(cold.scars).toHaveLength(250);
    expect(store.calls.bulk).toBe(1);

    resetCalls();
    const warm = await loadScarsFromSupabase();
    expect(warm.source).toBe("disk");
    expect(store.calls).toEqual({ fingerprint: 1, manifest: 0, byIds: [], bulk: 0 });
  });

  it("5 rows rewritten: fetches exactly those 5 vectors, not 250, and matches a full download", async () => {
    await loadScarsFromSupabase();
    const changed = ["id-007", "id-042", "id-099", "id-150", "id-249"];
    rewrite(changed, 5000);
    resetCalls();

    const synced = await loadScarsFromSupabase();

    expect(store.calls.bulk).toBe(0);
    expect(store.calls.manifest).toBe(1);
    expect(store.calls.byIds.flat().sort()).toEqual([...changed].sort());
    // Identical to what a full download would have returned, order included.
    expect(synced.scars).toEqual(active());
    expect(synced.latestUpdatedAt).toBe(ts(5000));

    // The rewritten cache serves the next start from disk.
    resetCalls();
    expect((await loadScarsFromSupabase()).source).toBe("disk");
    expect(store.calls.byIds).toEqual([]);
  });

  it("inserts and deactivations: fetches the new row, drops the gone one", async () => {
    await loadScarsFromSupabase();
    store.rows = store.rows.filter((r) => r.id !== "id-010");
    store.rows.push({ id: "id-new", title: "fresh", updated_at: ts(6000), embedding: vec(6000) });
    resetCalls();

    const synced = await loadScarsFromSupabase();
    expect(store.calls.bulk).toBe(0);
    expect(store.calls.byIds.flat()).toEqual(["id-new"]);
    expect(synced.scars.map((r) => r.id)).toEqual(active().map((r) => r.id));
    expect(synced.scars.some((r) => r.id === "id-010")).toBe(false);
  });

  it("a failed manifest falls back to the full download", async () => {
    await loadScarsFromSupabase();
    rewrite(["id-001"], 7000);
    store.manifestFails = true;
    resetCalls();

    const loaded = await loadScarsFromSupabase();
    expect(store.calls.bulk).toBe(1);
    expect(loaded.scars).toEqual(active());
  });

  it("cache-flush (bypassDiskCache) always takes the full download", async () => {
    await loadScarsFromSupabase();
    rewrite(["id-001"], 8000);
    resetCalls();

    await loadScarsFromSupabase({ bypassDiskCache: true });
    expect(store.calls.manifest).toBe(0);
    expect(store.calls.bulk).toBe(1);
  });

  it("no cache from this store: full download, no manifest", async () => {
    const loaded = await loadScarsFromSupabase();
    expect(store.calls.manifest).toBe(0);
    expect(store.calls.bulk).toBe(1);
    expect(loaded.scars).toHaveLength(250);
  });
});

/**
 * GIT-118: a failed load never empties recall.
 *
 * loadScarsFromSupabase returned [] on any error with no flag, and every
 * caller reinitialised the index and overwrote the hooks' scar cache with it.
 * create_learning triggers a reload after every write, so one failed request
 * emptied recall — and reported success — until the next good load, which a
 * failed init never retried.
 *
 * Store mocked at the supabase-client boundary; the disk vector cache, the
 * local index and the hook cache are real (temp GITMEM_DIR). Each test gets a
 * fresh module graph, i.e. a fresh process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const store = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; title: string; description: string; severity: string; learning_type: string; updated_at: string; embedding: number[] }>,
  down: false,
  calls: { bulk: 0, manifest: 0 },
}));
const active = () => [...store.rows].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
const fail = () => { throw new TypeError("fetch failed: ECONNRESET"); };

vi.mock("../../../src/services/supabase-client.js", () => ({
  isConfigured: () => true,
  getSupabaseUrl: () => "https://venue.example.supabase.co",
  getLearningsFingerprint: vi.fn(async () => {
    if (store.down) return { count: -1, latestUpdatedAt: null }; // the real one's failure shape
    const r = active();
    return { count: r.length, latestUpdatedAt: r[0]?.updated_at ?? null };
  }),
  loadLearningsManifest: vi.fn(async () => { store.calls.manifest++; if (store.down) fail(); return active().map(({ id, updated_at }) => ({ id, updated_at })); }),
  loadLearningsByIds: vi.fn(async (ids: string[]) => { if (store.down) fail(); return active().filter((r) => ids.includes(r.id)); }),
  loadScarsWithEmbeddings: vi.fn(async () => { store.calls.bulk++; if (store.down) fail(); return active().map((r) => ({ ...r })); }),
  directQuery: vi.fn(async () => []),
}));

let dir: string;
const ts = (n: number) => new Date(Date.UTC(2026, 8, 21, 0, 0, n)).toISOString();
const vec = (i: number) => Array.from({ length: 1536 }, (_, k) => Math.sin(i + k)); // the index keeps only 1536-dim rows
const seed = (n: number, at = 0) => {
  store.rows = Array.from({ length: n }, (_, i) => ({
    id: `id-${String(i).padStart(3, "0")}`, title: `scar ${i}`, description: "d", severity: "medium",
    learning_type: "scar", updated_at: ts(at + i), embedding: vec(i),
  }));
};
const hookCache = () => JSON.parse(fs.readFileSync(path.join(dir, "cache", "hook-scars.json"), "utf-8"));

async function freshProcess() {
  vi.resetModules();
  const startup = await import("../../../src/services/startup.js");
  const lvs = await import("../../../src/services/local-vector-search.js");
  return { startup, count: () => lvs.getLocalVectorSearch().getScarCount() };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-git118-"));
  vi.stubEnv("GITMEM_DIR", dir);
  vi.stubEnv("GITMEM_TIER", "pro");
  vi.stubEnv("SUPABASE_URL", "https://venue.example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
  vi.stubEnv("GITMEM_SEARCH_MODE", "local");
  vi.stubEnv("GITMEM_VECTOR_DISK_CACHE", "");
  store.down = false;
  store.calls = { bulk: 0, manifest: 0 };
  seed(20);
});

afterEach(async () => {
  const { resetReloadRetry } = await import("../../../src/services/startup.js");
  resetReloadRetry?.();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("GIT-118: a failed reload keeps what recall has", () => {
  it("flush with the store down: success false, index and hook cache kept", async () => {
    const { startup, count } = await freshProcess();
    expect((await startup.initializeGitMem()).success).toBe(true);
    expect(count()).toBe(20);
    expect(hookCache()).toHaveLength(20);

    store.down = true;
    const r = await startup.flushCache();

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/ECONNRESET/);
    expect(count()).toBe(20);
    expect(hookCache()).toHaveLength(20);
  });

  it("the post-write refresh uses the per-row delta, not a full download", async () => {
    const { startup } = await freshProcess();
    await startup.initializeGitMem();
    store.calls = { bulk: 0, manifest: 0 };
    store.rows.push({ ...store.rows[0], id: "id-new", updated_at: ts(999) });

    const r = await startup.refreshIndexAfterWrite();
    expect(r.success).toBe(true);
    expect(r.new_scar_count).toBe(21);
    expect(store.calls).toEqual({ bulk: 0, manifest: 1 });
  });

  it("cold start with the store down serves the disk cache (stale) and says it failed", async () => {
    const first = await freshProcess();
    await first.startup.initializeGitMem(); // leaves a disk cache behind

    store.down = true;
    const { startup, count } = await freshProcess();
    const r = await startup.initializeGitMem();

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/serving 20 from the disk cache/);
    expect(count()).toBe(20);
  });

  it("a genuinely empty store is success with 0, not a failure", async () => {
    store.rows = [];
    const { startup, count } = await freshProcess();
    const r = await startup.initializeGitMem();
    expect(r.success).toBe(true);
    expect(count()).toBe(0);
  });

  it("a failed load retries with backoff and recovers when the store does", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { startup, count } = await freshProcess();
    await startup.initializeGitMem();
    store.down = true;
    await startup.flushCache();
    expect(startup.getReloadRetryState()).toEqual({ pending: true, attempt: 1 });

    store.down = false;
    seed(25, 100);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(count()).toBe(25);
    expect(startup.getReloadRetryState()).toEqual({ pending: false, attempt: 0 });
  });

  it("the second retry waits twice as long", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { startup } = await freshProcess();
    await startup.initializeGitMem();
    store.down = true;
    await startup.flushCache();
    await vi.advanceTimersByTimeAsync(30_000); // retry 1 fails, schedules retry 2 at 60 s
    expect(startup.getReloadRetryState()).toEqual({ pending: true, attempt: 2 });
    store.calls = { bulk: 0, manifest: 0 };
    await vi.advanceTimersByTimeAsync(59_000);
    expect(store.calls.manifest + store.calls.bulk).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.calls.manifest + store.calls.bulk).toBeGreaterThan(0);
  });

  it("ensureInitialized tries again after a failed init (it cached the failure forever)", async () => {
    store.down = true;
    const { startup, count } = await freshProcess();
    await startup.ensureInitialized();
    expect(count()).toBe(0);

    store.down = false;
    await startup.ensureInitialized();
    expect(count()).toBe(20);
  });
});

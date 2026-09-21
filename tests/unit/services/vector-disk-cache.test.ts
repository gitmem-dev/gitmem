/**
 * GIT-98: disk-backed vector cache.
 *
 * The contract under test: every failure is a MISS (download as before), never
 * stale or foreign rows. Real filesystem, isolated GITMEM_DIR per test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let dir: string;

async function load() {
  vi.resetModules();
  return import("../../../src/services/vector-disk-cache.js");
}

const FP = { count: 3, latestUpdatedAt: "2026-09-20T15:25:16.480033+00:00" };
const ROWS = [
  { id: "a", title: "one", embedding: [0.1, 0.2, 0.3] },
  { id: "b", title: "two", embedding: [0.4, 0.5, 0.6] },
  { id: "c", title: "three", embedding: [0.7, 0.8, 0.9] },
];

describe("vector-disk-cache (GIT-98)", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-vcache-"));
    process.env.GITMEM_DIR = dir;
    delete process.env.GITMEM_VECTOR_DISK_CACHE;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.GITMEM_DIR;
    delete process.env.GITMEM_VECTOR_DISK_CACHE;
  });

  it("round-trips rows when store and fingerprint match", async () => {
    const c = await load();
    const key = c.computeStoreKey("https://x.supabase.co", "gitmem_learnings");
    expect(c.writeVectorCache(key, FP, ROWS)).toBe(true);

    const r = c.readVectorCache<typeof ROWS[number]>(key, FP);
    expect(r.hit).toBe(true);
    if (r.hit) {
      expect(r.rows).toEqual(ROWS);
      expect(r.bytesOnDisk).toBeGreaterThan(0);
    }
  });

  it("misses when the row count changed (insert or deactivation)", async () => {
    const c = await load();
    const key = c.computeStoreKey("https://x.supabase.co", "gitmem_learnings");
    c.writeVectorCache(key, FP, ROWS);
    const r = c.readVectorCache(key, { ...FP, count: 4 });
    expect(r).toEqual({ hit: false, reason: "store changed since cache was written" });
  });

  it("misses when the newest updated_at changed (edit)", async () => {
    const c = await load();
    const key = c.computeStoreKey("https://x.supabase.co", "gitmem_learnings");
    c.writeVectorCache(key, FP, ROWS);
    const r = c.readVectorCache(key, { ...FP, latestUpdatedAt: "2026-09-21T00:00:00+00:00" });
    expect(r.hit).toBe(false);
  });

  it("never serves another store's rows", async () => {
    const c = await load();
    const mine = c.computeStoreKey("https://mine.supabase.co", "gitmem_learnings");
    const theirs = c.computeStoreKey("https://theirs.supabase.co", "gitmem_learnings");
    expect(mine).not.toBe(theirs);
    c.writeVectorCache(mine, FP, ROWS);
    expect(c.readVectorCache(theirs, FP).hit).toBe(false);

    // Same URL, different table prefix is a different store too.
    const prefixed = c.computeStoreKey("https://mine.supabase.co", "orchestra_learnings");
    expect(prefixed).not.toBe(mine);
  });

  it("refuses a file that claims a different storeKey, even at the right path", async () => {
    const c = await load();
    const key = c.computeStoreKey("https://x.supabase.co", "gitmem_learnings");
    c.writeVectorCache(key, FP, ROWS);
    const file = c.getVectorCachePath(key);
    const tampered = JSON.parse(fs.readFileSync(file, "utf-8"));
    tampered.storeKey = "0000000000000000";
    fs.writeFileSync(file, JSON.stringify(tampered));
    expect(c.readVectorCache(key, FP)).toEqual({ hit: false, reason: "written for a different store" });
  });

  it("an unknown fingerprint (count -1) never matches and is never persisted", async () => {
    const c = await load();
    const key = c.computeStoreKey("https://x.supabase.co", "gitmem_learnings");
    const unknown = { count: -1, latestUpdatedAt: null };

    expect(c.writeVectorCache(key, unknown, ROWS)).toBe(false);
    expect(fs.existsSync(c.getVectorCachePath(key))).toBe(false);

    // Even if a file with an identical unknown fingerprint somehow exists, two failures must not "agree".
    fs.mkdirSync(path.dirname(c.getVectorCachePath(key)), { recursive: true });
    fs.writeFileSync(c.getVectorCachePath(key), JSON.stringify({
      format: c.VECTOR_CACHE_FORMAT, storeKey: key, fingerprint: unknown, savedAt: "x", rows: ROWS,
    }));
    expect(c.readVectorCache(key, unknown)).toEqual({ hit: false, reason: "store fingerprint unavailable" });
  });

  it("treats corrupt, truncated and wrong-format files as misses", async () => {
    const c = await load();
    const key = c.computeStoreKey("https://x.supabase.co", "gitmem_learnings");
    const file = c.getVectorCachePath(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    fs.writeFileSync(file, '{"format":1,"storeKey":"' + key + '","rows":[{"id":"a"');
    expect(c.readVectorCache(key, FP)).toEqual({ hit: false, reason: "corrupt JSON" });

    fs.writeFileSync(file, "null");
    expect(c.readVectorCache(key, FP).hit).toBe(false);

    fs.writeFileSync(file, JSON.stringify({ format: 999, storeKey: key, fingerprint: FP, rows: ROWS }));
    expect(c.readVectorCache(key, FP).hit).toBe(false);

    fs.writeFileSync(file, JSON.stringify({ format: c.VECTOR_CACHE_FORMAT, storeKey: key, fingerprint: FP, rows: "nope" }));
    expect(c.readVectorCache(key, FP)).toEqual({ hit: false, reason: "corrupt rows" });
  });

  it("GITMEM_VECTOR_DISK_CACHE=0 disables both read and write", async () => {
    const c = await load();
    const key = c.computeStoreKey("https://x.supabase.co", "gitmem_learnings");
    c.writeVectorCache(key, FP, ROWS);

    process.env.GITMEM_VECTOR_DISK_CACHE = "0";
    expect(c.readVectorCache(key, FP).hit).toBe(false);
    fs.rmSync(c.getVectorCachePath(key));
    expect(c.writeVectorCache(key, FP, ROWS)).toBe(false);
    expect(fs.existsSync(c.getVectorCachePath(key))).toBe(false);
  });

  it("leaves no temp files behind and writes owner-only", async () => {
    const c = await load();
    const key = c.computeStoreKey("https://x.supabase.co", "gitmem_learnings");
    c.writeVectorCache(key, FP, ROWS);
    const cacheDir = path.dirname(c.getVectorCachePath(key));
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    if (process.platform !== "win32") {
      expect(fs.statSync(c.getVectorCachePath(key)).mode & 0o777).toBe(0o600);
    }
  });

  it("the cache file does not contain the Supabase URL in clear", async () => {
    const c = await load();
    const key = c.computeStoreKey("https://secret-project-ref.supabase.co", "gitmem_learnings");
    c.writeVectorCache(key, FP, ROWS);
    const file = c.getVectorCachePath(key);
    expect(path.basename(file)).not.toContain("secret-project-ref");
    expect(fs.readFileSync(file, "utf-8")).not.toContain("secret-project-ref");
  });

  describe("single-flight download lock", () => {
    it("only one caller becomes leader; release lets the next one in", async () => {
      const c = await load();
      const key = c.computeStoreKey("https://x.supabase.co", "gitmem_learnings");
      const release = c.tryAcquireDownloadLock(key);
      expect(release).toBeTypeOf("function");
      expect(c.tryAcquireDownloadLock(key)).toBeNull();
      release!();
      const again = c.tryAcquireDownloadLock(key);
      expect(again).toBeTypeOf("function");
      again!();
      expect(fs.existsSync(`${c.getVectorCachePath(key)}.lock`)).toBe(false);
    });

    it("breaks a lock whose holder is presumed dead", async () => {
      const c = await load();
      const key = c.computeStoreKey("https://x.supabase.co", "gitmem_learnings");
      c.tryAcquireDownloadLock(key); // leader "crashes" without releasing
      const lock = `${c.getVectorCachePath(key)}.lock`;
      const old = new Date(Date.now() - 5 * 60_000);
      fs.utimesSync(lock, old, old);
      const release = c.tryAcquireDownloadLock(key);
      expect(release).toBeTypeOf("function");
      release!();
    });

    it("a follower receives the leader's rows once the cache lands", async () => {
      const c = await load();
      const key = c.computeStoreKey("https://x.supabase.co", "gitmem_learnings");
      const release = c.tryAcquireDownloadLock(key)!;
      const follower = c.waitForLeaderCache<typeof ROWS[number]>(key, FP, 5_000);
      setTimeout(() => { c.writeVectorCache(key, FP, ROWS); release(); }, 300);
      const got = await follower;
      expect(got?.hit).toBe(true);
      expect(got?.rows).toEqual(ROWS);
    });

    it("a follower gives up (null) when the leader releases without a usable cache", async () => {
      const c = await load();
      const key = c.computeStoreKey("https://x.supabase.co", "gitmem_learnings");
      const release = c.tryAcquireDownloadLock(key)!;
      const follower = c.waitForLeaderCache(key, FP, 5_000);
      setTimeout(() => release(), 300); // leader failed: no cache written
      expect(await follower).toBeNull();
    });

    it("a follower's wait is bounded when the leader hangs", async () => {
      const c = await load();
      const key = c.computeStoreKey("https://x.supabase.co", "gitmem_learnings");
      c.tryAcquireDownloadLock(key); // never released, never writes
      const t0 = Date.now();
      expect(await c.waitForLeaderCache(key, FP, 600)).toBeNull();
      expect(Date.now() - t0).toBeLessThan(2_000);
    });
  });
});

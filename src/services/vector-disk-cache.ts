/**
 * Vector Disk Cache (GIT-98)
 *
 * In local search mode every server process used to download every learning
 * with its 1536-dim embedding at startup and throw it away at exit. That is a
 * fair trade for one long interactive session and the worst possible trade for
 * short-lived processes — sub-agents, fan-outs, CI, cron — which are now the
 * common case. A customer exhausted a Supabase egress allowance this way.
 *
 * This module makes a cold process cheap by default:
 *
 *   1. Ask the store for a FINGERPRINT — row count + newest updated_at. One
 *      request, one row, a few hundred bytes (PostgREST `Prefer: count=exact`).
 *   2. If a cache file with the same fingerprint exists, load vectors from disk.
 *   3. Otherwise sync the difference (below) and rewrite the cache.
 *
 * ## Per-row delta sync
 *
 * A fingerprint miss used to mean a full download, and on a Pro store it
 * misses on nearly every session_start: refresh_scar_behavioral_scores()
 * rewrites every scar with enough recent usage and bumps its updated_at. So
 * a handful of changed rows cost the whole index.
 *
 * On a miss with a usable cache from this store, only the manifest (id,
 * updated_at; no vectors) is downloaded. A row whose id and updated_at match
 * the cache is reused from disk; only changed and new ids are fetched in full;
 * rows no longer in the manifest are dropped. The result is in manifest order,
 * exactly what a full download would have returned, given that updated_at
 * moves on every edit (the same assumption the fingerprint already makes).
 *
 * ## What the fingerprint can and cannot see
 *
 * It detects inserts, deactivations (count changes) and any edit that bumps
 * updated_at. It does NOT detect an in-place edit that leaves updated_at and
 * the row count unchanged. setup.sql maintains updated_at by trigger, so that
 * requires a store whose trigger is missing. `cache-flush` always bypasses the
 * disk cache, so there is a manual way out.
 *
 * ## Failure posture
 *
 * Every failure here degrades to the old behaviour (download), never to stale
 * or empty results. An unreadable, corrupt, mismatched or foreign cache file is
 * a miss. A failed fingerprint request is a miss. A failed write is logged and
 * ignored. The cache is an optimisation and must never be load-bearing.
 *
 * ## Concurrency
 *
 * Writes go to a temp file and are renamed into place, so a reader sees either
 * the old complete file or the new complete file, never a partial one.
 *
 * A fan-out starts N processes at the same instant, and any write to the store
 * invalidates the cache for all of them at once. Without coordination that is N
 * identical downloads — the exact cost this module exists to remove. So a miss
 * is single-flighted across processes: one LEADER takes an O_EXCL lock file and
 * downloads; FOLLOWERS wait for the cache to appear and read it. A follower
 * that waits too long, or finds the leader's lock stale, downloads for itself.
 * Waiting is async (never blocks the event loop) and bounded, so the worst case
 * is today's behaviour plus a bounded delay — never a hang.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { getGitmemDir } from "./gitmem-dir.js";

/** Bump when the on-disk shape changes; an older file is then a miss. */
export const VECTOR_CACHE_FORMAT = 1;

export interface StoreFingerprint {
  /** Active learnings of the indexed types, as counted by the store. */
  count: number;
  /** Newest updated_at among them, or null for an empty store. */
  latestUpdatedAt: string | null;
}

interface VectorCacheFile<T> {
  format: number;
  /** Identifies the store + table, so switching stores can never serve foreign rows. */
  storeKey: string;
  fingerprint: StoreFingerprint;
  savedAt: string;
  rows: T[];
}

export type CacheReadResult<T> =
  | { hit: true; rows: T[]; bytesOnDisk: number }
  | { hit: false; reason: string };

/** Opt-out: GITMEM_VECTOR_DISK_CACHE=0 (or "false") restores download-every-start. */
export function isVectorDiskCacheEnabled(): boolean {
  const v = process.env.GITMEM_VECTOR_DISK_CACHE;
  return !(v === "0" || v === "false");
}

/**
 * A stable, non-reversible key for (store URL, table). Hashed so the cache file
 * name and contents never carry the project URL in clear.
 */
export function computeStoreKey(supabaseUrl: string, table: string): string {
  return crypto.createHash("sha256").update(`${supabaseUrl}\n${table}`).digest("hex").slice(0, 16);
}

export function getVectorCachePath(storeKey: string): string {
  return path.join(getGitmemDir(), "cache", `learnings-vectors-${storeKey}.json`);
}

export function fingerprintsMatch(a: StoreFingerprint, b: StoreFingerprint): boolean {
  return a.count === b.count && a.latestUpdatedAt === b.latestUpdatedAt;
}

/**
 * Read the cache if, and only if, it was written for this store and this
 * fingerprint. Anything else is a miss with a reason (logged by the caller).
 */
export function readVectorCache<T>(storeKey: string, expected: StoreFingerprint): CacheReadResult<T> {
  if (!isVectorDiskCacheEnabled()) return { hit: false, reason: "disabled by GITMEM_VECTOR_DISK_CACHE" };

  // A failed fingerprint request reports count -1. Never match on it: two
  // failures would otherwise "agree" and serve whatever is on disk.
  if (expected.count < 0) return { hit: false, reason: "store fingerprint unavailable" };

  const file = readCacheFile<T>(storeKey);
  if (!file.ok) return { hit: false, reason: file.reason };
  if (!file.parsed.fingerprint || !fingerprintsMatch(file.parsed.fingerprint, expected)) {
    return { hit: false, reason: "store changed since cache was written" };
  }
  return { hit: true, rows: file.parsed.rows, bytesOnDisk: file.bytesOnDisk };
}

/**
 * The cached rows of this store, whatever fingerprint they were written under:
 * the base a delta sync reuses unchanged rows from. Never served as-is — every
 * row is checked against the store's manifest first.
 */
export function readVectorCacheBase<T>(storeKey: string): T[] | null {
  if (!isVectorDiskCacheEnabled()) return null;
  const file = readCacheFile<T>(storeKey);
  return file.ok ? file.parsed.rows : null;
}

export interface ManifestRow {
  id: string;
  updated_at: string | null;
}

export interface DeltaPlan<T> {
  /** Cached rows still current in the store, by id. */
  reuse: Map<string, T>;
  /** Ids to fetch in full: changed since the cache was written, or new. */
  fetchIds: string[];
  /** Cached rows the store no longer returns. */
  dropped: number;
}

/**
 * Compare the store's manifest with the cached rows. A row is reused only when
 * its id AND updated_at match; a cached row without updated_at is refetched.
 */
export function planDelta<T extends { id: string; updated_at?: string | null }>(
  cached: T[],
  manifest: ManifestRow[]
): DeltaPlan<T> {
  const cachedById = new Map(cached.map((r) => [r.id, r]));
  const reuse = new Map<string, T>();
  const fetchIds: string[] = [];
  for (const m of manifest) {
    const c = cachedById.get(m.id);
    if (c && m.updated_at != null && c.updated_at === m.updated_at) reuse.set(m.id, c);
    else fetchIds.push(m.id);
  }
  const inManifest = new Set(manifest.map((m) => m.id));
  const dropped = cached.filter((r) => !inManifest.has(r.id)).length;
  return { reuse, fetchIds, dropped };
}

/**
 * Rows in manifest order: reused where current, fetched otherwise. A manifest
 * id that is in neither (deactivated between the manifest and the fetch) is
 * left out, as a full download at that moment would have.
 */
export function assembleDelta<T extends { id: string }>(
  manifest: ManifestRow[],
  plan: DeltaPlan<T>,
  fetched: T[]
): T[] {
  const fetchedById = new Map(fetched.map((r) => [r.id, r]));
  const rows: T[] = [];
  for (const m of manifest) {
    const row = fetchedById.get(m.id) ?? plan.reuse.get(m.id);
    if (row) rows.push(row);
  }
  return rows;
}

function readCacheFile<T>(storeKey: string):
  | { ok: true; parsed: VectorCacheFile<T>; bytesOnDisk: number }
  | { ok: false; reason: string } {
  const file = getVectorCachePath(storeKey);
  let raw: string;
  try {
    if (!fs.existsSync(file)) return { ok: false, reason: "no cache file" };
    raw = fs.readFileSync(file, "utf-8");
  } catch (error) {
    return { ok: false, reason: `unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }

  let parsed: VectorCacheFile<T>;
  try {
    parsed = JSON.parse(raw) as VectorCacheFile<T>;
  } catch {
    return { ok: false, reason: "corrupt JSON" };
  }

  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "corrupt shape" };
  if (parsed.format !== VECTOR_CACHE_FORMAT) return { ok: false, reason: `format ${parsed.format} != ${VECTOR_CACHE_FORMAT}` };
  if (parsed.storeKey !== storeKey) return { ok: false, reason: "written for a different store" };
  if (!Array.isArray(parsed.rows)) return { ok: false, reason: "corrupt rows" };

  return { ok: true, parsed, bytesOnDisk: Buffer.byteLength(raw) };
}

/**
 * Persist rows under the fingerprint that was observed BEFORE they were
 * downloaded. If the store changed mid-download the file is merely stale and
 * the next start misses and reloads — the safe direction.
 */
export function writeVectorCache<T>(storeKey: string, fingerprint: StoreFingerprint, rows: T[]): boolean {
  if (!isVectorDiskCacheEnabled()) return false;
  if (fingerprint.count < 0) return false; // never persist under an unknown fingerprint

  const file = getVectorCachePath(storeKey);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload: VectorCacheFile<T> = {
      format: VECTOR_CACHE_FORMAT,
      storeKey,
      fingerprint,
      savedAt: new Date().toISOString(),
      rows,
    };
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    console.error("[vector-cache] Failed to write cache (non-fatal):", error instanceof Error ? error.message : error);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best effort */ }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cross-process single-flight for cache misses
// ---------------------------------------------------------------------------

/** A leader that has held the lock this long is presumed dead. A bulk load has a 15-30s budget. */
const LOCK_STALE_MS = 60_000;
/** How long a follower waits for the leader before downloading for itself. */
const FOLLOWER_WAIT_MS = 25_000;
const FOLLOWER_POLL_MS = 150;

function lockPathFor(storeKey: string): string {
  return `${getVectorCachePath(storeKey)}.lock`;
}

/** Try to become the downloader. Returns a release function, or null if someone else is. */
export function tryAcquireDownloadLock(storeKey: string): (() => void) | null {
  if (!isVectorDiskCacheEnabled()) return () => {};
  const lock = lockPathFor(storeKey);
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
  } catch {
    return () => {}; // cannot coordinate — behave as a lone downloader
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(lock); } catch { /* already gone */ } };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return () => {}; // odd fs — lone downloader
      // Held by someone. Break it only if its holder is presumed dead, then retry once.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch { /* vanished between calls — retry */ continue; }
      return null;
    }
  }
  return null;
}

/**
 * Follower path: wait for the leader's cache to land. Resolves with the rows on
 * a hit, or null when the caller should download for itself (leader gone,
 * leader failed, or the wait budget ran out).
 */
export async function waitForLeaderCache<T>(
  storeKey: string,
  expected: StoreFingerprint,
  waitMs: number = FOLLOWER_WAIT_MS
): Promise<CacheReadResult<T> & { hit: true } | null> {
  const lock = lockPathFor(storeKey);
  const deadline = Date.now() + waitMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, FOLLOWER_POLL_MS));

    const lockHeld = fs.existsSync(lock);
    const cached = readVectorCache<T>(storeKey, expected);
    if (cached.hit) return cached;

    // Lock released and still no usable cache: the leader failed, or it cached a
    // newer fingerprint than the one we observed. Either way, stop waiting.
    if (!lockHeld) return null;
  }
  return null;
}

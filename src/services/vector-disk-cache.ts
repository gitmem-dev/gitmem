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
 *   3. Otherwise download as before and rewrite the cache.
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

  const file = getVectorCachePath(storeKey);
  let raw: string;
  try {
    if (!fs.existsSync(file)) return { hit: false, reason: "no cache file" };
    raw = fs.readFileSync(file, "utf-8");
  } catch (error) {
    return { hit: false, reason: `unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }

  let parsed: VectorCacheFile<T>;
  try {
    parsed = JSON.parse(raw) as VectorCacheFile<T>;
  } catch {
    return { hit: false, reason: "corrupt JSON" };
  }

  if (!parsed || typeof parsed !== "object") return { hit: false, reason: "corrupt shape" };
  if (parsed.format !== VECTOR_CACHE_FORMAT) return { hit: false, reason: `format ${parsed.format} != ${VECTOR_CACHE_FORMAT}` };
  if (parsed.storeKey !== storeKey) return { hit: false, reason: "written for a different store" };
  if (!Array.isArray(parsed.rows)) return { hit: false, reason: "corrupt rows" };
  if (!parsed.fingerprint || !fingerprintsMatch(parsed.fingerprint, expected)) {
    return { hit: false, reason: "store changed since cache was written" };
  }

  return { hit: true, rows: parsed.rows, bytesOnDisk: Buffer.byteLength(raw) };
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

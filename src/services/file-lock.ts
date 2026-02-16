/**
 * Advisory File Lock (GIT-24)
 *
 * Uses O_CREAT | O_EXCL for atomic lock file creation — the standard
 * POSIX advisory lock pattern. Zero dependencies.
 *
 * Lock file: .gitmem/active-sessions.lock
 *
 * Stale lock detection: if a lock file is older than STALE_THRESHOLD_MS,
 * the holder likely crashed. We break the stale lock and retry.
 */

import * as fs from "fs";
import * as os from "os";

const STALE_THRESHOLD_MS = 30_000; // 30 seconds — critical section takes <10ms
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_MS = 25;

interface LockContents {
  pid: number;
  hostname: string;
  acquired_at: string;
}

/**
 * Synchronous sleep using Atomics.wait on a SharedArrayBuffer.
 * More precise than busy-wait, doesn't block the event loop for other threads.
 */
function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.wait(arr, 0, 0, ms);
}

/**
 * Check if a lock file is stale (holder likely crashed).
 */
function isLockStale(lockPath: string): boolean {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    const contents: LockContents = JSON.parse(raw);
    const age = Date.now() - new Date(contents.acquired_at).getTime();
    return age > STALE_THRESHOLD_MS;
  } catch {
    // Can't read/parse lock — treat as stale so we can recover
    return true;
  }
}

/**
 * Acquire an advisory file lock synchronously.
 *
 * Uses O_CREAT | O_EXCL to atomically create the lock file.
 * Retries with sleep until timeout. Breaks stale locks.
 *
 * @throws Error if lock cannot be acquired within timeout
 */
export function acquireLockSync(
  lockPath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  retryMs: number = DEFAULT_RETRY_MS
): void {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      // O_CREAT | O_EXCL | O_WRONLY — fails with EEXIST if file exists
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      const contents: LockContents = {
        pid: process.pid,
        hostname: os.hostname(),
        acquired_at: new Date().toISOString(),
      };
      fs.writeSync(fd, JSON.stringify(contents));
      fs.closeSync(fd);
      return;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== "EEXIST") {
        throw new Error(`[file-lock] Failed to create lock file ${lockPath}: ${error.message}`);
      }

      // Lock file exists — check if we already hold it (reentrance detection)
      try {
        const raw = fs.readFileSync(lockPath, "utf-8");
        const holder: LockContents = JSON.parse(raw);
        if (holder.pid === process.pid && holder.hostname === os.hostname()) {
          // Same process already holds the lock — reentrant call, allow through
          return;
        }
      } catch {
        // Can't read lock — fall through to stale check
      }

      // Lock file exists — check if stale
      if (isLockStale(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
          // Loop back to retry immediately after breaking stale lock
          continue;
        } catch {
          // Another process may have broken it first — retry
        }
      }

      // Check timeout
      if (Date.now() >= deadline) {
        let diagnostics = "";
        try {
          const raw = fs.readFileSync(lockPath, "utf-8");
          diagnostics = ` Lock held by: ${raw}`;
        } catch {
          diagnostics = " (lock file unreadable)";
        }
        throw new Error(
          `[file-lock] Timeout after ${timeoutMs}ms waiting for lock ${lockPath}.${diagnostics}`
        );
      }

      sleepSync(retryMs);
    }
  }
}

/**
 * Release an advisory file lock synchronously.
 * Ignores ENOENT (lock already released).
 */
export function releaseLockSync(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== "ENOENT") {
      console.warn(`[file-lock] Failed to release lock ${lockPath}: ${error.message}`);
    }
  }
}

/**
 * Execute a function while holding an advisory file lock.
 * Guarantees lock release even if fn throws.
 */
export function withLockSync<T>(lockPath: string, fn: () => T): T {
  acquireLockSync(lockPath);
  try {
    return fn();
  } finally {
    releaseLockSync(lockPath);
  }
}

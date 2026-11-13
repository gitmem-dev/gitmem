/**
 * Owner-only file writes for files that hold credentials.
 *
 * `fs.writeFileSync(path, data)` creates a file with the process umask default,
 * usually 0644, so other local accounts can read it. `mode` only applies when
 * the file is first created, so a file written by an earlier version stays
 * readable unless it is chmod'ed as well (the same lesson as GIT-109 in
 * startup.ts).
 *
 * Windows has no group/other mode bits (Node can only toggle the read-only flag
 * there), so the write is left exactly as it was and no chmod is attempted.
 */

import * as fs from "fs";

export interface PrivateWriteResult {
  /** Permission bits (mode & 0o777) before the write; null if the file was new, or on Windows. */
  previousMode: number | null;
  /**
   * An error code ("EPERM" etc.) when chmod threw, or "mode-unchanged" when chmod
   * returned but a stat after the write still shows a group or other bit.
   * The write still happened. Null when the file is owner-only (or on Windows).
   */
  tightenError: string | null;
}

/**
 * Write `data` to `filePath` so that only the owner can read it (POSIX).
 *
 * An existing file is set to 0600 BEFORE the new bytes are written, so new
 * secrets are never written into a readable file. A new file is created at 0600.
 * A chmod failure does not throw: the write still happens and the code is returned.
 */
export function writePrivateFileSync(filePath: string, data: string): PrivateWriteResult {
  if (process.platform === "win32") {
    fs.writeFileSync(filePath, data);
    return { previousMode: null, tightenError: null };
  }

  let previousMode: number | null = null;
  let tightenError: string | null = null;
  let chmodThrew = false;

  try {
    // statSync follows symlinks, so a symlinked file has its target tightened.
    previousMode = fs.statSync(filePath).mode & 0o777;
  } catch {
    previousMode = null; // new file (or unreadable: the write below will say)
  }

  if (previousMode !== null) {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch (err) {
      chmodThrew = true;
      tightenError = (err as NodeJS.ErrnoException).code || "chmod-failed";
    }
  }

  fs.writeFileSync(filePath, data, { mode: 0o600 });

  if (!chmodThrew) {
    // Some mounts (WSL /mnt/c without metadata, some FUSE and network mounts)
    // accept chmod and change nothing. Check the result rather than trust it.
    try {
      if ((fs.statSync(filePath).mode & 0o077) !== 0) {
        tightenError = "mode-unchanged";
      }
    } catch {
      // Cannot stat: leave as is.
    }
  }

  return { previousMode, tightenError };
}

/**
 * Set an existing file to 0600 without writing to it (POSIX). A missing file is
 * left alone. Like writePrivateFileSync, a chmod failure does not throw: the code
 * comes back in `tightenError`, and a symlink has its target tightened.
 */
export function tightenPrivateFileSync(filePath: string): PrivateWriteResult {
  if (process.platform === "win32") {
    return { previousMode: null, tightenError: null };
  }

  let previousMode: number;
  try {
    previousMode = fs.statSync(filePath).mode & 0o777;
  } catch {
    return { previousMode: null, tightenError: null }; // nothing to tighten
  }
  if ((previousMode & 0o077) === 0) return { previousMode, tightenError: null };

  try {
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    return { previousMode, tightenError: (err as NodeJS.ErrnoException).code || "chmod-failed" };
  }

  // Same check as the writer: some mounts accept chmod and change nothing.
  try {
    if ((fs.statSync(filePath).mode & 0o077) !== 0) {
      return { previousMode, tightenError: "mode-unchanged" };
    }
  } catch {
    // Cannot stat: leave as is.
  }
  return { previousMode, tightenError: null };
}

/** True when the file was readable by group or other before the write. */
export function wasReadableByOthers(r: PrivateWriteResult): boolean {
  return r.previousMode !== null && (r.previousMode & 0o077) !== 0;
}

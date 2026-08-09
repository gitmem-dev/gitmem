/**
 * Active Sessions Registry (GIT-19)
 *
 * CRUD operations for .gitmem/active-sessions.json — the multi-session
 * registry that tracks all running MCP server sessions.
 *
 * Key design decisions:
 * - Atomic writes (write-temp-rename) because multiple processes may
 *   register/unregister concurrently.
 * - Sync I/O to match codebase convention (fs.writeFileSync etc).
 * - Graceful degradation: corrupted registry = start fresh.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getGitmemDir, getSessionPath, sanitizePathComponent } from "./gitmem-dir.js";
import { ActiveSessionsRegistrySchema } from "../schemas/active-sessions.js";
import type { ActiveSessionEntry, ActiveSessionsRegistry, AgentIdentity } from "../types/index.js";
import { withLockSync } from "./file-lock.js";

const REGISTRY_FILENAME = "active-sessions.json";
const LOCK_FILENAME = "active-sessions.lock";
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

// --- Atomic write utility ---

/**
 * Atomic write: write to a temp file in the same directory, then rename.
 * rename() on the same filesystem is atomic on POSIX.
 * Falls back to direct write on rename failure.
 */
function atomicWriteFileSync(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.active-sessions.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (renameErr) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup failure */
    }
    console.warn("[active-sessions] Atomic rename failed, falling back to direct write:", renameErr);
    fs.writeFileSync(filePath, data, "utf-8");
  }
}

// --- Internal helpers ---

function getRegistryPath(): string {
  return path.join(getGitmemDir(), REGISTRY_FILENAME);
}

/**
 * A cheap fingerprint of the registry's current state (GIT-51).
 *
 * Session recovery needs to know whether it is worth retrying. The registry is
 * written by OTHER processes — notably the SessionStart hook, which runs as its
 * own CLI process (scar 55d1bccd) — so "I already failed to recover" is only
 * valid until someone else touches the file.
 *
 * Returns null when neither the registry nor the sessions directory exists,
 * which is itself a stable state worth caching against.
 *
 * GIT-89: covers the sessions directory as well as the registry. Identity now
 * resolves from sessions/<id>/session.json, so a fingerprint that watched only
 * active-sessions.json would keep the "already failed" latch closed over a
 * session that had since appeared on disk — reintroducing the permanent
 * fail-closed behaviour the fingerprint was introduced to prevent.
 */
export function getRegistryFingerprint(): number | null {
  const mtimes: number[] = [];
  for (const target of [getRegistryPath(), path.join(getGitmemDir(), "sessions")]) {
    try {
      mtimes.push(fs.statSync(target).mtimeMs);
    } catch {
      // Missing target contributes nothing — absence is part of the fingerprint.
    }
  }
  if (mtimes.length === 0) return null;
  // Sum, not concat: this only needs to change when either input changes.
  return mtimes.reduce((a, b) => a + b, 0);
}

function getLockPath(): string {
  return path.join(getGitmemDir(), LOCK_FILENAME);
}

/**
 * Read the registry from disk. Returns empty registry if file
 * doesn't exist, is corrupted, or fails Zod validation.
 */
function readRegistry(): ActiveSessionsRegistry {
  try {
    const filePath = getRegistryPath();
    if (!fs.existsSync(filePath)) {
      return { sessions: [] };
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const result = ActiveSessionsRegistrySchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    console.warn("[active-sessions] Registry failed validation, starting fresh:", result.error.message);
    return { sessions: [] };
  } catch (error) {
    console.warn("[active-sessions] Failed to read registry:", error);
    return { sessions: [] };
  }
}

/**
 * Write the registry to disk using atomic write.
 */
function writeRegistry(registry: ActiveSessionsRegistry): void {
  const filePath = getRegistryPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  atomicWriteFileSync(filePath, JSON.stringify(registry, null, 2));
}

// --- CRUD operations ---

/**
 * Register a new session in the active-sessions registry.
 * Idempotent: re-registering the same session_id replaces the entry.
 * Returns session IDs that were displaced (different session_id, same hostname+pid).
 */
export function registerSession(entry: ActiveSessionEntry): string[] {
  const displaced: string[] = [];
  withLockSync(getLockPath(), () => {
    const registry = readRegistry();
    // Collect displaced session IDs (same hostname+pid, different session_id)
    for (const s of registry.sessions) {
      if (s.session_id !== entry.session_id && s.hostname === entry.hostname && s.pid === entry.pid) {
        displaced.push(s.session_id);
      }
    }
    // Remove by session_id AND by hostname+pid to prevent duplicates
    registry.sessions = registry.sessions.filter((s) =>
      s.session_id !== entry.session_id &&
      !(s.hostname === entry.hostname && s.pid === entry.pid)
    );
    registry.sessions.push(entry);
    writeRegistry(registry);
  });
  if (displaced.length > 0) {
    console.error(
      `[active-sessions] Registered session ${entry.session_id.slice(0, 8)} — displaced ${displaced.length} prior session(s): ${displaced.map(id => id.slice(0, 8)).join(", ")}`
    );
  } else {
    console.error(
      `[active-sessions] Registered session ${entry.session_id.slice(0, 8)} (agent: ${entry.agent}, pid: ${entry.pid})`
    );
  }
  return displaced;
}

/**
 * Unregister a session from the active-sessions registry.
 * Returns true if the session was found and removed.
 */
export function unregisterSession(sessionId: string): boolean {
  const removed = withLockSync(getLockPath(), () => {
    const registry = readRegistry();
    const before = registry.sessions.length;
    registry.sessions = registry.sessions.filter((s) => s.session_id !== sessionId);
    const wasRemoved = registry.sessions.length < before;

    if (wasRemoved) {
      writeRegistry(registry);
    }
    return wasRemoved;
  });

  if (removed) {
    console.error(`[active-sessions] Unregistered session ${sessionId.slice(0, 8)}`);
  } else {
    console.warn(`[active-sessions] Session ${sessionId.slice(0, 8)} not found in registry`);
  }

  return removed;
}

/**
 * List all active sessions from the registry.
 */
export function listActiveSessions(): ActiveSessionEntry[] {
  return readRegistry().sessions;
}

/**
 * Find a session by hostname and PID.
 * Used by session_start to detect if this process already has a registered session.
 */
export function findSessionByHostPid(hostname: string, pid: number): ActiveSessionEntry | null {
  const registry = readRegistry();
  return registry.sessions.find((s) => s.hostname === hostname && s.pid === pid) || null;
}

/**
 * Find a session by session_id.
 */
export function findSessionById(sessionId: string): ActiveSessionEntry | null {
  const registry = readRegistry();
  return registry.sessions.find((s) => s.session_id === sessionId) || null;
}

/**
 * Check whether a PID is currently running.
 * EPERM means the process exists but belongs to another user — still alive.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check existence only
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * GIT-89: Resolve this process's session from the per-session directories.
 *
 * This replaces registry-gated recovery (GIT-51's adoptSessionForCurrentProcess).
 * That approach iterated `registry.sessions`, so an empty or diverged registry
 * meant "no session" no matter what was on disk — and the registry is precisely
 * the store that gets lost. Observed in the wild: active-sessions.json holding
 * `{"sessions": []}` with intact sessions/<id>/session.json files beside it.
 *
 * `.gitmem/sessions/<id>/session.json` is the durable evidence. session_close
 * deletes the directory (session-close.ts cleanupSessionFiles), so a directory
 * that still exists is a session that was never closed. The registry is derived
 * from this scan and repaired by it — it is an index, never an answer.
 *
 * PID is no longer an identity key, only a disambiguator among candidates:
 * - own PID          -> this process's session, no adoption needed
 * - dead PID         -> orphaned by an MCP restart, adoptable
 * - live foreign PID -> another concurrent server owns it, never touched
 *   (GIT-20: "never resume another process's session"; keeps GIT-19..23
 *   multi-session resolution intact)
 *
 * Returns the resolved entry (PID rebound to this process), or null when there
 * is genuinely nothing to resume. Never invents a session.
 */
const AGENT_IDENTITIES = ["cli", "desktop", "autonomous", "local", "cloud"] as const;

/**
 * Coerce a session.json `agent` field to AgentIdentity.
 *
 * Case-insensitive because session files in the field carry values like "CLI"
 * that never matched the lowercase union. Anything unrecognised becomes
 * "Unknown" rather than being asserted through — a wrong agent label is a
 * display problem, an invalid one is a type lie.
 */
function toAgentIdentity(value: unknown): AgentIdentity {
  if (typeof value !== "string") return "Unknown";
  const normalized = value.toLowerCase();
  return AGENT_IDENTITIES.find((id) => id === normalized) ?? "Unknown";
}

export function findResumableSessionOnDisk(): ActiveSessionEntry | null {
  const currentHostname = os.hostname();
  const currentPid = process.pid;
  const gitmemDir = getGitmemDir();
  const sessionsDir = path.join(gitmemDir, "sessions");

  let dirNames: string[];
  try {
    if (!fs.existsSync(sessionsDir)) return null;
    dirNames = fs.readdirSync(sessionsDir);
  } catch (error) {
    console.warn("[active-sessions] Failed to scan sessions directory:", error);
    return null;
  }

  const now = Date.now();
  const candidates: { entry: ActiveSessionEntry; pidAlive: boolean }[] = [];

  for (const dirName of dirNames) {
    const sessionFile = path.join(sessionsDir, dirName, "session.json");
    let data: Record<string, unknown>;
    try {
      if (!fs.existsSync(sessionFile)) continue;
      data = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
    } catch {
      continue; // unreadable or corrupt session file — not resumable
    }

    // The directory name IS the session id (getSessionDir). A mismatch means the
    // file was hand-edited or copied; refuse rather than resolve to the wrong id.
    if (typeof data.session_id !== "string" || data.session_id !== dirName) continue;

    // Sessions are host-local. A session file synced from another machine
    // (shared checkout, backup restore) is not ours to resume.
    if (typeof data.hostname === "string" && data.hostname !== currentHostname) continue;

    const startedAt = typeof data.started_at === "string" ? data.started_at : "";
    const age = now - new Date(startedAt).getTime();
    if (!Number.isFinite(age) || age > STALE_THRESHOLD_MS) continue;

    const pid = typeof data.pid === "number" ? data.pid : -1;
    candidates.push({
      entry: {
        session_id: data.session_id,
        agent: toAgentIdentity(data.agent),
        started_at: startedAt,
        hostname: currentHostname,
        pid,
        project: typeof data.project === "string" ? data.project : "default",
      },
      pidAlive: pid > 0 && pid !== currentPid && isPidAlive(pid),
    });
  }

  const newestFirst = (
    a: { entry: ActiveSessionEntry },
    b: { entry: ActiveSessionEntry }
  ) => new Date(b.entry.started_at).getTime() - new Date(a.entry.started_at).getTime();

  // 1. Our own PID — nothing to adopt, just rebuild in-memory state.
  const mine = candidates.filter((c) => c.entry.pid === currentPid).sort(newestFirst)[0];
  if (mine) {
    reconcileRegistryEntry(mine.entry);
    return { ...mine.entry };
  }

  // 2. Orphaned by a restart. Adopt at most one — rebinding every dead-PID
  //    session would leave several rows sharing hostname+pid.
  const orphaned = candidates.filter((c) => !c.pidAlive).sort(newestFirst)[0];
  if (!orphaned) return null;

  const rebound: ActiveSessionEntry = { ...orphaned.entry, pid: currentPid };
  console.error(
    `[active-sessions] Resuming session ${rebound.session_id.slice(0, 8)} from disk ` +
    `(dead pid ${orphaned.entry.pid} → ${currentPid})`
  );

  persistSessionPid(rebound.session_id, currentPid);
  reconcileRegistryEntry(rebound);
  return rebound;
}

/**
 * GIT-89: Write the resolved PID back into session.json so the next scan takes
 * the own-PID fast path instead of re-adopting.
 *
 * Read-modify-write of only the pid field: session.json accumulates state from
 * several writers (surfaced_scars from recall, threads from session_start), and
 * rewriting the whole object from an ActiveSessionEntry would drop all of it.
 */
function persistSessionPid(sessionId: string, pid: number): void {
  try {
    const sessionFile = path.join(getGitmemDir(), "sessions", sessionId, "session.json");
    const data = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
    data.pid = pid;
    atomicWriteFileSync(sessionFile, JSON.stringify(data, null, 2));
  } catch (error) {
    // Non-fatal: identity is resolved either way, the next scan just re-adopts.
    console.warn(`[active-sessions] Failed to persist pid for ${sessionId.slice(0, 8)}:`, error);
  }
}

/**
 * GIT-89: Repair the registry from a disk-resolved session.
 *
 * The registry is now derived state. When the scan finds a session the registry
 * has lost or mis-keyed, this puts it back so registry consumers
 * (findSessionByHostPid, list-sessions diagnostics) agree with disk again.
 */
function reconcileRegistryEntry(entry: ActiveSessionEntry): void {
  try {
    withLockSync(getLockPath(), () => {
      const registry = readRegistry();
      const existing = registry.sessions.find((s) => s.session_id === entry.session_id);
      if (existing && existing.pid === entry.pid && existing.hostname === entry.hostname) {
        return; // already agrees — no write
      }
      registry.sessions = registry.sessions.filter(
        (s) =>
          s.session_id !== entry.session_id &&
          !(s.hostname === entry.hostname && s.pid === entry.pid)
      );
      registry.sessions.push(entry);
      writeRegistry(registry);
      console.error(
        `[active-sessions] Registry reconciled from disk for ${entry.session_id.slice(0, 8)}`
      );
    });
  } catch (error) {
    // Non-fatal: the registry is an index, not the answer.
    console.warn("[active-sessions] Failed to reconcile registry from disk:", error);
  }
}

/**
 * Prune stale sessions from the registry (GIT-22 enhanced).
 *
 * A session is stale if:
 * 1. Its started_at is older than 24 hours, OR
 * 2. Its per-session directory/session.json is missing (orphaned registry entry)
 *
 * GIT-51: A dead PID is NOT on its own grounds for pruning. The MCP server
 * restarting mid-session leaves exactly that signature, and deleting the entry
 * (and its session directory) destroys a live session's state. Dead-PID entries
 * are left for adoptSessionForCurrentProcess() to recover, and fall out on the
 * 24h age path if nobody claims them.
 *
 * Also cleans up per-session directories for pruned sessions,
 * and removes orphaned session directories with no registry entry.
 * Returns the number of sessions pruned.
 */
export function pruneStale(): number {
  return withLockSync(getLockPath(), () => {
    const registry = readRegistry();
    const now = Date.now();
    const before = registry.sessions.length;
    const gitmemDir = getGitmemDir();

    registry.sessions = registry.sessions.filter((entry) => {
      // GIT-22: Check for orphaned registry entry (session file missing)
      const sessionFile = path.join(gitmemDir, "sessions", entry.session_id, "session.json");
      if (!fs.existsSync(sessionFile)) {
        // Only prune if session is old enough that session_start should have written the file.
        // Brand-new sessions may not have the file yet (race window during session_start).
        const age = now - new Date(entry.started_at).getTime();
        if (age > 60_000) { // 1 minute grace period
          console.error(
            `[active-sessions] Pruning orphaned registry entry ${entry.session_id.slice(0, 8)} (session file missing)`
          );
          cleanupSessionDir(gitmemDir, entry.session_id);
          return false;
        }
      }

      // Check age
      const age = now - new Date(entry.started_at).getTime();
      if (age > STALE_THRESHOLD_MS) {
        console.error(
          `[active-sessions] Pruning stale session ${entry.session_id.slice(0, 8)} (age: ${Math.round(age / 3600000)}h)`
        );
        cleanupSessionDir(gitmemDir, entry.session_id);
        return false;
      }

      // GIT-51: dead PID on this host = restarted server, not a dead session.
      // Left in place for adoptSessionForCurrentProcess() to recover.
      return true;
    });

    const pruned = before - registry.sessions.length;
    if (pruned > 0) {
      writeRegistry(registry);
      console.error(`[active-sessions] Pruned ${pruned} stale session(s)`);
    }

    // GIT-22: Clean up orphaned session directories (dir exists but no registry entry)
    pruneOrphanedDirs(gitmemDir, registry);

    return pruned;
  });
}

/**
 * GIT-22: Remove session directories that have no corresponding registry entry.
 * These can occur when a process crashes after creating the directory but before
 * registering, or when the registry is rebuilt after corruption.
 */
function pruneOrphanedDirs(gitmemDir: string, registry: ActiveSessionsRegistry): void {
  try {
    const sessionsDir = path.join(gitmemDir, "sessions");
    if (!fs.existsSync(sessionsDir)) return;

    const registeredIds = new Set(registry.sessions.map((s) => s.session_id));
    const dirs = fs.readdirSync(sessionsDir);

    for (const dirName of dirs) {
      if (registeredIds.has(dirName)) continue;

      const dirPath = path.join(sessionsDir, dirName);
      try {
        const stat = fs.statSync(dirPath);
        if (!stat.isDirectory()) continue;

        // Only prune directories older than 1 hour to avoid race conditions
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > 60 * 60 * 1000) {
          fs.rmSync(dirPath, { recursive: true, force: true });
          console.error(`[active-sessions] Cleaned up orphaned session directory: ${dirName.slice(0, 8)}`);
        }
      } catch {
        // Ignore errors on individual directories
      }
    }
  } catch {
    // sessionsDir doesn't exist or can't be read — nothing to prune
  }
}

/**
 * Clean up the per-session directory for a pruned/closed session.
 */
function cleanupSessionDir(gitmemDir: string, sessionId: string): void {
  try {
    sanitizePathComponent(sessionId, "sessionId");
    const sessionDir = path.join(gitmemDir, "sessions", sessionId);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.error(`[active-sessions] Cleaned up session directory: ${sessionDir}`);
    }
  } catch (error) {
    console.warn(`[active-sessions] Failed to clean up session directory for ${sessionId.slice(0, 8)}:`, error);
  }
}

// --- GIT-23: Migration from old format ---

let migrationRan = false;

/**
 * GIT-23: Migrate from old active-session.json (singular) to new multi-session format.
 *
 * Runs once per process. If old file exists and new registry does not:
 * 1. Read old file
 * 2. Create per-session directory with session.json
 * 3. Create active-sessions.json registry with single entry
 * 4. Rename old file to active-session.json.migrated (backup)
 *
 * Idempotent: skips if new registry already exists or old file is absent.
 */
export function migrateFromLegacy(): boolean {
  if (migrationRan) return false;
  migrationRan = true;

  try {
    return withLockSync(getLockPath(), () => {
      const gitmemDir = getGitmemDir();
      const oldPath = path.join(gitmemDir, "active-session.json");
      const newPath = path.join(gitmemDir, REGISTRY_FILENAME);

      // Skip if new registry already exists or old file is absent
      if (fs.existsSync(newPath) || !fs.existsSync(oldPath)) {
        return false;
      }

      const raw = fs.readFileSync(oldPath, "utf-8");
      const old = JSON.parse(raw);

      if (!old.session_id) {
        console.warn("[active-sessions] Legacy file has no session_id, skipping migration");
        return false;
      }

      // 1. Create per-session directory with session.json
      const sessionFilePath = getSessionPath(old.session_id, "session.json");
      fs.writeFileSync(sessionFilePath, JSON.stringify({
        ...old,
        hostname: old.hostname || os.hostname(),
        pid: old.pid || process.pid,
      }, null, 2));

      // 2. Create registry with single entry
      const entry: ActiveSessionEntry = {
        session_id: old.session_id,
        agent: old.agent || "cli",
        started_at: old.started_at || new Date().toISOString(),
        hostname: old.hostname || os.hostname(),
        pid: old.pid || process.pid,
        project: old.project || "default",
      };
      writeRegistry({ sessions: [entry] });

      // 3. Rename old file to backup
      const backupPath = path.join(gitmemDir, "active-session.json.migrated");
      fs.renameSync(oldPath, backupPath);

      console.error(
        `[active-sessions] Migrated legacy active-session.json → ` +
        `sessions/${old.session_id.slice(0, 8)}/ + active-sessions.json (backup: active-session.json.migrated)`
      );
      return true;
    });
  } catch (error) {
    console.warn("[active-sessions] Legacy migration failed (non-fatal):", error);
    return false;
  }
}

/**
 * Reset migration flag (for testing only).
 */
export function resetMigrationFlag(): void {
  migrationRan = false;
}

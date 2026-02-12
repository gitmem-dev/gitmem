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
import { getGitmemDir, getSessionPath } from "./gitmem-dir.js";
import { ActiveSessionsRegistrySchema } from "../schemas/active-sessions.js";
import type { ActiveSessionEntry, ActiveSessionsRegistry } from "../types/index.js";
import { withLockSync } from "./file-lock.js";

const REGISTRY_FILENAME = "active-sessions.json";
const LOCK_FILENAME = "active-sessions.lock";
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const ADOPT_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours — adopt dead-PID sessions if recent

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
 */
export function registerSession(entry: ActiveSessionEntry): void {
  withLockSync(getLockPath(), () => {
    const registry = readRegistry();
    // Remove by session_id AND by hostname+pid to prevent duplicates
    registry.sessions = registry.sessions.filter((s) =>
      s.session_id !== entry.session_id &&
      !(s.hostname === entry.hostname && s.pid === entry.pid)
    );
    registry.sessions.push(entry);
    writeRegistry(registry);
  });
  console.error(
    `[active-sessions] Registered session ${entry.session_id.slice(0, 8)} (agent: ${entry.agent}, pid: ${entry.pid})`
  );
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
 * Prune stale sessions from the registry (GIT-22 enhanced).
 *
 * A session is stale if:
 * 1. Its started_at is older than 24 hours, OR
 * 2. Its PID no longer exists on this hostname (process died without cleanup), OR
 * 3. Its per-session directory/session.json is missing (orphaned registry entry)
 *
 * Also cleans up per-session directories for pruned sessions,
 * and removes orphaned session directories with no registry entry.
 * Returns the number of sessions pruned.
 */
export function pruneStale(): number {
  return withLockSync(getLockPath(), () => {
    const registry = readRegistry();
    const now = Date.now();
    const currentHostname = os.hostname();
    const currentPid = process.pid;
    const before = registry.sessions.length;
    const gitmemDir = getGitmemDir();
    let adopted = false;

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

      // Check if PID is alive (only for sessions on the same host)
      if (entry.hostname === currentHostname) {
        try {
          process.kill(entry.pid, 0); // Signal 0 = check existence only
        } catch {
          // PID is dead. If session is recent, adopt it into the current process
          // instead of pruning. This handles MCP server restarts during context
          // compaction where the hostname stays the same but the PID changes.
          if (age < ADOPT_THRESHOLD_MS) {
            console.error(
              `[active-sessions] Adopting orphaned session ${entry.session_id.slice(0, 8)} (dead pid ${entry.pid} → ${currentPid})`
            );
            entry.pid = currentPid;
            adopted = true;
            return true; // Keep in registry with updated PID
          }
          console.error(
            `[active-sessions] Pruning dead session ${entry.session_id.slice(0, 8)} (pid ${entry.pid} no longer running)`
          );
          cleanupSessionDir(gitmemDir, entry.session_id);
          return false;
        }
      }

      return true;
    });

    const pruned = before - registry.sessions.length;
    if (pruned > 0 || adopted) {
      writeRegistry(registry);
      if (pruned > 0) {
        console.error(`[active-sessions] Pruned ${pruned} stale session(s)`);
      }
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
        agent: old.agent || "CLI",
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

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
import { getGitmemDir } from "./gitmem-dir.js";
import { ActiveSessionsRegistrySchema } from "../schemas/active-sessions.js";
import type { ActiveSessionEntry, ActiveSessionsRegistry } from "../types/index.js";

const REGISTRY_FILENAME = "active-sessions.json";
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
  const registry = readRegistry();
  registry.sessions = registry.sessions.filter((s) => s.session_id !== entry.session_id);
  registry.sessions.push(entry);
  writeRegistry(registry);
  console.error(
    `[active-sessions] Registered session ${entry.session_id.slice(0, 8)} (agent: ${entry.agent}, pid: ${entry.pid})`
  );
}

/**
 * Unregister a session from the active-sessions registry.
 * Returns true if the session was found and removed.
 */
export function unregisterSession(sessionId: string): boolean {
  const registry = readRegistry();
  const before = registry.sessions.length;
  registry.sessions = registry.sessions.filter((s) => s.session_id !== sessionId);
  const removed = registry.sessions.length < before;

  if (removed) {
    writeRegistry(registry);
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
 * Prune stale sessions from the registry.
 *
 * A session is stale if:
 * 1. Its started_at is older than 24 hours, OR
 * 2. Its PID no longer exists on this hostname (process died without cleanup)
 *
 * Also cleans up per-session directories for pruned sessions.
 * Returns the number of sessions pruned.
 */
export function pruneStale(): number {
  const registry = readRegistry();
  const now = Date.now();
  const currentHostname = os.hostname();
  const before = registry.sessions.length;
  const gitmemDir = getGitmemDir();

  registry.sessions = registry.sessions.filter((entry) => {
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
  if (pruned > 0) {
    writeRegistry(registry);
    console.error(`[active-sessions] Pruned ${pruned} stale session(s)`);
  }

  return pruned;
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

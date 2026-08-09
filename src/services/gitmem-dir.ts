/**
 * Resolved .gitmem directory path
 *
 * Solves: process.cwd() changes when agents cd into other repos (e.g., /workspace/gitmem),
 * but .gitmem/ was created in the project root.
 * The MCP server is long-running, so we resolve the path once and cache it.
 *
 * Resolution order:
 * 1. GITMEM_DIR env var (explicit override)
 * 2. Cached path from session_start (most reliable — session_start created the directory)
 * 3. Walk up from process.cwd() looking for existing .gitmem/ sentinels (backward compat)
 * 4. Fall back to ~/.gitmem (developer-scoped, survives across projects/containers)
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";

/**
 * Validate a string intended for use as a single path component (directory name or filename).
 * Rejects path traversal sequences, directory separators, and null bytes.
 * Throws on invalid input — callers should validate before reaching this layer.
 */
export function sanitizePathComponent(value: string, label: string): string {
  if (!value || typeof value !== "string") {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.includes("..") || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`${label} contains invalid characters (path traversal rejected)`);
  }
  return value;
}

let cachedGitmemDir: string | null = null;

/**
 * Set the .gitmem directory path (called by session_start after creating it)
 */
export function setGitmemDir(dir: string): void {
  cachedGitmemDir = dir;
  console.error(`[gitmem-dir] Cached .gitmem path: ${dir}`);
}

/**
 * Get the resolved .gitmem directory path
 *
 * Resolution order:
 * 1. GITMEM_DIR env var (explicit override)
 * 2. Cached path from session_start (most reliable)
 * 3. ~/.gitmem — authoritative, and independent of cwd.
 *
 * GIT-91 removed a cwd walk-up that sat between 2 and 3. Because it derived the
 * answer from process.cwd(), the MCP server and the SessionStart hook — which do
 * not share a cwd — resolved different roots for the same session. Project-scoped
 * roots are still supported, but must be named explicitly via GITMEM_DIR.
 */
export function getGitmemDir(): string {
  // 1. GITMEM_DIR env var (explicit override, highest priority)
  const envDir = process.env.GITMEM_DIR;
  if (envDir) {
    if (!cachedGitmemDir || cachedGitmemDir !== envDir) {
      cachedGitmemDir = envDir;
      console.error(`[gitmem-dir] Using GITMEM_DIR env var: ${envDir}`);
    }
    return envDir;
  }

  // 2. Use cached path from session_start
  if (cachedGitmemDir && fs.existsSync(cachedGitmemDir)) {
    return cachedGitmemDir;
  }

  // 3. ~/.gitmem is authoritative. Not a fallback — the answer.
  //
  //    GIT-91: resolution used to walk up from process.cwd() and adopt any
  //    directory containing active-sessions.json or config.json. That makes the
  //    answer a function of cwd, and the processes sharing a session do not
  //    share a cwd: the MCP server runs from wherever the client launched it,
  //    while the SessionStart hook runs in the repo. So one logical session bound
  //    to two different stores, and writes landed in a root that identity
  //    resolution never read.
  //
  //    No cwd-derived rule can fix that. Tightening the sentinel to require live
  //    state was tried first and does not hold: stale test-written sessions carry
  //    a structurally valid session.json (GIT-92), so the repo still qualified —
  //    and even a perfect liveness test cannot make two processes with different
  //    cwds agree. The only property that guarantees agreement is not depending
  //    on cwd at all.
  //
  //    Project-scoped roots remain reachable, but only by saying so explicitly
  //    via GITMEM_DIR. Nothing is moved or deleted; a project root that still
  //    holds live state is reported loudly, with the exact way to select it.
  const home = getHomeGitmemDir();
  warnAboutStrandedProjectRoots(home);
  return home;
}

/**
 * The developer-scoped root: `<home>/.gitmem`.
 *
 * GITMEM_HOME overrides the base directory. It is distinct from GITMEM_DIR:
 * GITMEM_DIR names the `.gitmem` directory itself and short-circuits resolution
 * entirely, while GITMEM_HOME only relocates the home the fallback is computed
 * from, leaving the precedence chain intact.
 *
 * It exists because os.homedir() reads the OS-level environment, which cannot be
 * redirected from inside a worker thread — process.env there is a JS-level copy
 * that never reaches getenv(). The test suite runs on `pool: "threads"` and
 * writes real session state, so without this there is no way to keep it off the
 * developer's store (GIT-92). The same lever is useful for containers and CI,
 * where HOME is often not where state should live.
 */
export function getHomeGitmemDir(): string {
  const base = process.env.GITMEM_HOME || os.homedir();
  return path.join(base, ".gitmem");
}

/** Report at most one stranded root per process — this runs on a hot path. */
let strandedWarningIssued = false;

/**
 * GIT-91: project-scoped roots above the cwd that hold live state and are no
 * longer read.
 *
 * Exported because stderr is invisible in most MCP clients: session_start puts
 * this in its display, where the user will actually see it. Returns [] on any
 * error — a diagnostic must never break resolution.
 */
/** What a stranded root actually holds, for the session_start notice (R18). */
export interface GitmemRootContents {
  root: string;
  learnings: number;
  threads: number;
  sessions: number;
}

/** Count entries in a store file that may be a bare array or {key: array}. */
function countCollection(file: string, key: string): number {
  try {
    if (!fs.existsSync(file)) return 0;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed && Array.isArray(parsed[key])) return parsed[key].length;
    return 0;
  } catch {
    return 0;
  }
}

/**
 * GIT-91 / R18: what a stranded root contains.
 *
 * The notice has to state counts, not just a path. "Your memory is at another
 * path" is abstract enough to scroll past; "142 learnings, 6 threads are sitting
 * at this path" is not. Detection-without-use only works if the detection says
 * something a user can weigh.
 *
 * Counts are best-effort by design — an unreadable or unexpected file yields 0
 * rather than throwing. A notice that fails to render because one file is
 * malformed would reintroduce exactly the silence this exists to prevent.
 */
export function describeGitmemRoot(root: string): GitmemRootContents {
  let sessions = 0;
  try {
    const sessionsDir = path.join(root, "sessions");
    if (fs.existsSync(sessionsDir)) {
      for (const entry of fs.readdirSync(sessionsDir)) {
        if (fs.existsSync(path.join(sessionsDir, entry, "session.json"))) sessions++;
      }
    }
  } catch {
    // best-effort
  }
  return {
    root,
    learnings: countCollection(path.join(root, "learnings.json"), "learnings"),
    threads: countCollection(path.join(root, "threads.json"), "threads"),
    sessions,
  };
}

export function findStrandedProjectRoots(): string[] {
  try {
    const home = getHomeGitmemDir();
    const stranded: string[] = [];
    let dir = process.cwd();
    const fsRoot = path.parse(dir).root;
    while (dir !== fsRoot) {
      const candidate = path.join(dir, ".gitmem");
      if (candidate !== home && isLiveGitmemRoot(candidate)) stranded.push(candidate);
      dir = path.dirname(dir);
    }
    return stranded;
  } catch {
    return [];
  }
}

/**
 * GIT-91: warn when a project-scoped root still holds live state.
 *
 * Resolution no longer walks up, so such a root is no longer read. It is not
 * touched either — moving a user's memory store is a far worse failure than not
 * reading it. Instead: name the path and the one-line fix, once per process.
 *
 * Silence here would be the same defect as GIT-93's "Proceed freely" — a system
 * reporting a clean state while a store it used to read sits unread.
 */
function warnAboutStrandedProjectRoots(home: string): void {
  if (strandedWarningIssued) return;
  strandedWarningIssued = true;

  try {
    const stranded = findStrandedProjectRoots();
    if (stranded.length === 0) return;

    console.error(
      `[gitmem-dir] Project-scoped .gitmem found with live state, NOT being used: ` +
      `${stranded.join(", ")}. gitmem now resolves ${home} regardless of cwd, so every ` +
      `process in a session agrees on one store (GIT-91). To use a project-scoped root, ` +
      `set GITMEM_DIR=<path> explicitly. Nothing has been moved or deleted.`
    );
  } catch {
    // Diagnostics must never break resolution.
  }
}

/**
 * GIT-91: does this directory hold a gitmem store that is actually in use?
 *
 * Presence of a file is not evidence. The registry in particular is present and
 * empty on any tree a gitmem process has merely passed through, and empty means
 * the opposite of "sessions live here". Test runs leave the same residue
 * (GIT-92), so an unrelated repo can acquire a convincing-looking .gitmem/
 * without ever having held a session.
 *
 * Any ONE of these counts:
 *   - config.json           a deliberate project-scoped install
 *   - a registered session  the registry names at least one
 *   - a real session dir    sessions/<id>/session.json parses with a session_id
 *
 * Exported for tests and diagnostics; the resolution path is the only caller
 * that matters.
 */
export function isLiveGitmemRoot(candidate: string): boolean {
  try {
    if (!fs.existsSync(candidate)) return false;

    // A project-scoped install is deliberate — honour it even when idle.
    if (fs.existsSync(path.join(candidate, "config.json"))) return true;

    const registryPath = path.join(candidate, "active-sessions.json");
    if (fs.existsSync(registryPath)) {
      try {
        const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
        if (Array.isArray(registry.sessions) && registry.sessions.length > 0) return true;
      } catch {
        // Unreadable registry is not evidence of anything. Fall through to the
        // session directories, which are the durable store (GIT-89).
      }
    }

    const sessionsDir = path.join(candidate, "sessions");
    if (!fs.existsSync(sessionsDir)) return false;
    for (const entry of fs.readdirSync(sessionsDir)) {
      const sessionFile = path.join(sessionsDir, entry, "session.json");
      if (!fs.existsSync(sessionFile)) continue; // fixture dir, not a session
      try {
        const data = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
        if (data && typeof data.session_id === "string" && data.session_id) return true;
      } catch {
        // Malformed session file — not evidence.
      }
    }
    return false;
  } catch {
    // Unreadable candidate (permissions, race). Treat as not-live rather than
    // throwing: resolution must always yield a usable root.
    return false;
  }
}

/**
 * Get a file path within the .gitmem directory
 */
export function getGitmemPath(filename: string): string {
  return path.join(getGitmemDir(), filename);
}

/**
 * Get the per-session directory path: .gitmem/sessions/<sessionId>/
 * Creates the directory if it doesn't exist.
 */
export function getSessionDir(sessionId: string): string {
  sanitizePathComponent(sessionId, "sessionId");
  const sessionsDir = path.join(getGitmemDir(), "sessions", sessionId);
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
    console.error(`[gitmem-dir] Created session directory: ${sessionsDir}`);
  }
  return sessionsDir;
}

/**
 * Get a file path within a per-session directory.
 */
export function getSessionPath(sessionId: string, filename: string): string {
  sanitizePathComponent(filename, "filename");
  return path.join(getSessionDir(sessionId), filename);
}

/**
 * Read the "project" field from .gitmem/config.json.
 * Returns null if the file doesn't exist or has no project field.
 *
 * Precedence (handled by callers): explicit param > config.json > "default"
 */
export function getConfigProject(): string | null {
  try {
    const configPath = path.join(getGitmemDir(), "config.json");
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (raw.project && typeof raw.project === "string") {
        return raw.project;
      }
    }
  } catch {
    // File doesn't exist or is invalid — fall through
  }
  return null;
}

/**
 * Check if feedback submission is enabled in .gitmem/config.json
 */
export function isFeedbackEnabled(): boolean {
  try {
    const configPath = path.join(getGitmemDir(), "config.json");
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return raw.feedback_enabled === true;
    }
  } catch { }
  return false;
}

/**
 * Get the install_id from .gitmem/config.json (anonymous install identifier)
 */
export function getInstallId(): string | null {
  try {
    const configPath = path.join(getGitmemDir(), "config.json");
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (raw.install_id && typeof raw.install_id === "string") return raw.install_id;
    }
  } catch { }
  return null;
}

/**
 * Clear the cached path (for testing)
 */
export function clearGitmemDirCache(): void {
  cachedGitmemDir = null;
  // GIT-91: the stranded-root notice is once-per-process, which would otherwise
  // leak between tests that share a module instance.
  strandedWarningIssued = false;
}

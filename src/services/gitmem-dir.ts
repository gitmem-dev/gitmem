/**
 * Resolved .gitmem directory path
 *
 * Solves: process.cwd() changes when agents cd into other repos (e.g., /workspace/gitmem),
 * but .gitmem/ was created in the project root (e.g., /workspace/orchestra/).
 * The MCP server is long-running, so we resolve the path once and cache it.
 *
 * Resolution order:
 * 1. Cached path from session_start (most reliable — session_start created the directory)
 * 2. Walk up from process.cwd() looking for existing .gitmem/ sentinels
 * 3. Fall back to process.cwd()/.gitmem (original behavior)
 */

import * as path from "path";
import * as fs from "fs";

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
 */
export function getGitmemDir(): string {
  // 1. Use cached path from session_start
  if (cachedGitmemDir && fs.existsSync(cachedGitmemDir)) {
    return cachedGitmemDir;
  }

  // 2. Walk up from CWD looking for existing .gitmem directory
  //    Sentinel files checked in priority order:
  //    - active-sessions.json  (multi-session registry, GIT-19)
  //    - config.json           (project-level gitmem config)
  const sentinels = ["active-sessions.json", "config.json"];
  let dir = process.cwd();
  const root = path.parse(dir).root;
  while (dir !== root) {
    const candidate = path.join(dir, ".gitmem");
    for (const sentinel of sentinels) {
      if (fs.existsSync(path.join(candidate, sentinel))) {
        cachedGitmemDir = candidate;
        console.error(`[gitmem-dir] Found .gitmem via walk-up (${sentinel}): ${candidate}`);
        return candidate;
      }
    }
    dir = path.dirname(dir);
  }

  // 3. Fall back to CWD (original behavior)
  const fallback = path.join(process.cwd(), ".gitmem");
  console.error(`[gitmem-dir] Falling back to CWD: ${fallback}`);
  return fallback;
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
 * Clear the cached path (for testing)
 */
export function clearGitmemDirCache(): void {
  cachedGitmemDir = null;
}

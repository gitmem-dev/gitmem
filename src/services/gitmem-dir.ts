/**
 * Resolved .gitmem directory path
 *
 * Solves: process.cwd() changes when agents cd into other repos (e.g., /workspace/gitmem),
 * but .gitmem/ was created in the project root (e.g., /workspace/orchestra/).
 * The MCP server is long-running, so we resolve the path once and cache it.
 *
 * Resolution order:
 * 1. Cached path from session_start (most reliable — session_start created the directory)
 * 2. Walk up from process.cwd() looking for existing .gitmem/active-session.json
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

  // 2. Walk up from CWD looking for existing .gitmem directory with active-session.json
  let dir = process.cwd();
  const root = path.parse(dir).root;
  while (dir !== root) {
    const candidate = path.join(dir, ".gitmem");
    if (fs.existsSync(path.join(candidate, "active-session.json"))) {
      cachedGitmemDir = candidate;
      console.error(`[gitmem-dir] Found .gitmem via walk-up: ${candidate}`);
      return candidate;
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
 * Clear the cached path (for testing)
 */
export function clearGitmemDirCache(): void {
  cachedGitmemDir = null;
}

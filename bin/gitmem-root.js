/**
 * GIT-115: where the CLI puts things, split the same way the server reads them.
 *
 * The store (learnings, threads, sessions, decisions, the closing payload and
 * its template) belongs in the root the server reads. That is resolved exactly
 * as src/services/gitmem-dir.ts does, without a running session: GITMEM_DIR,
 * then GITMEM_HOME/.gitmem, then ~/.gitmem. `init` used to seed <cwd>/.gitmem,
 * which the server has not read since GIT-91, so a fresh install saw no
 * starter lessons and was told its store was "NOT being read".
 *
 * The repo keeps its own .gitmem/ for two things only: config.json with the
 * project name (the SessionStart hook reads it from the repo) and the hook
 * scripts (committed settings refer to them by relative path).
 */

import { join } from "path";
import { homedir } from "os";

/** The root the server reads. */
export function storeRoot() {
  if (process.env.GITMEM_DIR) return process.env.GITMEM_DIR;
  return join(process.env.GITMEM_HOME || homedir(), ".gitmem");
}

/** The repo's .gitmem/: config.json and hooks/ only. */
export function repoGitmemDir(cwd = process.cwd()) {
  return join(cwd, ".gitmem");
}

/** A path shortened to ~ for display. */
export function displayPath(p) {
  const home = homedir();
  return p === home || p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

/**
 * GIT-91: copy a project-scoped .gitmem store into the developer-scoped root.
 *
 * Before v1.0.10 gitmem stored data in <project>/.gitmem. That release moved the
 * default to ~/.gitmem and kept a cwd walk-up so existing stores were still
 * found. GIT-91 removed the walk-up: deriving the root from process.cwd() meant
 * the MCP server and the SessionStart hook — which do not share a cwd — resolved
 * different stores for one session.
 *
 * The consequence for anyone still on a pre-1.0.10 layout is that their store is
 * no longer read. On the free tier that store IS the memory (learnings.json,
 * threads.json), so "my scars vanished after an upgrade" is the experience this
 * command exists to prevent.
 *
 * Design constraints, in order of importance:
 *
 *   COPY, NEVER MOVE. The source is left byte-for-byte intact. If this command
 *   is wrong about anything, the user still has their data where it was. Moving
 *   would make a bad merge unrecoverable.
 *
 *   NEVER OVERWRITE. A file that already exists at the destination wins. The
 *   destination is the live store; the source is, by definition, the one that
 *   has not been read recently. Clobbering current memory with stale memory is
 *   worse than skipping.
 *
 *   REPORT EVERY SKIP. A silent partial migration would leave the user believing
 *   they had merged when they had not — the failure class GIT-93 was about.
 */

import * as fs from "fs";
import * as path from "path";
import { findStrandedProjectRoots, getHomeGitmemDir } from "../services/gitmem-dir.js";

interface MigrationPlan {
  source: string;
  destination: string;
  copied: string[];
  skipped: Array<{ file: string; reason: string }>;
}

/**
 * Project-scoped roots holding live state. Delegates to the shared detector so
 * this command and the session_start notice can never disagree about what
 * counts as a store worth migrating.
 */
export function findProjectRoots(): string[] {
  return findStrandedProjectRoots();
}

/**
 * Recursively copy `from` into `to`, never overwriting an existing file.
 *
 * Returns what was copied and what was left alone, so the caller can report both
 * rather than claiming a clean merge.
 */
function copyTree(
  from: string,
  to: string,
  plan: MigrationPlan,
  relative = ""
): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const rel = relative ? path.join(relative, entry.name) : entry.name;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);

    // Caches and license state are per-install, not memory. Copying them would
    // move a license binding between roots, which is not this command's job.
    if (relative === "" && (entry.name === "cache" || entry.name === "license-cache.json")) {
      plan.skipped.push({ file: rel, reason: "per-install state, not memory" });
      continue;
    }

    if (entry.isDirectory()) {
      copyTree(src, dst, plan, rel);
      continue;
    }
    if (fs.existsSync(dst)) {
      plan.skipped.push({ file: rel, reason: "already exists in destination" });
      continue;
    }
    fs.copyFileSync(src, dst);
    plan.copied.push(rel);
  }
}

export function migrateRoot(source: string, destination: string, dryRun: boolean): MigrationPlan {
  const plan: MigrationPlan = { source, destination, copied: [], skipped: [] };

  if (dryRun) {
    // Walk the same tree without writing, so --dry-run reports the real plan
    // rather than a guess at one.
    const probe = (from: string, to: string, rel = ""): void => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const r = rel ? path.join(rel, entry.name) : entry.name;
        if (rel === "" && (entry.name === "cache" || entry.name === "license-cache.json")) {
          plan.skipped.push({ file: r, reason: "per-install state, not memory" });
          continue;
        }
        if (entry.isDirectory()) { probe(path.join(from, entry.name), path.join(to, entry.name), r); continue; }
        if (fs.existsSync(path.join(to, entry.name))) {
          plan.skipped.push({ file: r, reason: "already exists in destination" });
          continue;
        }
        plan.copied.push(r);
      }
    };
    probe(source, destination);
    return plan;
  }

  copyTree(source, destination, plan);
  return plan;
}

export function main(args: string[]): void {
  const dryRun = args.includes("--dry-run");
  // Must come from the resolver the server uses, not os.homedir() directly.
  // GITMEM_HOME relocates the developer-scoped root, and computing the
  // destination independently sent this command to a different store than the
  // one gitmem reads — under a GITMEM_HOME override it copied into the real
  // ~/.gitmem instead. A migration tool that writes somewhere the product does
  // not read is worse than no tool.
  const home = getHomeGitmemDir();

  const explicitIdx = args.indexOf("--from");
  const explicit = explicitIdx !== -1 ? args[explicitIdx + 1] : null;

  const sources = explicit ? [path.resolve(explicit)] : findProjectRoots();

  if (sources.length === 0) {
    console.log("No project-scoped .gitmem store found above the current directory.");
    console.log(`Nothing to migrate — ${home} is already the store gitmem reads.`);
    return;
  }

  if (sources.length > 1) {
    console.log(`Found ${sources.length} project-scoped stores:\n`);
    sources.forEach((s) => console.log(`  ${s}`));
    console.log(`\nMigrate them one at a time so each result is reviewable:`);
    console.log(`  npx gitmem-mcp migrate-root --from ${sources[0]}`);
    return;
  }

  const source = sources[0];
  if (source === home) {
    console.log(`Source and destination are the same (${home}). Nothing to do.`);
    return;
  }

  console.log(`${dryRun ? "Would copy" : "Copying"} gitmem store`);
  console.log(`  from: ${source}`);
  console.log(`    to: ${home}\n`);

  const plan = migrateRoot(source, home, dryRun);

  console.log(`${plan.copied.length} file(s) ${dryRun ? "would be " : ""}copied.`);
  if (plan.skipped.length > 0) {
    console.log(`${plan.skipped.length} skipped:`);
    for (const s of plan.skipped) console.log(`  ${s.file} — ${s.reason}`);
  }

  console.log(
    `\nThe source was NOT modified. ${source} is still intact — verify the result ` +
    `before deleting anything.`
  );
  if (dryRun) console.log("\nRe-run without --dry-run to apply.");
}

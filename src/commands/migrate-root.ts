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
 *   NEVER OVERWRITE a non-memory file. One that already exists at the
 *   destination wins; the destination is the live store.
 *
 *   MERGE THE MEMORY FILES (GIT-100). learnings.json, threads.json,
 *   decisions.json and sessions.json used to be skipped as "already exists" —
 *   so a store with ANY local memory at the destination migrated none of the
 *   project store's memory, and the report listed the user's scars under
 *   "skipped". They are now merged by record id: new ids are added; where both
 *   sides hold a record, the newer (updated_at, else resolved_at /
 *   last_touched_at / created_at) wins, the destination on a tie or when
 *   neither is dated; every loser is written to migrate-root-conflicts.json.
 *   The destination's memory files are backed up before the first write.
 *   Re-running is idempotent: nothing changes, and a conflict is logged once.
 *   A memory file that cannot be read as a list of records is reported as NOT
 *   merged — never as skipped.
 *
 *   REPORT EVERY SKIP. A silent partial migration would leave the user believing
 *   they had merged when they had not — the failure class GIT-93 was about.
 */

import * as fs from "fs";
import * as path from "path";
import { findStrandedProjectRoots, getHomeGitmemDir, sameDirectory } from "../services/gitmem-dir.js";

/** Memory files merged by record id instead of skipped (GIT-100). */
export const MERGED_FILES = ["learnings.json", "threads.json", "decisions.json", "sessions.json"] as const;
const CONFLICTS_FILE = "migrate-root-conflicts.json";

export interface MergeReport {
  file: string;
  added: number;
  updated: number;
  unchanged: number;
  /** Both sides held the record and the destination's was kept. */
  kept_destination: number;
  /** Conflicts written to the conflicts file by this run (already-logged ones are not repeated). */
  conflicts_logged: number;
}

interface MigrationPlan {
  source: string;
  destination: string;
  copied: string[];
  skipped: Array<{ file: string; reason: string }>;
  merged: MergeReport[];
  /** Memory files that could not be merged. Never silently skipped. */
  failed: Array<{ file: string; reason: string }>;
  /** Where the destination's memory files were backed up, when anything was written. */
  backup?: string;
  conflicts_file?: string;
}

type MemoryRecord = Record<string, unknown> & { id: string };

interface ConflictEntry {
  file: string;
  id: string;
  kept: "destination" | "source";
  kept_timestamp: string | null;
  lost_timestamp: string | null;
  lost_record: unknown;
  logged_at: string;
}

const RECENCY_FIELDS = ["updated_at", "resolved_at", "last_touched_at", "created_at"] as const;

function recency(r: MemoryRecord): { at: number | null; raw: string | null } {
  for (const f of RECENCY_FIELDS) {
    const v = r[f];
    if (typeof v === "string") {
      const at = Date.parse(v);
      if (Number.isFinite(at)) return { at, raw: v };
    }
  }
  return { at: null, raw: null };
}

/** Key-order-independent JSON, so re-serialized records compare equal. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function readRecords(file: string): { ok: true; records: MemoryRecord[] } | { ok: false; reason: string } {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    return { ok: false, reason: `unreadable JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!Array.isArray(data)) return { ok: false, reason: "not a list of records" };
  const bad = data.findIndex((r) => !r || typeof r !== "object" || typeof (r as { id?: unknown }).id !== "string");
  if (bad !== -1) return { ok: false, reason: `record ${bad} has no string id` };
  return { ok: true, records: data as MemoryRecord[] };
}

interface PlannedMerge {
  report: MergeReport;
  merged: MemoryRecord[];
  conflicts: Omit<ConflictEntry, "logged_at">[];
  changed: boolean;
}

/** Merge source into destination by id. Pure: returns the result, writes nothing. */
function planMerge(file: string, dest: MemoryRecord[], src: MemoryRecord[]): PlannedMerge {
  const report: MergeReport = { file, added: 0, updated: 0, unchanged: 0, kept_destination: 0, conflicts_logged: 0 };
  const conflicts: Omit<ConflictEntry, "logged_at">[] = [];
  const merged = dest.slice();
  const index = new Map(merged.map((r, i) => [r.id, i]));

  for (const s of src) {
    const i = index.get(s.id);
    if (i === undefined) {
      index.set(s.id, merged.length);
      merged.push(s);
      report.added++;
      continue;
    }
    const d = merged[i];
    if (stable(d) === stable(s)) { report.unchanged++; continue; }
    const rd = recency(d), rs = recency(s);
    const sourceNewer = rs.at !== null && (rd.at === null || rs.at > rd.at);
    if (sourceNewer) {
      merged[i] = s;
      report.updated++;
      conflicts.push({ file, id: s.id, kept: "source", kept_timestamp: rs.raw, lost_timestamp: rd.raw, lost_record: d });
    } else {
      report.kept_destination++;
      conflicts.push({ file, id: s.id, kept: "destination", kept_timestamp: rd.raw, lost_timestamp: rs.raw, lost_record: s });
    }
  }
  return { report, merged, conflicts, changed: report.added > 0 || report.updated > 0 };
}

/**
 * Project-scoped roots holding live state. Delegates to the shared detector so
 * this command and the session_start notice can never disagree about what
 * counts as a store worth migrating.
 */
export function findProjectRoots(): string[] {
  return findStrandedProjectRoots();
}

const isPerInstall = (relative: string, name: string) =>
  relative === "" && (name === "cache" || name === "license-cache.json" || name === "backups" || name === CONFLICTS_FILE);

const isMergedFile = (relative: string, name: string) =>
  relative === "" && (MERGED_FILES as readonly string[]).includes(name);

/**
 * Walk `from`, planning (and unless dryRun, performing) the copy of every
 * non-memory file that does not exist at `to`. Memory files present on both
 * sides are collected for merging instead.
 */
function walk(
  from: string,
  to: string,
  plan: MigrationPlan,
  dryRun: boolean,
  toMerge: string[],
  relative = ""
): void {
  if (!dryRun) fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const rel = relative ? path.join(relative, entry.name) : entry.name;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);

    // Caches and license state are per-install, not memory. Copying them would
    // move a license binding between roots, which is not this command's job.
    // Backups and the conflicts log belong to the root they were written in.
    if (isPerInstall(relative, entry.name)) {
      plan.skipped.push({ file: rel, reason: "per-install state, not memory" });
      continue;
    }

    if (entry.isDirectory()) {
      walk(src, dst, plan, dryRun, toMerge, rel);
      continue;
    }
    if (fs.existsSync(dst)) {
      if (isMergedFile(relative, entry.name)) {
        toMerge.push(entry.name);
      } else {
        plan.skipped.push({ file: rel, reason: "already exists in destination" });
      }
      continue;
    }
    if (!dryRun) fs.copyFileSync(src, dst);
    plan.copied.push(rel);
  }
}

function loadConflicts(file: string): ConflictEntry[] {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

const conflictKey = (c: Omit<ConflictEntry, "logged_at">) => `${c.file}\n${c.id}\n${stable(c.lost_record)}`;

export function migrateRoot(source: string, destination: string, dryRun: boolean): MigrationPlan {
  const plan: MigrationPlan = { source, destination, copied: [], skipped: [], merged: [], failed: [] };
  const toMerge: string[] = [];

  // Walk the same tree either way, so --dry-run reports the real plan rather
  // than a guess at one.
  walk(source, destination, plan, dryRun, toMerge);

  // Memory files on both sides: merge by record id (GIT-100).
  const planned: Array<PlannedMerge & { name: string }> = [];
  for (const name of toMerge) {
    const d = readRecords(path.join(destination, name));
    const s = readRecords(path.join(source, name));
    if (!d.ok || !s.ok) {
      const reason = !d.ok ? `destination ${d.reason}` : `source ${(s as { reason: string }).reason}`;
      plan.failed.push({ file: name, reason: `NOT merged: ${reason}` });
      continue;
    }
    planned.push({ name, ...planMerge(name, d.records, s.records) });
  }

  const conflictsPath = path.join(destination, CONFLICTS_FILE);
  const logged = loadConflicts(conflictsPath);
  const seen = new Set(logged.map(conflictKey));
  const newConflicts: ConflictEntry[] = [];
  const now = new Date().toISOString();
  for (const p of planned) {
    for (const c of p.conflicts) {
      const k = conflictKey(c);
      if (seen.has(k)) continue;
      seen.add(k);
      newConflicts.push({ ...c, logged_at: now });
      p.report.conflicts_logged++;
    }
    plan.merged.push(p.report);
  }
  if (newConflicts.length > 0 || logged.length > 0) plan.conflicts_file = conflictsPath;

  const writes = planned.filter((p) => p.changed);
  if (dryRun || (writes.length === 0 && newConflicts.length === 0)) return plan;

  // Back up the destination's memory files before the first write.
  if (writes.length > 0) {
    const backup = path.join(destination, "backups", `migrate-root-${now.replace(/[:.]/g, "-")}`);
    fs.mkdirSync(backup, { recursive: true });
    for (const name of MERGED_FILES) {
      const f = path.join(destination, name);
      if (fs.existsSync(f)) fs.copyFileSync(f, path.join(backup, name));
    }
    plan.backup = backup;
  }

  for (const p of writes) {
    const target = path.join(destination, p.name);
    const tmpFile = `${target}.migrate-${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(p.merged, null, 2));
    fs.renameSync(tmpFile, target);
  }
  if (newConflicts.length > 0) {
    fs.writeFileSync(conflictsPath, JSON.stringify([...logged, ...newConflicts], null, 2));
  }
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
  if (sameDirectory(source, home)) { // GIT-107: symlinks, /var vs /private/var
    console.log(`Source and destination are the same (${home}). Nothing to do.`);
    return;
  }

  console.log(`${dryRun ? "Would copy" : "Copying"} gitmem store`);
  console.log(`  from: ${source}`);
  console.log(`    to: ${home}\n`);

  const plan = migrateRoot(source, home, dryRun);

  console.log(`${plan.copied.length} file(s) ${dryRun ? "would be " : ""}copied.`);
  if (plan.merged.length > 0) {
    console.log(`${plan.merged.length} memory file(s) ${dryRun ? "would be " : ""}merged by record id:`);
    for (const m of plan.merged) {
      console.log(
        `  ${m.file} — ${m.added} added, ${m.updated} updated from the source, ${m.unchanged} unchanged, ` +
        `${m.kept_destination} kept from the destination` +
        (m.conflicts_logged > 0 ? `, ${m.conflicts_logged} conflict(s) ${dryRun ? "would be " : ""}logged` : "")
      );
    }
  }
  if (plan.failed.length > 0) {
    console.log(`${plan.failed.length} memory file(s) NOT merged — fix these and re-run:`);
    for (const f of plan.failed) console.log(`  ${f.file} — ${f.reason}`);
    process.exitCode = 1;
  }
  if (plan.backup) console.log(`Destination memory files backed up to ${plan.backup}`);
  if (plan.conflicts_file) console.log(`Conflicting records (the version not kept) are in ${plan.conflicts_file}`);
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

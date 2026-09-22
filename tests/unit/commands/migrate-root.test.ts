/**
 * GIT-91: migrate-root copies a stranded project store into the root gitmem reads.
 *
 * Removing the cwd walk-up leaves pre-v1.0.10 stores unread. On the free tier
 * that store IS the memory, so this command is the difference between "gitmem
 * changed where it looks" and "my scars vanished after an upgrade".
 *
 * The properties below are the ones that make it safe to run on a store you
 * cannot afford to lose. Each is a way this could destroy data rather than
 * merely fail:
 *
 *   copies, never moves        — a wrong call leaves the original intact
 *   never overwrites           — a non-memory file at the destination wins
 *   merges memory by id        — GIT-100: learnings/threads/decisions/sessions
 *                                .json were skipped as "already exists", so a
 *                                destination with any memory received none
 *   reports every skip         — a partial merge is never reported as complete
 *   writes where gitmem reads  — this one was a real bug: main() computed the
 *                                destination with os.homedir() instead of the
 *                                shared resolver, so under a GITMEM_HOME
 *                                override it wrote into the real ~/.gitmem.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { migrateRoot } from "../../../src/commands/migrate-root.js";

let tmp: string;
let source: string;
let destination: string;

const read = (p: string): string => fs.readFileSync(p, "utf-8");

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-migrate-"));
  source = path.join(tmp, "project", ".gitmem");
  destination = path.join(tmp, "home", ".gitmem");
  fs.mkdirSync(path.join(source, "sessions", "s1"), { recursive: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(source, "learnings.json"), '{"learnings":["old"]}');
  fs.writeFileSync(path.join(source, "threads.json"), '{"threads":["old-thread"]}');
  fs.writeFileSync(path.join(source, "sessions", "s1", "session.json"), '{"session_id":"s1"}');
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("GIT-91: migrate-root", () => {
  it("copies memory files into the destination", () => {
    const plan = migrateRoot(source, destination, false);

    expect(plan.copied).toContain("learnings.json");
    expect(plan.copied).toContain("threads.json");
    expect(read(path.join(destination, "learnings.json"))).toBe('{"learnings":["old"]}');
  });

  it("copies nested session directories", () => {
    migrateRoot(source, destination, false);

    expect(fs.existsSync(path.join(destination, "sessions", "s1", "session.json"))).toBe(true);
  });

  it("leaves the source byte-for-byte intact", () => {
    const before = read(path.join(source, "learnings.json"));

    migrateRoot(source, destination, false);

    expect(fs.existsSync(path.join(source, "learnings.json"))).toBe(true);
    expect(read(path.join(source, "learnings.json"))).toBe(before);
  });

  it("never overwrites a non-memory file that already exists in the destination", () => {
    // GIT-100: this used learnings.json and asserted it was skipped, i.e. the
    // project store's memory was dropped whenever the destination had any.
    // Memory files are merged now (below); other files keep this rule.
    fs.writeFileSync(path.join(source, "config.json"), '{"project":"old"}');
    fs.writeFileSync(path.join(destination, "config.json"), '{"project":"CURRENT"}');

    const plan = migrateRoot(source, destination, false);

    expect(read(path.join(destination, "config.json"))).toBe('{"project":"CURRENT"}');
    expect(plan.copied).not.toContain("config.json");
    expect(plan.skipped.map((s) => s.file)).toContain("config.json");
  });

  it("reports why each file was skipped", () => {
    fs.writeFileSync(path.join(source, "config.json"), "{}");
    fs.writeFileSync(path.join(destination, "config.json"), "{}");

    const plan = migrateRoot(source, destination, false);

    const skip = plan.skipped.find((s) => s.file === "config.json");
    // A silent partial merge would read as a complete one.
    expect(skip?.reason).toMatch(/already exists/i);
  });

  it("does not carry per-install state across roots", () => {
    fs.mkdirSync(path.join(source, "cache"), { recursive: true });
    fs.writeFileSync(path.join(source, "cache", "hook-scars.json"), "[]");
    fs.writeFileSync(path.join(source, "license-cache.json"), "{}");

    const plan = migrateRoot(source, destination, false);

    // Moving a license binding between roots is not this command's job.
    expect(fs.existsSync(path.join(destination, "license-cache.json"))).toBe(false);
    expect(plan.skipped.map((s) => s.file)).toContain("license-cache.json");
    expect(plan.skipped.map((s) => s.file)).toContain("cache");
  });

  it("writes nothing in dry-run, and reports the same plan it would apply", () => {
    const dry = migrateRoot(source, destination, true);

    expect(fs.existsSync(path.join(destination, "learnings.json"))).toBe(false);

    const applied = migrateRoot(source, destination, false);
    expect(dry.copied.sort()).toEqual(applied.copied.sort());
  });
});

// ===========================================================================
// GIT-100: memory files are merged by record id, not skipped
// ===========================================================================

const ts = (h: number) => `2026-09-${String(h).padStart(2, "0")}T00:00:00.000Z`;
const writeJson = (p: string, v: unknown) => fs.writeFileSync(p, JSON.stringify(v, null, 2));
const readJson = (p: string) => JSON.parse(read(p));
const ids = (p: string) => readJson(p).map((r: { id: string }) => r.id);

describe("GIT-100: migrate-root merges memory files by record id", () => {
  beforeEach(() => {
    for (const f of ["learnings.json", "threads.json", "decisions.json", "sessions.json"]) {
      fs.rmSync(path.join(source, f), { force: true });
    }
    writeJson(path.join(source, "learnings.json"), [
      { id: "L-src-only", title: "only in project store", updated_at: ts(1) },
      { id: "L-both-src-newer", title: "project edit", updated_at: ts(10) },
      { id: "L-both-dst-newer", title: "stale project copy", updated_at: ts(2) },
      { id: "L-same", title: "identical", updated_at: ts(3) },
    ]);
    writeJson(path.join(destination, "learnings.json"), [
      { id: "L-dst-only", title: "only in home store", updated_at: ts(4) },
      { id: "L-both-src-newer", title: "old home copy", updated_at: ts(5) },
      { id: "L-both-dst-newer", title: "home edit", updated_at: ts(9) },
      { updated_at: ts(3), title: "identical", id: "L-same" }, // same record, different key order
    ]);
    writeJson(path.join(source, "threads.json"), [{ id: "t-src", text: "project thread", created_at: ts(1) }]);
    writeJson(path.join(destination, "threads.json"), [{ id: "t-dst", text: "home thread", created_at: ts(2) }]);
    writeJson(path.join(source, "decisions.json"), [{ id: "D1", title: "undated A" }]);
    writeJson(path.join(destination, "decisions.json"), [{ id: "D1", title: "undated B" }]);
    writeJson(path.join(source, "sessions.json"), [{ id: "S-src", session_date: "2026-09-01" }]);
  });

  it("never lists a memory file under skipped", () => {
    const plan = migrateRoot(source, destination, false);
    const skipped = plan.skipped.map((s) => s.file);
    for (const f of ["learnings.json", "threads.json", "decisions.json", "sessions.json"]) expect(skipped).not.toContain(f);
  });

  it("adds new ids, keeps destination-only ids, and the newer record wins", () => {
    const plan = migrateRoot(source, destination, false);
    const merged = readJson(path.join(destination, "learnings.json"));
    const byId = Object.fromEntries(merged.map((r: { id: string; title: string }) => [r.id, r.title]));

    expect(byId).toEqual({
      "L-dst-only": "only in home store",
      "L-both-src-newer": "project edit",   // source newer: replaced
      "L-both-dst-newer": "home edit",      // destination newer: kept
      "L-same": "identical",
      "L-src-only": "only in project store",
    });
    expect(plan.merged.find((m) => m.file === "learnings.json")).toMatchObject({
      added: 1, updated: 1, unchanged: 1, kept_destination: 1, conflicts_logged: 2,
    });
    expect(ids(path.join(destination, "threads.json")).sort()).toEqual(["t-dst", "t-src"]);
  });

  it("a memory file only in the source is copied", () => {
    const plan = migrateRoot(source, destination, false);
    expect(plan.copied).toContain("sessions.json");
    expect(ids(path.join(destination, "sessions.json"))).toEqual(["S-src"]);
  });

  it("undated records that differ: the destination is kept and the loser logged", () => {
    migrateRoot(source, destination, false);
    expect(readJson(path.join(destination, "decisions.json"))).toEqual([{ id: "D1", title: "undated B" }]);
    const conflicts = readJson(path.join(destination, "migrate-root-conflicts.json"));
    expect(conflicts.find((c: { id: string }) => c.id === "D1")).toMatchObject({ kept: "destination", lost_record: { id: "D1", title: "undated A" } });
  });

  it("logs every loser, with which side was kept", () => {
    migrateRoot(source, destination, false);
    const conflicts = readJson(path.join(destination, "migrate-root-conflicts.json"));
    const learningConflicts = conflicts.filter((c: { file: string }) => c.file === "learnings.json");
    expect(learningConflicts).toHaveLength(2);
    expect(learningConflicts.find((c: { id: string }) => c.id === "L-both-src-newer")).toMatchObject({
      kept: "source", lost_record: { title: "old home copy" }, kept_timestamp: ts(10), lost_timestamp: ts(5),
    });
    expect(learningConflicts.find((c: { id: string }) => c.id === "L-both-dst-newer")).toMatchObject({
      kept: "destination", lost_record: { title: "stale project copy" },
    });
  });

  it("backs up the destination's memory files before writing", () => {
    const before = read(path.join(destination, "learnings.json"));
    const plan = migrateRoot(source, destination, false);
    expect(plan.backup).toBeDefined();
    expect(read(path.join(plan.backup!, "learnings.json"))).toBe(before);
    expect(fs.existsSync(path.join(plan.backup!, "threads.json"))).toBe(true);
  });

  it("is idempotent: a re-run changes nothing, backs up nothing, logs nothing new", () => {
    migrateRoot(source, destination, false);
    const snapshot = ["learnings.json", "threads.json", "decisions.json", "sessions.json", "migrate-root-conflicts.json"]
      .map((f) => read(path.join(destination, f)));

    const again = migrateRoot(source, destination, false);

    expect(["learnings.json", "threads.json", "decisions.json", "sessions.json", "migrate-root-conflicts.json"]
      .map((f) => read(path.join(destination, f)))).toEqual(snapshot);
    expect(again.backup).toBeUndefined();
    for (const m of again.merged) {
      expect(m.added).toBe(0);
      expect(m.updated).toBe(0);
      expect(m.conflicts_logged).toBe(0);
    }
  });

  it("leaves the source intact", () => {
    const before = read(path.join(source, "learnings.json"));
    migrateRoot(source, destination, false);
    expect(read(path.join(source, "learnings.json"))).toBe(before);
  });

  it("dry-run writes nothing but reports the same merge", () => {
    const before = read(path.join(destination, "learnings.json"));
    const dry = migrateRoot(source, destination, true);
    expect(read(path.join(destination, "learnings.json"))).toBe(before);
    expect(fs.existsSync(path.join(destination, "migrate-root-conflicts.json"))).toBe(false);
    expect(fs.existsSync(path.join(destination, "backups"))).toBe(false);

    const applied = migrateRoot(source, destination, false);
    expect(dry.merged).toEqual(applied.merged);
  });

  it("an unreadable memory file is reported as NOT merged, never skipped, and left untouched", () => {
    fs.writeFileSync(path.join(destination, "threads.json"), "{ not json");
    const plan = migrateRoot(source, destination, false);
    expect(plan.failed).toEqual([{ file: "threads.json", reason: expect.stringMatching(/^NOT merged: destination unreadable JSON/) }]);
    expect(plan.skipped.map((s) => s.file)).not.toContain("threads.json");
    expect(read(path.join(destination, "threads.json"))).toBe("{ not json");
  });

  it("does not migrate backups or the conflicts log out of a source that has them", () => {
    fs.mkdirSync(path.join(source, "backups", "old"), { recursive: true });
    fs.writeFileSync(path.join(source, "migrate-root-conflicts.json"), "[]");
    const plan = migrateRoot(source, destination, false);
    expect(plan.copied.some((f) => f.startsWith("backups"))).toBe(false);
    expect(plan.copied).not.toContain("migrate-root-conflicts.json");
  });
});

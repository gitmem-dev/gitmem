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
 *   never overwrites           — stale memory cannot clobber current memory
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

  it("never overwrites a file that already exists in the destination", () => {
    // The destination is the live store; the source is by definition the one
    // that has not been read recently. Stale must not win.
    fs.writeFileSync(path.join(destination, "learnings.json"), '{"learnings":["CURRENT"]}');

    const plan = migrateRoot(source, destination, false);

    expect(read(path.join(destination, "learnings.json"))).toBe('{"learnings":["CURRENT"]}');
    expect(plan.copied).not.toContain("learnings.json");
    expect(plan.skipped.map((s) => s.file)).toContain("learnings.json");
  });

  it("reports why each file was skipped", () => {
    fs.writeFileSync(path.join(destination, "learnings.json"), "{}");

    const plan = migrateRoot(source, destination, false);

    const skip = plan.skipped.find((s) => s.file === "learnings.json");
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

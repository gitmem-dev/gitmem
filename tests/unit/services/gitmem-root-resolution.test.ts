/**
 * GIT-91: the .gitmem root must not depend on process.cwd().
 *
 * Resolution used to walk up from cwd and adopt any directory containing
 * active-sessions.json or config.json. The processes that share a session do not
 * share a cwd — the MCP server runs from wherever the client launched it, the
 * SessionStart hook runs in the repo — so one logical session bound to two
 * different stores, and writes landed in a root that identity resolution never
 * read. On the machine where this was found there were three such roots.
 *
 * Tightening the sentinel to require live state was the first attempt and does
 * not hold: test-written sessions carry a structurally valid session.json
 * (GIT-92), so a repo containing only stale test residue still qualified. And
 * even a perfect liveness check cannot make two processes with different cwds
 * agree — the dependency on cwd is the defect, not the strictness of the test.
 *
 * So the invariant under test is not "picks the best root". It is "picks the
 * SAME root from anywhere". Everything else here supports that.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  getGitmemDir,
  clearGitmemDirCache,
  getHomeGitmemDir,
  isLiveGitmemRoot,
  describeGitmemRoot,
} from "../../../src/services/gitmem-dir.js";

const HOME_ROOT = getHomeGitmemDir();
let tmp: string;
const originalEnv = process.env.GITMEM_DIR;

/**
 * vitest workers forbid changing the working directory, so cwd is stubbed.
 * That is closer to the real defect anyway: the point is that resolution READS
 * cwd, and the processes sharing a session report different values for it.
 */
function atCwd(dir: string): void {
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  clearGitmemDirCache();
}

/** A .gitmem holding one structurally valid session — what tests leave behind. */
function seedSessionRoot(dir: string, sessionId = "aaaaaaaa-1111-2222-3333-444444444444"): string {
  const gitmem = path.join(dir, ".gitmem");
  fs.mkdirSync(path.join(gitmem, "sessions", sessionId), { recursive: true });
  fs.writeFileSync(path.join(gitmem, "active-sessions.json"), JSON.stringify({ sessions: [] }));
  fs.writeFileSync(
    path.join(gitmem, "sessions", sessionId, "session.json"),
    JSON.stringify({ session_id: sessionId, agent: "cli", project: "gitmem_test" })
  );
  return gitmem;
}

describe("GIT-91: .gitmem root resolution is independent of cwd", () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-root-"));
    delete process.env.GITMEM_DIR;
    clearGitmemDirCache();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    clearGitmemDirCache();
    if (originalEnv === undefined) delete process.env.GITMEM_DIR;
    else process.env.GITMEM_DIR = originalEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("resolves the same root from inside a project that has its own .gitmem", () => {
    seedSessionRoot(tmp);

    atCwd(tmp);
    const fromProject = getGitmemDir();

    atCwd(os.tmpdir());
    const fromElsewhere = getGitmemDir();

    // The whole bug in one assertion: these used to differ.
    expect(fromProject).toBe(fromElsewhere);
    expect(fromProject).toBe(HOME_ROOT);
  });

  it("does not adopt a project root left behind by a test run", () => {
    // Structurally valid session, stale — indistinguishable from a real one,
    // which is why a liveness check was not enough (GIT-92).
    seedSessionRoot(tmp);
    atCwd(tmp);

    expect(getGitmemDir()).toBe(HOME_ROOT);
  });

  it("does not adopt a project root that merely contains an empty registry", () => {
    const gitmem = path.join(tmp, ".gitmem");
    fs.mkdirSync(gitmem, { recursive: true });
    fs.writeFileSync(path.join(gitmem, "active-sessions.json"), JSON.stringify({ sessions: [] }));
    atCwd(tmp);

    expect(getGitmemDir()).toBe(HOME_ROOT);
  });

  it("honours GITMEM_DIR, which is now the only way to select a project root", () => {
    const explicit = path.join(tmp, "explicit-root");
    fs.mkdirSync(explicit, { recursive: true });
    process.env.GITMEM_DIR = explicit;
    atCwd(os.tmpdir());

    expect(getGitmemDir()).toBe(explicit);
  });

  it("reports a stranded project root instead of silently ignoring it", () => {
    seedSessionRoot(tmp);
    atCwd(tmp);
    const errors: string[] = [];
    (console.error as unknown as { mockImplementation: (f: (m: string) => void) => void })
      .mockImplementation((m: string) => { errors.push(String(m)); });

    getGitmemDir();

    const notice = errors.find((e) => e.includes("NOT being used"));
    expect(notice, "a root holding live state that is no longer read must be reported").toBeTruthy();
    expect(notice).toContain("GITMEM_DIR");
    // Never move or delete a user's memory store to make resolution tidy.
    expect(notice).toContain("Nothing has been moved or deleted");
  });
});

describe("GIT-91: isLiveGitmemRoot only counts real evidence", () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-live-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("counts a deliberate project-scoped install (config.json)", () => {
    const gitmem = path.join(tmp, ".gitmem");
    fs.mkdirSync(gitmem, { recursive: true });
    fs.writeFileSync(path.join(gitmem, "config.json"), JSON.stringify({ project: "x" }));

    expect(isLiveGitmemRoot(gitmem)).toBe(true);
  });

  it("counts a registry naming at least one session", () => {
    const gitmem = path.join(tmp, ".gitmem");
    fs.mkdirSync(gitmem, { recursive: true });
    fs.writeFileSync(
      path.join(gitmem, "active-sessions.json"),
      JSON.stringify({ sessions: [{ session_id: "abc", pid: 1 }] })
    );

    expect(isLiveGitmemRoot(gitmem)).toBe(true);
  });

  it("does not count an empty registry — that means the opposite", () => {
    const gitmem = path.join(tmp, ".gitmem");
    fs.mkdirSync(gitmem, { recursive: true });
    fs.writeFileSync(path.join(gitmem, "active-sessions.json"), JSON.stringify({ sessions: [] }));

    expect(isLiveGitmemRoot(gitmem)).toBe(false);
  });

  it("does not count session directories with no session.json", () => {
    const gitmem = path.join(tmp, ".gitmem");
    // Exactly the residue found in the wild: named like sessions, empty inside.
    for (const name of ["original-session", "test-session-2", "test-session-clean"]) {
      fs.mkdirSync(path.join(gitmem, "sessions", name), { recursive: true });
    }

    expect(isLiveGitmemRoot(gitmem)).toBe(false);
  });

  it("does not throw on a missing or unreadable candidate", () => {
    expect(isLiveGitmemRoot(path.join(tmp, "does-not-exist"))).toBe(false);
  });
});

/**
 * R18 acceptance: detection-without-use must state what the stranded store
 * HOLDS, not merely that one exists.
 *
 * The ruling rejected a read-only compatibility fallback — reading the legacy
 * path with a warning keeps the cross-process disagreement the fix exists to
 * kill, because the hook and the server still resolve differently. Detection
 * replaces it, and detection only works if the user can weigh what they are
 * told: "your memory is at another path" is abstract enough to scroll past,
 * "3 learnings, 2 sessions are sitting there" is not.
 */
describe("R18: describeGitmemRoot reports what a stranded store holds", () => {
  let store: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-counts-"));
    store = path.join(tmp, ".gitmem");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("counts learnings, threads and sessions in a populated legacy store", () => {
    fs.mkdirSync(path.join(store, "sessions", "s1"), { recursive: true });
    fs.mkdirSync(path.join(store, "sessions", "s2"), { recursive: true });
    fs.writeFileSync(path.join(store, "sessions", "s1", "session.json"), '{"session_id":"s1"}');
    fs.writeFileSync(path.join(store, "sessions", "s2", "session.json"), '{"session_id":"s2"}');
    fs.writeFileSync(path.join(store, "learnings.json"), JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]));
    fs.writeFileSync(path.join(store, "threads.json"), JSON.stringify([{ id: "t1" }]));

    const c = describeGitmemRoot(store);

    expect(c.learnings).toBe(3);
    expect(c.threads).toBe(1);
    expect(c.sessions).toBe(2);
  });

  it("does not count a session directory with no session.json", () => {
    fs.mkdirSync(path.join(store, "sessions", "test-session-2"), { recursive: true });

    expect(describeGitmemRoot(store).sessions).toBe(0);
  });

  it("handles the {key: array} file shape as well as a bare array", () => {
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(
      path.join(store, "learnings.json"),
      JSON.stringify({ learnings: [{ id: 1 }, { id: 2 }] })
    );

    expect(describeGitmemRoot(store).learnings).toBe(2);
  });

  it("returns zeros rather than throwing on a malformed store", () => {
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, "learnings.json"), "not json at all");

    // A notice that failed to render because one file is corrupt would
    // reintroduce exactly the silence detection exists to prevent.
    expect(() => describeGitmemRoot(store)).not.toThrow();
    expect(describeGitmemRoot(store).learnings).toBe(0);
  });

  it("reports zeros for a root that does not exist", () => {
    expect(describeGitmemRoot(path.join(tmp, "nope", ".gitmem")))
      .toMatchObject({ learnings: 0, threads: 0, sessions: 0 });
  });
});

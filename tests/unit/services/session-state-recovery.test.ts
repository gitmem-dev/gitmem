/**
 * GIT-51: session identity recovery after an MCP server restart.
 *
 * Session identity lives in an in-memory `currentSession` that dies with the
 * process. The MCP server restarts routinely mid-session (context compaction,
 * rebuild, client restart), and until GIT-51 nothing rebuilt that state except
 * session_start — which agents don't call again mid-session. The result was
 * "No active session" for every session-required tool, and a close that could
 * not resolve which session to close.
 *
 * These tests exercise the real registry and real session files (temp dir)
 * rather than module mocks, because the defect was in how those two stores
 * relate to each other.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { setGitmemDir, clearGitmemDirCache } from "../../../src/services/gitmem-dir.js";
import { registerSession, listActiveSessions } from "../../../src/services/active-sessions.js";
import {
  setCurrentSession,
  clearCurrentSession,
  resolveCurrentSession,
  getCurrentSession,
  getSurfacedScars,
  addSurfacedScars,
} from "../../../src/services/session-state.js";
import type { SurfacedScar } from "../../../src/types/index.js";

const HOSTNAME = os.hostname();
const DEAD_PID = 99999999; // very unlikely to be a real PID

let tmpDir: string;

const MOCK_SCARS: SurfacedScar[] = [
  {
    scar_id: "aaaa1111-1111-1111-1111-111111111111",
    scar_title: "Trace execution path first",
    title: "Trace execution path first",
    severity: "high",
    surfaced_at: "2026-02-22T10:00:00.000Z",
    source: "recall",
  },
  {
    scar_id: "bbbb2222-2222-2222-2222-222222222222",
    scar_title: "Done != Deployed",
    title: "Done != Deployed",
    severity: "high",
    surfaced_at: "2026-02-22T10:00:00.000Z",
    source: "recall",
  },
] as SurfacedScar[];

/**
 * Simulate a session that was started by a now-dead server process:
 * a registry entry with a dead PID plus the session file it wrote.
 */
function seedOrphanedSession(opts: {
  sessionId: string;
  startedAt?: string;
  pid?: number;
  scars?: SurfacedScar[];
  project?: string;
}): void {
  const startedAt = opts.startedAt || new Date().toISOString();
  registerSession({
    session_id: opts.sessionId,
    agent: "cli",
    started_at: startedAt,
    hostname: HOSTNAME,
    pid: opts.pid ?? DEAD_PID,
    project: opts.project || "gitmem",
  });

  const sessionDir = path.join(tmpDir, "sessions", opts.sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "session.json"),
    JSON.stringify({
      session_id: opts.sessionId,
      agent: "cli",
      started_at: startedAt,
      project: opts.project || "gitmem",
      hostname: HOSTNAME,
      pid: opts.pid ?? DEAD_PID,
      surfaced_scars: opts.scars ?? MOCK_SCARS,
      threads: [],
    })
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-git51-"));
  setGitmemDir(tmpDir);
  clearCurrentSession();
});

afterEach(() => {
  clearCurrentSession();
  clearGitmemDirCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveCurrentSession() — restart recovery", () => {
  it("re-binds identity after a restart (dead PID + session file on disk)", () => {
    const sessionId = "11111111-1111-1111-1111-111111111111";
    seedOrphanedSession({ sessionId });

    // In-memory state is null — exactly what a restarted server sees.
    const resolved = resolveCurrentSession();

    expect(resolved).not.toBeNull();
    expect(resolved!.sessionId).toBe(sessionId);
    expect(resolved!.surfacedScars).toHaveLength(2);
    expect(resolved!.project).toBe("gitmem");
  });

  it("recovers a session older than the old 2h adoption window", () => {
    // Regression test for ADOPT_THRESHOLD_MS: real sessions routinely run
    // longer than two hours, so the sessions most in need of recovery were
    // precisely the ones the old window excluded.
    const sessionId = "22222222-2222-2222-2222-222222222222";
    seedOrphanedSession({
      sessionId,
      startedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    });

    const resolved = resolveCurrentSession();

    expect(resolved).not.toBeNull();
    expect(resolved!.sessionId).toBe(sessionId);
    expect(resolved!.surfacedScars).toHaveLength(2);
  });

  it("rebinds the registry entry to the current PID so close can find it", () => {
    const sessionId = "33333333-3333-3333-3333-333333333333";
    seedOrphanedSession({ sessionId });

    resolveCurrentSession();

    const entries = listActiveSessions();
    expect(entries).toHaveLength(1);
    expect(entries[0].session_id).toBe(sessionId);
    expect(entries[0].pid).toBe(process.pid);
  });

  it("preserves surfaced_scars through the restart", () => {
    const sessionId = "44444444-4444-4444-4444-444444444444";
    seedOrphanedSession({ sessionId });

    const scars = getSurfacedScars();

    expect(scars.map((s) => s.scar_id)).toEqual([
      "aaaa1111-1111-1111-1111-111111111111",
      "bbbb2222-2222-2222-2222-222222222222",
    ]);
  });

  it("returns the in-memory session without touching disk when one is active", () => {
    setCurrentSession({
      sessionId: "live-session",
      agent: "cli",
      startedAt: new Date(),
    });
    addSurfacedScars(MOCK_SCARS);

    // A stale orphan exists, but the live session must win.
    seedOrphanedSession({ sessionId: "55555555-5555-5555-5555-555555555555" });

    expect(getCurrentSession()!.sessionId).toBe("live-session");
  });

  it("returns null when there is genuinely no session", () => {
    expect(resolveCurrentSession()).toBeNull();
    expect(getSurfacedScars()).toEqual([]);
  });

  it("does not invent a session from a registry entry with no session file", () => {
    registerSession({
      session_id: "66666666-6666-6666-6666-666666666666",
      agent: "cli",
      started_at: new Date().toISOString(),
      hostname: HOSTNAME,
      pid: DEAD_PID,
      project: "gitmem",
    });

    expect(resolveCurrentSession()).toBeNull();
  });

  it("ignores sessions belonging to other hosts", () => {
    const sessionId = "77777777-7777-7777-7777-777777777777";
    registerSession({
      session_id: sessionId,
      agent: "cli",
      started_at: new Date().toISOString(),
      hostname: "some-other-container",
      pid: DEAD_PID,
      project: "gitmem",
    });
    const sessionDir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "session.json"),
      JSON.stringify({ session_id: sessionId, surfaced_scars: MOCK_SCARS })
    );

    expect(resolveCurrentSession()).toBeNull();
  });

  it("handles a corrupted session.json without throwing", () => {
    const sessionId = "88888888-8888-8888-8888-888888888888";
    seedOrphanedSession({ sessionId });
    fs.writeFileSync(
      path.join(tmpDir, "sessions", sessionId, "session.json"),
      "not valid json{{{"
    );

    expect(resolveCurrentSession()).toBeNull();
    expect(getSurfacedScars()).toEqual([]);
  });
});

describe("getSurfacedScars() — cross-session isolation", () => {
  it("never hands one session another concurrent session's scars", () => {
    // Two sessions on one host. The live one owns this PID; the other is a
    // different agent's orphan. The pre-GIT-51 fallback picked "newest session
    // on this host" regardless of PID, which could return the wrong scars.
    const otherScars = [
      {
        scar_id: "cccc3333-3333-3333-3333-333333333333",
        scar_title: "Someone else's scar",
        title: "Someone else's scar",
        severity: "high",
        surfaced_at: "2026-02-22T12:00:00.000Z",
        source: "recall",
      },
    ] as SurfacedScar[];

    const mineId = "aaaaaaaa-0000-0000-0000-000000000001";
    const theirsId = "bbbbbbbb-0000-0000-0000-000000000002";

    // Mine started earlier; theirs is newer — so "newest wins" would pick theirs.
    seedOrphanedSession({
      sessionId: mineId,
      pid: process.pid,
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    seedOrphanedSession({
      sessionId: theirsId,
      startedAt: new Date().toISOString(),
      scars: otherScars,
    });

    const resolved = resolveCurrentSession();

    expect(resolved!.sessionId).toBe(mineId);
    expect(getSurfacedScars().map((s) => s.scar_id)).toEqual([
      "aaaa1111-1111-1111-1111-111111111111",
      "bbbb2222-2222-2222-2222-222222222222",
    ]);
  });
});

// ---------------------------------------------------------------------------
// GIT-51 reconciliation (GIT-69 sprint): the two ruled fixes
// ---------------------------------------------------------------------------

/** Seed a session whose session.json and registry entry disagree on project. */
function seedConflictingSession(opts: {
  sessionId: string;
  registryProject: string;
  fileProject: string;
}): void {
  const startedAt = new Date().toISOString();
  registerSession({
    session_id: opts.sessionId,
    agent: "cli",
    started_at: startedAt,
    hostname: HOSTNAME,
    pid: DEAD_PID,
    project: opts.registryProject,
  });

  const sessionDir = path.join(tmpDir, "sessions", opts.sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "session.json"),
    JSON.stringify({
      session_id: opts.sessionId,
      agent: "cli",
      started_at: startedAt,
      project: opts.fileProject,
      hostname: HOSTNAME,
      pid: DEAD_PID,
      surfaced_scars: [],
      threads: [],
    })
  );
}

describe("recovery retries when the registry changes", () => {
  it("finds a session registered AFTER an earlier failed recovery", () => {
    // The SessionStart hook runs as a separate CLI process (scar 55d1bccd), so
    // a session can appear in the registry after this process already tried and
    // failed. A plain boolean latch made that permanent — and with GIT-67's R5
    // guard refusing sessionless writes, one early miss would refuse every
    // write for the life of the process. Fail-closed replacing fail-open.
    expect(resolveCurrentSession()).toBeNull();

    seedOrphanedSession({ sessionId: "cccc3333-3333-3333-3333-333333333333" });

    const recovered = resolveCurrentSession();
    expect(recovered).not.toBeNull();
    expect(recovered?.sessionId).toBe("cccc3333-3333-3333-3333-333333333333");
  });

  it("does not re-read while the registry is unchanged", () => {
    // The latch still exists — it just is not permanent. Two consecutive
    // failures with no registry change stay null without thrashing the disk.
    expect(resolveCurrentSession()).toBeNull();
    expect(resolveCurrentSession()).toBeNull();
  });
});

describe("project disagreement between session.json and the registry", () => {
  it("flags the conflict instead of resolving it silently", () => {
    seedConflictingSession({
      sessionId: "dddd4444-4444-4444-4444-444444444444",
      registryProject: "weekend_warrior",
      fileProject: "gitmem",
    });

    const recovered = resolveCurrentSession();

    expect(recovered?.recoveryConflict).toBe(true);
  });

  it("keeps session.json authoritative, as documented", () => {
    seedConflictingSession({
      sessionId: "eeee5555-5555-5555-5555-555555555555",
      registryProject: "weekend_warrior",
      fileProject: "gitmem",
    });

    // Precedence is unchanged from the original `||` — what changed is that it
    // is now stated and the disagreement is recorded. GIT-69's scope resolver
    // keys on this project, so a silent wrong value scopes the whole session to
    // the wrong namespace.
    expect(resolveCurrentSession()?.project).toBe("gitmem");
  });

  it("does not flag a conflict when the two agree", () => {
    seedOrphanedSession({
      sessionId: "ffff6666-6666-6666-6666-666666666666",
      project: "gitmem",
    });

    const recovered = resolveCurrentSession();

    expect(recovered?.project).toBe("gitmem");
    expect(recovered?.recoveryConflict).toBeFalsy();
  });
});

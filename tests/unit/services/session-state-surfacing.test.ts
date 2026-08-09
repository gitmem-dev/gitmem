/**
 * GIT-89: recall/confirm_scars must fail (or succeed) together.
 *
 * The two halves of the protocol used to fail asymmetrically. recall() returned
 * scars with a soft "No active session" banner and dropped them from tracking;
 * confirm_scars() hard-rejected the same condition. The agent saw scars, acted
 * on them, and a later confirm reported "no scars to confirm" — a green result
 * that actually meant the surfacing had been discarded (scar 810a1624).
 *
 * addSurfacedScars was the discard point: it read the in-memory session
 * directly, and on null logged a console warning and returned void. Nothing
 * downstream could tell a tracked recall from an untracked one.
 *
 * These tests use the real registry and real session files in a temp dir — the
 * defect was in how in-memory state, disk state, and the return contract relate.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { setGitmemDir, clearGitmemDirCache } from "../../../src/services/gitmem-dir.js";
import {
  setCurrentSession,
  clearCurrentSession,
  addSurfacedScars,
  getSurfacedScars,
  setRecallCalled,
  isRecallCalled,
} from "../../../src/services/session-state.js";
import type { SurfacedScar } from "../../../src/types/index.js";

const HOSTNAME = os.hostname();
const DEAD_PID = 99999999;

let tmpDir: string;

const SCARS: SurfacedScar[] = [
  {
    scar_id: "aaaa1111-1111-1111-1111-111111111111",
    scar_title: "Trace execution path first",
    severity: "high",
    surfaced_at: "2026-08-08T10:00:00.000Z",
    source: "recall",
  },
  {
    scar_id: "bbbb2222-2222-2222-2222-222222222222",
    scar_title: "Done != Deployed",
    severity: "high",
    surfaced_at: "2026-08-08T10:00:00.000Z",
    source: "recall",
  },
] as SurfacedScar[];

function sessionFilePath(sessionId: string): string {
  return path.join(tmpDir, "sessions", sessionId, "session.json");
}

/** Write a session.json as session_start would, with no registry entry. */
function seedSessionFile(sessionId: string, overrides: Record<string, unknown> = {}): void {
  const dir = path.join(tmpDir, "sessions", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    sessionFilePath(sessionId),
    JSON.stringify({
      session_id: sessionId,
      agent: "cli",
      started_at: new Date().toISOString(),
      hostname: HOSTNAME,
      pid: process.pid,
      project: "orchestra_dev",
      surfaced_scars: [],
      threads: [],
      ...overrides,
    })
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-git89-"));
  setGitmemDir(tmpDir);
  clearCurrentSession();
});

afterEach(() => {
  clearCurrentSession();
  clearGitmemDirCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("addSurfacedScars reports whether tracking happened (GIT-89)", () => {
  it("returns false when there is genuinely no session", () => {
    // The signal recall needs in order to warn as loudly as confirm_scars does,
    // instead of printing scars as though they were recorded.
    expect(addSurfacedScars(SCARS)).toBe(false);
  });

  it("returns true when the scars were tracked", () => {
    const sessionId = "11111111-1111-1111-1111-111111111111";
    seedSessionFile(sessionId);
    setCurrentSession({
      sessionId,
      project: "orchestra_dev",
      startedAt: new Date(),
    });

    expect(addSurfacedScars(SCARS)).toBe(true);
    expect(getSurfacedScars()).toHaveLength(2);
  });

  it("tracks against a session recovered from disk rather than discarding", () => {
    // The exact production shape: the MCP server restarted, so in-memory state
    // is gone, but the session is alive and its file is on disk. Before GIT-89
    // this returned void after a console warning and the scars vanished.
    const sessionId = "22222222-2222-2222-2222-222222222222";
    seedSessionFile(sessionId, { pid: DEAD_PID });

    expect(addSurfacedScars(SCARS)).toBe(true);
    expect(getSurfacedScars().map((s) => s.scar_id)).toEqual([
      "aaaa1111-1111-1111-1111-111111111111",
      "bbbb2222-2222-2222-2222-222222222222",
    ]);
  });

  it("deduplicates by scar_id across repeated recalls", () => {
    const sessionId = "33333333-3333-3333-3333-333333333333";
    seedSessionFile(sessionId);
    setCurrentSession({ sessionId, project: "orchestra_dev", startedAt: new Date() });

    addSurfacedScars(SCARS);
    addSurfacedScars(SCARS);

    expect(getSurfacedScars()).toHaveLength(2);
  });
});

describe("surfacing survives the process that recorded it (GIT-89)", () => {
  it("writes surfaced scars through to session.json", () => {
    // Surfacing held only in memory is lost to the next restart, which turns an
    // identity break into a tracking break.
    const sessionId = "44444444-4444-4444-4444-444444444444";
    seedSessionFile(sessionId);
    setCurrentSession({ sessionId, project: "orchestra_dev", startedAt: new Date() });

    addSurfacedScars(SCARS);

    const data = JSON.parse(fs.readFileSync(sessionFilePath(sessionId), "utf-8"));
    expect(data.surfaced_scars).toHaveLength(2);
    expect(data.surfaced_scars[0].scar_id).toBe("aaaa1111-1111-1111-1111-111111111111");
  });

  it("write-through covers the free tier path too", () => {
    // The old inline write lived in recall's pro-tier branch only, so free-tier
    // surfacing was memory-only and did not survive a restart at all.
    const sessionId = "55555555-5555-5555-5555-555555555555";
    seedSessionFile(sessionId, { pid: DEAD_PID });

    expect(addSurfacedScars(SCARS)).toBe(true);

    const data = JSON.parse(fs.readFileSync(sessionFilePath(sessionId), "utf-8"));
    expect(data.surfaced_scars).toHaveLength(2);
  });

  it("a restart between recall and confirm still sees the surfaced scars", () => {
    const sessionId = "66666666-6666-6666-6666-666666666666";
    seedSessionFile(sessionId);
    setCurrentSession({ sessionId, project: "orchestra_dev", startedAt: new Date() });
    addSurfacedScars(SCARS);

    // MCP server restart: in-memory state dies, disk survives.
    clearCurrentSession();

    expect(getSurfacedScars()).toHaveLength(2);
  });

  it("preserves unrelated session state when persisting scars", () => {
    const sessionId = "77777777-7777-7777-7777-777777777777";
    seedSessionFile(sessionId, {
      threads: [{ id: "t1", status: "open" }],
      recording_path: "/tmp/recording.jsonl",
    });
    setCurrentSession({ sessionId, project: "orchestra_dev", startedAt: new Date() });

    addSurfacedScars(SCARS);

    const data = JSON.parse(fs.readFileSync(sessionFilePath(sessionId), "utf-8"));
    expect(data.threads).toHaveLength(1);
    expect(data.recording_path).toBe("/tmp/recording.jsonl");
    expect(data.surfaced_scars).toHaveLength(2);
  });

  it("does not fail the call when the session file is unwritable", () => {
    // Persistence is best-effort — losing the write must not lose the tracking.
    const sessionId = "88888888-8888-8888-8888-888888888888";
    setCurrentSession({ sessionId, project: "orchestra_dev", startedAt: new Date() });

    // No session.json on disk at all.
    expect(addSurfacedScars(SCARS)).toBe(true);
    expect(getSurfacedScars()).toHaveLength(2);
  });
});

describe("recall_called survives a restart (GIT-89)", () => {
  it("persists the flag to session.json", () => {
    const sessionId = "aaaa0000-0000-0000-0000-000000000001";
    seedSessionFile(sessionId);
    setCurrentSession({ sessionId, project: "orchestra_dev", startedAt: new Date() });

    setRecallCalled();

    const data = JSON.parse(fs.readFileSync(sessionFilePath(sessionId), "utf-8"));
    expect(data.recall_called).toBe(true);
  });

  it("still reports recall as called after in-memory state is lost", () => {
    // Enforcement Check 3 reads this flag. Held only in memory, every
    // create_learning / create_decision / session_close after a restart warned
    // "No recall() was run this session" in sessions where it plainly had —
    // the same false-alarm class as the "No active session" banner.
    const sessionId = "aaaa0000-0000-0000-0000-000000000002";
    seedSessionFile(sessionId);
    setCurrentSession({ sessionId, project: "orchestra_dev", startedAt: new Date() });
    setRecallCalled();

    clearCurrentSession(); // MCP server restart

    expect(isRecallCalled()).toBe(true);
  });

  it("stays false when recall genuinely never ran", () => {
    // The warning has to remain true when it fires.
    const sessionId = "aaaa0000-0000-0000-0000-000000000003";
    seedSessionFile(sessionId, { pid: DEAD_PID });

    expect(isRecallCalled()).toBe(false);
  });

  it("does not rewrite the file once the flag is already set", () => {
    const sessionId = "aaaa0000-0000-0000-0000-000000000004";
    seedSessionFile(sessionId, { recall_called: true });
    setCurrentSession({ sessionId, project: "orchestra_dev", startedAt: new Date() });

    const before = fs.statSync(sessionFilePath(sessionId)).mtimeMs;
    setRecallCalled();

    expect(fs.statSync(sessionFilePath(sessionId)).mtimeMs).toBe(before);
  });
});

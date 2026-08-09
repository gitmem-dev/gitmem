/**
 * GIT-89 AC#4: session_close must resolve the correct session after an MCP
 * restart without the agent passing session_id.
 *
 * The runtime was always written for this — sessionClose() guards
 * `params.session_id &&` before validating the format, and recovers identity
 * when it is absent — but SessionCloseParamsSchema marked the field required.
 * The MCP layer therefore rejected the call with "session_id: Required" before
 * sessionClose() ever ran, so the recovery branch was unreachable in the only
 * scenario it existed for. A restart (or a context compaction) takes the id
 * away from the agent, which is precisely when close matters most: the failure
 * lands after the reflection has been written and has nowhere to go.
 *
 * These tests pin both halves — the schema contract and the disk resolution —
 * because fixing either one alone leaves the acceptance criterion unmet.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { setGitmemDir, clearGitmemDirCache } from "../../../src/services/gitmem-dir.js";
import { clearCurrentSession, resolveCurrentSession } from "../../../src/services/session-state.js";
import { SessionCloseParamsSchema } from "../../../src/schemas/session-close.js";

const SESSION_ID = "7f3a9c21-4b5d-4e6f-8a90-1b2c3d4e5f60";
let tmpRoot: string;

/** A session left on disk by a process that no longer exists — i.e. a restart. */
function seedOrphanedSession(sessionId: string, deadPid: number): void {
  const dir = path.join(tmpRoot, "sessions", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "session.json"),
    JSON.stringify({
      session_id: sessionId,
      agent: "cli",
      project: "gitmem",
      started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      hostname: os.hostname(),
      pid: deadPid,
      host_pid: deadPid,
      surfaced_scars: [{ scar_id: "535e0e42", title: "registry cannot rescue a lost registry" }],
      recall_called: true,
    })
  );
  // The registry is empty — the store that gets lost on restart.
  fs.writeFileSync(path.join(tmpRoot, "active-sessions.json"), JSON.stringify({ sessions: [] }));
}

describe("GIT-89 AC#4: session_close resolves identity after a restart", () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-close-identity-"));
    clearGitmemDirCache();
    setGitmemDir(tmpRoot);
    clearCurrentSession();
  });

  afterEach(() => {
    clearCurrentSession();
    clearGitmemDirCache();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("schema contract", () => {
    it("accepts a close with no session_id, so the recovery branch is reachable", () => {
      const result = SessionCloseParamsSchema.safeParse({ close_type: "quick" });
      expect(result.success).toBe(true);
    });

    it("still rejects a malformed session_id when one is supplied", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "../../etc/passwd",
        close_type: "quick",
      });
      expect(result.success).toBe(false);
    });

    it("accepts a well-formed session_id", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: SESSION_ID,
        close_type: "quick",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("disk resolution", () => {
    it("recovers the orphaned session id that close would otherwise have to be told", () => {
      seedOrphanedSession(SESSION_ID, 999_991);

      const resolved = resolveCurrentSession();

      expect(resolved).not.toBeNull();
      expect(resolved?.sessionId).toBe(SESSION_ID);
    });

    it("carries the surfacing forward, so a close after a restart still reflects it", () => {
      seedOrphanedSession(SESSION_ID, 999_991);

      const resolved = resolveCurrentSession();

      expect(resolved?.surfacedScars).toHaveLength(1);
      expect(resolved?.recallCalled).toBe(true);
    });

    it("returns null when there is genuinely no session, rather than inventing one", () => {
      fs.mkdirSync(path.join(tmpRoot, "sessions"), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, "active-sessions.json"), JSON.stringify({ sessions: [] }));

      expect(resolveCurrentSession()).toBeNull();
    });
  });
});

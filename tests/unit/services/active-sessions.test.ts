/**
 * Unit tests for active-sessions.ts (GIT-19)
 *
 * Tests CRUD operations, atomic writes, stale pruning,
 * and corruption recovery using temp directories.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { setGitmemDir, clearGitmemDirCache } from "../../../src/services/gitmem-dir.js";
import {
  registerSession,
  unregisterSession,
  listActiveSessions,
  findSessionByHostPid,
  findSessionById,
  pruneStale,
} from "../../../src/services/active-sessions.js";
import type { ActiveSessionEntry } from "../../../src/types/index.js";

let tmpDir: string;

function makeEntry(overrides: Partial<ActiveSessionEntry> = {}): ActiveSessionEntry {
  return {
    session_id: overrides.session_id || "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    agent: overrides.agent || "CLI",
    started_at: overrides.started_at || new Date().toISOString(),
    hostname: overrides.hostname || os.hostname(),
    pid: overrides.pid ?? process.pid,
    project: overrides.project || "orchestra_dev",
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-test-"));
  setGitmemDir(tmpDir);
});

afterEach(() => {
  clearGitmemDirCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("registerSession", () => {
  it("creates registry file and adds entry when file does not exist", () => {
    const entry = makeEntry();
    registerSession(entry);

    const sessions = listActiveSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].session_id).toBe(entry.session_id);
  });

  it("appends to existing registry", () => {
    const entry1 = makeEntry({ session_id: "11111111-1111-1111-1111-111111111111", pid: 1001 });
    const entry2 = makeEntry({ session_id: "22222222-2222-2222-2222-222222222222", pid: 1002 });

    registerSession(entry1);
    registerSession(entry2);

    const sessions = listActiveSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.session_id)).toContain(entry1.session_id);
    expect(sessions.map((s) => s.session_id)).toContain(entry2.session_id);
  });

  it("is idempotent — re-registering same session_id replaces entry", () => {
    const entry = makeEntry({ pid: 1001 });
    registerSession(entry);

    const updated = makeEntry({ pid: 1002 }); // same session_id, different pid
    registerSession(updated);

    const sessions = listActiveSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].pid).toBe(1002);
  });

  it("creates registry file in existing .gitmem directory", () => {
    // The .gitmem dir must exist first (session_start creates it)
    const nestedDir = path.join(tmpDir, "sub", "deep");
    fs.mkdirSync(nestedDir, { recursive: true });
    setGitmemDir(nestedDir);

    registerSession(makeEntry());

    expect(fs.existsSync(path.join(nestedDir, "active-sessions.json"))).toBe(true);
  });
});

describe("unregisterSession", () => {
  it("removes session by ID and returns true", () => {
    const entry = makeEntry();
    registerSession(entry);

    const result = unregisterSession(entry.session_id);
    expect(result).toBe(true);
    expect(listActiveSessions()).toHaveLength(0);
  });

  it("returns false when session not found", () => {
    const result = unregisterSession("nonexistent-0000-0000-0000-000000000000");
    expect(result).toBe(false);
  });

  it("preserves other sessions in registry", () => {
    const entry1 = makeEntry({ session_id: "11111111-1111-1111-1111-111111111111", pid: 1001 });
    const entry2 = makeEntry({ session_id: "22222222-2222-2222-2222-222222222222", pid: 1002 });

    registerSession(entry1);
    registerSession(entry2);
    unregisterSession(entry1.session_id);

    const sessions = listActiveSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].session_id).toBe(entry2.session_id);
  });
});

describe("listActiveSessions", () => {
  it("returns empty array when no registry file", () => {
    expect(listActiveSessions()).toEqual([]);
  });

  it("returns all registered sessions", () => {
    registerSession(makeEntry({ session_id: "11111111-1111-1111-1111-111111111111" }));
    registerSession(makeEntry({ session_id: "22222222-2222-2222-2222-222222222222" }));
    registerSession(makeEntry({ session_id: "33333333-3333-3333-3333-333333333333" }));

    expect(listActiveSessions()).toHaveLength(3);
  });

  it("returns empty array when registry is corrupted JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "active-sessions.json"), "not json at all");
    expect(listActiveSessions()).toEqual([]);
  });

  it("returns empty array when registry fails Zod validation", () => {
    fs.writeFileSync(
      path.join(tmpDir, "active-sessions.json"),
      JSON.stringify({ sessions: [{ bad: "data" }] })
    );
    expect(listActiveSessions()).toEqual([]);
  });
});

describe("findSessionByHostPid", () => {
  it("finds matching session", () => {
    const entry = makeEntry({ hostname: "test-host", pid: 9999 });
    registerSession(entry);

    const found = findSessionByHostPid("test-host", 9999);
    expect(found).not.toBeNull();
    expect(found!.session_id).toBe(entry.session_id);
  });

  it("returns null when no match", () => {
    registerSession(makeEntry({ hostname: "test-host", pid: 9999 }));

    expect(findSessionByHostPid("other-host", 9999)).toBeNull();
    expect(findSessionByHostPid("test-host", 1111)).toBeNull();
  });

  it("requires both hostname AND pid to match", () => {
    registerSession(makeEntry({ hostname: "host-A", pid: 100 }));
    registerSession(makeEntry({
      session_id: "22222222-2222-2222-2222-222222222222",
      hostname: "host-B",
      pid: 200,
    }));

    expect(findSessionByHostPid("host-A", 200)).toBeNull();
    expect(findSessionByHostPid("host-B", 100)).toBeNull();
  });
});

describe("findSessionById", () => {
  it("finds session by UUID", () => {
    const entry = makeEntry();
    registerSession(entry);

    const found = findSessionById(entry.session_id);
    expect(found).not.toBeNull();
    expect(found!.agent).toBe("CLI");
  });

  it("returns null for unknown ID", () => {
    expect(findSessionById("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("pruneStale", () => {
  it("removes sessions older than 24 hours", () => {
    const stale = makeEntry({
      session_id: "11111111-1111-1111-1111-111111111111",
      started_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
      hostname: "other-host", // different host so PID check is skipped
      pid: 99999,
    });
    const fresh = makeEntry({
      session_id: "22222222-2222-2222-2222-222222222222",
      started_at: new Date().toISOString(),
    });

    registerSession(stale);
    registerSession(fresh);

    const pruned = pruneStale();
    expect(pruned).toBe(1);

    const sessions = listActiveSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].session_id).toBe(fresh.session_id);
  });

  it("removes sessions with dead PIDs on same host", () => {
    const dead = makeEntry({
      session_id: "11111111-1111-1111-1111-111111111111",
      hostname: os.hostname(),
      pid: 99999999, // very unlikely to be a real PID
    });

    registerSession(dead);

    const pruned = pruneStale();
    expect(pruned).toBe(1);
    expect(listActiveSessions()).toHaveLength(0);
  });

  it("keeps sessions with live PIDs", () => {
    const live = makeEntry({
      hostname: os.hostname(),
      pid: process.pid, // this process is alive
    });

    registerSession(live);

    const pruned = pruneStale();
    expect(pruned).toBe(0);
    expect(listActiveSessions()).toHaveLength(1);
  });

  it("keeps sessions on different hosts regardless of PID", () => {
    const remote = makeEntry({
      hostname: "some-other-container",
      pid: 99999999, // dead PID but on different host
    });

    registerSession(remote);

    const pruned = pruneStale();
    expect(pruned).toBe(0);
    expect(listActiveSessions()).toHaveLength(1);
  });

  it("returns 0 when nothing to prune", () => {
    registerSession(makeEntry());
    expect(pruneStale()).toBe(0);
  });

  it("cleans up session directories for pruned sessions", () => {
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const sessionDir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "session.json"), "{}");

    registerSession(
      makeEntry({
        session_id: sessionId,
        started_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        hostname: "other-host",
      })
    );

    pruneStale();

    expect(fs.existsSync(sessionDir)).toBe(false);
  });
});

describe("registry corruption recovery", () => {
  it("handles empty file gracefully", () => {
    fs.writeFileSync(path.join(tmpDir, "active-sessions.json"), "");
    expect(listActiveSessions()).toEqual([]);

    // Can still write after corruption
    registerSession(makeEntry());
    expect(listActiveSessions()).toHaveLength(1);
  });

  it("handles malformed JSON gracefully", () => {
    fs.writeFileSync(path.join(tmpDir, "active-sessions.json"), "{broken json");
    expect(listActiveSessions()).toEqual([]);
  });

  it("handles valid JSON that fails Zod validation", () => {
    fs.writeFileSync(
      path.join(tmpDir, "active-sessions.json"),
      JSON.stringify({ sessions: "not-an-array" })
    );
    expect(listActiveSessions()).toEqual([]);
  });
});

describe("atomic write behavior", () => {
  it("does not leave temp files on success", () => {
    registerSession(makeEntry());

    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("produces valid JSON after register and unregister", () => {
    const entry = makeEntry();
    registerSession(entry);
    unregisterSession(entry.session_id);

    const raw = fs.readFileSync(path.join(tmpDir, "active-sessions.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.sessions).toEqual([]);
  });
});

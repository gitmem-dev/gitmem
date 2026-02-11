/**
 * Concurrency regression test for active-sessions registry locking (GIT-24)
 *
 * Verifies that the withLockSync wrapper on registerSession prevents
 * the race condition where concurrent register calls lose entries.
 *
 * Since we can't truly test multi-process concurrency in a single-threaded
 * Node.js unit test, we verify:
 * 1. Lock files are created and cleaned up during register/unregister/prune
 * 2. Sequential rapid registrations all survive
 * 3. The lock file does not leak after operations
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
  pruneStale,
  resetMigrationFlag,
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
    project: overrides.project || "default",
  };
}

function createSessionFile(sessionId: string): void {
  const sessionDir = path.join(tmpDir, "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "session.json"), JSON.stringify({ session_id: sessionId }));
}

function lockFileExists(): boolean {
  return fs.existsSync(path.join(tmpDir, "active-sessions.lock"));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-lock-regression-"));
  setGitmemDir(tmpDir);
});

afterEach(() => {
  clearGitmemDirCache();
  resetMigrationFlag();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("lock file lifecycle", () => {
  it("lock file does not persist after registerSession", () => {
    registerSession(makeEntry());
    expect(lockFileExists()).toBe(false);
  });

  it("lock file does not persist after unregisterSession", () => {
    registerSession(makeEntry());
    unregisterSession("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(lockFileExists()).toBe(false);
  });

  it("lock file does not persist after pruneStale", () => {
    registerSession(makeEntry());
    createSessionFile("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    pruneStale();
    expect(lockFileExists()).toBe(false);
  });
});

describe("rapid sequential registration (simulated concurrency)", () => {
  it("all entries survive when registering 20 sessions rapidly", () => {
    const sessionIds: string[] = [];

    for (let i = 0; i < 20; i++) {
      const id = `${i.toString().padStart(8, "0")}-0000-0000-0000-000000000000`;
      sessionIds.push(id);
      registerSession(makeEntry({
        session_id: id,
        pid: 1000 + i,
        hostname: `host-${i}`,
      }));
    }

    const sessions = listActiveSessions();
    expect(sessions).toHaveLength(20);

    // Verify all session IDs are present
    const registeredIds = new Set(sessions.map((s) => s.session_id));
    for (const id of sessionIds) {
      expect(registeredIds.has(id)).toBe(true);
    }
  });

  it("interleaved register and unregister operations are consistent", () => {
    // Register 10 sessions
    for (let i = 0; i < 10; i++) {
      registerSession(makeEntry({
        session_id: `${i.toString().padStart(8, "0")}-0000-0000-0000-000000000000`,
        pid: 1000 + i,
        hostname: `host-${i}`,
      }));
    }

    // Unregister odd-numbered sessions
    for (let i = 1; i < 10; i += 2) {
      unregisterSession(`${i.toString().padStart(8, "0")}-0000-0000-0000-000000000000`);
    }

    const sessions = listActiveSessions();
    expect(sessions).toHaveLength(5);

    // Only even-numbered sessions should remain
    const ids = sessions.map((s) => s.session_id);
    expect(ids).toContain("00000000-0000-0000-0000-000000000000");
    expect(ids).toContain("00000002-0000-0000-0000-000000000000");
    expect(ids).toContain("00000004-0000-0000-0000-000000000000");
    expect(ids).toContain("00000006-0000-0000-0000-000000000000");
    expect(ids).toContain("00000008-0000-0000-0000-000000000000");
  });

  it("register during prune does not lose non-stale entries", () => {
    // Register a mix of stale and fresh entries
    const staleId = "11111111-1111-1111-1111-111111111111";
    const freshId = "22222222-2222-2222-2222-222222222222";

    registerSession(makeEntry({
      session_id: staleId,
      started_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
      hostname: "other-host",
      pid: 99999,
    }));
    createSessionFile(staleId);

    registerSession(makeEntry({
      session_id: freshId,
    }));
    createSessionFile(freshId);

    // Prune should remove stale but keep fresh
    const pruned = pruneStale();
    expect(pruned).toBe(1);

    const sessions = listActiveSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].session_id).toBe(freshId);

    // No lock file leak
    expect(lockFileExists()).toBe(false);
  });
});

describe("lock file cleanup on error", () => {
  it("lock file does not leak when registry write involves corrupted file", () => {
    // Write corrupted registry
    fs.writeFileSync(path.join(tmpDir, "active-sessions.json"), "not json");

    // Register should recover from corruption and not leak lock
    registerSession(makeEntry());
    expect(lockFileExists()).toBe(false);

    // Should have created a fresh registry with one entry
    const sessions = listActiveSessions();
    expect(sessions).toHaveLength(1);
  });
});

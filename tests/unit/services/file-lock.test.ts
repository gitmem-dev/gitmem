/**
 * Unit tests for file-lock.ts (GIT-24)
 *
 * Tests advisory file lock: acquire, release, stale detection,
 * timeout, and withLockSync exception safety.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { acquireLockSync, releaseLockSync, withLockSync } from "../../../src/services/file-lock.js";

let tmpDir: string;

function lockPath(name = "test.lock"): string {
  return path.join(tmpDir, name);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-lock-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("acquireLockSync / releaseLockSync", () => {
  it("creates lock file on acquire and removes it on release", () => {
    const lp = lockPath();
    acquireLockSync(lp);

    expect(fs.existsSync(lp)).toBe(true);
    const contents = JSON.parse(fs.readFileSync(lp, "utf-8"));
    expect(contents.pid).toBe(process.pid);
    expect(contents.hostname).toBe(os.hostname());
    expect(contents.acquired_at).toBeTruthy();

    releaseLockSync(lp);
    expect(fs.existsSync(lp)).toBe(false);
  });

  it("release is idempotent — ignores ENOENT", () => {
    const lp = lockPath();
    // Release without acquire — should not throw
    expect(() => releaseLockSync(lp)).not.toThrow();
  });

  it("different paths are independent locks", () => {
    const lp1 = lockPath("a.lock");
    const lp2 = lockPath("b.lock");

    acquireLockSync(lp1);
    acquireLockSync(lp2); // should not block

    expect(fs.existsSync(lp1)).toBe(true);
    expect(fs.existsSync(lp2)).toBe(true);

    releaseLockSync(lp1);
    releaseLockSync(lp2);
  });
});

describe("stale lock detection", () => {
  it("breaks stale lock (older than 30s) and acquires", () => {
    const lp = lockPath();

    // Create a stale lock file manually
    const staleContents = {
      pid: 99999999,
      hostname: "dead-host",
      acquired_at: new Date(Date.now() - 60_000).toISOString(), // 60s ago
    };
    fs.writeFileSync(lp, JSON.stringify(staleContents));

    // Should break the stale lock and acquire
    acquireLockSync(lp, 1000);

    const contents = JSON.parse(fs.readFileSync(lp, "utf-8"));
    expect(contents.pid).toBe(process.pid); // our lock now
    expect(contents.hostname).toBe(os.hostname());

    releaseLockSync(lp);
  });

  it("breaks unreadable lock file (corrupt) and acquires", () => {
    const lp = lockPath();
    fs.writeFileSync(lp, "not json at all");

    acquireLockSync(lp, 1000);

    const contents = JSON.parse(fs.readFileSync(lp, "utf-8"));
    expect(contents.pid).toBe(process.pid);

    releaseLockSync(lp);
  });
});

describe("timeout behavior", () => {
  it("allows reentrant acquisition when same process holds lock", () => {
    const lp = lockPath();

    // Create a fresh lock held by this process
    const freshContents = {
      pid: process.pid,
      hostname: os.hostname(),
      acquired_at: new Date().toISOString(),
    };
    fs.writeFileSync(lp, JSON.stringify(freshContents));

    // Same PID + hostname → reentrant, should NOT throw
    expect(() => acquireLockSync(lp, 100, 10)).not.toThrow();

    // Clean up
    fs.unlinkSync(lp);
  });

  it("times out when lock is held by different process (not stale)", () => {
    const lp = lockPath();

    // Create a fresh lock held by a different PID
    const freshContents = {
      pid: process.pid + 9999,
      hostname: os.hostname(),
      acquired_at: new Date().toISOString(),
    };
    fs.writeFileSync(lp, JSON.stringify(freshContents));

    // Different PID → should timeout
    expect(() => acquireLockSync(lp, 100, 10)).toThrow(/Timeout after 100ms/);

    // Clean up
    fs.unlinkSync(lp);
  });

  it("timeout error includes diagnostic info about lock holder", () => {
    const lp = lockPath();
    const contents = {
      pid: 12345,
      hostname: "other-container",
      acquired_at: new Date().toISOString(),
    };
    fs.writeFileSync(lp, JSON.stringify(contents));

    try {
      acquireLockSync(lp, 100, 10);
      expect.fail("should have thrown");
    } catch (err: unknown) {
      const msg = (err as Error).message;
      expect(msg).toContain("Timeout");
      expect(msg).toContain("Lock held by");
    }

    fs.unlinkSync(lp);
  });
});

describe("withLockSync", () => {
  it("acquires lock, runs function, releases lock", () => {
    const lp = lockPath();

    const result = withLockSync(lp, () => {
      // Lock should be held during execution
      expect(fs.existsSync(lp)).toBe(true);
      return 42;
    });

    expect(result).toBe(42);
    // Lock should be released after
    expect(fs.existsSync(lp)).toBe(false);
  });

  it("releases lock even when function throws", () => {
    const lp = lockPath();

    expect(() =>
      withLockSync(lp, () => {
        throw new Error("boom");
      })
    ).toThrow("boom");

    // Lock must be released despite the exception
    expect(fs.existsSync(lp)).toBe(false);
  });

  it("propagates return value from function", () => {
    const lp = lockPath();
    const result = withLockSync(lp, () => ({ key: "value", count: 3 }));
    expect(result).toEqual({ key: "value", count: 3 });
  });

  it("can be called sequentially on the same path", () => {
    const lp = lockPath();

    withLockSync(lp, () => "first");
    withLockSync(lp, () => "second");
    const result = withLockSync(lp, () => "third");

    expect(result).toBe("third");
    expect(fs.existsSync(lp)).toBe(false);
  });
});

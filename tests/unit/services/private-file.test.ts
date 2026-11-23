/**
 * Unit tests for writePrivateFileSync and tightenPrivateFileSync (owner-only credential files)
 *
 * Verifies:
 * - A new file is created at 0600 (POSIX)
 * - An existing file is set to 0600 BEFORE the new bytes are written
 * - The previous permission bits are returned
 * - A symlink's target is tightened and the link stays
 * - A chmod failure, or a chmod with no effect, does not stop the write
 * - Windows writes exactly as before and never calls chmod
 *
 * The POSIX cases are skipped on Windows and the Windows case everywhere else.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Pass-through spies so the tests can record call order and make chmod misbehave.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    chmodSync: vi.fn(actual.chmodSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

import { writePrivateFileSync, tightenPrivateFileSync, wasReadableByOthers } from "../../../src/services/private-file.js";

const isWindows = process.platform === "win32";

describe("writePrivateFileSync", () => {
  let dir: string;
  let p: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-private-file-"));
    p = path.join(dir, "config.json");
    vi.mocked(fs.chmodSync).mockClear();
    vi.mocked(fs.writeFileSync).mockClear();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(isWindows)("creates a new file at 0600 and reports no previous mode (AC-10.1)", () => {
    const result = writePrivateFileSync(p, "{}");

    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(p, "utf-8")).toBe("{}");
    expect(result.previousMode).toBeNull();
    expect(result.tightenError).toBeNull();
  });

  it.skipIf(isWindows)("tightens an existing 0644 file and returns its previous mode (AC-11.1)", () => {
    fs.writeFileSync(p, "old");
    fs.chmodSync(p, 0o644);

    const result = writePrivateFileSync(p, "new");

    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(p, "utf-8")).toBe("new");
    expect(result.previousMode).toBe(0o644);
    expect(wasReadableByOthers(result)).toBe(true);
  });

  it.skipIf(isWindows)("chmods before it writes, so new bytes never land in a readable file (AC-11.2)", () => {
    fs.writeFileSync(p, "old");
    fs.chmodSync(p, 0o644);
    vi.mocked(fs.chmodSync).mockClear();
    vi.mocked(fs.writeFileSync).mockClear();

    writePrivateFileSync(p, "new");

    const chmodCalls = vi.mocked(fs.chmodSync).mock;
    const writeCalls = vi.mocked(fs.writeFileSync).mock;
    expect(chmodCalls.calls[0]).toEqual([p, 0o600]);
    expect(writeCalls.calls.length).toBe(1);
    expect(chmodCalls.invocationCallOrder[0]).toBeLessThan(writeCalls.invocationCallOrder[0]);
  });

  it.skipIf(isWindows)("reports an already-0600 file as not readable by others (AC-11.3)", () => {
    fs.writeFileSync(p, "old");
    fs.chmodSync(p, 0o600);

    const result = writePrivateFileSync(p, "new");

    expect(result.previousMode).toBe(0o600);
    expect(wasReadableByOthers(result)).toBe(false);
    expect(result.tightenError).toBeNull();
  });

  it.skipIf(isWindows)("tightens a symlink's target and leaves the link in place (AC-11.4)", () => {
    const target = path.join(dir, "target.json");
    fs.writeFileSync(target, "old");
    fs.chmodSync(target, 0o644);
    fs.symlinkSync(target, p);

    writePrivateFileSync(p, "new");

    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(target, "utf-8")).toBe("new");
    expect(fs.lstatSync(p).isSymbolicLink()).toBe(true);
  });

  it.skipIf(!isWindows)("writes plainly on Windows: no chmod, no previous mode (AC-12.1)", () => {
    fs.writeFileSync(p, "old");
    vi.mocked(fs.chmodSync).mockClear();

    const result = writePrivateFileSync(p, "new");

    expect(fs.readFileSync(p, "utf-8")).toBe("new");
    expect(fs.chmodSync).not.toHaveBeenCalled();
    expect(result.previousMode).toBeNull();
  });

  it.skipIf(isWindows)("still writes when chmod throws, and returns the error code (AC-13.1)", () => {
    fs.writeFileSync(p, "old");
    fs.chmodSync(p, 0o644);
    vi.mocked(fs.chmodSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });

    const result = writePrivateFileSync(p, "new");

    expect(fs.readFileSync(p, "utf-8")).toBe("new");
    expect(result.tightenError).toBe("EPERM");
  });

  it.skipIf(isWindows)("flags a chmod that returns but changes nothing as mode-unchanged (AC-13.2)", () => {
    fs.writeFileSync(p, "old");
    fs.chmodSync(p, 0o644);
    vi.mocked(fs.chmodSync).mockImplementationOnce(() => undefined);

    const result = writePrivateFileSync(p, "new");

    expect(fs.readFileSync(p, "utf-8")).toBe("new");
    expect(result.tightenError).toBe("mode-unchanged");
    expect(wasReadableByOthers(result)).toBe(true);
  });
});

describe("tightenPrivateFileSync", () => {
  let dir: string;
  let p: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-tighten-"));
    p = path.join(dir, "config.json");
    vi.mocked(fs.chmodSync).mockClear();
    vi.mocked(fs.writeFileSync).mockClear();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(isWindows)("sets an existing 0644 file to 0600 without touching its contents", () => {
    fs.writeFileSync(p, "keep");
    fs.chmodSync(p, 0o644);
    vi.mocked(fs.writeFileSync).mockClear();

    const result = tightenPrivateFileSync(p);

    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(p, "utf-8")).toBe("keep");
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(result.previousMode).toBe(0o644);
    expect(wasReadableByOthers(result)).toBe(true);
    expect(result.tightenError).toBeNull();
  });

  it.skipIf(isWindows)("leaves an already-0600 file alone and does not call chmod", () => {
    fs.writeFileSync(p, "keep");
    fs.chmodSync(p, 0o600);
    vi.mocked(fs.chmodSync).mockClear();

    const result = tightenPrivateFileSync(p);

    expect(fs.chmodSync).not.toHaveBeenCalled();
    expect(result.previousMode).toBe(0o600);
    expect(wasReadableByOthers(result)).toBe(false);
  });

  it.skipIf(isWindows)("does nothing for a missing file", () => {
    const result = tightenPrivateFileSync(p);

    expect(fs.existsSync(p)).toBe(false);
    expect(fs.chmodSync).not.toHaveBeenCalled();
    expect(result).toEqual({ previousMode: null, tightenError: null });
  });

  it.skipIf(isWindows)("tightens a symlink's target and leaves the link in place", () => {
    const target = path.join(dir, "target.json");
    fs.writeFileSync(target, "keep");
    fs.chmodSync(target, 0o644);
    fs.symlinkSync(target, p);

    tightenPrivateFileSync(p);

    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.lstatSync(p).isSymbolicLink()).toBe(true);
  });

  it.skipIf(isWindows)("returns the error code when chmod throws, and does not throw", () => {
    fs.writeFileSync(p, "keep");
    fs.chmodSync(p, 0o644);
    vi.mocked(fs.chmodSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });

    const result = tightenPrivateFileSync(p);

    expect(result.tightenError).toBe("EPERM");
  });

  it.skipIf(isWindows)("flags a chmod that returns but changes nothing as mode-unchanged", () => {
    fs.writeFileSync(p, "keep");
    fs.chmodSync(p, 0o644);
    vi.mocked(fs.chmodSync).mockImplementationOnce(() => undefined);

    expect(tightenPrivateFileSync(p).tightenError).toBe("mode-unchanged");
  });

  it.skipIf(!isWindows)("is a no-op on Windows: no stat result, no chmod", () => {
    fs.writeFileSync(p, "keep");

    const result = tightenPrivateFileSync(p);

    expect(fs.chmodSync).not.toHaveBeenCalled();
    expect(result).toEqual({ previousMode: null, tightenError: null });
  });
});

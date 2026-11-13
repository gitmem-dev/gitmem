/**
 * Unit tests for tightenCredentialFiles (server start)
 *
 * An install that never runs `activate` again keeps the 0644 config.json and
 * license-cache.json an earlier version wrote. At start they are set to 0600
 * (same lesson as hook-scars.json, GIT-109). Verifies:
 * - both files are tightened and their contents are not touched
 * - a missing file is not created
 * - a chmod failure is logged and never throws, and the other file is still done
 * - Windows does nothing
 *
 * The store is a temp folder with fake values: no real store is read.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, chmodSync: vi.fn(actual.chmodSync) };
});

const { tightenCredentialFiles } = await import("../../../src/services/startup.js");
const { setGitmemDir, clearGitmemDirCache } = await import("../../../src/services/gitmem-dir.js");

const isWindows = process.platform === "win32";

describe("tightenCredentialFiles", () => {
  let dir: string;
  let errors: string;
  const config = () => path.join(dir, "config.json");
  const cache = () => path.join(dir, "license-cache.json");
  const mode = (p: string) => fs.statSync(p).mode & 0o777;
  const open = (p: string) => {
    fs.writeFileSync(p, '{"api_key":"gitmem_dev_fake"}');
    fs.chmodSync(p, 0o644);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-tighten-start-"));
    setGitmemDir(dir);
    errors = "";
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors += a.map(String).join(" ") + "\n";
    });
    vi.mocked(fs.chmodSync).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearGitmemDirCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(isWindows)("tightens 0644 config.json and license-cache.json and leaves their contents", () => {
    open(config());
    open(cache());

    tightenCredentialFiles();

    expect(mode(config())).toBe(0o600);
    expect(mode(cache())).toBe(0o600);
    expect(fs.readFileSync(config(), "utf-8")).toBe('{"api_key":"gitmem_dev_fake"}');
    expect(errors).toContain("Restricted config.json to its owner (was 0644)");
    expect(errors).not.toContain("gitmem_dev_fake");
  });

  it.skipIf(isWindows)("creates nothing when the files are missing", () => {
    tightenCredentialFiles();

    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it.skipIf(isWindows)("logs a chmod failure, does not throw, and still tightens the other file", () => {
    open(config());
    open(cache());
    vi.mocked(fs.chmodSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });

    expect(() => tightenCredentialFiles()).not.toThrow();

    expect(mode(config())).toBe(0o644);
    expect(mode(cache())).toBe(0o600);
    expect(errors).toContain("Could not restrict config.json");
    expect(errors).toContain("EPERM");
  });

  it.skipIf(!isWindows)("does nothing on Windows", () => {
    fs.writeFileSync(config(), "{}");

    tightenCredentialFiles();

    expect(fs.chmodSync).not.toHaveBeenCalled();
    expect(errors).toBe("");
  });
});

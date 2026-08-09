/**
 * Unit tests for gitmem-dir.ts multi-session extensions (GIT-19)
 *
 * Tests getSessionDir, getSessionPath, and the updated walk-up algorithm.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  getGitmemDir,
  getSessionDir,
  getSessionPath,
  setGitmemDir,
  clearGitmemDirCache,
} from "../../../src/services/gitmem-dir.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-dir-test-"));
  clearGitmemDirCache();
});

afterEach(() => {
  clearGitmemDirCache();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getSessionDir", () => {
  it("creates sessions/<sessionId>/ directory", () => {
    setGitmemDir(tmpDir);
    const sessionId = "test-session-id";

    const result = getSessionDir(sessionId);

    expect(result).toBe(path.join(tmpDir, "sessions", sessionId));
    expect(fs.existsSync(result)).toBe(true);
  });

  it("returns existing directory without error on repeat calls", () => {
    setGitmemDir(tmpDir);
    const sessionId = "test-session-id";

    const first = getSessionDir(sessionId);
    const second = getSessionDir(sessionId);

    expect(first).toBe(second);
    expect(fs.existsSync(first)).toBe(true);
  });

  it("creates nested path including sessions/ parent", () => {
    setGitmemDir(tmpDir);
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    getSessionDir(sessionId);

    expect(fs.existsSync(path.join(tmpDir, "sessions"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "sessions", sessionId))).toBe(true);
  });
});

describe("getSessionPath", () => {
  it("returns path to file within session directory", () => {
    setGitmemDir(tmpDir);
    const sessionId = "test-session-id";

    const result = getSessionPath(sessionId, "session.json");

    expect(result).toBe(path.join(tmpDir, "sessions", sessionId, "session.json"));
    // The directory should have been created by getSessionDir
    expect(fs.existsSync(path.dirname(result))).toBe(true);
  });
});

describe("getGitmemDir walk-up with multiple sentinels", () => {
  // GIT-91: the walk-up these tests described has been removed. Deriving the
  // root from process.cwd() meant the MCP server and the SessionStart hook —
  // which do not share a cwd — resolved different stores for the same session.
  // The three cases below asserted exactly that behaviour, so they now assert
  // its replacement: cwd is ignored, and a project-scoped root is selected only
  // by naming it in GITMEM_DIR.

  it("ignores an active-sessions.json sentinel in a parent directory", () => {
    const projectDir = path.join(tmpDir, "project");
    const subDir = path.join(projectDir, "sub", "deep");
    const gitmemDir = path.join(projectDir, ".gitmem");

    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(gitmemDir, { recursive: true });
    fs.writeFileSync(path.join(gitmemDir, "active-sessions.json"), "{}");

    vi.spyOn(process, "cwd").mockReturnValue(subDir);

    expect(getGitmemDir()).toBe(path.join(os.homedir(), ".gitmem"));
  });

  it("ignores a config.json sentinel in a parent directory", () => {
    const projectDir = path.join(tmpDir, "project");
    const subDir = path.join(projectDir, "sub");
    const gitmemDir = path.join(projectDir, ".gitmem");

    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(gitmemDir, { recursive: true });
    fs.writeFileSync(path.join(gitmemDir, "config.json"), "{}");

    vi.spyOn(process, "cwd").mockReturnValue(subDir);

    expect(getGitmemDir()).toBe(path.join(os.homedir(), ".gitmem"));
  });

  it("does NOT use legacy active-session.json as sentinel (removed in multi-session)", () => {
    const projectDir = path.join(tmpDir, "project");
    const subDir = path.join(projectDir, "sub");
    const gitmemDir = path.join(projectDir, ".gitmem");

    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(gitmemDir, { recursive: true });
    fs.writeFileSync(path.join(gitmemDir, "active-session.json"), "{}");

    vi.spyOn(process, "cwd").mockReturnValue(subDir);

    expect(getGitmemDir()).toBe(path.join(os.homedir(), ".gitmem"));
  });

  it("selects a project-scoped root when GITMEM_DIR names it", () => {
    const projectDir = path.join(tmpDir, "project");
    const gitmemDir = path.join(projectDir, ".gitmem");

    fs.mkdirSync(gitmemDir, { recursive: true });
    fs.writeFileSync(path.join(gitmemDir, "active-sessions.json"), "{}");
    fs.writeFileSync(path.join(gitmemDir, "config.json"), "{}");

    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    const previous = process.env.GITMEM_DIR;
    process.env.GITMEM_DIR = gitmemDir;
    try {
      clearGitmemDirCache();
      expect(getGitmemDir()).toBe(gitmemDir);
    } finally {
      if (previous === undefined) delete process.env.GITMEM_DIR;
      else process.env.GITMEM_DIR = previous;
      clearGitmemDirCache();
    }
  });

  it("falls back to ~/.gitmem when no sentinel found", () => {
    const emptyDir = path.join(tmpDir, "empty");
    fs.mkdirSync(emptyDir, { recursive: true });

    vi.spyOn(process, "cwd").mockReturnValue(emptyDir);

    const result = getGitmemDir();
    expect(result).toBe(path.join(os.homedir(), ".gitmem"));
  });
});

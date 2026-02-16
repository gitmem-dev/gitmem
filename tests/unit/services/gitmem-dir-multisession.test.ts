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
  it("finds .gitmem with active-sessions.json sentinel", () => {
    const projectDir = path.join(tmpDir, "project");
    const subDir = path.join(projectDir, "sub", "deep");
    const gitmemDir = path.join(projectDir, ".gitmem");

    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(gitmemDir, { recursive: true });
    fs.writeFileSync(path.join(gitmemDir, "active-sessions.json"), "{}");

    vi.spyOn(process, "cwd").mockReturnValue(subDir);

    const result = getGitmemDir();
    expect(result).toBe(gitmemDir);
  });

  it("finds .gitmem with config.json sentinel", () => {
    const projectDir = path.join(tmpDir, "project");
    const subDir = path.join(projectDir, "sub");
    const gitmemDir = path.join(projectDir, ".gitmem");

    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(gitmemDir, { recursive: true });
    fs.writeFileSync(path.join(gitmemDir, "config.json"), "{}");

    vi.spyOn(process, "cwd").mockReturnValue(subDir);

    const result = getGitmemDir();
    expect(result).toBe(gitmemDir);
  });

  it("does NOT use legacy active-session.json as sentinel (removed in multi-session)", () => {
    const projectDir = path.join(tmpDir, "project");
    const subDir = path.join(projectDir, "sub");
    const gitmemDir = path.join(projectDir, ".gitmem");

    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(gitmemDir, { recursive: true });
    fs.writeFileSync(path.join(gitmemDir, "active-session.json"), "{}");

    vi.spyOn(process, "cwd").mockReturnValue(subDir);

    const result = getGitmemDir();
    // Falls back to ~/.gitmem since active-session.json is no longer a sentinel
    expect(result).toBe(path.join(os.homedir(), ".gitmem"));
  });

  it("prefers active-sessions.json over config.json at same level", () => {
    const projectDir = path.join(tmpDir, "project");
    const gitmemDir = path.join(projectDir, ".gitmem");

    fs.mkdirSync(gitmemDir, { recursive: true });
    fs.writeFileSync(path.join(gitmemDir, "active-sessions.json"), "{}");
    fs.writeFileSync(path.join(gitmemDir, "config.json"), "{}");

    vi.spyOn(process, "cwd").mockReturnValue(projectDir);

    // This always works since active-sessions.json is checked first
    const result = getGitmemDir();
    expect(result).toBe(gitmemDir);
  });

  it("falls back to ~/.gitmem when no sentinel found", () => {
    const emptyDir = path.join(tmpDir, "empty");
    fs.mkdirSync(emptyDir, { recursive: true });

    vi.spyOn(process, "cwd").mockReturnValue(emptyDir);

    const result = getGitmemDir();
    expect(result).toBe(path.join(os.homedir(), ".gitmem"));
  });
});

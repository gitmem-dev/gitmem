/**
 * GIT-107: roots are compared as directories, not strings.
 *
 * On macOS /var is a symlink to /private/var. process.cwd() reports the
 * resolved /private/var/... while a home under $TMPDIR is spelled /var/..., so
 * the store being read was announced as "Memory store found but NOT being
 * read". Any symlink in either path does the same.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findStrandedProjectRoots, sameDirectory, canonicalPath, clearGitmemDirCache } from "../../../src/services/gitmem-dir.js";

let tmp: string;
const saved = { home: process.env.GITMEM_HOME, dir: process.env.GITMEM_DIR };

/**
 * A live project-scoped store: it holds a learning of the user's own.
 * (GIT-115: config.json alone no longer marks one; a repo keeps its
 * config.json and hooks in .gitmem/ while the store lives elsewhere.)
 */
function liveStore(dir: string): string {
  const g = path.join(dir, ".gitmem");
  fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(path.join(g, "learnings.json"), JSON.stringify([{ id: "user-learning", title: "mine" }]));
  return g;
}

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-git107-")));
  delete process.env.GITMEM_DIR;
  clearGitmemDirCache();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (saved.home === undefined) delete process.env.GITMEM_HOME; else process.env.GITMEM_HOME = saved.home;
  if (saved.dir === undefined) delete process.env.GITMEM_DIR; else process.env.GITMEM_DIR = saved.dir;
  clearGitmemDirCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("GIT-107: root comparison survives symlinks", () => {
  it("home reached through a symlink is not reported as a stranded store", () => {
    const real = path.join(tmp, "real-home");
    fs.mkdirSync(real);
    liveStore(real); // the store gitmem reads
    const link = path.join(tmp, "link-home");
    fs.symlinkSync(real, link, "dir");

    process.env.GITMEM_HOME = link;                         // home spelled via the symlink
    vi.spyOn(process, "cwd").mockReturnValue(path.join(real, "work")); // cwd spelled resolved

    expect(findStrandedProjectRoots()).toEqual([]);
  });

  it("a genuinely different live store is still reported", () => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(home);
    const project = path.join(tmp, "project");
    const stranded = liveStore(project);
    process.env.GITMEM_HOME = home;
    vi.spyOn(process, "cwd").mockReturnValue(path.join(project, "src"));

    expect(findStrandedProjectRoots()).toEqual([stranded]);
  });

  it("an explicit GITMEM_DIR naming the project store is the store being read, not a stranded one", () => {
    const project = path.join(tmp, "project");
    const store = liveStore(project);
    process.env.GITMEM_HOME = path.join(tmp, "home");
    process.env.GITMEM_DIR = path.join(tmp, "project", ".", ".gitmem");
    vi.spyOn(process, "cwd").mockReturnValue(project);

    expect(findStrandedProjectRoots()).not.toContain(store);
  });

  it("sameDirectory: symlinks, trailing slashes, dot segments and not-yet-existing leaves", () => {
    const real = path.join(tmp, "r");
    fs.mkdirSync(real);
    const link = path.join(tmp, "l");
    fs.symlinkSync(real, link, "dir");

    expect(sameDirectory(link, real)).toBe(true);
    expect(sameDirectory(`${real}/`, path.join(real, ".", "."))).toBe(true);
    // Destination roots may not exist yet; they resolve through their parent.
    expect(sameDirectory(path.join(link, ".gitmem"), path.join(real, ".gitmem"))).toBe(true);
    expect(canonicalPath(path.join(link, "a", "b"))).toBe(path.join(real, "a", "b"));
    expect(sameDirectory(path.join(tmp, "x"), path.join(tmp, "y"))).toBe(false);
  });

  // The reported case: macOS /var -> /private/var.
  const tmpdirReal = fs.realpathSync.native(os.tmpdir());
  it.skipIf(tmpdirReal === path.resolve(os.tmpdir()))("macOS: /var/... and /private/var/... are one store", () => {
    const spelledTmp = path.join(os.tmpdir(), path.basename(tmp)); // /var/folders/... spelling
    const real = path.join(tmp, "home");
    fs.mkdirSync(real);
    liveStore(real);
    process.env.GITMEM_HOME = path.join(spelledTmp, "home");
    vi.spyOn(process, "cwd").mockReturnValue(real); // what process.cwd() reports: /private/var/...

    expect(process.env.GITMEM_HOME).not.toBe(real);
    expect(findStrandedProjectRoots()).toEqual([]);
  });
});

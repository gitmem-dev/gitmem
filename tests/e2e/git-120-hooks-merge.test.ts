/**
 * GIT-120: install-hooks and uninstall-hooks keep other people's hooks.
 *
 * install-hooks replaced settings.hooks wholesale and uninstall-hooks deleted
 * the key, so a user's own hooks (or another tool's) vanished. These run the
 * real CLI in a scratch repo that already has foreign hooks, and check that
 * only gitmem's commands come and go, that the file is backed up first, and
 * that the output says what changed.
 *
 * No server, no Supabase, no Docker: safe for CI.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const execFile = promisify(execFileCb);
const GITMEM_BIN = join(__dirname, "../../bin/gitmem.js");

async function gitmem(args: string[], cwd: string, home: string) {
  try {
    const { stdout, stderr } = await execFile("node", [GITMEM_BIN, ...args], {
      cwd,
      env: { ...process.env, HOME: home, NO_COLOR: "1", SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", GITMEM_TIER: "free" },
      timeout: 30_000,
    });
    return { stdout, stderr, code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: typeof e.code === "number" ? e.code : 1 };
  }
}

/** A user's own hooks, including one whose path happens to contain "gitmem". */
const FOREIGN_CLAUDE = {
  SessionStart: [{ hooks: [{ type: "command", command: "echo foreign-session-start" }] }],
  PreToolUse: [
    { matcher: "Bash", hooks: [{ type: "command", command: "bash ~/code/gitmem-notes/lint.sh" }] },
  ],
  Notification: [{ hooks: [{ type: "command", command: "say done" }] }],
};

const allCommands = (hooks: Record<string, any[]> = {}) =>
  Object.values(hooks).flat().flatMap((e: any) => (Array.isArray(e.hooks) ? e.hooks : [e])).map((h: any) => h.command as string);
const gitmemCommands = (hooks?: Record<string, any[]>) => allCommands(hooks).filter((c) => c.includes(".gitmem/hooks/"));
const foreignCommands = (hooks?: Record<string, any[]>) => allCommands(hooks).filter((c) => !c.includes(".gitmem/hooks/"));
const backups = (dir: string, base: string) => readdirSync(dir).filter((f) => f.startsWith(`${base}.gitmem-backup-`));

let repo: string;
let home: string;
let settingsPath: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitmem-git120-repo-"));
  home = mkdtempSync(join(tmpdir(), "gitmem-git120-home-"));
  mkdirSync(join(repo, ".claude"));
  settingsPath = join(repo, ".claude", "settings.json");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("GIT-120: Claude Code settings.json", () => {
  const original = () => ({ permissions: { allow: ["Bash(ls:*)"] }, hooks: structuredClone(FOREIGN_CLAUDE) });

  it("install-hooks keeps foreign hooks, backs up first, and prints what changed", async () => {
    const before = JSON.stringify(original(), null, 2);
    writeFileSync(settingsPath, before);

    const r = await gitmem(["install-hooks"], repo, home);
    expect(r.code).toBe(0);
    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));

    expect(foreignCommands(after.hooks).sort()).toEqual(allCommands(FOREIGN_CLAUDE).sort());
    expect(after.hooks.Notification).toEqual(FOREIGN_CLAUDE.Notification);
    expect(gitmemCommands(after.hooks).length).toBeGreaterThan(0);
    expect(after.permissions).toEqual({ allow: ["Bash(ls:*)"] });

    const b = backups(join(repo, ".claude"), "settings.json");
    expect(b).toHaveLength(1);
    expect(readFileSync(join(repo, ".claude", b[0]), "utf-8")).toBe(before);

    expect(r.stdout).toContain("Changes to .claude/settings.json:");
    expect(r.stdout).toMatch(/SessionStart: added \d+ gitmem hook\(s\), kept 1 other/);
    expect(r.stdout).toMatch(/Notification: kept 1 \(untouched\)/);
    expect(r.stdout).toContain("Backup of the previous file:");
  });

  it("install-hooks --force twice replaces gitmem's hooks without duplicating them", async () => {
    writeFileSync(settingsPath, JSON.stringify(original(), null, 2));
    await gitmem(["install-hooks"], repo, home);
    const once = gitmemCommands(JSON.parse(readFileSync(settingsPath, "utf-8")).hooks).length;

    const r = await gitmem(["install-hooks", "--force"], repo, home);
    expect(r.code).toBe(0);
    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(gitmemCommands(after.hooks)).toHaveLength(once);
    expect(foreignCommands(after.hooks).sort()).toEqual(allCommands(FOREIGN_CLAUDE).sort());
    expect(r.stdout).toMatch(/SessionStart: replaced \d+ gitmem hook\(s\) with \d+, kept 1 other/);
  });

  it("install-hooks without --force leaves an installed file alone", async () => {
    writeFileSync(settingsPath, JSON.stringify(original(), null, 2));
    await gitmem(["install-hooks"], repo, home);
    const snapshot = readFileSync(settingsPath, "utf-8");
    const r = await gitmem(["install-hooks"], repo, home);
    expect(r.stdout).toContain("already installed");
    expect(readFileSync(settingsPath, "utf-8")).toBe(snapshot);
  });

  it("uninstall-hooks removes only gitmem's commands and leaves the foreign hooks as they were", async () => {
    writeFileSync(settingsPath, JSON.stringify(original(), null, 2));
    await gitmem(["install-hooks"], repo, home);

    const r = await gitmem(["uninstall-hooks"], repo, home);
    expect(r.code).toBe(0);
    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.hooks).toEqual(FOREIGN_CLAUDE);
    expect(after.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(r.stdout).toMatch(/Removed \d+ gitmem hook\(s\) from \.claude\/settings\.json; kept 3 other/);
    expect(backups(join(repo, ".claude"), "settings.json")).toHaveLength(2);
  });

  it("uninstall-hooks keeps a foreign command that shares a matcher group with gitmem's", async () => {
    const mixed = {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [
          { type: "command", command: "bash .gitmem/hooks/credential-guard.sh", timeout: 3000 },
          { type: "command", command: "echo mine" },
        ] }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(mixed, null, 2));
    const r = await gitmem(["uninstall-hooks"], repo, home);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, "utf-8")).hooks).toEqual({
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }],
    });
  });

  it("install-hooks leaves events it does not manage alone, including init's auto-retrieve hook", async () => {
    const autoRetrieve = { UserPromptSubmit: [{ hooks: [{ type: "command", command: "bash .gitmem/hooks/auto-retrieve-hook.sh", timeout: 3000 }] }] };
    writeFileSync(settingsPath, JSON.stringify({ hooks: autoRetrieve }, null, 2));
    const r = await gitmem(["install-hooks", "--force"], repo, home);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, "utf-8")).hooks.UserPromptSubmit).toEqual(autoRetrieve.UserPromptSubmit);
  });

  it("uninstall-hooks drops the hooks key only when nothing else is left", async () => {
    await gitmem(["install-hooks"], repo, home);
    await gitmem(["uninstall-hooks"], repo, home);
    expect(JSON.parse(readFileSync(settingsPath, "utf-8")).hooks).toBeUndefined();
  });

  it("an unparseable settings.json is not overwritten", async () => {
    writeFileSync(settingsPath, "{ not json");
    for (const cmd of ["install-hooks", "uninstall-hooks"]) {
      const r = await gitmem([cmd], repo, home);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Nothing was changed");
      expect(readFileSync(settingsPath, "utf-8")).toBe("{ not json");
    }
  });
});

describe("GIT-120: Cursor hooks.json", () => {
  it("install and uninstall keep a foreign Cursor hook", async () => {
    mkdirSync(join(repo, ".cursor"));
    const hooksPath = join(repo, ".cursor", "hooks.json");
    const foreign = { version: 1, hooks: { stop: [{ command: "echo cursor-stop" }], afterFileEdit: [{ command: "prettier --write" }] } };
    writeFileSync(hooksPath, JSON.stringify(foreign, null, 2));

    const i = await gitmem(["install-hooks", "--client", "cursor"], repo, home);
    expect(i.code).toBe(0);
    const installed = JSON.parse(readFileSync(hooksPath, "utf-8"));
    expect(foreignCommands(installed.hooks).sort()).toEqual(["echo cursor-stop", "prettier --write"]);
    expect(gitmemCommands(installed.hooks).length).toBeGreaterThan(0);
    expect(installed.version).toBe(1);

    const u = await gitmem(["uninstall-hooks", "--client", "cursor"], repo, home);
    expect(u.code).toBe(0);
    expect(JSON.parse(readFileSync(hooksPath, "utf-8"))).toEqual(foreign);
  });
});

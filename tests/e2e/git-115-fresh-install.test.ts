/**
 * GIT-115: a fresh install reads what init wrote.
 *
 * init seeded <cwd>/.gitmem while the server reads ~/.gitmem (GIT-91), so a
 * new user's first session had no starter lessons and was told its store was
 * "NOT being read". Now the store goes to the root the server reads, and the
 * repo keeps only config.json (the project name) and the hook scripts.
 *
 * Clean HOME, clean repo, the real CLI, the real SessionStart hook and the
 * built server. No Supabase, no Docker: safe for CI.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createMcpClient, callTool, getToolResultText, isToolError, type McpTestClient } from "./mcp-client.js";

const execFile = promisify(execFileCb);
const GITMEM_BIN = join(__dirname, "../../bin/gitmem.js");
const STARTER_COUNT = JSON.parse(readFileSync(join(__dirname, "../../schema/starter-scars.json"), "utf-8")).length;
const PROJECT = "acme-git115";

let home: string;
let repo: string;
let mcp: McpTestClient | undefined;

/** The environment of a new user: nothing gitmem-specific set. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(GITMEM_|SUPABASE_|OPENAI_|OPENROUTER_)/.test(k)) env[k] = v;
  }
  // GITMEM_DIR/GITMEM_HOME blank as well: createMcpClient layers process.env underneath.
  return { ...env, HOME: home, GITMEM_DIR: "", GITMEM_HOME: "", NO_COLOR: "1", GITMEM_TIER: "free", SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" };
}

async function run(cmd: string, args: string[], input?: string) {
  const p = execFile(cmd, args, { cwd: repo, env: cleanEnv(), timeout: 60_000 });
  if (input !== undefined) { p.child.stdin?.end(input); }
  try {
    const { stdout, stderr } = await p;
    return { stdout, stderr, code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: typeof e.code === "number" ? e.code : 1 };
  }
}

let initOut = "";
let hookOut = "";
let startText = "";
let recallText = "";

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "gitmem-git115-home-")));
  repo = realpathSync(mkdtempSync(join(tmpdir(), "gitmem-git115-repo-")));

  const init = await run("node", [GITMEM_BIN, "init", "--yes", "--project", PROJECT, "--client", "claude"]);
  initOut = init.stdout + init.stderr;

  // The SessionStart hook, as Claude Code runs it: from the repo, JSON on stdin.
  hookOut = (await run("bash", [".gitmem/hooks/session-start.sh"], "{}")).stdout;

  // The project the hook tells the agent to use, straight from the repo config.
  const hinted = (hookOut.match(/session_start\(project: "([^"]+)"\)/) || [])[1];

  mcp = await createMcpClient(cleanEnv(), { cwd: repo });
  const result = await callTool(mcp.client, "session_start", {
    agent_identity: "cli", force: true, ...(hinted ? { project: hinted } : {}),
  });
  startText = isToolError(result) ? `ERROR ${getToolResultText(result)}` : getToolResultText(result);
  const rc = await callTool(mcp.client, "recall", { plan: "run the database migration without a rollback plan", project: PROJECT });
  recallText = isToolError(rc) ? `ERROR ${getToolResultText(rc)}` : getToolResultText(rc);
}, 120_000);

afterAll(async () => {
  if (mcp) await mcp.cleanup();
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("GIT-115: fresh install, clean HOME", () => {
  it("init seeds the starter lessons into the root the server reads", () => {
    const learnings = JSON.parse(readFileSync(join(home, ".gitmem", "learnings.json"), "utf-8"));
    expect(learnings).toHaveLength(STARTER_COUNT);
    expect(existsSync(join(home, ".gitmem", "threads.json"))).toBe(true);
    expect(existsSync(join(home, ".gitmem", "closing-payload-template.json"))).toBe(true);
    expect(initOut).toContain("~/.gitmem");
  });

  it("the repo keeps only config.json (with the project) and the hooks", () => {
    expect(readdirSync(join(repo, ".gitmem")).sort()).toEqual(["config.json", "hooks"]);
    expect(JSON.parse(readFileSync(join(repo, ".gitmem", "config.json"), "utf-8"))).toEqual({ project: PROJECT });
  });

  it("the SessionStart hook names the project from the repo config", () => {
    expect(hookOut).toContain(`session_start(project: "${PROJECT}")`);
  });

  it("session_start reads what init seeded, under the repo's project", () => {
    expect(startText).not.toMatch(/^ERROR/);
    expect(startText).toContain(`· ${PROJECT}`);
    // The welcome thread init wrote into the store.
    expect(startText).toContain("Add your first project-specific scar");
  });

  it("recall in that session returns a starter scar", () => {
    expect(recallText).not.toMatch(/^ERROR/);
    expect(recallText).toContain("Database Migration Without Rollback Plan");
  });

  it("session_start does not report the repo's .gitmem as a store NOT being read", () => {
    expect(startText).not.toContain("NOT being read");
  });
});

describe("GIT-115: uninstall follows the same split", () => {
  it("init installs its hooks beside a foreign hook under a gitmem-named path (GIT-120 matching)", async () => {
    // The wizard's old substring match took this hook for gitmem's own and
    // skipped installing gitmem's hooks altogether.
    const other = realpathSync(mkdtempSync(join(tmpdir(), "gitmem-git115-repo2-")));
    try {
      const foreign = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash ~/code/gitmem-notes/lint.sh" }] }] } };
      mkdirSync(join(other, ".claude"));
      writeFileSync(join(other, ".claude", "settings.json"), JSON.stringify(foreign, null, 2));
      const r = await execFile("node", [GITMEM_BIN, "init", "--yes", "--client", "claude"], { cwd: other, env: cleanEnv(), timeout: 60_000 });
      expect(r.stdout).toContain("Added automatic memory hooks");
      const text = readFileSync(join(other, ".claude", "settings.json"), "utf-8");
      expect(text).toContain("gitmem-notes/lint.sh");
      expect(text).toContain(".gitmem/hooks/session-start.sh");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("uninstall removes the repo's config and hooks, keeps foreign hooks, and keeps the shared store", async () => {
    const settingsPath = join(repo, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    settings.hooks.PreToolUse.find((g: any) => g.matcher === "Bash").hooks.push({ type: "command", command: "bash ~/code/gitmem-notes/lint.sh" });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    const r = await run("node", [GITMEM_BIN, "uninstall", "--yes", "--client", "claude"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(repo, ".gitmem"))).toBe(false);
    const hooks = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf-8")).hooks;
    expect(JSON.stringify(hooks)).toContain("gitmem-notes/lint.sh");
    expect(JSON.stringify(hooks)).not.toContain(".gitmem/hooks/");
    expect(existsSync(join(home, ".gitmem", "learnings.json"))).toBe(true);
  });

  it("uninstall --all deletes the store", async () => {
    const r = await run("node", [GITMEM_BIN, "uninstall", "--yes", "--all", "--client", "claude"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(home, ".gitmem"))).toBe(false);
  });
});

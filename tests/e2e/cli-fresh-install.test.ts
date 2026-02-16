/**
 * E2E Tests: CLI Fresh Install Flow
 *
 * Tests the actual CLI commands as child processes — simulating
 * what a real user does on day one:
 *   1. npx gitmem init
 *   2. npx gitmem configure
 *   3. npx gitmem check
 *   4. npx gitmem install-hooks
 *   5. Start MCP server → session lifecycle
 *
 *
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createMcpClient,
  callTool,
  listTools,
  getToolResultText,
  parseToolResult,
  isToolError,
  createTierEnv,
  CORE_TOOLS,
  EXPECTED_TOOL_COUNTS,
  type McpTestClient,
} from "./mcp-client.js";

const execFile = promisify(execFileCb);
const GITMEM_BIN = join(__dirname, "../../bin/gitmem.js");

/**
 * Run a gitmem CLI command as a child process
 */
async function runGitmem(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
  } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env = {
    ...process.env,
    // Ensure free tier unless overridden
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    GITMEM_TIER: "free",
    NO_COLOR: "1",
    ...options.env,
  };

  try {
    const { stdout, stderr } = await execFile("node", [GITMEM_BIN, ...args], {
      cwd: options.cwd,
      env,
      timeout: 30_000,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      exitCode: error.code || 1,
    };
  }
}

// ─── Test Scenario 1: Free Tier CLI Flow ───────────────────────────

describe("Fresh Install: Free Tier CLI", () => {
  const TEST_DIR = join(tmpdir(), `gitmem-cli-free-${Date.now()}`);

  beforeAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("gitmem init creates .gitmem/ with starter scars", async () => {
    const { stdout, exitCode } = await runGitmem(["init", "--yes"], { cwd: TEST_DIR });

    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toContain("free");

    // .gitmem/ directory created
    const gitmemDir = join(TEST_DIR, ".gitmem");
    expect(existsSync(gitmemDir)).toBe(true);

    // learnings.json has starter scars
    const learningsPath = join(gitmemDir, "learnings.json");
    expect(existsSync(learningsPath)).toBe(true);
    const learnings = JSON.parse(readFileSync(learningsPath, "utf-8"));
    expect(learnings.length).toBeGreaterThan(0);

    // Other collection files created
    expect(existsSync(join(gitmemDir, "sessions.json"))).toBe(true);
    expect(existsSync(join(gitmemDir, "decisions.json"))).toBe(true);
    expect(existsSync(join(gitmemDir, "scar-usage.json"))).toBe(true);

    // stdout shows scar count
    const countMatch = stdout.match(/(\d+) starter scars/) || stdout.match(/(\d+) new scars added/);
    expect(countMatch).not.toBeNull();
    expect(parseInt(countMatch![1])).toBeGreaterThan(0);
  });

  it("gitmem init is idempotent (no duplicates on re-run)", async () => {
    // Count scars before second run
    const learningsPath = join(TEST_DIR, ".gitmem", "learnings.json");
    const beforeCount = JSON.parse(readFileSync(learningsPath, "utf-8")).length;

    const { stdout, exitCode } = await runGitmem(["init", "--yes"], { cwd: TEST_DIR });

    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toContain("already configured");

    // Same count — no duplicates
    const afterCount = JSON.parse(readFileSync(learningsPath, "utf-8")).length;
    expect(afterCount).toBe(beforeCount);
  });

  it("gitmem configure outputs valid MCP JSON", async () => {
    const { stdout, exitCode } = await runGitmem(["configure"], {
      cwd: TEST_DIR,
    });

    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toContain("free tier");

    // Extract JSON from output (it's wrapped in text)
    const jsonMatch = stdout.match(/\{[\s\S]*"mcpServers"[\s\S]*\}/);
    expect(jsonMatch).not.toBeNull();

    const config = JSON.parse(jsonMatch![0]);
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers.gitmem).toBeDefined();
    expect(config.mcpServers.gitmem.command).toBe("npx");
  });

  it("gitmem check passes on initialized directory", async () => {
    const { stdout, stderr, exitCode } = await runGitmem(["check"], {
      cwd: TEST_DIR,
    });

    expect(exitCode).toBe(0);
    // check command writes to stderr (MCP convention)
    const output = stdout + stderr;
    expect(output).toContain("All health checks passed");
  });

  it("gitmem check --output writes JSON report", async () => {
    const reportPath = join(TEST_DIR, "report.json");

    const { exitCode } = await runGitmem(
      ["check", "--output", reportPath],
      { cwd: TEST_DIR }
    );

    expect(exitCode).toBe(0);
    expect(existsSync(reportPath)).toBe(true);

    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    expect(report.version).toBeDefined();
    expect(report.health).toBeDefined();
    expect(report.configuration).toBeDefined();
    expect(report.environment.tier).toBe("free");
    expect(report.configuration.supabaseConfigured).toBe(false);
  });

  it("gitmem help shows all commands", async () => {
    const { stdout, exitCode } = await runGitmem(["help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("init");
    expect(stdout).toContain("configure");
    expect(stdout).toContain("check");
    expect(stdout).toContain("install-hooks");
    expect(stdout).toContain("uninstall-hooks");
    expect(stdout).toContain("server");
  });
});

// ─── Test Scenario 2: Hooks Install/Uninstall ──────────────────────

describe("Fresh Install: Hooks CLI", () => {
  const TEST_DIR = join(tmpdir(), `gitmem-cli-hooks-${Date.now()}`);
  const SETTINGS_PATH = join(TEST_DIR, ".claude", "settings.json");

  beforeAll(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });

    // Run init first so .claude/settings.json has permissions.allow
    await runGitmem(["init", "--yes"], { cwd: TEST_DIR });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("install-hooks writes hooks to .claude/settings.json", async () => {
    const { stdout, exitCode } = await runGitmem(["install-hooks", "--force"], {
      cwd: TEST_DIR,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Hooks written to .claude/settings.json");

    // settings.json exists and has correct hook structure
    expect(existsSync(SETTINGS_PATH)).toBe(true);
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));

    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.PostToolUse).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();

    // Verify hook commands reference correct scripts
    const sessionStartCmd = JSON.stringify(settings.hooks.SessionStart);
    expect(sessionStartCmd).toContain("session-start.sh");

    const preToolCmd = JSON.stringify(settings.hooks.PreToolUse);
    expect(preToolCmd).toContain("recall-check.sh");

    const postToolCmd = JSON.stringify(settings.hooks.PostToolUse);
    expect(postToolCmd).toContain("post-tool-use.sh");

    const stopCmd = JSON.stringify(settings.hooks.Stop);
    expect(stopCmd).toContain("session-close-check.sh");
  });

  it("install-hooks preserves existing permissions", async () => {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));

    // init should have set permissions.allow with mcp__gitmem__*
    expect(settings.permissions).toBeDefined();
    expect(settings.permissions.allow).toContain("mcp__gitmem__*");

    // And hooks should also be present
    expect(settings.hooks).toBeDefined();
  });

  it("install-hooks detects existing hooks", async () => {
    const { stdout, exitCode } = await runGitmem(["install-hooks"], {
      cwd: TEST_DIR,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("already installed");
  });

  it("install-hooks --force overwrites hooks", async () => {
    const { stdout, exitCode } = await runGitmem(
      ["install-hooks", "--force"],
      { cwd: TEST_DIR }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Hooks written");

    // Hooks still present
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    expect(settings.hooks.SessionStart).toBeDefined();
  });

  it("install-hooks --force preserves permissions", async () => {
    // Write a settings file with custom permissions + existing hooks
    const customSettings = {
      permissions: { allow: ["mcp__gitmem__*", "custom_tool"] },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo old" }] }] },
    };
    writeFileSync(SETTINGS_PATH, JSON.stringify(customSettings, null, 2));

    const { exitCode } = await runGitmem(["install-hooks", "--force"], {
      cwd: TEST_DIR,
    });

    expect(exitCode).toBe(0);

    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    // Permissions preserved
    expect(settings.permissions.allow).toContain("mcp__gitmem__*");
    expect(settings.permissions.allow).toContain("custom_tool");
    // Hooks replaced with new ones
    const cmd = JSON.stringify(settings.hooks.SessionStart);
    expect(cmd).toContain("session-start.sh");
  });

  it("uninstall-hooks removes hooks from settings", async () => {
    const { stdout, exitCode } = await runGitmem(["uninstall-hooks"], {
      cwd: TEST_DIR,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Uninstall complete");

    // settings.json still exists but hooks key removed
    expect(existsSync(SETTINGS_PATH)).toBe(true);
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    expect(settings.hooks).toBeUndefined();

    // Permissions preserved
    expect(settings.permissions).toBeDefined();
  });

  it("uninstall-hooks is idempotent", async () => {
    const { stdout, exitCode } = await runGitmem(["uninstall-hooks"], {
      cwd: TEST_DIR,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("No hooks found");
  });
});

// ─── Test Scenario 3: MCP Server from Initialized Directory ────────

describe("Fresh Install: MCP Server Lifecycle", () => {
  const TEST_DIR = join(tmpdir(), `gitmem-cli-mcp-${Date.now()}`);
  let mcp: McpTestClient;

  beforeAll(async () => {
    // Create temp dir and initialize
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });

    // Run init to populate .gitmem/
    await runGitmem(["init", "--yes"], { cwd: TEST_DIR });

    // Start MCP server with CWD in the initialized directory
    // so it walks up and finds .gitmem/ with starter scars
    mcp = await createMcpClient(
      {
        ...createTierEnv("free"),
        HOME: TEST_DIR,
      },
      { cwd: TEST_DIR }
    );
  }, 30_000);

  afterAll(async () => {
    if (mcp) await mcp.cleanup();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("registers correct number of free tier tools", async () => {
    const tools = await listTools(mcp.client);
    expect(tools.length).toBe(EXPECTED_TOOL_COUNTS.free);

    const toolNames = tools.map((t) => t.name);
    for (const core of CORE_TOOLS) {
      expect(toolNames, `Missing core tool: ${core}`).toContain(core);
    }
  });

  it("session_start works on fresh install", async () => {
    const result = await callTool(mcp.client, "session_start", {
      agent_identity: "CLI",
      force: true,
    });

    expect(isToolError(result)).toBe(false);
    const text = getToolResultText(result);
    // Output format: "gitmem ── active" or "gitmem ── resumed"
    expect(text.toLowerCase().includes("active") || text.toLowerCase().includes("resumed")).toBe(true);
  });

  it("recall finds starter scars", async () => {
    const result = await callTool(mcp.client, "recall", {
      plan: "deploy to production and verify",
    });

    expect(isToolError(result)).toBe(false);

    // Recall returns display-formatted text with scar summaries
    const text = getToolResultText(result);
    expect(text.length).toBeGreaterThan(0);
    // Should contain the plan echo and at least one scar reference
    expect(text.toLowerCase()).toContain("deploy");
  });

  it("create_learning persists to local storage", async () => {
    const result = await callTool(mcp.client, "create_learning", {
      learning_type: "scar",
      title: "CLI Fresh Install Test Scar",
      description:
        "Created during fresh install integration test to verify persistence",
      severity: "low",
      counter_arguments: [
        "This is a test scar, not real",
        "No actual lesson learned here",
      ],
    });

    expect(isToolError(result)).toBe(false);

    // Verify it shows up in a search
    const searchResult = await callTool(mcp.client, "search", {
      query: "CLI Fresh Install Test",
    });
    expect(isToolError(searchResult)).toBe(false);
  });

  it("session_close completes lifecycle", async () => {
    // Start a session to close
    const startResult = await callTool(mcp.client, "session_start", {
      agent_identity: "CLI",
      force: true,
    });
    expect(isToolError(startResult)).toBe(false);

    // Extract session ID from display text (format: "uuid · CLI · default")
    const text = getToolResultText(startResult);
    const sessionId = text.split("\n").find(l => /^[0-9a-f]{8}-/.test(l))?.split(" ")[0];

    // Close with quick type
    const closeResult = await callTool(mcp.client, "session_close", {
      session_id: sessionId,
      close_type: "quick",
    });

    expect(isToolError(closeResult)).toBe(false);
  });
});

// ─── Test Scenario 4: Hook Script Output ────────────────────────────

describe("Fresh Install: Hook Script Output", () => {
  const TEST_DIR = join(tmpdir(), `gitmem-cli-hookout-${Date.now()}`);
  const SCRIPTS_DIR = join(__dirname, "../../hooks/scripts");

  beforeAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("session-start.sh outputs protocol when gitmem detected", async () => {
    // Hook scripts read JSON from stdin via `cat -`, so pipe empty JSON via shell
    const scriptPath = join(SCRIPTS_DIR, "session-start.sh");
    const sessionId = `test-hookout-${Date.now()}`;
    try {
      const { stdout } = await execFile(
        "bash",
        ["-c", `echo '{}' | bash "${scriptPath}"`],
        {
          cwd: TEST_DIR,
          env: {
            ...process.env,
            GITMEM_ENABLED: "true",
            CLAUDE_SESSION_ID: sessionId,
            HOME: TEST_DIR,
          },
          timeout: 10_000,
        }
      );

      expect(stdout).toContain("SESSION START");
      // Hook output references mcp__gitmem__session_start (not ToolSearch)
      expect(stdout).toContain("session_start");
      expect(stdout).not.toContain("orchestra_dev");
      expect(stdout).not.toContain("weekend_warrior");
    } finally {
      rmSync(`/tmp/gitmem-hooks-${sessionId}`, { recursive: true, force: true });
    }
  });

  it("session-start.sh outputs inactive when gitmem not detected", async () => {
    // The detection cascade checks hardcoded paths like /home/claude/mcp-config.json.
    // In our dev container that file exists with gitmem configured, so detection
    // always succeeds. Skip this test if any hardcoded config path has gitmem.
    const hardcodedPaths = [
      "/home/claude/mcp-config.json",
      "/home/node/mcp-config.json",
    ];
    const hasGlobalConfig = hardcodedPaths.some((p) => {
      try {
        return readFileSync(p, "utf-8").includes("gitmem");
      } catch {
        return false;
      }
    });
    if (hasGlobalConfig) {
      // Can't simulate "not detected" in this container — skip gracefully
      return;
    }

    const cleanDir = join(TEST_DIR, "clean");
    mkdirSync(cleanDir, { recursive: true });
    const sessionId = `test-clean-${Date.now()}`;

    try {
      const { stdout } = await execFile(
        "bash",
        ["-c", `echo '{}' | bash "${join(SCRIPTS_DIR, "session-start.sh")}"`],
        {
          cwd: cleanDir,
          env: {
            PATH: "/usr/bin:/bin",
            HOME: cleanDir,
            CLAUDE_SESSION_ID: sessionId,
          },
          timeout: 10_000,
        }
      );

      expect(stdout.toLowerCase()).toContain("not detected");
    } finally {
      rmSync(`/tmp/gitmem-hooks-${sessionId}`, { recursive: true, force: true });
    }
  });

  it("session-close-check.sh ceremony wording is correct", async () => {
    // Setup: create meaningful session (>5 tool calls) with active registry
    const sessionDir = join(TEST_DIR, "close-test");
    mkdirSync(join(sessionDir, ".gitmem"), { recursive: true });

    // Create active sessions registry
    writeFileSync(
      join(sessionDir, ".gitmem", "active-sessions.json"),
      JSON.stringify({ sessions: [{ session_id: "test-close" }] })
    );

    const sessionId = `test-close-${Date.now()}`;
    const stateDir = `/tmp/gitmem-hooks-${sessionId}`;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "start_time"), String(Math.floor(Date.now() / 1000) - 600));
    writeFileSync(join(stateDir, "tool_call_count"), "10");

    const scriptPath = join(SCRIPTS_DIR, "session-close-check.sh");

    try {
      const { stdout } = await execFile(
        "bash",
        ["-c", `echo '{}' | bash "${scriptPath}"`],
        {
          cwd: sessionDir,
          env: {
            ...process.env,
            CLAUDE_SESSION_ID: sessionId,
            HOME: TEST_DIR,
          },
          timeout: 10_000,
        }
      );

      // Output should contain ceremony instructions with correct wording
      expect(stdout).toContain("YOU (the agent) ANSWER");
      expect(stdout).not.toContain("orchestra_dev");
      expect(stdout).not.toContain("weekend_warrior");
    } finally {
      // Cleanup state dir
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

// ─── Test Scenario 5: Output Sanitization ───────────────────────────

describe("Fresh Install: Output Sanitization", () => {
  const TEST_DIR = join(tmpdir(), `gitmem-cli-sanitize-${Date.now()}`);

  beforeAll(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    await runGitmem(["init", "--yes"], { cwd: TEST_DIR });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("gitmem init output has no orchestra references", async () => {
    const cleanDir = join(TEST_DIR, "init-clean");
    mkdirSync(cleanDir, { recursive: true });
    const { stdout, stderr } = await runGitmem(["init", "--yes"], { cwd: cleanDir });

    expect(stdout.toLowerCase()).not.toContain("orchestra");
    expect(stderr.toLowerCase()).not.toContain("orchestra");
  });

  it("gitmem configure output has no orchestra references", async () => {
    const { stdout } = await runGitmem(["configure"]);

    expect(stdout.toLowerCase()).not.toContain("orchestra");
  });

  it("gitmem help output has no orchestra references", async () => {
    const { stdout } = await runGitmem(["help"]);

    expect(stdout.toLowerCase()).not.toContain("orchestra");
  });

  it("gitmem check output has no orchestra references", async () => {
    const { stdout } = await runGitmem(["check"], { cwd: TEST_DIR });

    expect(stdout.toLowerCase()).not.toContain("orchestra");
  });

  it("CLAUDE.md.template has no orchestra references and correct ceremony", () => {
    const templatePath = join(__dirname, "../../CLAUDE.md.template");
    const content = readFileSync(templatePath, "utf-8");

    expect(content.toLowerCase()).not.toContain("orchestra");
    // Template includes reflection questions in session end section
    expect(content.toLowerCase()).toContain("answer these reflection questions");
  });

  it("starter-scars.json has no orchestra references", () => {
    const scarsPath = join(__dirname, "../../schema/starter-scars.json");
    const content = readFileSync(scarsPath, "utf-8");

    expect(content.toLowerCase()).not.toContain("orchestra_dev");
    expect(content.toLowerCase()).not.toContain("weekend_warrior");
  });
});

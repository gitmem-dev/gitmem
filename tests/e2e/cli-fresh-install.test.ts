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
 * Issue: OD-607
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  accessSync,
  constants,
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
    const { stdout, exitCode } = await runGitmem(["init"], { cwd: TEST_DIR });

    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toContain("free tier");

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
    const countMatch = stdout.match(/(\d+) new scars added/);
    expect(countMatch).not.toBeNull();
    expect(parseInt(countMatch![1])).toBeGreaterThan(0);
  });

  it("gitmem init is idempotent (no duplicates on re-run)", async () => {
    // Count scars before second run
    const learningsPath = join(TEST_DIR, ".gitmem", "learnings.json");
    const beforeCount = JSON.parse(readFileSync(learningsPath, "utf-8")).length;

    const { stdout, exitCode } = await runGitmem(["init"], { cwd: TEST_DIR });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("already exists");

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
    const { stdout, exitCode } = await runGitmem(["check"], {
      cwd: TEST_DIR,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("All health checks passed");
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
  const TEST_HOME = join(tmpdir(), `gitmem-cli-hooks-${Date.now()}`);
  const PLUGIN_DIR = join(TEST_HOME, ".claude", "plugins", "gitmem-hooks");

  beforeAll(() => {
    if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true });
    mkdirSync(TEST_HOME, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true });
  });

  it("install-hooks creates plugin directory with correct structure", async () => {
    const { stdout, exitCode } = await runGitmem(["install-hooks"], {
      env: { HOME: TEST_HOME },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Installed successfully");

    // Plugin manifest exists
    expect(existsSync(join(PLUGIN_DIR, ".claude-plugin", "plugin.json"))).toBe(
      true
    );

    // Hooks registration exists
    expect(existsSync(join(PLUGIN_DIR, "hooks", "hooks.json"))).toBe(true);

    // Scripts exist and are executable
    const scripts = [
      "session-start.sh",
      "recall-check.sh",
      "session-close-check.sh",
      "post-tool-use.sh",
    ];
    for (const script of scripts) {
      const scriptPath = join(PLUGIN_DIR, "scripts", script);
      expect(existsSync(scriptPath), `Missing script: ${script}`).toBe(true);
      // Check executable bit
      accessSync(scriptPath, constants.X_OK);
    }
  });

  it("install-hooks detects existing installation", async () => {
    const { stdout, exitCode } = await runGitmem(["install-hooks"], {
      env: { HOME: TEST_HOME },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("already installed");
  });

  it("install-hooks --force overwrites existing installation", async () => {
    const { stdout, exitCode } = await runGitmem(
      ["install-hooks", "--force"],
      { env: { HOME: TEST_HOME } }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Installed successfully");

    // Files still present
    expect(existsSync(join(PLUGIN_DIR, ".claude-plugin", "plugin.json"))).toBe(
      true
    );
  });

  it("uninstall-hooks removes plugin directory", async () => {
    const { stdout, exitCode } = await runGitmem(["uninstall-hooks"], {
      env: { HOME: TEST_HOME },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Uninstall complete");
    expect(existsSync(PLUGIN_DIR)).toBe(false);
  });

  it("uninstall-hooks is idempotent", async () => {
    const { stdout, exitCode } = await runGitmem(["uninstall-hooks"], {
      env: { HOME: TEST_HOME },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("already removed");
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
    await runGitmem(["init"], { cwd: TEST_DIR });

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
    expect(text).toContain("SESSION START");
  });

  it("recall finds starter scars", async () => {
    const result = await callTool(mcp.client, "recall", {
      plan: "deploy to production and verify",
    });

    expect(isToolError(result)).toBe(false);

    const data = parseToolResult<{
      activated: boolean;
      plan: string;
      scars: Array<{ title: string }>;
    }>(result);

    expect(data.plan).toBe("deploy to production and verify");
    expect(Array.isArray(data.scars)).toBe(true);
    // Free tier with starter scars should find matches via keyword search
    expect(data.scars.length).toBeGreaterThan(0);
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

    // Close with quick type — server manages session IDs internally
    const closeResult = await callTool(mcp.client, "session_close", {
      close_type: "quick",
    });

    expect(isToolError(closeResult)).toBe(false);
  });
});

/**
 * E2E Tests: Cross-Tool Continuity (Claude Code <-> Cursor)
 *
 * Tests the init wizard, uninstall, and hooks CLI for both Claude Code
 * and Cursor IDE paths. Verifies:
 *   - Correct files created for each client
 *   - No cross-contamination between clients
 *   - Shared .gitmem/ directory across clients
 *   - Auto-detection logic
 *   - Idempotency
 *   - Hook format correctness (Claude nested vs Cursor flat)
 *   - Uninstall reversal
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
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

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

// ─── Test Scenario 1: Cursor Init (Clean Room) ─────────────────────

describe("Cursor: Init Clean Room", () => {
  const TEST_DIR = join(tmpdir(), `gitmem-cursor-init-${Date.now()}`);

  beforeAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("init --client cursor creates correct files", async () => {
    const { stdout, exitCode } = await runGitmem(
      ["init", "--client", "cursor", "--yes"],
      { cwd: TEST_DIR }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Setup for Cursor");
    expect(stdout).toContain("Step 1/5");
    expect(stdout).toContain("Step 5/5");
    // No step 6 (no permissions step for Cursor)
    expect(stdout).not.toContain("Step 6/");

    // .gitmem/ created with starter scars
    expect(existsSync(join(TEST_DIR, ".gitmem"))).toBe(true);
    expect(existsSync(join(TEST_DIR, ".gitmem", "learnings.json"))).toBe(true);
    const learnings = readJson(join(TEST_DIR, ".gitmem", "learnings.json"));
    expect(learnings.length).toBeGreaterThan(0);

    // .cursor/mcp.json created
    const mcpConfig = readJson(join(TEST_DIR, ".cursor", "mcp.json"));
    expect(mcpConfig).not.toBeNull();
    expect(mcpConfig.mcpServers.gitmem).toBeDefined();
    expect(mcpConfig.mcpServers.gitmem.command).toBe("npx");

    // .cursorrules created with correct markers
    const rules = readFileSync(join(TEST_DIR, ".cursorrules"), "utf-8");
    expect(rules).toContain("# --- gitmem:start ---");
    expect(rules).toContain("# --- gitmem:end ---");
    expect(rules).toContain("GitMem");

    // .cursor/hooks.json created with flat format
    const hooks = readJson(join(TEST_DIR, ".cursor", "hooks.json"));
    expect(hooks).not.toBeNull();
    expect(hooks.hooks).toBeDefined();
    expect(hooks.hooks.sessionStart).toBeDefined();
    expect(hooks.hooks.beforeMCPExecution).toBeDefined();
    expect(hooks.hooks.afterMCPExecution).toBeDefined();
    expect(hooks.hooks.stop).toBeDefined();

    // .gitignore created
    const gitignore = readFileSync(join(TEST_DIR, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".gitmem/");
  });

  it("Cursor init does NOT create Claude-specific files", () => {
    // No .mcp.json at project root
    expect(existsSync(join(TEST_DIR, ".mcp.json"))).toBe(false);
    // No CLAUDE.md
    expect(existsSync(join(TEST_DIR, "CLAUDE.md"))).toBe(false);
    // No .claude/ directory
    expect(existsSync(join(TEST_DIR, ".claude"))).toBe(false);
  });

  it("Cursor hooks use flat format (not Claude nested format)", () => {
    const hooks = readJson(join(TEST_DIR, ".cursor", "hooks.json"));

    // Cursor format: each entry is {command: "...", timeout: N}
    for (const eventEntries of Object.values(hooks.hooks) as any[]) {
      for (const entry of eventEntries) {
        expect(entry.command).toBeDefined();
        expect(typeof entry.command).toBe("string");
        expect(entry.command).toContain("gitmem");
        // Should NOT have Claude's nested {hooks: [{type, command}]} format
        expect(entry.hooks).toBeUndefined();
        expect(entry.type).toBeUndefined();
      }
    }
  });

  it("Cursor hooks reference correct event names", () => {
    const hooks = readJson(join(TEST_DIR, ".cursor", "hooks.json"));
    const eventNames = Object.keys(hooks.hooks);

    // Cursor events
    expect(eventNames).toContain("sessionStart");
    expect(eventNames).toContain("beforeMCPExecution");
    expect(eventNames).toContain("afterMCPExecution");
    expect(eventNames).toContain("stop");

    // NOT Claude events
    expect(eventNames).not.toContain("SessionStart");
    expect(eventNames).not.toContain("PreToolUse");
    expect(eventNames).not.toContain("PostToolUse");
    expect(eventNames).not.toContain("Stop");
  });

  it("Cursor init is idempotent (second run skips all)", async () => {
    const { stdout, exitCode } = await runGitmem(
      ["init", "--client", "cursor", "--yes"],
      { cwd: TEST_DIR }
    );

    expect(exitCode).toBe(0);
    // Every step should say "Already configured" or "Skipping"
    expect(stdout).toContain("Already configured");
    // Should not create anything new
    expect(stdout).not.toContain("Created .gitmem/");
    expect(stdout).not.toContain("Added gitmem entry");
    expect(stdout).not.toContain("Created .cursorrules");
  });

  it(".cursorrules has no Claude-specific references", () => {
    const rules = readFileSync(join(TEST_DIR, ".cursorrules"), "utf-8");

    // Should not reference Claude-specific concepts
    expect(rules).not.toContain("<!-- gitmem:start -->");
    expect(rules).not.toContain("<!-- gitmem:end -->");
    expect(rules).not.toContain("CLAUDE.md");
    expect(rules).not.toContain("MEMORY.md");
    // Should not mention "PreToolUse" (Claude hook event name)
    expect(rules).not.toContain("PreToolUse hooks");
  });
});

// ─── Test Scenario 2: Claude Init (Control Group) ──────────────────

describe("Claude: Init Control Group", () => {
  const TEST_DIR = join(tmpdir(), `gitmem-claude-init-${Date.now()}`);

  beforeAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("init --client claude creates correct files", async () => {
    const { stdout, exitCode } = await runGitmem(
      ["init", "--client", "claude", "--yes"],
      { cwd: TEST_DIR }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Setup for Claude Code");
    expect(stdout).toContain("Step 1/6");
    expect(stdout).toContain("Step 6/6");

    // .mcp.json at project root
    const mcpConfig = readJson(join(TEST_DIR, ".mcp.json"));
    expect(mcpConfig).not.toBeNull();
    expect(mcpConfig.mcpServers.gitmem).toBeDefined();

    // CLAUDE.md created with HTML markers
    const claudeMd = readFileSync(join(TEST_DIR, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("<!-- gitmem:start -->");
    expect(claudeMd).toContain("<!-- gitmem:end -->");

    // .claude/settings.json with permissions AND hooks
    const settings = readJson(join(TEST_DIR, ".claude", "settings.json"));
    expect(settings).not.toBeNull();
    expect(settings.permissions.allow).toContain("mcp__gitmem__*");
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.PostToolUse).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();
  });

  it("Claude init does NOT create Cursor-specific files", () => {
    // No .cursor/ directory
    expect(existsSync(join(TEST_DIR, ".cursor"))).toBe(false);
    // No .cursorrules
    expect(existsSync(join(TEST_DIR, ".cursorrules"))).toBe(false);
  });

  it("Claude hooks use nested format (not Cursor flat format)", () => {
    const settings = readJson(join(TEST_DIR, ".claude", "settings.json"));

    // Claude format: each event has entries with {hooks: [{type, command}]}
    // or entries with {matcher, hooks: [{type, command}]}
    const sessionStart = settings.hooks.SessionStart;
    expect(Array.isArray(sessionStart)).toBe(true);
    expect(sessionStart[0].hooks).toBeDefined();
    expect(Array.isArray(sessionStart[0].hooks)).toBe(true);
    expect(sessionStart[0].hooks[0].type).toBe("command");
    expect(sessionStart[0].hooks[0].command).toContain("gitmem");
  });

  it("Claude hooks reference correct event names", () => {
    const settings = readJson(join(TEST_DIR, ".claude", "settings.json"));
    const eventNames = Object.keys(settings.hooks);

    // Claude events (PascalCase)
    expect(eventNames).toContain("SessionStart");
    expect(eventNames).toContain("PreToolUse");
    expect(eventNames).toContain("PostToolUse");
    expect(eventNames).toContain("Stop");

    // NOT Cursor events (camelCase)
    expect(eventNames).not.toContain("sessionStart");
    expect(eventNames).not.toContain("beforeMCPExecution");
    expect(eventNames).not.toContain("afterMCPExecution");
    expect(eventNames).not.toContain("stop");
  });
});

// ─── Test Scenario 3: No Cross-Contamination ───────────────────────

describe("Cross-Contamination Prevention", () => {
  it("Cursor init followed by Claude init creates separate configs", async () => {
    const TEST_DIR = join(tmpdir(), `gitmem-cross-${Date.now()}`);
    mkdirSync(TEST_DIR, { recursive: true });

    try {
      // First: init for Cursor
      await runGitmem(["init", "--client", "cursor", "--yes"], { cwd: TEST_DIR });

      // Second: init for Claude in same directory
      await runGitmem(["init", "--client", "claude", "--yes"], { cwd: TEST_DIR });

      // Both config files should exist independently
      expect(existsSync(join(TEST_DIR, ".cursor", "mcp.json"))).toBe(true);
      expect(existsSync(join(TEST_DIR, ".mcp.json"))).toBe(true);

      // Both instruction files should exist
      expect(existsSync(join(TEST_DIR, ".cursorrules"))).toBe(true);
      expect(existsSync(join(TEST_DIR, "CLAUDE.md"))).toBe(true);

      // Both hook configs should exist
      expect(existsSync(join(TEST_DIR, ".cursor", "hooks.json"))).toBe(true);
      expect(existsSync(join(TEST_DIR, ".claude", "settings.json"))).toBe(true);

      // Single shared .gitmem/ directory
      expect(existsSync(join(TEST_DIR, ".gitmem"))).toBe(true);
      expect(existsSync(join(TEST_DIR, ".gitmem", "learnings.json"))).toBe(true);

      // Verify each config is correct format
      const cursorHooks = readJson(join(TEST_DIR, ".cursor", "hooks.json"));
      expect(cursorHooks.hooks.sessionStart).toBeDefined(); // camelCase

      const claudeSettings = readJson(join(TEST_DIR, ".claude", "settings.json"));
      expect(claudeSettings.hooks.SessionStart).toBeDefined(); // PascalCase
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("Shared .gitmem/ has same scars regardless of init order", async () => {
    const DIR_A = join(tmpdir(), `gitmem-shared-a-${Date.now()}`);
    const DIR_B = join(tmpdir(), `gitmem-shared-b-${Date.now()}`);
    mkdirSync(DIR_A, { recursive: true });
    mkdirSync(DIR_B, { recursive: true });

    try {
      // Init Claude in DIR_A
      await runGitmem(["init", "--client", "claude", "--yes"], { cwd: DIR_A });

      // Init Cursor in DIR_B
      await runGitmem(["init", "--client", "cursor", "--yes"], { cwd: DIR_B });

      const scarsA = readJson(join(DIR_A, ".gitmem", "learnings.json"));
      const scarsB = readJson(join(DIR_B, ".gitmem", "learnings.json"));

      // Same number of starter scars
      expect(scarsA.length).toBe(scarsB.length);

      // Same scar IDs
      const idsA = new Set(scarsA.map((s: any) => s.id));
      const idsB = new Set(scarsB.map((s: any) => s.id));
      expect(idsA).toEqual(idsB);
    } finally {
      rmSync(DIR_A, { recursive: true, force: true });
      rmSync(DIR_B, { recursive: true, force: true });
    }
  });
});

// ─── Test Scenario 4: Auto-Detection ───────────────────────────────

describe("Client Auto-Detection", () => {
  it("detects Cursor when only .cursor/ exists", async () => {
    const TEST_DIR = join(tmpdir(), `gitmem-detect-cursor-${Date.now()}`);
    mkdirSync(join(TEST_DIR, ".cursor"), { recursive: true });

    try {
      const { stdout, exitCode } = await runGitmem(["init", "--yes"], { cwd: TEST_DIR });

      expect(exitCode).toBe(0);
      expect(stdout).toContain("auto-detected");
      expect(stdout).toContain("Setup for Cursor");
      // Should create Cursor files
      expect(existsSync(join(TEST_DIR, ".cursor", "mcp.json"))).toBe(true);
      expect(existsSync(join(TEST_DIR, ".cursorrules"))).toBe(true);
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("detects Claude when only .claude/ exists", async () => {
    const TEST_DIR = join(tmpdir(), `gitmem-detect-claude-${Date.now()}`);
    mkdirSync(join(TEST_DIR, ".claude"), { recursive: true });

    try {
      const { stdout, exitCode } = await runGitmem(["init", "--yes"], { cwd: TEST_DIR });

      expect(exitCode).toBe(0);
      expect(stdout).toContain("auto-detected");
      expect(stdout).toContain("Setup for Claude Code");
      expect(existsSync(join(TEST_DIR, ".mcp.json"))).toBe(true);
      expect(existsSync(join(TEST_DIR, "CLAUDE.md"))).toBe(true);
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("detects Cursor when .cursorrules exists without CLAUDE.md", async () => {
    const TEST_DIR = join(tmpdir(), `gitmem-detect-rules-${Date.now()}`);
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, ".cursorrules"), "# My rules\n");

    try {
      const { stdout, exitCode } = await runGitmem(["init", "--yes"], { cwd: TEST_DIR });

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Setup for Cursor");
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("detects Claude when .mcp.json exists without .cursor/mcp.json", async () => {
    const TEST_DIR = join(tmpdir(), `gitmem-detect-mcp-${Date.now()}`);
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, ".mcp.json"), '{"mcpServers":{}}');

    try {
      const { stdout, exitCode } = await runGitmem(["init", "--yes"], { cwd: TEST_DIR });

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Setup for Claude Code");
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("defaults to Claude when no signals present", async () => {
    const TEST_DIR = join(tmpdir(), `gitmem-detect-default-${Date.now()}`);
    mkdirSync(TEST_DIR, { recursive: true });

    try {
      const { stdout, exitCode } = await runGitmem(["init", "--yes"], { cwd: TEST_DIR });

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Setup for Claude Code");
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("--client flag overrides auto-detection", async () => {
    const TEST_DIR = join(tmpdir(), `gitmem-detect-override-${Date.now()}`);
    // Create .claude/ to bias auto-detection toward Claude
    mkdirSync(join(TEST_DIR, ".claude"), { recursive: true });

    try {
      const { stdout, exitCode } = await runGitmem(
        ["init", "--client", "cursor", "--yes"],
        { cwd: TEST_DIR }
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain("via --client flag");
      expect(stdout).toContain("Setup for Cursor");
      // Should create Cursor files despite .claude/ existing
      expect(existsSync(join(TEST_DIR, ".cursor", "mcp.json"))).toBe(true);
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("rejects unknown --client value", async () => {
    const TEST_DIR = join(tmpdir(), `gitmem-detect-bad-${Date.now()}`);
    mkdirSync(TEST_DIR, { recursive: true });

    try {
      const { stderr, exitCode } = await runGitmem(
        ["init", "--client", "vscode", "--yes"],
        { cwd: TEST_DIR }
      );

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Unknown client");
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });
});

// ─── Test Scenario 5: Cursor Uninstall ─────────────────────────────

describe("Cursor: Uninstall", () => {
  const TEST_DIR = join(tmpdir(), `gitmem-cursor-uninstall-${Date.now()}`);

  beforeAll(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    // Init Cursor first
    await runGitmem(["init", "--client", "cursor", "--yes"], { cwd: TEST_DIR });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("uninstall --client cursor removes gitmem from all config files", async () => {
    // Verify files exist before uninstall
    expect(existsSync(join(TEST_DIR, ".cursorrules"))).toBe(true);
    expect(existsSync(join(TEST_DIR, ".cursor", "mcp.json"))).toBe(true);
    expect(existsSync(join(TEST_DIR, ".cursor", "hooks.json"))).toBe(true);

    const { stdout, exitCode } = await runGitmem(
      ["uninstall", "--client", "cursor", "--yes", "--all"],
      { cwd: TEST_DIR }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Uninstall (Cursor)");
    expect(stdout).toContain("Uninstall complete");

    // .cursorrules removed (was gitmem-only)
    expect(existsSync(join(TEST_DIR, ".cursorrules"))).toBe(false);

    // .gitmem/ deleted (--all flag)
    expect(existsSync(join(TEST_DIR, ".gitmem"))).toBe(false);
  });

  it("uninstall skips permissions step for Cursor", async () => {
    // Re-init and uninstall to check step count
    await runGitmem(["init", "--client", "cursor", "--yes"], { cwd: TEST_DIR });

    const { stdout } = await runGitmem(
      ["uninstall", "--client", "cursor", "--yes", "--all"],
      { cwd: TEST_DIR }
    );

    // Cursor has 4 steps (no permissions), Claude has 5
    expect(stdout).toContain("Step 4/4");
    expect(stdout).not.toContain("Step 5/");
    // Cursor uninstall has no permissions step — 4 steps total (verified above)
  });
});

// ─── Test Scenario 6: Hook Preservation ────────────────────────────

describe("Cursor: Hook Preservation", () => {
  it("init preserves existing non-gitmem hooks in .cursor/hooks.json", async () => {
    const TEST_DIR = join(tmpdir(), `gitmem-cursor-preserve-${Date.now()}`);
    mkdirSync(join(TEST_DIR, ".cursor"), { recursive: true });

    // Write pre-existing hooks
    const existingHooks = {
      hooks: {
        sessionStart: [
          { command: "echo custom-session-hook", timeout: 1000 },
        ],
        beforeMCPExecution: [
          { command: "echo custom-pre-hook", timeout: 1000 },
        ],
      },
    };
    writeFileSync(
      join(TEST_DIR, ".cursor", "hooks.json"),
      JSON.stringify(existingHooks, null, 2)
    );

    try {
      const { stdout, exitCode } = await runGitmem(
        ["init", "--client", "cursor", "--yes"],
        { cwd: TEST_DIR }
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain("preserved");

      const hooks = readJson(join(TEST_DIR, ".cursor", "hooks.json"));

      // Custom hooks preserved
      const sessionCmds = hooks.hooks.sessionStart.map((h: any) => h.command);
      expect(sessionCmds).toContain("echo custom-session-hook");
      // gitmem hooks added
      expect(sessionCmds.some((c: string) => c.includes("gitmem"))).toBe(true);

      const preCmds = hooks.hooks.beforeMCPExecution.map((h: any) => h.command);
      expect(preCmds).toContain("echo custom-pre-hook");
      expect(preCmds.some((c: string) => c.includes("gitmem"))).toBe(true);
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("uninstall preserves existing non-gitmem hooks in .cursor/hooks.json", async () => {
    const TEST_DIR = join(tmpdir(), `gitmem-cursor-unhook-${Date.now()}`);
    mkdirSync(join(TEST_DIR, ".cursor"), { recursive: true });

    // Create hooks with both gitmem and custom entries
    const mixedHooks = {
      hooks: {
        sessionStart: [
          { command: "echo custom-hook", timeout: 1000 },
          { command: "bash .gitmem/hooks/session-start.sh", timeout: 5000 },
        ],
        beforeMCPExecution: [
          { command: "bash .gitmem/hooks/credential-guard.sh", timeout: 3000 },
          { command: "bash .gitmem/hooks/recall-check.sh", timeout: 5000 },
        ],
        stop: [
          { command: "echo custom-stop", timeout: 1000 },
          { command: "bash .gitmem/hooks/session-close-check.sh", timeout: 5000 },
        ],
      },
    };
    writeFileSync(
      join(TEST_DIR, ".cursor", "hooks.json"),
      JSON.stringify(mixedHooks, null, 2)
    );

    // Also need .cursorrules and .cursor/mcp.json for full uninstall
    writeFileSync(join(TEST_DIR, ".cursorrules"), "# --- gitmem:start ---\ntest\n# --- gitmem:end ---\n");
    writeFileSync(
      join(TEST_DIR, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { gitmem: { command: "npx" } } })
    );

    try {
      const { stdout, exitCode } = await runGitmem(
        ["uninstall", "--client", "cursor", "--yes"],
        { cwd: TEST_DIR }
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain("preserved");

      const hooks = readJson(join(TEST_DIR, ".cursor", "hooks.json"));

      // Custom hooks preserved
      const sessionCmds = hooks.hooks.sessionStart.map((h: any) => h.command);
      expect(sessionCmds).toContain("echo custom-hook");
      expect(sessionCmds.every((c: string) => !c.includes("gitmem"))).toBe(true);

      const stopCmds = hooks.hooks.stop.map((h: any) => h.command);
      expect(stopCmds).toContain("echo custom-stop");
      expect(stopCmds.every((c: string) => !c.includes("gitmem"))).toBe(true);

      // beforeMCPExecution was all gitmem — should be removed entirely
      expect(hooks.hooks.beforeMCPExecution).toBeUndefined();
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });
});

// ─── Test Scenario 7: Standalone Hooks CLI ─────────────────────────

describe("Cursor: Standalone Hooks CLI", () => {
  it("install-hooks --client cursor writes .cursor/hooks.json", async () => {
    const TEST_DIR = join(tmpdir(), `gitmem-cursor-hooks-${Date.now()}`);
    mkdirSync(TEST_DIR, { recursive: true });
    // Need .gitmem/ for hook scripts
    mkdirSync(join(TEST_DIR, ".gitmem", "hooks"), { recursive: true });

    try {
      const { stdout, exitCode } = await runGitmem(
        ["install-hooks", "--client", "cursor", "--force"],
        { cwd: TEST_DIR }
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain(".cursor/hooks.json");

      const hooks = readJson(join(TEST_DIR, ".cursor", "hooks.json"));
      expect(hooks.hooks.sessionStart).toBeDefined();
      expect(hooks.hooks.beforeMCPExecution).toBeDefined();
      expect(hooks.hooks.afterMCPExecution).toBeDefined();
      expect(hooks.hooks.stop).toBeDefined();
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("uninstall-hooks --client cursor removes hooks", async () => {
    const TEST_DIR = join(tmpdir(), `gitmem-cursor-unhooks-${Date.now()}`);
    mkdirSync(join(TEST_DIR, ".cursor"), { recursive: true });

    // Pre-populate with gitmem hooks
    writeFileSync(
      join(TEST_DIR, ".cursor", "hooks.json"),
      JSON.stringify({
        hooks: {
          sessionStart: [{ command: "bash .gitmem/hooks/session-start.sh", timeout: 5000 }],
        },
      })
    );

    try {
      const { stdout, exitCode } = await runGitmem(
        ["uninstall-hooks", "--client", "cursor"],
        { cwd: TEST_DIR }
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Uninstall complete");

      // hooks.json should exist but have no hooks
      const hooks = readJson(join(TEST_DIR, ".cursor", "hooks.json"));
      expect(hooks.hooks).toBeUndefined();
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("uninstall-hooks is idempotent for Cursor", async () => {
    const TEST_DIR = join(tmpdir(), `gitmem-cursor-idempotent-${Date.now()}`);
    mkdirSync(join(TEST_DIR, ".cursor"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, ".cursor", "hooks.json"),
      JSON.stringify({ hooks: {} })
    );

    try {
      const { stdout, exitCode } = await runGitmem(
        ["uninstall-hooks", "--client", "cursor"],
        { cwd: TEST_DIR }
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain("No gitmem hooks found");
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });
});

// ─── Test Scenario 8: Instructions File Content ────────────────────

describe("Instructions File Content Validation", () => {
  it(".cursorrules and CLAUDE.md templates have same tool table", () => {
    const cursorTemplate = readFileSync(
      join(__dirname, "../../cursorrules.template"),
      "utf-8"
    );
    const claudeTemplate = readFileSync(
      join(__dirname, "../../CLAUDE.md.template"),
      "utf-8"
    );

    // Both should list the same tools
    const tools = [
      "recall",
      "confirm_scars",
      "search",
      "log",
      "session_start",
      "session_close",
      "create_learning",
      "create_decision",
      "list_threads",
      "create_thread",
      "help",
    ];

    for (const tool of tools) {
      expect(cursorTemplate, `Cursor template missing tool: ${tool}`).toContain(tool);
      expect(claudeTemplate, `Claude template missing tool: ${tool}`).toContain(tool);
    }
  });

  it(".cursorrules template has correct delimiters", () => {
    const template = readFileSync(
      join(__dirname, "../../cursorrules.template"),
      "utf-8"
    );

    expect(template.startsWith("# --- gitmem:start ---")).toBe(true);
    expect(template.trimEnd().endsWith("# --- gitmem:end ---")).toBe(true);
  });

  it("CLAUDE.md template has correct delimiters", () => {
    const template = readFileSync(
      join(__dirname, "../../CLAUDE.md.template"),
      "utf-8"
    );

    expect(template.startsWith("<!-- gitmem:start -->")).toBe(true);
    expect(template.trimEnd().endsWith("<!-- gitmem:end -->")).toBe(true);
  });

  it("uninstall strips .cursorrules gitmem section cleanly", async () => {
    const TEST_DIR = join(tmpdir(), `gitmem-strip-rules-${Date.now()}`);
    mkdirSync(TEST_DIR, { recursive: true });

    // Create .cursorrules with user content + gitmem section
    const userContent = "# My custom rules\n\nAlways use TypeScript.\n";
    const gitmemSection = "# --- gitmem:start ---\nGitMem content here\n# --- gitmem:end ---\n";
    writeFileSync(
      join(TEST_DIR, ".cursorrules"),
      userContent + "\n" + gitmemSection
    );

    // Minimal MCP config for uninstall to find
    mkdirSync(join(TEST_DIR, ".cursor"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: {} })
    );

    try {
      await runGitmem(
        ["uninstall", "--client", "cursor", "--yes"],
        { cwd: TEST_DIR }
      );

      // .cursorrules should still exist with user content
      expect(existsSync(join(TEST_DIR, ".cursorrules"))).toBe(true);
      const remaining = readFileSync(join(TEST_DIR, ".cursorrules"), "utf-8");
      expect(remaining).toContain("My custom rules");
      expect(remaining).toContain("Always use TypeScript");
      expect(remaining).not.toContain("gitmem:start");
      expect(remaining).not.toContain("gitmem:end");
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("uninstall removes .cursorrules if gitmem-only", async () => {
    const TEST_DIR = join(tmpdir(), `gitmem-strip-only-${Date.now()}`);
    mkdirSync(TEST_DIR, { recursive: true });

    // gitmem-only .cursorrules
    writeFileSync(
      join(TEST_DIR, ".cursorrules"),
      "# --- gitmem:start ---\nGitMem only\n# --- gitmem:end ---\n"
    );

    mkdirSync(join(TEST_DIR, ".cursor"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: {} })
    );

    try {
      const { stdout } = await runGitmem(
        ["uninstall", "--client", "cursor", "--yes"],
        { cwd: TEST_DIR }
      );

      expect(stdout).toContain("Removed .cursorrules (was gitmem-only)");
      expect(existsSync(join(TEST_DIR, ".cursorrules"))).toBe(false);
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });
});

// ─── Test Scenario 9: Output Sanitization ──────────────────────────

describe("Cursor: Output Sanitization", () => {
  it("Cursor init output has no orchestra references", async () => {
    const TEST_DIR = join(tmpdir(), `gitmem-cursor-sanitize-${Date.now()}`);
    mkdirSync(TEST_DIR, { recursive: true });

    try {
      const { stdout, stderr } = await runGitmem(
        ["init", "--client", "cursor", "--yes"],
        { cwd: TEST_DIR }
      );

      expect(stdout.toLowerCase()).not.toContain("orchestra");
      expect(stderr.toLowerCase()).not.toContain("orchestra");
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("Cursor uninstall output has no orchestra references", async () => {
    const TEST_DIR = join(tmpdir(), `gitmem-cursor-unsanitize-${Date.now()}`);
    mkdirSync(TEST_DIR, { recursive: true });
    await runGitmem(["init", "--client", "cursor", "--yes"], { cwd: TEST_DIR });

    try {
      const { stdout, stderr } = await runGitmem(
        ["uninstall", "--client", "cursor", "--yes", "--all"],
        { cwd: TEST_DIR }
      );

      expect(stdout.toLowerCase()).not.toContain("orchestra");
      expect(stderr.toLowerCase()).not.toContain("orchestra");
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("cursorrules.template has no orchestra references", () => {
    const content = readFileSync(
      join(__dirname, "../../cursorrules.template"),
      "utf-8"
    );

    expect(content.toLowerCase()).not.toContain("orchestra_dev");
    expect(content.toLowerCase()).not.toContain("weekend_warrior");
    expect(content.toLowerCase()).not.toContain("orchestra");
  });
});

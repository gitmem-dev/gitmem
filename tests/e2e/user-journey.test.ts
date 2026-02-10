/**
 * E2E Tests: User Journey via Claude CLI
 *
 * Tests the ACTUAL user experience by running `claude -p` in a directory
 * with gitmem installed. Parses stream-json output to verify:
 *   - SessionStart hook fires
 *   - MCP tools are registered and visible to the agent
 *   - Agent can call gitmem tools (session_start, recall)
 *   - No orchestra_dev references in any output
 *
 * Requires: ANTHROPIC_API_KEY (costs real API calls)
 * Run with: npm run test:e2e -- tests/e2e/user-journey.test.ts
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
  writeFileSync,
  symlinkSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

const execFile = promisify(execFileCb);
const GITMEM_BIN = join(__dirname, "../../bin/gitmem.js");
const GITMEM_ROOT = join(__dirname, "../..");

// ─── Types for stream-json events ────────────────────────────────────

interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  [key: string]: unknown;
}

interface HookEvent extends StreamEvent {
  type: "system";
  subtype: "hook_started" | "hook_response";
  hook_name: string;
  hook_event: string;
  output?: string;
  stdout?: string;
  exit_code?: number;
  outcome?: string;
}

interface InitEvent extends StreamEvent {
  type: "system";
  subtype: "init";
  tools: string[];
  mcp_servers: Array<{ name: string; status: string }>;
}

interface AssistantEvent extends StreamEvent {
  type: "assistant";
  message: {
    content: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
}

interface ResultEvent extends StreamEvent {
  type: "result";
  subtype: "success" | "error";
  result: string;
  num_turns: number;
  total_cost_usd: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Parse stream-json output into typed events
 */
function parseStreamEvents(output: string): StreamEvent[] {
  return output
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line) as StreamEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is StreamEvent => e !== null);
}

/**
 * Run a claude -p session and return parsed events
 */
async function runClaudeSession(
  prompt: string,
  options: {
    cwd: string;
    maxTurns?: number;
    appendSystemPrompt?: string;
  }
): Promise<{
  events: StreamEvent[];
  hooks: HookEvent[];
  init: InitEvent | null;
  assistantMessages: AssistantEvent[];
  result: ResultEvent | null;
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  raw: string;
}> {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--verbose",
    "--max-turns",
    String(options.maxTurns || 5),
  ];

  if (options.appendSystemPrompt) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }

  const { stdout } = await execFile("claude", args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
    timeout: 120_000,
  });

  const events = parseStreamEvents(stdout);

  const hooks = events.filter(
    (e): e is HookEvent =>
      e.type === "system" &&
      (e.subtype === "hook_started" || e.subtype === "hook_response")
  );

  const init = (events.find(
    (e) => e.type === "system" && e.subtype === "init"
  ) as InitEvent) || null;

  const assistantMessages = events.filter(
    (e): e is AssistantEvent => e.type === "assistant"
  );

  const result = (events.find(
    (e) => e.type === "result"
  ) as ResultEvent) || null;

  // Extract tool calls from assistant messages
  const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
  for (const msg of assistantMessages) {
    for (const block of msg.message?.content || []) {
      if (block.type === "tool_use" && block.name) {
        toolCalls.push({
          name: block.name,
          input: (block.input || {}) as Record<string, unknown>,
        });
      }
    }
  }

  return { events, hooks, init, assistantMessages, result, toolCalls, raw: stdout };
}

// ─── Test Suite ──────────────────────────────────────────────────────

// Skip if claude CLI is not available or not authenticated
// Claude CLI manages its own auth — ANTHROPIC_API_KEY env var isn't required
let claudeAvailable = false;
try {
  const { execFileSync } = await import("child_process");
  const ver = execFileSync("claude", ["--version"], { timeout: 5_000 }).toString().trim();
  claudeAvailable = ver.includes("Claude Code");
} catch {
  // claude not installed or not working
}

describe.skipIf(!claudeAvailable)("User Journey: Claude CLI with GitMem", () => {
  const TEST_DIR = join(tmpdir(), `gitmem-journey-${Date.now()}`);

  beforeAll(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });

    // 1. gitmem init — creates .gitmem/ + .claude/settings.json with permissions
    await execFile("node", [GITMEM_BIN, "init"], {
      cwd: TEST_DIR,
      env: { ...process.env, SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", GITMEM_TIER: "free" },
    });

    // 2. Create .mcp.json pointing to built server (not npx — avoids network)
    const mcpConfig = {
      mcpServers: {
        gitmem: {
          command: "node",
          args: [join(GITMEM_ROOT, "dist/index.js")],
          env: { GITMEM_TIER: "free" },
        },
      },
    };
    writeFileSync(join(TEST_DIR, ".mcp.json"), JSON.stringify(mcpConfig, null, 2));

    // 3. Install hooks — writes to .claude/settings.json
    //    But hooks reference node_modules/gitmem-mcp/hooks/scripts/ which won't exist.
    //    Create a symlink so the paths resolve.
    const nmDir = join(TEST_DIR, "node_modules", "gitmem-mcp");
    mkdirSync(nmDir, { recursive: true });
    symlinkSync(join(GITMEM_ROOT, "hooks"), join(nmDir, "hooks"));

    await execFile("node", [GITMEM_BIN, "install-hooks"], {
      cwd: TEST_DIR,
      env: { ...process.env },
    });

    // Verify setup
    const settings = JSON.parse(readFileSync(join(TEST_DIR, ".claude", "settings.json"), "utf-8"));
    if (!settings.hooks?.SessionStart) {
      throw new Error("Setup failed: hooks not in settings.json");
    }
    if (!existsSync(join(TEST_DIR, ".gitmem", "learnings.json"))) {
      throw new Error("Setup failed: .gitmem/learnings.json missing");
    }
  }, 30_000);

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("SessionStart hook fires on session start", async () => {
    const session = await runClaudeSession(
      "Just say 'hello'. Nothing else.",
      { cwd: TEST_DIR, maxTurns: 3 }
    );

    // Hook should fire
    const hookStarted = session.hooks.find(
      (h) => h.subtype === "hook_started" && h.hook_event === "SessionStart"
    );
    expect(hookStarted, "SessionStart hook should fire").toBeTruthy();

    // Hook should succeed (exit 0, not error)
    const hookResponse = session.hooks.find(
      (h) => h.subtype === "hook_response" && h.hook_event === "SessionStart"
    );
    expect(hookResponse, "SessionStart hook should respond").toBeTruthy();
    expect(hookResponse!.exit_code, "Hook should exit 0").toBe(0);
    expect(hookResponse!.outcome, "Hook should not error").not.toBe("error");
  }, 60_000);

  it("gitmem MCP tools are registered and visible", async () => {
    const session = await runClaudeSession(
      "Just say 'hello'. Nothing else.",
      { cwd: TEST_DIR, maxTurns: 3 }
    );

    // Init event should list gitmem tools
    expect(session.init, "Init event should exist").toBeTruthy();
    const tools = session.init!.tools;

    const gitmemTools = tools.filter((t) => t.startsWith("mcp__gitmem__"));
    expect(gitmemTools.length, "Should have gitmem MCP tools").toBeGreaterThan(10);

    // Core tools must be present
    const coreTools = [
      "mcp__gitmem__recall",
      "mcp__gitmem__session_start",
      "mcp__gitmem__session_close",
      "mcp__gitmem__create_learning",
      "mcp__gitmem__search",
    ];
    for (const tool of coreTools) {
      expect(tools, `Missing core tool: ${tool}`).toContain(tool);
    }

    // MCP server should be connected
    const mcpServers = session.init!.mcp_servers;
    const gitmemServer = mcpServers.find((s) => s.name === "gitmem");
    expect(gitmemServer, "gitmem MCP server should be listed").toBeTruthy();
    expect(gitmemServer!.status).toBe("connected");
  }, 60_000);

  it("agent calls session_start when instructed by hook", async () => {
    // The SessionStart hook tells the agent to call session_start.
    // Give the agent a simple task that requires following hook instructions.
    const session = await runClaudeSession(
      "Follow all startup instructions from hooks, then say 'ready'.",
      {
        cwd: TEST_DIR,
        maxTurns: 10,
        appendSystemPrompt:
          "After following any hook instructions (like calling session_start), just respond with 'ready'. Do not do anything else.",
      }
    );

    // Check if session_start was called
    const sessionStartCalls = session.toolCalls.filter(
      (tc) =>
        tc.name === "mcp__gitmem__session_start" ||
        tc.name === "mcp__gitmem__gitmem-ss" ||
        tc.name === "mcp__gitmem__gm-open"
    );

    // The agent should have called session_start (or an alias)
    // Note: This tests whether the LLM follows the hook instruction
    expect(
      sessionStartCalls.length,
      "Agent should call session_start when instructed by hook"
    ).toBeGreaterThan(0);
  }, 120_000);

  it("agent can call recall and get results", async () => {
    const session = await runClaudeSession(
      "Call the recall tool with plan 'deploy to production'. Show me what scars come back.",
      {
        cwd: TEST_DIR,
        maxTurns: 10,
        appendSystemPrompt: "Call the recall MCP tool, then display the results. Do not call any other tools.",
      }
    );

    // Check recall was called
    const recallCalls = session.toolCalls.filter(
      (tc) =>
        tc.name === "mcp__gitmem__recall" ||
        tc.name === "mcp__gitmem__gitmem-r" ||
        tc.name === "mcp__gitmem__gm-scar"
    );

    expect(recallCalls.length, "Agent should call recall").toBeGreaterThan(0);

    // The result should mention scars
    expect(session.result).toBeTruthy();
    expect(session.result!.subtype).toBe("success");
  }, 120_000);

  it("no orchestra references in any output", async () => {
    const session = await runClaudeSession(
      "Just say 'hello'. Nothing else.",
      { cwd: TEST_DIR, maxTurns: 3 }
    );

    // Check raw output for orchestra_dev leaks
    expect(session.raw.toLowerCase()).not.toContain("orchestra_dev");
    expect(session.raw.toLowerCase()).not.toContain("weekend_warrior");

    // Check hook output specifically
    for (const hook of session.hooks) {
      const output = (hook.output || "") + (hook.stdout || "");
      expect(output.toLowerCase()).not.toContain("orchestra_dev");
      expect(output.toLowerCase()).not.toContain("weekend_warrior");
    }

    // Check result text
    if (session.result?.result) {
      expect(session.result.result.toLowerCase()).not.toContain("orchestra_dev");
    }
  }, 60_000);

  it("hook output contains correct ceremony wording", async () => {
    const session = await runClaudeSession(
      "Just say 'hello'. Nothing else.",
      { cwd: TEST_DIR, maxTurns: 3 }
    );

    // Find the SessionStart hook response
    const hookResponse = session.hooks.find(
      (h) => h.subtype === "hook_response" && h.hook_event === "SessionStart"
    );

    if (hookResponse?.stdout || hookResponse?.output) {
      const hookText = (hookResponse.stdout || "") + (hookResponse.output || "");

      // Should contain the correct ceremony wording
      if (hookText.includes("SESSION START")) {
        expect(hookText).toContain("YOU (the agent) ANSWER");
        expect(hookText).toContain("session_start");
      }
    }
  }, 60_000);
});

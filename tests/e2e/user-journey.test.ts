/**
 * E2E Tests: User Journey via Claude Agent SDK
 *
 * Tests the ACTUAL user experience by spawning Claude sessions with gitmem
 * installed via the Agent SDK (in-process, no subprocess). Verifies:
 *   - SessionStart hook fires and succeeds
 *   - MCP tools are registered and visible to the agent
 *   - Agent can call gitmem tools (session_start, recall)
 *   - No orchestra_dev references in any output
 *   - Hook output contains correct ceremony wording
 *
 * Uses haiku model with budget caps for fast, cheap tests.
 * Requires: Claude CLI authenticated (costs real API calls)
 * Run with: npm run test:e2e -- tests/e2e/user-journey.test.ts
 *
 *
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKHookStartedMessage,
  SDKHookResponseMessage,
  HookCallback,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
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

// ─── Types ───────────────────────────────────────────────────────────

interface SessionObservation {
  messages: SDKMessage[];
  init: SDKSystemMessage | null;
  hooks: {
    started: SDKHookStartedMessage[];
    responses: SDKHookResponseMessage[];
  };
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  result: SDKResultMessage | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Run a Claude session via the Agent SDK and collect all observations.
 * Uses haiku for speed, budget cap for cost control.
 */
async function runSession(
  prompt: string,
  options: {
    cwd: string;
    maxTurns?: number;
    maxBudgetUsd?: number;
    appendSystemPrompt?: string;
  }
): Promise<SessionObservation> {
  const obs: SessionObservation = {
    messages: [],
    init: null,
    hooks: { started: [], responses: [] },
    toolCalls: [],
    result: null,
  };

  // Track tool calls via PreToolUse hook
  const toolObserver: HookCallback = async (input) => {
    if (input.hook_event_name === "PreToolUse") {
      const pre = input as PreToolUseHookInput;
      obs.toolCalls.push({
        name: pre.tool_name,
        input: (pre.tool_input || {}) as Record<string, unknown>,
      });
    }
    return {};
  };

  const systemPrompt = options.appendSystemPrompt
    ? { type: "preset" as const, preset: "claude_code" as const, append: options.appendSystemPrompt }
    : undefined;

  for await (const msg of query({
    prompt,
    options: {
      cwd: options.cwd,
      model: "haiku",
      maxTurns: options.maxTurns ?? 5,
      maxBudgetUsd: options.maxBudgetUsd ?? 1.0,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      settingSources: ["project"],
      systemPrompt,
      thinking: { type: "disabled" },
      hooks: {
        PreToolUse: [{ hooks: [toolObserver] }],
      },
    },
  })) {
    obs.messages.push(msg);

    if (msg.type === "system" && msg.subtype === "init") {
      obs.init = msg as SDKSystemMessage;
    }
    if (msg.type === "system" && msg.subtype === "hook_started") {
      obs.hooks.started.push(msg as SDKHookStartedMessage);
    }
    if (msg.type === "system" && msg.subtype === "hook_response") {
      obs.hooks.responses.push(msg as SDKHookResponseMessage);
    }
    if (msg.type === "result") {
      obs.result = msg as SDKResultMessage;
    }
  }

  return obs;
}

// ─── Test Suite ──────────────────────────────────────────────────────

// Skip if claude CLI is not available (SDK requires it as the runtime)
let claudeAvailable = false;
try {
  const { execFileSync } = await import("child_process");
  const ver = execFileSync("claude", ["--version"], { timeout: 5_000 })
    .toString()
    .trim();
  claudeAvailable = ver.includes("Claude Code");
} catch {
  // claude not installed
}

describe.skipIf(!claudeAvailable)(
  "User Journey: Claude Agent SDK with GitMem",
  () => {
    const TEST_DIR = join(tmpdir(), `gitmem-journey-${Date.now()}`);

    beforeAll(async () => {
      if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
      mkdirSync(TEST_DIR, { recursive: true });

      // 1. gitmem init — creates .gitmem/ + .claude/settings.json with permissions
      await execFile("node", [GITMEM_BIN, "init", "--yes"], {
        cwd: TEST_DIR,
        env: {
          ...process.env,
          SUPABASE_URL: "",
          SUPABASE_SERVICE_ROLE_KEY: "",
          GITMEM_TIER: "free",
        },
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
      writeFileSync(
        join(TEST_DIR, ".mcp.json"),
        JSON.stringify(mcpConfig, null, 2)
      );

      // 3. Install hooks — writes to .claude/settings.json
      //    Hooks reference node_modules/gitmem-mcp/hooks/scripts/
      //    Create a symlink so the paths resolve.
      const nmDir = join(TEST_DIR, "node_modules", "gitmem-mcp");
      mkdirSync(nmDir, { recursive: true });
      symlinkSync(join(GITMEM_ROOT, "hooks"), join(nmDir, "hooks"));

      await execFile("node", [GITMEM_BIN, "install-hooks"], {
        cwd: TEST_DIR,
        env: { ...process.env },
      });

      // Verify setup
      const settings = JSON.parse(
        readFileSync(join(TEST_DIR, ".claude", "settings.json"), "utf-8")
      );
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
      const session = await runSession("Just say 'hello'. Nothing else.", {
        cwd: TEST_DIR,
        maxTurns: 2,
      });

      // Hook should fire
      const hookStarted = session.hooks.started.find(
        (h) => h.hook_event === "SessionStart"
      );
      expect(hookStarted, "SessionStart hook should fire").toBeTruthy();

      // Hook should succeed (exit 0, not error)
      const hookResponse = session.hooks.responses.find(
        (h) => h.hook_event === "SessionStart"
      );
      expect(hookResponse, "SessionStart hook should respond").toBeTruthy();
      expect(hookResponse!.exit_code, "Hook should exit 0").toBe(0);
      expect(hookResponse!.outcome, "Hook should not error").not.toBe("error");
    }, 90_000);

    it("gitmem MCP tools are registered and visible", async () => {
      const session = await runSession("Just say 'hello'. Nothing else.", {
        cwd: TEST_DIR,
        maxTurns: 2,
      });

      // Init event should list gitmem tools
      expect(session.init, "Init event should exist").toBeTruthy();
      const tools = session.init!.tools;

      const gitmemTools = tools.filter((t) => t.startsWith("mcp__gitmem__"));
      expect(
        gitmemTools.length,
        "Should have gitmem MCP tools"
      ).toBeGreaterThan(10);

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
    }, 90_000);

    it("agent calls session_start when instructed", async () => {
      const session = await runSession(
        "Call the session_start MCP tool, then say 'ready'.",
        {
          cwd: TEST_DIR,
          maxTurns: 5,
          appendSystemPrompt:
            "Call mcp__gitmem__session_start, then respond with 'ready'. Do not call other tools.",
        }
      );

      // Check if session_start was called (via our PreToolUse hook observer)
      const sessionStartCalls = session.toolCalls.filter(
        (tc) =>
          tc.name === "mcp__gitmem__session_start" ||
          tc.name === "mcp__gitmem__gitmem-ss" ||
          tc.name === "mcp__gitmem__gm-open"
      );

      expect(
        sessionStartCalls.length,
        "Agent should call session_start"
      ).toBeGreaterThan(0);
    }, 90_000);

    it("agent can call recall and get results", async () => {
      const session = await runSession(
        "Call the recall MCP tool with plan 'deploy to production', then show results.",
        {
          cwd: TEST_DIR,
          maxTurns: 5,
          appendSystemPrompt:
            "Call the mcp__gitmem__recall tool, then display the results. Do not call any other tools.",
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

      // Session should complete successfully
      expect(session.result).toBeTruthy();
      expect(session.result!.subtype).toBe("success");
    }, 90_000);

    it("no orchestra references in any output", async () => {
      const session = await runSession("Just say 'hello'. Nothing else.", {
        cwd: TEST_DIR,
        maxTurns: 2,
      });

      // Check hook output for orchestra leaks
      for (const hookResp of session.hooks.responses) {
        const output =
          (hookResp.output || "") + (hookResp.stdout || "");
        expect(output.toLowerCase()).not.toContain("orchestra_dev");
        expect(output.toLowerCase()).not.toContain("weekend_warrior");
      }

      // Check result text
      if (session.result?.subtype === "success") {
        const resultText = (session.result as SDKResultSuccess).result || "";
        expect(resultText.toLowerCase()).not.toContain("orchestra_dev");
      }
    }, 90_000);

    it("hook output contains correct ceremony wording", async () => {
      const session = await runSession("Just say 'hello'. Nothing else.", {
        cwd: TEST_DIR,
        maxTurns: 2,
      });

      // Find the SessionStart hook response
      const hookResponse = session.hooks.responses.find(
        (h) => h.hook_event === "SessionStart"
      );

      if (hookResponse?.stdout || hookResponse?.output) {
        const hookText =
          (hookResponse.stdout || "") + (hookResponse.output || "");

        // Should contain the correct ceremony wording
        if (hookText.includes("SESSION START")) {
          expect(hookText).toContain("session_start");
          // Should mention persistent memory
          expect(hookText).toContain("persistent memory");
        }
      }
    }, 90_000);
  }
);

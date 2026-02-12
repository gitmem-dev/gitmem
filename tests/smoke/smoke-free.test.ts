/**
 * Smoke Test: Free Tier
 *
 * Post-build verification that the MCP server actually works.
 * No Docker, no Supabase, no external services. Safe for CI.
 *
 * Critical path:
 *   1. Server starts without crashing
 *   2. Tools are registered (exact count for free tier)
 *   3. session_start returns session_id and agent
 *   4. recall accepts plan parameter and returns without error
 *   5. session_close succeeds
 *
 * Target: <10 seconds total
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createMcpClient,
  callTool,
  listTools,
  parseToolResult,
  getToolResultText,
  isToolError,
  createTierEnv,
  CORE_TOOLS,
  timedStep,
  EXPECTED_TOOL_COUNTS,
  type McpTestClient,
} from "./helpers.js";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DIR = join(tmpdir(), `gitmem-smoke-free-${Date.now()}`);

describe("Smoke: Free Tier", () => {
  let mcp: McpTestClient;

  beforeAll(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });

    const { result } = await timedStep("Server starts", async () => {
      return createMcpClient({
        ...createTierEnv("free"),
        GITMEM_DIR: TEST_DIR,
        HOME: TEST_DIR,
      });
    });
    mcp = result;
  }, 15_000);

  afterAll(async () => {
    if (mcp) await mcp.cleanup();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("tools registered (correct count)", async () => {
    const { result: tools } = await timedStep("Tools registered", () =>
      listTools(mcp.client)
    );

    // Exact count — catches accidental gating/ungating
    expect(tools.length).toBe(EXPECTED_TOOL_COUNTS.free);

    // All 8 core tools present
    const toolNames = tools.map((t) => t.name);
    for (const core of CORE_TOOLS) {
      expect(toolNames, `Missing core tool: ${core}`).toContain(core);
    }

    // Every tool has a description
    for (const tool of tools) {
      expect(
        tool.description?.length,
        `Tool ${tool.name} has no description`
      ).toBeGreaterThan(0);
    }
  });

  it("session_start works", async () => {
    const { result } = await timedStep("session_start", async () => {
      return callTool(mcp.client, "session_start", {
        agent_identity: "CLI",
        force: true,
      });
    });

    expect(isToolError(result)).toBe(false);

    // session_start returns pre-formatted markdown display string
    const text = getToolResultText(result);
    expect(text).toContain("session active");
    expect(text).toContain("CLI");
  });

  it("recall works", async () => {
    const { result } = await timedStep("recall", async () => {
      return callTool(mcp.client, "recall", {
        plan: "smoke test deployment verification",
      });
    });

    expect(isToolError(result)).toBe(false);

    const data = parseToolResult<{
      activated: boolean;
      plan: string;
      scars: unknown[];
    }>(result);

    // Plan echoed back — proves parameter passing through MCP protocol
    expect(data.plan).toBe("smoke test deployment verification");
    expect(typeof data.activated).toBe("boolean");
    expect(Array.isArray(data.scars)).toBe(true);
  });

  it("session_close works", async () => {
    // Start a session to get a session_id for closing
    const startResult = await callTool(mcp.client, "session_start", {
      agent_identity: "CLI",
      force: true,
    });
    expect(isToolError(startResult)).toBe(false);

    // session_start returns markdown display — read active-sessions.json for full UUID
    // Server walks up from CWD to find .gitmem/, so registry is at CWD/.gitmem/
    const registryPath = join(process.cwd(), ".gitmem", "active-sessions.json");
    expect(existsSync(registryPath), "active-sessions.json should exist after session_start").toBe(true);
    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    const sessionId = registry.sessions[registry.sessions.length - 1].session_id;

    const { result } = await timedStep("session_close", async () => {
      return callTool(mcp.client, "session_close", {
        session_id: sessionId,
        close_type: "quick",
      });
    });

    expect(isToolError(result)).toBe(false);
    const closeText = getToolResultText(result);
    expect(closeText).toContain("CLOSE");
  });
});

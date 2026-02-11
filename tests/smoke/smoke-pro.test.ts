/**
 * Smoke Test: Pro Tier
 *
 * Post-build verification with live Supabase connectivity.
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in environment.
 * Auto-skips when Supabase is not configured (CI-safe).
 *
 * Critical path:
 *   1. Server starts with Supabase config
 *   2. Tools registered (pro tier count)
 *   3. session_start connects to Supabase, returns last_session
 *   4. recall performs semantic search
 *   5. session_close persists to database
 *   6. cache_status reports initialized
 *
 * Target: <15 seconds total
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createMcpClient,
  callTool,
  listTools,
  parseToolResult,
  getToolResultText,
  isToolError,
  timedStep,
  EXPECTED_TOOL_COUNTS,
  CORE_TOOLS,
  type McpTestClient,
} from "./helpers.js";

const HAS_SUPABASE = !!(
  process.env.SUPABASE_URL &&
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY)
);

describe.skipIf(!HAS_SUPABASE)("Smoke: Pro Tier", () => {
  let mcp: McpTestClient;
  let sessionId: string;

  beforeAll(async () => {
    const { result } = await timedStep("Server starts (pro)", async () => {
      return createMcpClient({
        GITMEM_TIER: "pro",
      });
    });
    mcp = result;
  }, 15_000);

  afterAll(async () => {
    if (mcp) await mcp.cleanup();
  });

  it("tools registered (pro count)", async () => {
    const { result: tools } = await timedStep("Tools registered (pro)", () =>
      listTools(mcp.client)
    );

    expect(tools.length).toBe(EXPECTED_TOOL_COUNTS.pro);

    const toolNames = tools.map((t) => t.name);

    // Core tools
    for (const core of CORE_TOOLS) {
      expect(toolNames, `Missing core tool: ${core}`).toContain(core);
    }

    // Pro-specific: cache management
    expect(toolNames).toContain("gitmem-cache-status");
    expect(toolNames).toContain("gitmem-cache-health");

    // Pro-specific: analyze
    expect(toolNames).toContain("analyze");
  });

  it("session_start connects to Supabase", async () => {
    const { result, latencyMs } = await timedStep(
      "session_start (pro)",
      async () => {
        return callTool(mcp.client, "session_start", {
          agent_identity: "CLI",
          project: "test-project",
          force: true,
        });
      }
    );

    expect(isToolError(result)).toBe(false);

    const data = parseToolResult<{
      session_id: string;
      agent: string;
      last_session: { id: string; title: string; date: string } | null;
      recent_decisions?: Array<{ id: string; title: string }>;
      performance: {
        latency_ms: number;
        total_latency_ms: number;
        network_calls_made: number;
      };
    }>(result);

    sessionId = data.session_id;

    // Valid UUID
    expect(data.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(data.agent).toBe("CLI");

    // Performance breakdown proves Supabase connected
    expect(data.performance).toBeDefined();
    expect(data.performance.total_latency_ms).toBeGreaterThan(0);

    // last_session field present (null is fine for first-ever session)
    expect("last_session" in data).toBe(true);

    // OD-645: relevant_scars no longer in session_start result
    // Scars load on-demand via recall()
    expect(data).not.toHaveProperty("relevant_scars");

    // session_start should complete under 5s with Supabase
    expect(latencyMs).toBeLessThan(5000);
  });

  it("recall returns semantic matches", async () => {
    const { result, latencyMs } = await timedStep(
      "recall (pro)",
      async () => {
        return callTool(mcp.client, "recall", {
          plan: "deploy to production",
          project: "test-project",
          match_count: 3,
        });
      }
    );

    expect(isToolError(result)).toBe(false);

    const data = parseToolResult<{
      activated: boolean;
      plan: string;
      scars: Array<{
        id: string;
        title: string;
        severity: string;
        similarity: number;
        description: string;
      }>;
    }>(result);

    expect(data.plan).toBe("deploy to production");
    expect(Array.isArray(data.scars)).toBe(true);

    // Validate scar structure if any returned
    if (data.scars.length > 0) {
      const scar = data.scars[0];
      expect(scar.id).toBeDefined();
      expect(scar.title.length).toBeGreaterThan(0);
      expect(scar.similarity).toBeGreaterThan(0);
      expect(scar.description.length).toBeGreaterThan(0);
    }

    // Recall should complete under 3s
    expect(latencyMs).toBeLessThan(3000);
  });

  it("session_close persists", async () => {
    const { result } = await timedStep("session_close (pro)", async () => {
      return callTool(mcp.client, "session_close", {
        session_id: sessionId,
        close_type: "quick",
      });
    });

    expect(isToolError(result)).toBe(false);

    const text = getToolResultText(result);
    expect(text.length).toBeGreaterThan(0);

    // Verify no error payload hidden in the response
    const data = parseToolResult<Record<string, unknown>>(result);
    expect(data).not.toHaveProperty("error");
  });

  it("cache_status reports initialized", async () => {
    // Brief wait for background cache init that started at server launch
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const { result } = await timedStep("cache_status", async () => {
      return callTool(mcp.client, "gitmem-cache-status", {
        project: "test-project",
      });
    });

    expect(isToolError(result)).toBe(false);
    expect(getToolResultText(result).length).toBeGreaterThan(0);
  });
});

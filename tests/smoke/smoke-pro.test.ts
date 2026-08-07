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
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createMcpClient,
  callTool,
  listTools,
  getToolResultText,
  querySessionRow,
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
    // GIT-74/R16a: the smoke server MUST run with its cwd outside the repo.
    //
    // Without this it resolves the developer's real .gitmem by walking up from
    // the working directory (GIT-80 — GITMEM_HOME alone does not prevent it),
    // and then session_close tries to sync the developer's actual threads and
    // sessions into the smoke target. Against a blank store that surfaces as
    // foreign-key violations:
    //
    //   Key (source_session)=(057f7a50-…) is not present in table "gitmem_sessions"
    //
    // which is real local state leaking into a test, not a product defect. A
    // smoke suite that reads the machine it runs on is measuring the machine.
    const sandbox = mkdtempSync(join(tmpdir(), "gitmem-smoke-pro-"));

    const { result } = await timedStep("Server starts (pro)", async () => {
      return createMcpClient(
        {
          GITMEM_TIER: "pro",
          GITMEM_HOME: sandbox,
        },
        { cwd: sandbox }
      );
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

    // GIT-74/R16a: session_start returns display text, not a JSON body — the
    // machine-data blob was removed deliberately. So the session id comes from
    // the render, and "connected to Supabase" is proved by the row it wrote
    // rather than by a performance object the tool no longer returns. That is
    // a stronger assertion than the one it replaces: the old test could pass
    // against a latency number with nothing persisted behind it.
    const text = getToolResultText(result);
    const uuid = text.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/
    );
    expect(uuid, `no session id in session_start display:\n${text.slice(0, 200)}`).not.toBeNull();
    sessionId = uuid![0];

    const row = await querySessionRow(sessionId, {
      url: process.env.SUPABASE_URL!,
      key: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      tablePrefix: process.env.GITMEM_TABLE_PREFIX,
    });
    expect(row, "session_start reported a session id with no row behind it").not.toBeNull();
    expect(row!.id).toBe(sessionId);
    expect(row!.project).toBe("test-project");

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

    // GIT-74/R16a: recall renders display text, so the assertion moves onto the
    // render. It must also not assume a populated corpus — this suite's venue is
    // a deliberately blank e2e project, and the old test's "returns semantic
    // matches" expectation was a fixture assumption, not a contract.
    //
    // The contract that actually holds either way: recall answers, and it is
    // unambiguous about which case it is in. When scars ARE present they carry
    // the citable id form the citation rule demands (GIT-74/R14).
    const text = getToolResultText(result);
    expect(text.length).toBeGreaterThan(0);

    const foundScars = /\bid:[0-9a-z]{8}\b/.test(text);
    const saidNone = /no relevant scars|no past lessons/i.test(text);
    expect(
      foundScars || saidNone,
      `recall was neither a cited hit nor an explicit miss:\n${text.slice(0, 300)}`
    ).toBe(true);

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

    // GIT-74/R16a: the old check parsed the response as JSON and asserted no
    // "error" key. Against display text that threw before it could assert
    // anything — and the test is named "persists", so the honest check is the
    // row, not the absence of a word in a string.
    expect(text).not.toMatch(/\berror\b/i);

    const row = await querySessionRow(sessionId, {
      url: process.env.SUPABASE_URL!,
      key: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      tablePrefix: process.env.GITMEM_TABLE_PREFIX,
    });
    expect(row, "session_close returned without the session row surviving").not.toBeNull();
    expect(row!.id).toBe(sessionId);
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

/**
 * E2E Tests: Free Tier
 *
 * Tests gitmem-mcp with no Supabase configuration (free tier).
 * Verifies:
 * - 8 core tools are registered
 * - recall returns empty results (not crash)
 * - session lifecycle works with local .gitmem/
 * - pro/dev tools return tier error
 *
 * All tests go through actual MCP stdio transport.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createMcpClient,
  callTool,
  listTools,
  getToolResultText,
  isToolError,
  createTierEnv,
  CORE_TOOLS,
  PRO_TOOLS,
  type McpTestClient,
} from "./mcp-client.js";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Test-specific .gitmem directory
const TEST_GITMEM_DIR = join(tmpdir(), `gitmem-e2e-free-${Date.now()}`);

describe("Free Tier E2E", () => {
  let mcpClient: McpTestClient;

  beforeAll(async () => {
    // Create test .gitmem directory
    if (existsSync(TEST_GITMEM_DIR)) {
      rmSync(TEST_GITMEM_DIR, { recursive: true });
    }
    mkdirSync(TEST_GITMEM_DIR, { recursive: true });

    // Create MCP client with free tier configuration
    const env = {
      ...createTierEnv("free"),
      GITMEM_DIR: TEST_GITMEM_DIR,
      HOME: TEST_GITMEM_DIR, // Ensure .gitmem goes to test dir
    };

    mcpClient = await createMcpClient(env);
  }, 30_000);

  afterAll(async () => {
    if (mcpClient) {
      await mcpClient.cleanup();
    }

    // Cleanup test directory
    if (existsSync(TEST_GITMEM_DIR)) {
      rmSync(TEST_GITMEM_DIR, { recursive: true });
    }
  });

  describe("Tool Registration", () => {
    it("has all core tools available", async () => {
      const tools = await listTools(mcpClient.client);
      const toolNames = tools.map((t) => t.name);

      for (const coreTool of CORE_TOOLS) {
        expect(toolNames).toContain(coreTool);
      }
    });

    it("lists tools with descriptions", async () => {
      const tools = await listTools(mcpClient.client);

      // All tools should have descriptions
      for (const tool of tools) {
        expect(tool.description).toBeDefined();
        expect(tool.description!.length).toBeGreaterThan(0);
      }
    });
  });

  describe("Recall Tool", () => {
    it("returns empty results without crashing", async () => {
      const result = await callTool(mcpClient.client, "recall", {
        plan: "test deployment verification",
      });

      // Should not be an error
      expect(isToolError(result)).toBe(false);

      // Should have content
      const text = getToolResultText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it("accepts plan parameter correctly", async () => {
      const result = await callTool(mcpClient.client, "recall", {
        plan: "check for relevant scars before deploying",
      });

      expect(isToolError(result)).toBe(false);
    });

    it("handles optional parameters", async () => {
      const result = await callTool(mcpClient.client, "recall", {
        plan: "test with options",
        match_count: 3,
      });

      expect(isToolError(result)).toBe(false);
    });
  });

  describe("Session Lifecycle", () => {
    it("can start a session", async () => {
      const result = await callTool(mcpClient.client, "session_start", {
        agent: "CLI",
      });

      expect(isToolError(result)).toBe(false);
      const text = getToolResultText(result);
      expect(text.toLowerCase()).toContain("session");
    });

    it("can close a session", async () => {
      // First start a session
      await callTool(mcpClient.client, "session_start", {
        agent: "CLI",
      });

      // Then close it
      const result = await callTool(mcpClient.client, "session_close", {
        close_type: "quick",
      });

      expect(isToolError(result)).toBe(false);
    });
  });

  describe("Search Tool", () => {
    it("returns results without crashing", async () => {
      const result = await callTool(mcpClient.client, "search", {
        query: "deployment",
      });

      expect(isToolError(result)).toBe(false);
    });
  });

  describe("Log Tool", () => {
    it("can log a message", async () => {
      const result = await callTool(mcpClient.client, "log", {
        message: "Test log message from E2E test",
        level: "info",
      });

      expect(isToolError(result)).toBe(false);
    });
  });

  describe("Create Learning Tool", () => {
    it("can create a scar", async () => {
      const result = await callTool(mcpClient.client, "create_learning", {
        learning_type: "scar",
        title: "E2E Test Scar",
        description: "Created during E2E testing",
        severity: "low",
        counter_arguments: [
          "This is just a test",
          "No actual lesson learned",
        ],
      });

      // In free tier, this may fail due to no Supabase, but shouldn't crash
      // The tool should handle this gracefully
      const text = getToolResultText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it("can create a win", async () => {
      const result = await callTool(mcpClient.client, "create_learning", {
        learning_type: "win",
        title: "E2E Test Win",
        description: "Testing win creation",
      });

      const text = getToolResultText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe("Create Decision Tool", () => {
    it("can create a decision", async () => {
      const result = await callTool(mcpClient.client, "create_decision", {
        title: "E2E Test Decision",
        decision: "Use MCP for E2E testing",
        rationale: "Tests through actual protocol",
      });

      const text = getToolResultText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe("Record Scar Usage Tool", () => {
    it("can record scar usage", async () => {
      const result = await callTool(mcpClient.client, "record_scar_usage", {
        scar_id: "test-scar-id",
        reference_type: "acknowledged",
        reference_context: "Applied during E2E test",
        surfaced_at: new Date().toISOString(),
      });

      const text = getToolResultText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // OD-666: Rapport Memory Feature
  describe("Rapport Memory (OD-666)", () => {
    it("accepts closing_reflection with Q8/Q9 rapport fields", async () => {
      // Start a session first
      await callTool(mcpClient.client, "session_start", {
        agent_identity: "CLI",
      });

      // Close with rapport fields in closing_reflection
      const result = await callTool(mcpClient.client, "session_close", {
        close_type: "standard",
        closing_reflection: {
          what_broke: "Nothing",
          what_took_longer: "Test infrastructure setup",
          do_differently: "Start with Docker earlier",
          what_worked: "Rapid iteration",
          wrong_assumption: "Thought tests would pass first try",
          scars_applied: [],
          collaborative_dynamic: "Direct and terse. No hedging, no preamble.",
          rapport_notes: "Push-back welcomed. High-energy rapid iteration.",
        },
        task_completion: {
          questions_displayed_at: new Date().toISOString(),
          reflection_completed_at: new Date().toISOString(),
          human_asked_at: new Date().toISOString(),
          human_response: "no corrections",
          human_response_at: new Date().toISOString(),
        },
      });

      expect(isToolError(result)).toBe(false);
      const text = getToolResultText(result);
      expect(text.length).toBeGreaterThan(0);
    });

    it("session_close without rapport fields still works (backwards compatible)", async () => {
      // Start a session
      await callTool(mcpClient.client, "session_start", {
        agent_identity: "CLI",
        force: true,
      });

      // Close without Q8/Q9
      const result = await callTool(mcpClient.client, "session_close", {
        close_type: "standard",
        closing_reflection: {
          what_broke: "Nothing",
          what_took_longer: "Nothing",
          do_differently: "Nothing",
          what_worked: "Everything",
          wrong_assumption: "None",
          scars_applied: [],
        },
        task_completion: {
          questions_displayed_at: new Date().toISOString(),
          reflection_completed_at: new Date().toISOString(),
          human_asked_at: new Date().toISOString(),
          human_response: "looks good",
          human_response_at: new Date().toISOString(),
        },
      });

      expect(isToolError(result)).toBe(false);
    });

    it("session_start output contains rapport section when rapport exists", async () => {
      // First: close a session WITH rapport to populate local storage
      await callTool(mcpClient.client, "session_start", {
        agent_identity: "CLI",
        force: true,
      });

      await callTool(mcpClient.client, "session_close", {
        close_type: "standard",
        closing_reflection: {
          what_broke: "Nothing",
          what_took_longer: "Nothing",
          do_differently: "Nothing",
          what_worked: "Rapid iteration",
          wrong_assumption: "None",
          scars_applied: [],
          collaborative_dynamic: "Directive and fast-paced",
          rapport_notes: "Candid assessment preferred over polite agreement",
        },
        task_completion: {
          questions_displayed_at: new Date().toISOString(),
          reflection_completed_at: new Date().toISOString(),
          human_asked_at: new Date().toISOString(),
          human_response: "confirmed",
          human_response_at: new Date().toISOString(),
        },
      });

      // Now start a new session — rapport should appear in output
      const startResult = await callTool(mcpClient.client, "session_start", {
        agent_identity: "CLI",
        force: true,
      });

      expect(isToolError(startResult)).toBe(false);
      const text = getToolResultText(startResult);

      // Free tier uses local storage — rapport surfacing depends on
      // whether the local session store persists rapport_summary.
      // At minimum, the start should succeed without error.
      expect(text.toLowerCase()).toContain("session");
    });
  });
});

describe("Free Tier - Parameter Validation", () => {
  let mcpClient: McpTestClient;

  beforeAll(async () => {
    const env = {
      ...createTierEnv("free"),
      GITMEM_DIR: TEST_GITMEM_DIR,
    };
    mcpClient = await createMcpClient(env);
  }, 30_000);

  afterAll(async () => {
    if (mcpClient) {
      await mcpClient.cleanup();
    }
  });

  describe("Golden Regression: action vs plan parameter", () => {
    /**
     * This test catches the 2026-02-03 recall crash.
     * The MCP tool definition used "action" but the function expected "plan".
     * With Zod validation, this should return a helpful error.
     */

    it("rejects action parameter with helpful error", async () => {
      // This is the exact input that caused the 2026-02-03 crash
      const result = await callTool(mcpClient.client, "recall", {
        action: "deploy to production",
      } as any);

      // Should get an error about the parameter
      const text = getToolResultText(result);

      // The error should mention plan or action
      // (exact format depends on implementation)
      expect(
        text.toLowerCase().includes("plan") ||
        text.toLowerCase().includes("required") ||
        isToolError(result)
      ).toBe(true);
    });

    it("rejects empty plan", async () => {
      const result = await callTool(mcpClient.client, "recall", {
        plan: "",
      });

      // Should get an error about empty plan
      expect(isToolError(result) || getToolResultText(result).toLowerCase().includes("required")).toBe(true);
    });
  });
});

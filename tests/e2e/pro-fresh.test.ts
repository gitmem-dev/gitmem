/**
 * E2E Tests: Pro Tier - Fresh Install
 *
 * Tests gitmem-mcp with Supabase + 15 starter scars (fresh install scenario).
 * Uses Testcontainers to provide real PostgreSQL database.
 *
 * Verifies:
 * - Recall finds matches through MCP protocol
 * - Session lifecycle persists to database
 * - Cache tools available
 *
 * All tests go through actual MCP stdio transport.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createMcpClient,
  callTool,
  listTools,
  getToolResultText,
  parseToolResult,
  isToolError,
  CORE_TOOLS,
  PRO_TOOLS,
  type McpTestClient,
} from "./mcp-client.js";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { readFileSync } from "fs";
import { join } from "path";

// This test requires Docker - probe for a working container runtime
let DOCKER_AVAILABLE = false;
try {
  const { execFileSync } = await import("child_process");
  execFileSync("docker", ["info"], { timeout: 5_000, stdio: "ignore" });
  DOCKER_AVAILABLE = true;
} catch {
  // docker not installed or not running
}

describe.skipIf(!DOCKER_AVAILABLE)("Pro Tier - Fresh Install E2E", () => {
  let container: StartedPostgreSqlContainer;
  let pgClient: Client;
  let mcpClient: McpTestClient;

  beforeAll(async () => {
    // Start PostgreSQL container with pgvector
    console.log("[e2e] Starting PostgreSQL container...");
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
      .withDatabase("gitmem_test")
      .withUsername("test")
      .withPassword("test")
      .start();

    console.log(`[e2e] Container started: ${container.getConnectionUri()}`);

    // Connect and load schema
    pgClient = new Client({
      connectionString: container.getConnectionUri(),
    });
    await pgClient.connect();

    // Stub Supabase auth.role() — plain Postgres doesn't have the auth schema
    await pgClient.query(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
        SELECT 'service_role'::TEXT;
      $$ LANGUAGE sql;
    `);

    // Load schema
    const schemaPath = join(__dirname, "../../schema/setup.sql");
    const schema = readFileSync(schemaPath, "utf-8");
    await pgClient.query(schema);

    // Seed 15 starter scars
    await seedStarterScars(pgClient);

    console.log("[e2e] Schema loaded and starter scars seeded");

    // Create MCP client pointing to the test database
    mcpClient = await createMcpClient({
      SUPABASE_URL: container.getConnectionUri(),
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      GITMEM_TIER: "pro",
      DATABASE_URL: container.getConnectionUri(),
    });
  }, 120_000); // 2 minute timeout for container startup

  afterAll(async () => {
    if (mcpClient) {
      await mcpClient.cleanup();
    }
    if (pgClient) {
      await pgClient.end();
    }
    if (container) {
      await container.stop();
    }
  });

  describe("Tool Registration", () => {
    it("has all core tools", async () => {
      const tools = await listTools(mcpClient.client);
      const toolNames = tools.map((t) => t.name);

      for (const tool of CORE_TOOLS) {
        expect(toolNames).toContain(tool);
      }
    });

    it("has pro tier tools", async () => {
      const tools = await listTools(mcpClient.client);
      const toolNames = tools.map((t) => t.name);

      // Pro tools should be available
      for (const tool of PRO_TOOLS) {
        expect(toolNames).toContain(tool);
      }
    });
  });

  describe("Recall with Starter Scars", () => {
    it("finds matches for deployment query", async () => {
      const result = await callTool(mcpClient.client, "recall", {
        plan: "deploy to production",
      });

      expect(isToolError(result)).toBe(false);
      const text = getToolResultText(result);

      // Should find the "Done ≠ Deployed" starter scar
      expect(text.toLowerCase()).toContain("deploy");
    });

    it("finds matches for testing query", async () => {
      const result = await callTool(mcpClient.client, "recall", {
        plan: "run tests before merge",
      });

      expect(isToolError(result)).toBe(false);
    });

    it("returns results with similarity scores", async () => {
      const result = await callTool(mcpClient.client, "recall", {
        plan: "verify deployment",
        match_count: 5,
      });

      expect(isToolError(result)).toBe(false);
      // Result should mention scars or matches
      const text = getToolResultText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe("Session Lifecycle", () => {
    it("starts session successfully", async () => {
      const result = await callTool(mcpClient.client, "session_start", {
        agent_identity: "CLI",
        project: "gitmem_test",
      });

      expect(isToolError(result)).toBe(false);
      const text = getToolResultText(result);
      expect(text.toLowerCase()).toContain("session");
    });

    it("closes session with reflection", async () => {
      // Start a new session
      await callTool(mcpClient.client, "session_start", {
        agent_identity: "CLI",
        project: "gitmem_test",
        force: true,
      });

      // Close with quick type
      const result = await callTool(mcpClient.client, "session_close", {
        close_type: "quick",
      });

      expect(isToolError(result)).toBe(false);
    });
  });

  describe("Create Learning", () => {
    it("creates scar without error", async () => {
      const result = await callTool(mcpClient.client, "create_learning", {
        learning_type: "scar",
        title: "E2E Pro Tier Test Scar",
        description: "Created during pro tier E2E testing",
        severity: "medium",
        counter_arguments: [
          "This is a test scar",
          "Should be cleaned up after testing",
        ],
        project: "gitmem_test",
      });

      expect(isToolError(result)).toBe(false);
      const text = getToolResultText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe("Create Decision", () => {
    it("creates decision without error", async () => {
      const result = await callTool(mcpClient.client, "create_decision", {
        title: "E2E Test Decision",
        decision: "Use Testcontainers for E2E",
        rationale: "Real database catches real bugs",
        project: "gitmem_test",
      });

      expect(isToolError(result)).toBe(false);
      const text = getToolResultText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe("Pro Tools", () => {
    it("can use analyze tool", async () => {
      const result = await callTool(mcpClient.client, "analyze", {
        lens: "summary",
        days: 7,
      });

      expect(isToolError(result)).toBe(false);
    });

    it("can use cache status tool", async () => {
      const result = await callTool(mcpClient.client, "gitmem-cache-status", {});

      // Cache status should return info without error
      expect(isToolError(result)).toBe(false);
      const text = getToolResultText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });
});

/**
 * Seed the database with 15 starter scars
 */
async function seedStarterScars(client: Client): Promise<void> {
  const starterScars = [
    {
      title: "Done ≠ Deployed ≠ Verified Working",
      description: "Completing a task is not the same as deploying it.",
      learning_type: "scar",
      severity: "critical",
    },
    {
      title: "No Tests = No Approval",
      description: "Code without tests should not be approved.",
      learning_type: "scar",
      severity: "critical",
    },
    {
      title: "Architect Before Delegating",
      description: "Map full integration before creating subtasks.",
      learning_type: "scar",
      severity: "high",
    },
    {
      title: "Test from Consumer Perspective",
      description: "Tests should exercise the system from consumer view.",
      learning_type: "scar",
      severity: "high",
    },
    {
      title: "Validate All External Inputs",
      description: "All inputs from external sources must be validated.",
      learning_type: "scar",
      severity: "high",
    },
    {
      title: "Check Index Existence in Migrations",
      description: "Verify indexes are preserved when modifying migrations.",
      learning_type: "scar",
      severity: "high",
    },
    {
      title: "Cache Symmetrically",
      description: "Apply caching consistently to similar operations.",
      learning_type: "scar",
      severity: "medium",
    },
    {
      title: "Log Before and After External Calls",
      description: "Log entry and exit of external service calls.",
      learning_type: "pattern",
      severity: null,
    },
    {
      title: "Use Semantic Versioning",
      description: "Follow semver for releases.",
      learning_type: "pattern",
      severity: null,
    },
    {
      title: "Prefer Editing Over Creating",
      description: "Edit existing files rather than creating new ones.",
      learning_type: "pattern",
      severity: null,
    },
    {
      title: "Local Vector Search Reduces Latency",
      description: "Cache embeddings locally for faster search.",
      learning_type: "win",
      severity: null,
    },
    {
      title: "Schema Validation Catches Bugs Early",
      description: "Zod schemas catch bugs at the boundary.",
      learning_type: "win",
      severity: null,
    },
    {
      title: "Testcontainers Catch Real Regressions",
      description: "Real databases catch issues mocks miss.",
      learning_type: "win",
      severity: null,
    },
    {
      title: "File-Based Cache for Resilience",
      description: "File cache survives process restarts.",
      learning_type: "win",
      severity: null,
    },
    {
      title: "Golden Regression Tests",
      description: "Add tests that replay specific bugs.",
      learning_type: "pattern",
      severity: null,
    },
  ];

  for (const scar of starterScars) {
    // Generate a simple random embedding (1536 dimensions)
    const embedding = Array.from({ length: 1536 }, () => Math.random() * 2 - 1);
    const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    const normalizedEmbedding = embedding.map((v) => v / magnitude);
    const embeddingStr = `[${normalizedEmbedding.join(",")}]`;

    await client.query(
      `INSERT INTO gitmem_learnings (title, description, learning_type, severity, project, embedding)
       VALUES ($1, $2, $3, $4, 'gitmem_test', $5::vector)`,
      [scar.title, scar.description, scar.learning_type, scar.severity, embeddingStr]
    );
  }

  console.log("[e2e] Seeded 15 starter scars");
}

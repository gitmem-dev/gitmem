/**
 * Integration Test Setup with Testcontainers
 *
 * Provides a real PostgreSQL database with pgvector for integration testing.
 * This catches issues that mocks would miss:
 * - Missing indexes (51s query regression)
 * - Query plan changes
 * - Schema drift
 *
 * Based on: docs/planning/gitmem-regression-testing-plan.md
 */

import { beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { readFileSync } from "fs";
import { join } from "path";

// Export container and client for tests to use
export let container: StartedPostgreSqlContainer;
export let pgClient: Client;

// Track query count for cache behavior tests
export let queryCount = 0;

/**
 * Reset query counter
 */
export function resetQueryCount(): void {
  queryCount = 0;
}

/**
 * Increment query counter (called by instrumented functions)
 */
export function incrementQueryCount(): void {
  queryCount++;
}

/**
 * Get connection string for the test container
 */
export function getConnectionString(): string {
  if (!container) {
    throw new Error("Container not started - ensure setup.ts is loaded");
  }
  return container.getConnectionUri();
}

/**
 * Get a new pg Client connected to the test database
 */
export async function getTestClient(): Promise<Client> {
  const client = new Client({
    connectionString: getConnectionString(),
  });
  await client.connect();
  return client;
}

/**
 * Setup: Start PostgreSQL container with pgvector
 */
beforeAll(async () => {
  console.log("[setup] Starting PostgreSQL container with pgvector...");

  // Start PostgreSQL container with pgvector image
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withDatabase("gitmem_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  console.log(`[setup] Container started: ${container.getConnectionUri()}`);

  // Connect pg client
  pgClient = new Client({
    connectionString: container.getConnectionUri(),
  });
  await pgClient.connect();

  // Load and execute schema
  const schemaPath = join(__dirname, "../../schema/setup.sql");
  const schema = readFileSync(schemaPath, "utf-8");

  // Split and execute schema statements
  // Note: pgvector extension is included in the docker image
  await pgClient.query(schema);

  console.log("[setup] Schema loaded successfully");

  // Set environment variables for the application
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.SUPABASE_URL = container.getConnectionUri();
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GITMEM_TIER = "pro"; // Enable pro tier features

}, 120_000); // 2 minute timeout for container startup

/**
 * Teardown: Stop container
 */
afterAll(async () => {
  console.log("[setup] Stopping PostgreSQL container...");

  if (pgClient) {
    await pgClient.end();
  }

  if (container) {
    await container.stop();
  }

  console.log("[setup] Container stopped");
});

/**
 * Reset query counter before each test
 */
beforeEach(() => {
  resetQueryCount();
});

/**
 * Helper: Truncate all tables (for test isolation)
 */
export async function truncateAllTables(): Promise<void> {
  await pgClient.query(`
    TRUNCATE TABLE
      gitmem_scar_usage,
      gitmem_decisions,
      gitmem_sessions,
      gitmem_learnings
    CASCADE
  `);
}

/**
 * Helper: Check if an index exists
 */
export async function indexExists(indexName: string): Promise<boolean> {
  const result = await pgClient.query(
    `SELECT 1 FROM pg_indexes WHERE indexname = $1`,
    [indexName]
  );
  return result.rows.length > 0;
}

/**
 * Helper: Get query plan for a statement
 */
export async function getQueryPlan(sql: string): Promise<string> {
  const result = await pgClient.query(`EXPLAIN (FORMAT TEXT) ${sql}`);
  return result.rows.map((r) => r["QUERY PLAN"]).join("\n");
}

/**
 * Helper: Get query plan with timing
 */
export async function analyzeQueryPlan(sql: string): Promise<{
  plan: string;
  executionTime: number;
  usesIndex: boolean;
  indexName?: string;
}> {
  const result = await pgClient.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`);
  const plan = result.rows[0]["QUERY PLAN"][0];

  const planText = JSON.stringify(plan, null, 2);
  const usesIndex = planText.includes("Index Scan") || planText.includes("Index Only Scan");

  // Extract index name if present
  let indexName: string | undefined;
  const indexMatch = planText.match(/"Index Name":\s*"([^"]+)"/);
  if (indexMatch) {
    indexName = indexMatch[1];
  }

  return {
    plan: planText,
    executionTime: plan["Execution Time"] || 0,
    usesIndex,
    indexName,
  };
}

/**
 * Helper: Generate a random vector (1536 dimensions for OpenAI embeddings)
 */
export function generateRandomVector(dimensions = 1536): number[] {
  const vector: number[] = [];
  for (let i = 0; i < dimensions; i++) {
    vector.push(Math.random() * 2 - 1); // Range: -1 to 1
  }
  // Normalize to unit vector
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return vector.map((v) => v / magnitude);
}

/**
 * Helper: Format vector for PostgreSQL pgvector
 */
export function formatVector(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

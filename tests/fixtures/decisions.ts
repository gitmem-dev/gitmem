/**
 * Test Fixtures: Decisions
 *
 * Typed decision test data for integration and E2E tests.
 */

import { randomUUID } from "crypto";

export interface TestDecision {
  id: string;
  decision_date?: string;
  title: string;
  decision: string;
  rationale: string;
  alternatives_considered?: string[];
  session_id?: string;
  project: string;
  embedding?: number[];
  created_at?: string;
}

/**
 * Decision about test framework
 */
export const DECISION_TEST_FRAMEWORK: TestDecision = {
  id: randomUUID(),
  title: "Use Vitest for Testing",
  decision: "Adopt Vitest as the primary test framework for gitmem-mcp.",
  rationale:
    "Vitest provides fast execution, native TypeScript support, and excellent developer experience. " +
    "It's already the standard in the ecosystem and integrates well with our build tooling.",
  alternatives_considered: [
    "Jest - More established but slower and requires more configuration for ESM/TypeScript.",
    "Mocha + Chai - More flexible but requires more setup and doesn't have built-in mocking.",
    "Node.js built-in test runner - Too basic, lacks features we need.",
  ],
  project: "gitmem_test",
};

/**
 * Decision about database testing
 */
export const DECISION_TESTCONTAINERS: TestDecision = {
  id: randomUUID(),
  title: "Use Testcontainers for Database Tests",
  decision: "Use Testcontainers to spin up real PostgreSQL instances for integration tests.",
  rationale:
    "Mocks cannot catch issues like missing indexes (which caused the 51s query regression). " +
    "Real databases catch query plan changes, schema drift, and performance regressions.",
  alternatives_considered: [
    "Mocking Supabase client - Faster but misses real database issues.",
    "Shared test database - Would require cleanup and could have test interference.",
    "SQLite for testing - Different SQL dialect, can't test PostgreSQL-specific features.",
  ],
  project: "gitmem_test",
};

/**
 * Decision about caching strategy
 */
export const DECISION_FILE_CACHE: TestDecision = {
  id: randomUUID(),
  title: "Use File-Based Caching",
  decision: "Implement file-based caching for decisions, wins, and scar search results.",
  rationale:
    "File-based caching survives process restarts, doesn't require external services like Redis, " +
    "and works well for CLI tools. 5-minute TTL balances freshness with performance.",
  alternatives_considered: [
    "In-memory cache - Lost on process restart, not suitable for CLI tool.",
    "Redis - Adds operational complexity, overkill for single-user CLI.",
    "SQLite cache - More complex than file-based, similar benefits.",
  ],
  project: "gitmem_test",
};

/**
 * Decision about schema validation
 */
export const DECISION_ZOD_SCHEMAS: TestDecision = {
  id: randomUUID(),
  title: "Adopt Zod for Parameter Validation",
  decision: "Use Zod schemas for all MCP tool parameter validation.",
  rationale:
    "The recall crash was caused by undefined propagating through the system. " +
    "Zod provides TypeScript-first validation that catches issues at the boundary with helpful error messages.",
  alternatives_considered: [
    "Manual validation - Error-prone, inconsistent error messages.",
    "JSON Schema + ajv - More verbose, less TypeScript integration.",
    "io-ts - Good but Zod has better DX and community adoption.",
  ],
  project: "gitmem_test",
};

/**
 * All test decisions for seeding
 */
export const ALL_TEST_DECISIONS: TestDecision[] = [
  DECISION_TEST_FRAMEWORK,
  DECISION_TESTCONTAINERS,
  DECISION_FILE_CACHE,
  DECISION_ZOD_SCHEMAS,
];

/**
 * Create a decision linked to a session
 */
export function createDecisionForSession(
  sessionId: string,
  title: string,
  decision: string,
  rationale: string,
  project = "gitmem_test"
): TestDecision {
  return {
    id: randomUUID(),
    session_id: sessionId,
    title,
    decision,
    rationale,
    project,
    decision_date: new Date().toISOString().split("T")[0],
  };
}

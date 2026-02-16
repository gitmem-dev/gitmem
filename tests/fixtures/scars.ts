/**
 * Test Fixtures: Scars
 *
 * Typed scar test data for integration and E2E tests.
 */

import { randomUUID } from "crypto";

export interface TestScar {
  id: string;
  title: string;
  description: string;
  learning_type: "scar" | "win" | "pattern" | "anti_pattern";
  severity?: "critical" | "high" | "medium" | "low";
  scar_type?: string;
  counter_arguments?: string[];
  problem_context?: string;
  solution_approach?: string;
  applies_when?: string[];
  keywords?: string[];
  domain?: string[];
  embedding?: number[];
  project: string;
  source_date?: string;
  created_at?: string;
  updated_at?: string;
  is_starter?: boolean;
}

/**
 * Critical scar about deployment verification
 */
export const SCAR_DEPLOYMENT_VERIFICATION: TestScar = {
  id: randomUUID(),
  title: "Done ≠ Deployed ≠ Verified Working",
  description:
    "Completing a task is not the same as deploying it, which is not the same as verifying it works in production. " +
    "The full loop requires: merge → push → pull on target → restart service → verify running.",
  learning_type: "scar",
  severity: "critical",
  scar_type: "operational",
  counter_arguments: [
    "You might think the CI/CD pipeline handles deployment automatically — but not all pipelines include verification steps.",
    "You might assume if tests pass, it's working — but integration environment differs from production.",
  ],
  problem_context: "Feature was marked done after PR merge, but service wasn't restarted on production.",
  solution_approach: "Always verify the service is running with the new code before marking done.",
  applies_when: ["marking issue as done", "completing deployment", "finishing feature"],
  keywords: ["deployment", "verification", "done", "ci-cd"],
  domain: ["devops", "workflow"],
  project: "gitmem_test",
};

/**
 * High severity scar about missing tests
 */
export const SCAR_NO_TESTS: TestScar = {
  id: randomUUID(),
  title: "No Tests = No Approval",
  description:
    "Code without automated tests should not be approved. Tests catch regressions, document behavior, " +
    "and provide confidence for future changes.",
  learning_type: "scar",
  severity: "high",
  scar_type: "quality",
  counter_arguments: [
    "You might think the code is simple enough to not need tests — but even simple code can break with edge cases.",
    "You might believe manual testing is sufficient — but manual tests don't prevent regressions.",
  ],
  problem_context: "Feature was approved without tests, later broke during refactoring.",
  solution_approach: "Require test output in PR before approval. 'Where are the tests? Show me the output.'",
  applies_when: ["reviewing PRs", "approving code", "completing features"],
  keywords: ["testing", "quality", "approval", "regression"],
  domain: ["development", "quality"],
  project: "gitmem_test",
};

/**
 * Medium severity scar about recall parameter
 */
export const SCAR_RECALL_PARAM: TestScar = {
  id: randomUUID(),
  title: "Recall requires 'plan' not 'action'",
  description:
    "The recall tool expects a 'plan' parameter describing what you're about to do. " +
    "Using 'action' instead causes undefined to propagate through the embedding chain.",
  learning_type: "scar",
  severity: "medium",
  scar_type: "technical",
  counter_arguments: [
    "You might think 'action' and 'plan' are interchangeable — but the schema expects 'plan' specifically.",
    "You might assume parameter validation catches this — but without Zod validation, undefined propagates silently.",
  ],
  problem_context: "recall({action: 'deploy'}) caused crash in embedding service.",
  solution_approach: "Use Zod schemas for parameter validation with clear error messages.",
  applies_when: ["calling recall tool", "implementing MCP tools"],
  keywords: ["recall", "parameters", "validation", "zod"],
  domain: ["mcp", "api"],
  project: "gitmem_test",
};

/**
 * Low severity scar about caching
 */
export const SCAR_CACHE_ASYMMETRY: TestScar = {
  id: randomUUID(),
  title: "Cache symmetry for similar operations",
  description:
    "When two similar operations exist (e.g., loading decisions vs loading wins), " +
    "they should both use the same caching pattern. Asymmetric caching causes confusing performance differences.",
  learning_type: "scar",
  severity: "low",
  scar_type: "performance",
  counter_arguments: [
    "You might think different data types need different caching strategies — but similar access patterns benefit from consistent caching.",
    "You might prioritize one operation over another — but users expect consistent performance.",
  ],
  problem_context: "Decisions cached (3ms) while wins always hit database (12s).",
  solution_approach: "Audit similar operations for consistent caching. Apply same TTL and pattern.",
  applies_when: ["implementing caching", "adding new data retrieval"],
  keywords: ["caching", "performance", "consistency"],
  domain: ["performance", "architecture"],
  project: "gitmem_test",
};

/**
 * Win pattern about semantic search
 */
export const WIN_SEMANTIC_SEARCH: TestScar = {
  id: randomUUID(),
  title: "Local vector search reduces latency",
  description:
    "Embedding scars locally and using cosine similarity for search reduces recall latency " +
    "from 2-5 seconds (API call) to under 100ms (local computation).",
  learning_type: "win",
  problem_context: "Recall was slow due to remote API calls for every query.",
  solution_approach: "Cache embeddings locally, perform vector search in-process.",
  applies_when: ["implementing search", "optimizing latency"],
  keywords: ["search", "embeddings", "performance", "local"],
  domain: ["performance", "search"],
  project: "gitmem_test",
};

/**
 * All test scars for seeding
 */
export const ALL_TEST_SCARS: TestScar[] = [
  SCAR_DEPLOYMENT_VERIFICATION,
  SCAR_NO_TESTS,
  SCAR_RECALL_PARAM,
  SCAR_CACHE_ASYMMETRY,
  WIN_SEMANTIC_SEARCH,
];

/**
 * Get scars by severity
 */
export function getScarsBySeverity(severity: TestScar["severity"]): TestScar[] {
  return ALL_TEST_SCARS.filter((s) => s.severity === severity);
}

/**
 * Get scars by type
 */
export function getScarsByType(type: TestScar["learning_type"]): TestScar[] {
  return ALL_TEST_SCARS.filter((s) => s.learning_type === type);
}

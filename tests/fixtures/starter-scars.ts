/**
 * Test Fixtures: Starter Scars
 *
 * These match the 15 starter scars that ship with gitmem.
 * Used for testing the "fresh install with starter scars" scenario.
 */

import { randomUUID } from "crypto";
import type { TestScar } from "./scars.js";

/**
 * The 15 starter scars for fresh installations
 */
export const STARTER_SCARS: TestScar[] = [
  {
    id: randomUUID(),
    title: "Done ≠ Deployed ≠ Verified Working",
    description:
      "Completing a task locally is not the same as deploying it, which is not the same as verifying it works. " +
      "Always complete the full loop: merge → deploy → verify running in target environment.",
    learning_type: "scar",
    severity: "critical",
    counter_arguments: [
      "You might think CI/CD handles deployment — but not all pipelines include verification.",
      "You might assume passing tests mean it works — but production differs from test environments.",
    ],
    project: "gitmem_test",
    keywords: ["deployment", "verification", "done"],
  },
  {
    id: randomUUID(),
    title: "No Tests = No Approval",
    description: "Code without automated tests should not be approved. Ask: 'Where are the tests? Show me the output.'",
    learning_type: "scar",
    severity: "critical",
    counter_arguments: [
      "You might think the code is simple enough — but simple code can break with edge cases.",
      "You might believe manual testing is sufficient — but it doesn't prevent regressions.",
    ],
    project: "gitmem_test",
    keywords: ["testing", "quality", "approval"],
  },
  {
    id: randomUUID(),
    title: "Architect Before Delegating",
    description:
      "Before creating subtasks or delegating work, fully architect the integration. " +
      "Map all touchpoints, dependencies, and contracts first.",
    learning_type: "scar",
    severity: "high",
    counter_arguments: [
      "You might want to parallelize immediately — but unarchitected work creates integration debt.",
      "You might think each piece is independent — but hidden dependencies emerge at integration time.",
    ],
    project: "gitmem_test",
    keywords: ["architecture", "delegation", "planning"],
  },
  {
    id: randomUUID(),
    title: "Test from Consumer's Perspective",
    description:
      "Tests should exercise the system from the consumer's perspective, not just internal functions. " +
      "If an MCP tool is the interface, test through MCP, not direct function calls.",
    learning_type: "scar",
    severity: "high",
    counter_arguments: [
      "You might think unit tests are sufficient — but they miss integration issues.",
      "You might test internal functions for speed — but you'll miss consumer-facing bugs.",
    ],
    project: "gitmem_test",
    keywords: ["testing", "consumer", "integration"],
  },
  {
    id: randomUUID(),
    title: "Validate All External Inputs",
    description:
      "All inputs from external sources (APIs, user input, file content) must be validated. " +
      "Use schema validation (Zod) at boundaries.",
    learning_type: "scar",
    severity: "high",
    counter_arguments: [
      "You might trust the caller to send valid data — but callers make mistakes.",
      "You might add validation later — but undefined values will propagate silently until then.",
    ],
    project: "gitmem_test",
    keywords: ["validation", "security", "zod"],
  },
  {
    id: randomUUID(),
    title: "Check Index Existence in Migrations",
    description:
      "When consolidating or modifying migrations, verify all required indexes are preserved. " +
      "Missing indexes cause severe performance regressions (200ms → 51s).",
    learning_type: "scar",
    severity: "high",
    counter_arguments: [
      "You might think the query works without the index — but it will be orders of magnitude slower.",
      "You might not notice missing indexes in dev — but production data volumes will expose them.",
    ],
    project: "gitmem_test",
    keywords: ["database", "indexes", "migrations", "performance"],
  },
  {
    id: randomUUID(),
    title: "Cache Symmetrically",
    description:
      "When similar operations exist (decisions vs wins, read vs write), apply caching consistently. " +
      "Asymmetric caching causes confusing performance differences.",
    learning_type: "scar",
    severity: "medium",
    counter_arguments: [
      "You might prioritize one operation — but users expect consistent performance.",
      "You might think different data needs different caching — but similar patterns benefit from consistency.",
    ],
    project: "gitmem_test",
    keywords: ["caching", "performance", "consistency"],
  },
  {
    id: randomUUID(),
    title: "Log Before and After External Calls",
    description:
      "Log entry and exit of external service calls with timing. This makes debugging latency issues much easier.",
    learning_type: "pattern",
    applies_when: ["making API calls", "database queries", "external service integration"],
    project: "gitmem_test",
    keywords: ["logging", "debugging", "observability"],
  },
  {
    id: randomUUID(),
    title: "Use Semantic Versioning",
    description:
      "Follow semantic versioning: MAJOR for breaking changes, MINOR for new features, PATCH for bug fixes. " +
      "Document changes in CHANGELOG.md.",
    learning_type: "pattern",
    applies_when: ["releasing", "versioning", "publishing"],
    project: "gitmem_test",
    keywords: ["versioning", "semver", "releases"],
  },
  {
    id: randomUUID(),
    title: "Prefer Editing Over Creating",
    description:
      "When modifying behavior, edit existing files rather than creating new ones. " +
      "This reduces duplication and maintains discoverability.",
    learning_type: "pattern",
    applies_when: ["implementing features", "refactoring", "adding functionality"],
    project: "gitmem_test",
    keywords: ["coding", "files", "organization"],
  },
  {
    id: randomUUID(),
    title: "Local Vector Search Reduces Latency",
    description:
      "For semantic search, cache embeddings locally and compute similarity in-process. " +
      "This reduces latency from seconds (API call) to milliseconds (local computation).",
    learning_type: "win",
    problem_context: "Remote API calls for every search query caused 2-5s latency.",
    solution_approach: "Cache embeddings locally, use cosine similarity for search.",
    project: "gitmem_test",
    keywords: ["search", "embeddings", "performance"],
  },
  {
    id: randomUUID(),
    title: "Schema Validation Catches Bugs Early",
    description:
      "Adding Zod schemas for all tool parameters catches bugs at the boundary, " +
      "preventing undefined values from propagating through the system.",
    learning_type: "win",
    problem_context: "Undefined values propagated through system until hitting external API.",
    solution_approach: "Add Zod schemas for all parameters, validate at tool entry.",
    project: "gitmem_test",
    keywords: ["zod", "validation", "schemas"],
  },
  {
    id: randomUUID(),
    title: "Testcontainers Catch Real Regressions",
    description:
      "Using Testcontainers with real databases catches issues mocks miss: " +
      "missing indexes, query plan changes, schema drift.",
    learning_type: "win",
    problem_context: "Mocks couldn't catch the 51s query regression from missing index.",
    solution_approach: "Use Testcontainers with real PostgreSQL for integration tests.",
    project: "gitmem_test",
    keywords: ["testing", "testcontainers", "integration"],
  },
  {
    id: randomUUID(),
    title: "File-Based Cache for Resilience",
    description:
      "File-based caching survives process restarts and doesn't require external services. " +
      "Good for CLI tools and local-first applications.",
    learning_type: "win",
    problem_context: "In-memory cache lost on process restart.",
    solution_approach: "Use file-based cache with TTL-based expiration.",
    project: "gitmem_test",
    keywords: ["caching", "files", "resilience"],
  },
  {
    id: randomUUID(),
    title: "Golden Regression Tests",
    description:
      "For every bug found in production, add a 'golden regression test' that replays the exact failure. " +
      "This prevents the same bug from recurring.",
    learning_type: "pattern",
    applies_when: ["fixing bugs", "writing tests", "preventing regressions"],
    project: "gitmem_test",
    keywords: ["testing", "regression", "bugs"],
  },
];

/**
 * Get starter scars for a specific project
 */
export function getStarterScarsForProject(project: string): TestScar[] {
  return STARTER_SCARS.map((scar) => ({
    ...scar,
    id: randomUUID(), // Generate new IDs
    project,
  }));
}

/**
 * Get starter scar count by type
 */
export function getStarterScarStats(): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const scar of STARTER_SCARS) {
    stats[scar.learning_type] = (stats[scar.learning_type] || 0) + 1;
  }
  return stats;
}

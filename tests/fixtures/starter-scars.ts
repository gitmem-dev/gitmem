/**
 * Test Fixtures: Starter Scars
 *
 * Representative subset of the 12 starter scars that ship with gitmem.
 * Used for testing the "fresh install with starter scars" scenario.
 */

import { randomUUID } from "crypto";
import type { TestScar } from "./scars.js";

/**
 * Representative subset of starter scars for fresh installations
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
    is_starter: true,
  },
  {
    id: randomUUID(),
    title: "Database Migration Without Rollback Plan",
    description:
      "Running database migrations without a tested rollback plan risks data loss or extended downtime. " +
      "Destructive migrations (dropping columns, changing types) are especially dangerous. " +
      "Always write and test the down migration before running the up migration in production.",
    learning_type: "scar",
    severity: "critical",
    counter_arguments: [
      "You might think this migration is additive so it's safe — but even additive migrations can fail and leave the schema in a partial state.",
      "You might rely on backup restoration — but that takes time and may lose recent data.",
    ],
    project: "gitmem_test",
    keywords: ["database", "migration", "rollback", "schema", "data-loss"],
    is_starter: true,
  },
  {
    id: randomUUID(),
    title: "Silent Error Swallowing Hides Real Failures",
    description:
      "Empty catch blocks and generic error handlers that log but don't surface errors lead to silent failures. " +
      "The system appears to work while data is lost or corrupted. " +
      "At minimum, log errors with enough context to diagnose the issue. Better: fail visibly.",
    learning_type: "scar",
    severity: "high",
    counter_arguments: [
      "You might catch errors to prevent crashes — but catching without handling is worse because the problem is hidden.",
      "You might think the error is non-critical — but 'non-critical' errors compound and mask root causes of critical issues.",
    ],
    project: "gitmem_test",
    keywords: ["error-handling", "catch", "silent-failure", "logging"],
    is_starter: true,
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

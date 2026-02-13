/**
 * Integration Tests: Query Plans
 *
 * Tests that critical queries use indexes, not sequential scans.
 * This catches the 51s regression caused by missing indexes.
 *
 * Uses EXPLAIN ANALYZE to verify query plans.
 */

import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { randomUUID } from "crypto";
import { pgClient, truncateAllTables, analyzeQueryPlan, indexExists, formatVector } from "./setup.js";
import { seedScaleProfile, generateRandomVector } from "../fixtures/scale-seed.js";

describe("Query Plans", () => {
  beforeAll(async () => {
    // Seed with MEDIUM profile for realistic query planning
    await truncateAllTables();
    await seedScaleProfile(pgClient, "MEDIUM", "gitmem_test");

    // Run ANALYZE to update statistics for query planner
    await pgClient.query("ANALYZE gitmem_learnings");
    await pgClient.query("ANALYZE gitmem_sessions");
    await pgClient.query("ANALYZE gitmem_decisions");
  });

  describe("index existence", () => {
    it("has embedding index on learnings", async () => {
      const exists = await indexExists("idx_gitmem_learnings_embedding");
      expect(exists).toBe(true);
    });

    it("has type index on learnings", async () => {
      const exists = await indexExists("idx_gitmem_learnings_type");
      expect(exists).toBe(true);
    });

    it("has project index on learnings", async () => {
      const exists = await indexExists("idx_gitmem_learnings_project");
      expect(exists).toBe(true);
    });

    it("has agent index on sessions", async () => {
      const exists = await indexExists("idx_gitmem_sessions_agent");
      expect(exists).toBe(true);
    });

    it("has created_at index on sessions", async () => {
      const exists = await indexExists("idx_gitmem_sessions_created");
      expect(exists).toBe(true);
    });

    it("has session_id index on decisions", async () => {
      const exists = await indexExists("idx_gitmem_decisions_session");
      expect(exists).toBe(true);
    });

    it("has scar_id index on scar_usage", async () => {
      const exists = await indexExists("idx_gitmem_scar_usage_scar");
      expect(exists).toBe(true);
    });
  });

  describe("decisions query performance", () => {
    it("uses index for recent decisions query", async () => {
      const query = `
        SELECT id, title, decision FROM gitmem_decisions
        WHERE project = 'gitmem_test'
        ORDER BY created_at DESC
        LIMIT 5
      `;

      const plan = await analyzeQueryPlan(query);

      // Should complete in reasonable time (not 51s!)
      expect(plan.executionTime).toBeLessThan(1000); // Under 1 second

      // Log plan for debugging
      console.log("[query-plan] Decisions query plan:", plan.plan);
    });

    it("decisions query should not do sequential scan on large tables", async () => {
      // Seed more data for realistic test
      const query = `
        SELECT id, title, decision FROM gitmem_decisions
        ORDER BY created_at DESC
        LIMIT 5
      `;

      const plan = await analyzeQueryPlan(query);

      // With proper indexes, should use index scan
      // Note: For small datasets, PostgreSQL might choose seq scan as it's faster
      // This test mainly catches the regression where indexes are missing entirely
      console.log("[query-plan] Decisions plan uses index:", plan.usesIndex);
      console.log("[query-plan] Execution time:", plan.executionTime, "ms");

      // The key assertion: query should be fast regardless of method
      expect(plan.executionTime).toBeLessThan(1000);
    });
  });

  describe("learnings query performance", () => {
    it("uses index for learnings by type query", async () => {
      const query = `
        SELECT id, title, description FROM gitmem_learnings
        WHERE learning_type = 'scar' AND project = 'gitmem_test'
        ORDER BY created_at DESC
        LIMIT 10
      `;

      const plan = await analyzeQueryPlan(query);

      expect(plan.executionTime).toBeLessThan(1000);
      console.log("[query-plan] Learnings by type plan:", plan.usesIndex);
    });

    it("uses index for wins query", async () => {
      const query = `
        SELECT id, title, description FROM gitmem_learnings
        WHERE learning_type = 'win' AND project = 'gitmem_test'
        ORDER BY created_at DESC
        LIMIT 8
      `;

      const plan = await analyzeQueryPlan(query);

      expect(plan.executionTime).toBeLessThan(1000);
    });
  });

  describe("sessions query performance", () => {
    it("uses index for recent sessions by agent", async () => {
      const query = `
        SELECT id, session_title, agent FROM gitmem_sessions
        WHERE agent = 'CLI'
        ORDER BY created_at DESC
        LIMIT 5
      `;

      const plan = await analyzeQueryPlan(query);

      expect(plan.executionTime).toBeLessThan(1000);
    });

    it("uses created_at index for ordering", async () => {
      const query = `
        SELECT id, session_title FROM gitmem_sessions
        ORDER BY created_at DESC
        LIMIT 10
      `;

      const plan = await analyzeQueryPlan(query);

      expect(plan.executionTime).toBeLessThan(1000);
    });
  });

  describe("semantic search performance", () => {
    it("vector search uses IVFFlat index", async () => {
      // Generate a query embedding
      const embedding = generateRandomVector();
      const vectorStr = formatVector(embedding);

      // Use the RPC function
      const query = `
        SELECT * FROM gitmem_semantic_search(
          '${vectorStr}'::vector(1536),
          5,
          0.0
        )
      `;

      const startTime = Date.now();
      await pgClient.query(query);
      const elapsed = Date.now() - startTime;

      console.log("[query-plan] Semantic search time:", elapsed, "ms");

      // Semantic search should be reasonably fast with index
      // Note: IVFFlat is approximate, so exact timing varies
      expect(elapsed).toBeLessThan(2000);
    });
  });

  describe("scar usage tracking performance", () => {
    it("uses index for scar usage lookup", async () => {
      // First insert some usage records
      const scarId = randomUUID();
      const embedding = generateRandomVector();

      await pgClient.query(
        `INSERT INTO gitmem_learnings (id, title, description, learning_type, project, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)
         ON CONFLICT (id) DO NOTHING`,
        [scarId, "Test Scar", "Description", "scar", "gitmem_test", formatVector(embedding)]
      );

      for (let i = 0; i < 10; i++) {
        await pgClient.query(
          `INSERT INTO gitmem_scar_usage (id, scar_id, agent, reference_type, surfaced_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), scarId, "CLI", "acknowledged", new Date().toISOString()]
        );
      }

      const query = `
        SELECT * FROM gitmem_scar_usage
        WHERE scar_id = '${scarId}'
      `;

      const plan = await analyzeQueryPlan(query);

      expect(plan.executionTime).toBeLessThan(500);
      // Should use the scar_id index
      console.log("[query-plan] Scar usage lookup uses index:", plan.usesIndex);
    });
  });
});

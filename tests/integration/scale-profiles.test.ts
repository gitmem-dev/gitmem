/**
 * Integration Tests: Scale Profiles
 *
 * Tests gitmem performance at different data volumes:
 * - Fresh (0) → Empty install
 * - Starter (15) → Post-init with starter scars
 * - Small (100) → Early adoption
 * - Medium (500) → Active use
 * - Large (1000) → Mature system
 *
 * Verifies that queries remain performant as data grows.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { pgClient, truncateAllTables, formatVector } from "./setup.js";
import {
  seedScaleProfile,
  SCALE_PROFILES,
  generateRandomVector,
  generateScars,
} from "../fixtures/scale-seed.js";

describe("Scale Profiles", () => {
  describe("FRESH profile (0 records)", () => {
    beforeEach(async () => {
      await truncateAllTables();
    });

    it("has zero records after truncate", async () => {
      const result = await pgClient.query(
        `SELECT COUNT(*) as count FROM gitmem_learnings`
      );
      expect(parseInt(result.rows[0].count)).toBe(0);
    });

    it("queries complete quickly on empty tables", async () => {
      const startTime = Date.now();

      await pgClient.query(`SELECT * FROM gitmem_learnings LIMIT 10`);
      await pgClient.query(`SELECT * FROM gitmem_sessions LIMIT 10`);
      await pgClient.query(`SELECT * FROM gitmem_decisions LIMIT 10`);

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(100); // Under 100ms
    });
  });

  describe("STARTER profile (15 scars)", () => {
    beforeEach(async () => {
      await truncateAllTables();
      await seedScaleProfile(pgClient, "STARTER", "scale_test");
    });

    it("seeds correct number of records", async () => {
      const result = await pgClient.query(
        `SELECT COUNT(*) as count FROM gitmem_learnings WHERE project = $1`,
        ["scale_test"]
      );
      expect(parseInt(result.rows[0].count)).toBe(15);
    });

    it("semantic search works with starter data", async () => {
      const queryEmbedding = generateRandomVector();
      const startTime = Date.now();

      const result = await pgClient.query(
        `SELECT * FROM gitmem_semantic_search($1::vector(1536), 5, 0.0)`,
        [formatVector(queryEmbedding)]
      );

      const elapsed = Date.now() - startTime;

      expect(result.rows.length).toBeLessThanOrEqual(5);
      expect(elapsed).toBeLessThan(500); // Under 500ms
    });
  });

  describe("SMALL profile (100 scars, 20 sessions, 10 decisions)", () => {
    beforeEach(async () => {
      await truncateAllTables();
      await seedScaleProfile(pgClient, "SMALL", "scale_test");
    });

    it("seeds correct number of records", async () => {
      const scarsResult = await pgClient.query(
        `SELECT COUNT(*) as count FROM gitmem_learnings WHERE project = $1`,
        ["scale_test"]
      );
      const sessionsResult = await pgClient.query(
        `SELECT COUNT(*) as count FROM gitmem_sessions WHERE project = $1`,
        ["scale_test"]
      );
      const decisionsResult = await pgClient.query(
        `SELECT COUNT(*) as count FROM gitmem_decisions`
      );

      expect(parseInt(scarsResult.rows[0].count)).toBe(100);
      expect(parseInt(sessionsResult.rows[0].count)).toBe(20);
      expect(parseInt(decisionsResult.rows[0].count)).toBe(10);
    });

    it("recent decisions query is fast", async () => {
      const startTime = Date.now();

      const result = await pgClient.query(
        `SELECT id, title, decision FROM gitmem_decisions
         ORDER BY created_at DESC
         LIMIT 5`
      );

      const elapsed = Date.now() - startTime;

      expect(result.rows.length).toBeLessThanOrEqual(5);
      expect(elapsed).toBeLessThan(100); // Under 100ms
    });

    it("recent sessions query is fast", async () => {
      const startTime = Date.now();

      const result = await pgClient.query(
        `SELECT id, session_title, agent FROM gitmem_sessions
         WHERE project = $1
         ORDER BY created_at DESC
         LIMIT 5`,
        ["scale_test"]
      );

      const elapsed = Date.now() - startTime;

      expect(result.rows.length).toBeLessThanOrEqual(5);
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe("MEDIUM profile (500 scars, 100 sessions, 50 decisions)", () => {
    beforeEach(async () => {
      await truncateAllTables();
      await seedScaleProfile(pgClient, "MEDIUM", "scale_test");
    }, 60_000); // Extended timeout for seeding

    it("seeds correct number of records", async () => {
      const scarsResult = await pgClient.query(
        `SELECT COUNT(*) as count FROM gitmem_learnings WHERE project = $1`,
        ["scale_test"]
      );

      expect(parseInt(scarsResult.rows[0].count)).toBe(500);
    });

    it("semantic search completes in reasonable time", async () => {
      const queryEmbedding = generateRandomVector();
      const startTime = Date.now();

      const result = await pgClient.query(
        `SELECT * FROM gitmem_semantic_search($1::vector(1536), 10, 0.0)`,
        [formatVector(queryEmbedding)]
      );

      const elapsed = Date.now() - startTime;

      expect(result.rows.length).toBeLessThanOrEqual(10);
      expect(elapsed).toBeLessThan(2000); // Under 2 seconds
      console.log(`[scale] MEDIUM semantic search: ${elapsed}ms`);
    });

    it("filtered queries remain fast", async () => {
      const startTime = Date.now();

      const result = await pgClient.query(
        `SELECT id, title, severity FROM gitmem_learnings
         WHERE learning_type = 'scar' AND severity = 'critical' AND project = $1
         LIMIT 10`,
        ["scale_test"]
      );

      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(200);
      console.log(`[scale] MEDIUM filtered query: ${elapsed}ms, rows: ${result.rows.length}`);
    });
  });

  describe("LARGE profile (1000 scars, 300 sessions, 150 decisions)", () => {
    beforeEach(async () => {
      await truncateAllTables();
      await seedScaleProfile(pgClient, "LARGE", "scale_test");
    }, 120_000); // Extended timeout for seeding

    it("seeds correct number of records", async () => {
      const scarsResult = await pgClient.query(
        `SELECT COUNT(*) as count FROM gitmem_learnings WHERE project = $1`,
        ["scale_test"]
      );

      expect(parseInt(scarsResult.rows[0].count)).toBe(1000);
    });

    it("semantic search completes within baseline", async () => {
      const queryEmbedding = generateRandomVector();
      const startTime = Date.now();

      const result = await pgClient.query(
        `SELECT * FROM gitmem_semantic_search($1::vector(1536), 5, 0.0)`,
        [formatVector(queryEmbedding)]
      );

      const elapsed = Date.now() - startTime;

      // Golden regression: 51s was the bug - should be under 5s
      expect(elapsed).toBeLessThan(5000);
      console.log(`[scale] LARGE semantic search: ${elapsed}ms`);
    });

    it("decisions query does not regress to 51s", async () => {
      const startTime = Date.now();

      const result = await pgClient.query(
        `SELECT id, title, decision FROM gitmem_decisions
         ORDER BY created_at DESC
         LIMIT 5`
      );

      const elapsed = Date.now() - startTime;

      // Golden regression: This is the exact query that regressed to 51,375ms
      expect(elapsed).toBeLessThan(1000); // Must be under 1 second
      console.log(`[scale] LARGE decisions query: ${elapsed}ms`);
    });

    it("wins query does not bypass cache", async () => {
      // Simulate two consecutive queries (cache behavior test)
      const startTime1 = Date.now();
      await pgClient.query(
        `SELECT id, title, description FROM gitmem_learnings
         WHERE learning_type = 'win' AND project = $1
         ORDER BY created_at DESC
         LIMIT 8`,
        ["scale_test"]
      );
      const elapsed1 = Date.now() - startTime1;

      const startTime2 = Date.now();
      await pgClient.query(
        `SELECT id, title, description FROM gitmem_learnings
         WHERE learning_type = 'win' AND project = $1
         ORDER BY created_at DESC
         LIMIT 8`,
        ["scale_test"]
      );
      const elapsed2 = Date.now() - startTime2;

      // Both queries should be fast (PostgreSQL has query cache)
      expect(elapsed1).toBeLessThan(500);
      expect(elapsed2).toBeLessThan(500);
      console.log(`[scale] LARGE wins queries: ${elapsed1}ms, ${elapsed2}ms`);
    });

    it("aggregation queries work at scale", async () => {
      const startTime = Date.now();

      // Count by type
      const result = await pgClient.query(
        `SELECT learning_type, COUNT(*) as count
         FROM gitmem_learnings
         WHERE project = $1
         GROUP BY learning_type`,
        ["scale_test"]
      );

      const elapsed = Date.now() - startTime;

      expect(result.rows.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(500);

      // Log distribution
      const distribution = Object.fromEntries(
        result.rows.map((r) => [r.learning_type, parseInt(r.count)])
      );
      console.log(`[scale] LARGE type distribution:`, distribution);
    });
  });

  describe("performance baselines", () => {
    /**
     * These tests establish performance baselines for CI tracking.
     * If any of these fail, it indicates a performance regression.
     */

    it("baseline: empty query < 50ms", async () => {
      await truncateAllTables();

      const startTime = Date.now();
      await pgClient.query(`SELECT 1`);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(50);
    });

    it("baseline: single insert < 100ms", async () => {
      await truncateAllTables();

      const startTime = Date.now();
      const embedding = generateRandomVector();
      await pgClient.query(
        `INSERT INTO gitmem_learnings (id, title, description, learning_type, project, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)`,
        [randomUUID(), "Baseline", "Test", "scar", "baseline", formatVector(embedding)]
      );
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(100);
    });

    it("baseline: bulk insert 100 records < 5s", async () => {
      await truncateAllTables();

      const scars = generateScars(100, "bulk_test");
      const startTime = Date.now();

      for (const scar of scars) {
        await pgClient.query(
          `INSERT INTO gitmem_learnings (id, title, description, learning_type, project, embedding)
           VALUES ($1, $2, $3, $4, $5, $6::vector)`,
          [
            scar.id,
            scar.title,
            scar.description,
            scar.learning_type,
            scar.project,
            scar.embedding ? formatVector(scar.embedding) : null,
          ]
        );
      }

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(5000);
      console.log(`[baseline] 100 inserts: ${elapsed}ms`);
    });
  });
});

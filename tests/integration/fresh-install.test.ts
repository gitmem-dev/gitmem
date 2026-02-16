/**
 * Integration Tests: Fresh Install
 *
 * Tests zero-data scenarios to ensure gitmem works on fresh installations:
 * - Empty database → all tools work, return empty results
 * - Starter scars (3) → recall finds matches
 * - Free tier (no DB) → local storage works
 *
 * These tests verify the day-one experience for new customers.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { pgClient, truncateAllTables, formatVector, generateRandomVector } from "./setup.js";
import { getStarterScarsForProject, STARTER_SCARS } from "../fixtures/starter-scars.js";

describe("Fresh Install", () => {
  beforeEach(async () => {
    await truncateAllTables();
  });

  describe("empty database", () => {
    it("learnings query returns empty array", async () => {
      const result = await pgClient.query(
        `SELECT * FROM gitmem_learnings WHERE project = $1`,
        ["fresh_install_test"]
      );

      expect(result.rows).toEqual([]);
      expect(result.rows.length).toBe(0);
    });

    it("sessions query returns empty array", async () => {
      const result = await pgClient.query(
        `SELECT * FROM gitmem_sessions WHERE project = $1`,
        ["fresh_install_test"]
      );

      expect(result.rows).toEqual([]);
    });

    it("decisions query returns empty array", async () => {
      const result = await pgClient.query(
        `SELECT * FROM gitmem_decisions WHERE project = $1`,
        ["fresh_install_test"]
      );

      expect(result.rows).toEqual([]);
    });

    it("semantic search returns empty array on empty database", async () => {
      const queryEmbedding = generateRandomVector();

      const result = await pgClient.query(
        `SELECT * FROM gitmem_semantic_search($1::vector(1536), 5, 0.0)`,
        [formatVector(queryEmbedding)]
      );

      expect(result.rows).toEqual([]);
    });

    it("can create first session in empty database", async () => {
      const sessionId = randomUUID();

      await pgClient.query(
        `INSERT INTO gitmem_sessions (id, session_title, agent, project)
         VALUES ($1, $2, $3, $4)`,
        [sessionId, "First Session Ever", "CLI", "fresh_install_test"]
      );

      const result = await pgClient.query(
        `SELECT * FROM gitmem_sessions WHERE id = $1`,
        [sessionId]
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].session_title).toBe("First Session Ever");
    });

    it("can create first scar in empty database", async () => {
      const scarId = randomUUID();
      const embedding = generateRandomVector();

      await pgClient.query(
        `INSERT INTO gitmem_learnings (id, title, description, learning_type, severity, project, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
        [
          scarId,
          "First Scar",
          "This is the first scar in a fresh installation",
          "scar",
          "medium",
          "fresh_install_test",
          formatVector(embedding),
        ]
      );

      const result = await pgClient.query(
        `SELECT * FROM gitmem_learnings WHERE id = $1`,
        [scarId]
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].title).toBe("First Scar");
    });
  });

  describe("starter scars (3)", () => {
    it("can seed 3 starter scars", async () => {
      const starterScars = getStarterScarsForProject("starter_test");

      expect(starterScars.length).toBe(3);

      // Insert starter scars
      for (const scar of starterScars) {
        const embedding = generateRandomVector();
        await pgClient.query(
          `INSERT INTO gitmem_learnings (id, title, description, learning_type, severity, counter_arguments, project, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)`,
          [
            scar.id,
            scar.title,
            scar.description,
            scar.learning_type,
            scar.severity || null,
            scar.counter_arguments || [],
            scar.project,
            formatVector(embedding),
          ]
        );
      }

      // Verify all inserted
      const result = await pgClient.query(
        `SELECT COUNT(*) as count FROM gitmem_learnings WHERE project = $1`,
        ["starter_test"]
      );

      expect(parseInt(result.rows[0].count)).toBe(3);
    });

    it("semantic search finds matches in starter scars", async () => {
      // Seed starter scars
      const starterScars = getStarterScarsForProject("starter_test");
      for (const scar of starterScars) {
        const embedding = generateRandomVector();
        await pgClient.query(
          `INSERT INTO gitmem_learnings (id, title, description, learning_type, severity, project, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
          [
            scar.id,
            scar.title,
            scar.description,
            scar.learning_type,
            scar.severity || null,
            scar.project,
            formatVector(embedding),
          ]
        );
      }

      // Perform semantic search
      const queryEmbedding = generateRandomVector();
      const result = await pgClient.query(
        `SELECT * FROM gitmem_semantic_search($1::vector(1536), 5, 0.0)`,
        [formatVector(queryEmbedding)]
      );

      // Should find matches (random vectors will have some similarity)
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows.length).toBeLessThanOrEqual(5);
    });

    it("starter scars have correct distribution of types", async () => {
      const starterScars = getStarterScarsForProject("starter_test");

      const typeCounts: Record<string, number> = {};
      for (const scar of starterScars) {
        typeCounts[scar.learning_type] = (typeCounts[scar.learning_type] || 0) + 1;
      }

      // Verify distribution (all 3 starter scars are type "scar")
      expect(typeCounts["scar"]).toBe(3);

      // Total should be 3
      const total = Object.values(typeCounts).reduce((a, b) => a + b, 0);
      expect(total).toBe(3);
    });

    it("can query scars by severity", async () => {
      // Seed starter scars
      const starterScars = getStarterScarsForProject("starter_test");
      for (const scar of starterScars) {
        if (scar.learning_type === "scar" && scar.severity) {
          const embedding = generateRandomVector();
          await pgClient.query(
            `INSERT INTO gitmem_learnings (id, title, description, learning_type, severity, project, embedding)
             VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
            [
              scar.id,
              scar.title,
              scar.description,
              scar.learning_type,
              scar.severity,
              scar.project,
              formatVector(embedding),
            ]
          );
        }
      }

      // Query critical scars
      const criticalResult = await pgClient.query(
        `SELECT * FROM gitmem_learnings
         WHERE learning_type = 'scar' AND severity = 'critical' AND project = $1`,
        ["starter_test"]
      );

      expect(criticalResult.rows.length).toBeGreaterThan(0);
    });
  });

  describe("schema validation", () => {
    it("tables exist and have correct columns", async () => {
      // Check gitmem_learnings columns
      const learningsColumns = await pgClient.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'gitmem_learnings'
        ORDER BY ordinal_position
      `);

      const columnNames = learningsColumns.rows.map((r) => r.column_name);
      expect(columnNames).toContain("id");
      expect(columnNames).toContain("title");
      expect(columnNames).toContain("description");
      expect(columnNames).toContain("learning_type");
      expect(columnNames).toContain("severity");
      expect(columnNames).toContain("embedding");
    });

    it("has pgvector extension enabled", async () => {
      const result = await pgClient.query(`
        SELECT extname FROM pg_extension WHERE extname = 'vector'
      `);

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].extname).toBe("vector");
    });

    it("semantic search function exists", async () => {
      const result = await pgClient.query(`
        SELECT proname FROM pg_proc WHERE proname = 'gitmem_semantic_search'
      `);

      expect(result.rows.length).toBe(1);
    });
  });

  describe("first-run experience", () => {
    it("can complete full session lifecycle on fresh install", async () => {
      // 1. Start session
      const sessionId = randomUUID();
      await pgClient.query(
        `INSERT INTO gitmem_sessions (id, session_title, agent, project)
         VALUES ($1, $2, $3, $4)`,
        [sessionId, "Fresh Install Session", "CLI", "fresh_test"]
      );

      // 2. Query for scars (returns empty)
      const scarResult = await pgClient.query(
        `SELECT * FROM gitmem_learnings WHERE project = $1`,
        ["fresh_test"]
      );
      expect(scarResult.rows.length).toBe(0);

      // 3. Create first scar
      const embedding = generateRandomVector();
      await pgClient.query(
        `INSERT INTO gitmem_learnings (id, title, description, learning_type, severity, project, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
        [
          randomUUID(),
          "First Learning",
          "Discovered during first session",
          "scar",
          "medium",
          "fresh_test",
          formatVector(embedding),
        ]
      );

      // 4. Create first decision
      await pgClient.query(
        `INSERT INTO gitmem_decisions (id, title, decision, rationale, session_id, project)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          "Use GitMem",
          "Adopt gitmem for institutional memory",
          "Prevents repeat mistakes",
          sessionId,
          "fresh_test",
        ]
      );

      // 5. Close session
      await pgClient.query(
        `UPDATE gitmem_sessions
         SET closing_reflection = $1, decisions = $2
         WHERE id = $3`,
        [
          JSON.stringify({ what_worked: "Fresh install worked smoothly" }),
          ["Use GitMem"],
          sessionId,
        ]
      );

      // Verify complete lifecycle
      const finalSession = await pgClient.query(
        `SELECT * FROM gitmem_sessions WHERE id = $1`,
        [sessionId]
      );

      expect(finalSession.rows.length).toBe(1);
      expect(finalSession.rows[0].closing_reflection.what_worked).toBe(
        "Fresh install worked smoothly"
      );
    });
  });
});

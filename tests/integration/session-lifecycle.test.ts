/**
 * Integration Tests: Session Lifecycle
 *
 * Tests the full session lifecycle against a real PostgreSQL database:
 * - session_start → creates session record, loads components
 * - session_close → persists session, validates all fields written
 * - Full cycle: start → recall → create_learning → create_decision → close
 *
 * Uses Testcontainers to spin up real PostgreSQL with pgvector.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { pgClient, truncateAllTables, generateRandomVector, formatVector } from "./setup.js";
import { createTestSession, createMinimalSession } from "../fixtures/sessions.js";
import { SCAR_DEPLOYMENT_VERIFICATION } from "../fixtures/scars.js";
import { createDecisionForSession } from "../fixtures/decisions.js";

describe("Session Lifecycle", () => {
  beforeEach(async () => {
    await truncateAllTables();
  });

  describe("session_start", () => {
    it("creates a new session record", async () => {
      const session = createMinimalSession("CLI", "gitmem_test");

      // Insert session
      await pgClient.query(
        `INSERT INTO gitmem_sessions (id, session_title, session_date, agent, project)
         VALUES ($1, $2, $3, $4, $5)`,
        [session.id, session.session_title, session.session_date, session.agent, session.project]
      );

      // Verify session exists
      const result = await pgClient.query(
        `SELECT * FROM gitmem_sessions WHERE id = $1`,
        [session.id]
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].agent).toBe("CLI");
      expect(result.rows[0].project).toBe("gitmem_test");
    });

    it("loads recent decisions for session context", async () => {
      // Seed some decisions
      const session = createMinimalSession("CLI", "gitmem_test");
      await pgClient.query(
        `INSERT INTO gitmem_sessions (id, session_title, agent, project) VALUES ($1, $2, $3, $4)`,
        [session.id, "Previous Session", "CLI", "gitmem_test"]
      );

      const decision = createDecisionForSession(session.id, "Test Decision", "Use Vitest", "Fast and modern");
      await pgClient.query(
        `INSERT INTO gitmem_decisions (id, title, decision, rationale, session_id, project)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [decision.id, decision.title, decision.decision, decision.rationale, decision.session_id, decision.project]
      );

      // Query recent decisions (simulating session_start component)
      const result = await pgClient.query(
        `SELECT id, title, decision FROM gitmem_decisions
         WHERE project = $1
         ORDER BY created_at DESC
         LIMIT 5`,
        ["gitmem_test"]
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].title).toBe("Test Decision");
    });

    it("loads recent wins for session context", async () => {
      // Seed a win
      const embedding = generateRandomVector();
      await pgClient.query(
        `INSERT INTO gitmem_learnings (id, title, description, learning_type, project, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)`,
        [
          "test-win-id",
          "Test Win",
          "A successful pattern",
          "win",
          "gitmem_test",
          formatVector(embedding),
        ]
      );

      // Query recent wins (simulating session_start component)
      const result = await pgClient.query(
        `SELECT id, title, description FROM gitmem_learnings
         WHERE learning_type = 'win' AND project = $1
         ORDER BY created_at DESC
         LIMIT 8`,
        ["gitmem_test"]
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].title).toBe("Test Win");
    });
  });

  describe("session_close", () => {
    it("persists session with closing reflection", async () => {
      const session = createTestSession({
        agent: "CLI",
        project: "gitmem_test",
        closing_reflection: {
          what_broke: "Nothing unexpected",
          what_worked: "File-based caching",
          scars_applied: ["Done ≠ Deployed"],
        },
      });

      // Insert session with reflection
      await pgClient.query(
        `INSERT INTO gitmem_sessions (id, session_title, agent, project, closing_reflection)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          session.id,
          session.session_title,
          session.agent,
          session.project,
          JSON.stringify(session.closing_reflection),
        ]
      );

      // Verify reflection was stored
      const result = await pgClient.query(
        `SELECT closing_reflection FROM gitmem_sessions WHERE id = $1`,
        [session.id]
      );

      expect(result.rows.length).toBe(1);
      const reflection = result.rows[0].closing_reflection;
      expect(reflection.what_broke).toBe("Nothing unexpected");
      expect(reflection.what_worked).toBe("File-based caching");
    });

    it("updates existing session on close", async () => {
      const session = createMinimalSession("CLI", "gitmem_test");

      // Create session (simulating session_start)
      await pgClient.query(
        `INSERT INTO gitmem_sessions (id, session_title, agent, project)
         VALUES ($1, $2, $3, $4)`,
        [session.id, session.session_title, session.agent, session.project]
      );

      // Update with closing reflection (simulating session_close)
      const reflection = {
        what_broke: "Test assertion failed",
        what_worked: "Quick debugging",
      };

      await pgClient.query(
        `UPDATE gitmem_sessions
         SET closing_reflection = $1, decisions = $2
         WHERE id = $3`,
        [JSON.stringify(reflection), ["Added unit tests"], session.id]
      );

      // Verify update
      const result = await pgClient.query(
        `SELECT closing_reflection, decisions FROM gitmem_sessions WHERE id = $1`,
        [session.id]
      );

      expect(result.rows[0].closing_reflection.what_broke).toBe("Test assertion failed");
      expect(result.rows[0].decisions).toContain("Added unit tests");
    });
  });

  describe("full lifecycle", () => {
    it("start → create_learning → create_decision → close", async () => {
      // 1. Start session
      const session = createMinimalSession("CLI", "gitmem_test");
      await pgClient.query(
        `INSERT INTO gitmem_sessions (id, session_title, agent, project)
         VALUES ($1, $2, $3, $4)`,
        [session.id, session.session_title, session.agent, session.project]
      );

      // 2. Create a scar during session
      const scar = { ...SCAR_DEPLOYMENT_VERIFICATION, id: "lifecycle-test-scar" };
      const embedding = generateRandomVector();
      await pgClient.query(
        `INSERT INTO gitmem_learnings (id, title, description, learning_type, severity, counter_arguments, project, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)`,
        [
          scar.id,
          scar.title,
          scar.description,
          scar.learning_type,
          scar.severity,
          scar.counter_arguments,
          scar.project,
          formatVector(embedding),
        ]
      );

      // 3. Create a decision during session
      const decision = createDecisionForSession(session.id, "Use Testcontainers", "Real DB for tests", "Catches index issues");
      await pgClient.query(
        `INSERT INTO gitmem_decisions (id, title, decision, rationale, session_id, project)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [decision.id, decision.title, decision.decision, decision.rationale, decision.session_id, decision.project]
      );

      // 4. Close session with reflection
      const reflection = {
        what_broke: "Initial test setup",
        what_worked: "Testcontainers approach",
        scars_applied: [scar.title],
        capture_as_memory: "Lifecycle test pattern",
      };

      await pgClient.query(
        `UPDATE gitmem_sessions
         SET closing_reflection = $1, decisions = $2
         WHERE id = $3`,
        [JSON.stringify(reflection), [decision.title], session.id]
      );

      // Verify complete lifecycle
      const sessionResult = await pgClient.query(
        `SELECT * FROM gitmem_sessions WHERE id = $1`,
        [session.id]
      );
      const learningResult = await pgClient.query(
        `SELECT * FROM gitmem_learnings WHERE id = $1`,
        [scar.id]
      );
      const decisionResult = await pgClient.query(
        `SELECT * FROM gitmem_decisions WHERE session_id = $1`,
        [session.id]
      );

      expect(sessionResult.rows.length).toBe(1);
      expect(sessionResult.rows[0].closing_reflection.what_worked).toBe("Testcontainers approach");

      expect(learningResult.rows.length).toBe(1);
      expect(learningResult.rows[0].severity).toBe("critical");

      expect(decisionResult.rows.length).toBe(1);
      expect(decisionResult.rows[0].title).toBe("Use Testcontainers");
    });
  });

  describe("record scar usage", () => {
    it("tracks which scars were applied during session", async () => {
      // Create session and scar
      const session = createMinimalSession("CLI", "gitmem_test");
      await pgClient.query(
        `INSERT INTO gitmem_sessions (id, session_title, agent, project) VALUES ($1, $2, $3, $4)`,
        [session.id, session.session_title, session.agent, session.project]
      );

      const scar = { ...SCAR_DEPLOYMENT_VERIFICATION, id: "usage-test-scar" };
      const embedding = generateRandomVector();
      await pgClient.query(
        `INSERT INTO gitmem_learnings (id, title, description, learning_type, severity, project, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
        [scar.id, scar.title, scar.description, scar.learning_type, scar.severity, scar.project, formatVector(embedding)]
      );

      // Record scar usage
      await pgClient.query(
        `INSERT INTO gitmem_scar_usage (id, scar_id, session_id, agent, reference_type, reference_context, surfaced_at, execution_successful)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          "usage-record-1",
          scar.id,
          session.id,
          "CLI",
          "acknowledged",
          "Applied during deployment verification",
          new Date().toISOString(),
          true,
        ]
      );

      // Verify usage was recorded
      const result = await pgClient.query(
        `SELECT * FROM gitmem_scar_usage WHERE session_id = $1`,
        [session.id]
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].reference_type).toBe("acknowledged");
      expect(result.rows[0].execution_successful).toBe(true);
    });
  });
});

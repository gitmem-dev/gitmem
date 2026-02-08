/**
 * Test Fixtures: Scale Seeding
 *
 * Generates N test records with valid embeddings for scale testing.
 * Used to test performance at different data volumes.
 */

import { randomUUID } from "crypto";
import type { Client } from "pg";
import type { TestScar } from "./scars.js";
import type { TestDecision } from "./decisions.js";
import type { TestSession } from "./sessions.js";

/**
 * Scale profiles for testing different data volumes
 */
export const SCALE_PROFILES = {
  FRESH: { scars: 0, sessions: 0, decisions: 0 },
  STARTER: { scars: 15, sessions: 0, decisions: 0 },
  SMALL: { scars: 100, sessions: 20, decisions: 10 },
  MEDIUM: { scars: 500, sessions: 100, decisions: 50 },
  LARGE: { scars: 1000, sessions: 300, decisions: 150 },
} as const;

export type ScaleProfile = keyof typeof SCALE_PROFILES;

/**
 * Generate a random vector (1536 dimensions for OpenAI embeddings)
 * Normalizes to unit vector for proper cosine similarity
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
 * Format vector for PostgreSQL pgvector
 */
export function formatVector(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * Generate fake scars for scale testing
 */
export function generateScars(count: number, project = "gitmem_test"): TestScar[] {
  const severities: TestScar["severity"][] = ["critical", "high", "medium", "low"];
  const types: TestScar["learning_type"][] = ["scar", "win", "pattern", "anti_pattern"];

  const scars: TestScar[] = [];

  for (let i = 0; i < count; i++) {
    const type = types[i % types.length];
    const isScar = type === "scar";

    scars.push({
      id: randomUUID(),
      title: `Test ${type} ${i + 1}`,
      description: `Description for test ${type} ${i + 1}. This is a generated test entry for scale testing. ` +
        `It contains enough text to simulate realistic description lengths that would be used in production.`,
      learning_type: type,
      severity: isScar ? severities[i % severities.length] : undefined,
      scar_type: isScar ? "operational" : undefined,
      counter_arguments: isScar
        ? [
            `Counter argument 1 for ${type} ${i + 1}`,
            `Counter argument 2 for ${type} ${i + 1}`,
          ]
        : undefined,
      problem_context: `Problem context for ${type} ${i + 1}`,
      solution_approach: `Solution approach for ${type} ${i + 1}`,
      applies_when: [`applying ${type} ${i + 1}`, `testing scale`],
      keywords: [`test`, `scale`, `${type}`, `entry-${i}`],
      domain: [`testing`, `scale`],
      embedding: generateRandomVector(),
      project,
      source_date: new Date(Date.now() - i * 86400000).toISOString().split("T")[0], // Stagger dates
      created_at: new Date(Date.now() - i * 86400000).toISOString(),
    });
  }

  return scars;
}

/**
 * Generate fake sessions for scale testing
 */
export function generateSessions(count: number, project = "gitmem_test"): TestSession[] {
  const agents = ["CLI", "DAC", "CODA-1", "Brain_Cloud", "Brain_Local"];

  const sessions: TestSession[] = [];

  for (let i = 0; i < count; i++) {
    sessions.push({
      id: randomUUID(),
      session_title: `Test Session ${i + 1}`,
      session_date: new Date(Date.now() - i * 86400000).toISOString().split("T")[0],
      agent: agents[i % agents.length],
      project,
      decisions: [`Decision from session ${i + 1}`],
      open_threads: i % 3 === 0 ? [`Open thread from session ${i + 1}`] : [],
      embedding: generateRandomVector(),
      created_at: new Date(Date.now() - i * 86400000).toISOString(),
    });
  }

  return sessions;
}

/**
 * Generate fake decisions for scale testing
 */
export function generateDecisions(
  count: number,
  sessionIds: string[],
  project = "gitmem_test"
): TestDecision[] {
  const decisions: TestDecision[] = [];

  for (let i = 0; i < count; i++) {
    decisions.push({
      id: randomUUID(),
      decision_date: new Date(Date.now() - i * 86400000).toISOString().split("T")[0],
      title: `Test Decision ${i + 1}`,
      decision: `Decision content for test decision ${i + 1}. This represents a choice made during development.`,
      rationale: `Rationale for test decision ${i + 1}. This explains why this decision was made.`,
      alternatives_considered: [
        `Alternative A for decision ${i + 1}`,
        `Alternative B for decision ${i + 1}`,
      ],
      session_id: sessionIds.length > 0 ? sessionIds[i % sessionIds.length] : undefined,
      project,
      embedding: generateRandomVector(),
      created_at: new Date(Date.now() - i * 86400000).toISOString(),
    });
  }

  return decisions;
}

/**
 * Seed the database with a specific scale profile
 */
export async function seedScaleProfile(
  client: Client,
  profile: ScaleProfile,
  project = "gitmem_test"
): Promise<{
  scars: number;
  sessions: number;
  decisions: number;
  elapsed: number;
}> {
  const startTime = Date.now();
  const config = SCALE_PROFILES[profile];

  console.log(`[seed] Seeding ${profile} profile: ${JSON.stringify(config)}`);

  // Generate data
  const scars = generateScars(config.scars, project);
  const sessions = generateSessions(config.sessions, project);
  const decisions = generateDecisions(
    config.decisions,
    sessions.map((s) => s.id),
    project
  );

  // Bulk insert scars
  if (scars.length > 0) {
    await bulkInsertScars(client, scars);
  }

  // Bulk insert sessions
  if (sessions.length > 0) {
    await bulkInsertSessions(client, sessions);
  }

  // Bulk insert decisions
  if (decisions.length > 0) {
    await bulkInsertDecisions(client, decisions);
  }

  const elapsed = Date.now() - startTime;
  console.log(`[seed] Seeded ${profile} profile in ${elapsed}ms`);

  return {
    scars: scars.length,
    sessions: sessions.length,
    decisions: decisions.length,
    elapsed,
  };
}

/**
 * Bulk insert scars using PostgreSQL COPY-like efficiency
 */
async function bulkInsertScars(client: Client, scars: TestScar[]): Promise<void> {
  // Use parameterized batch insert for safety and performance
  const BATCH_SIZE = 100;

  for (let i = 0; i < scars.length; i += BATCH_SIZE) {
    const batch = scars.slice(i, i + BATCH_SIZE);

    const values = batch.map((scar, idx) => {
      const base = idx * 15;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}::vector)`;
    }).join(", ");

    const params = batch.flatMap((scar) => [
      scar.id,
      scar.learning_type,
      scar.title,
      scar.description,
      scar.severity || null,
      scar.scar_type || null,
      scar.counter_arguments || [],
      scar.problem_context || "",
      scar.solution_approach || "",
      scar.applies_when || [],
      scar.keywords || [],
      scar.domain || [],
      scar.project,
      scar.source_date || new Date().toISOString().split("T")[0],
      scar.embedding ? formatVector(scar.embedding) : null,
    ]);

    await client.query(
      `INSERT INTO gitmem_learnings (id, learning_type, title, description, severity, scar_type, counter_arguments, problem_context, solution_approach, applies_when, keywords, domain, project, source_date, embedding)
       VALUES ${values}`,
      params
    );
  }
}

/**
 * Bulk insert sessions
 */
async function bulkInsertSessions(client: Client, sessions: TestSession[]): Promise<void> {
  const BATCH_SIZE = 100;

  for (let i = 0; i < sessions.length; i += BATCH_SIZE) {
    const batch = sessions.slice(i, i + BATCH_SIZE);

    const values = batch.map((_, idx) => {
      const base = idx * 8;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::vector)`;
    }).join(", ");

    const params = batch.flatMap((session) => [
      session.id,
      session.session_title || "Test Session",
      session.session_date || new Date().toISOString().split("T")[0],
      session.agent || "CLI",
      session.project,
      session.decisions || [],
      session.open_threads || [],
      session.embedding ? formatVector(session.embedding) : null,
    ]);

    await client.query(
      `INSERT INTO gitmem_sessions (id, session_title, session_date, agent, project, decisions, open_threads, embedding)
       VALUES ${values}`,
      params
    );
  }
}

/**
 * Bulk insert decisions
 */
async function bulkInsertDecisions(client: Client, decisions: TestDecision[]): Promise<void> {
  const BATCH_SIZE = 100;

  for (let i = 0; i < decisions.length; i += BATCH_SIZE) {
    const batch = decisions.slice(i, i + BATCH_SIZE);

    const values = batch.map((_, idx) => {
      const base = idx * 8;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::vector)`;
    }).join(", ");

    const params = batch.flatMap((decision) => [
      decision.id,
      decision.decision_date || new Date().toISOString().split("T")[0],
      decision.title,
      decision.decision,
      decision.rationale,
      decision.alternatives_considered || [],
      decision.session_id || null,
      decision.embedding ? formatVector(decision.embedding) : null,
    ]);

    await client.query(
      `INSERT INTO gitmem_decisions (id, decision_date, title, decision, rationale, alternatives_considered, session_id, embedding)
       VALUES ${values}`,
      params
    );
  }
}

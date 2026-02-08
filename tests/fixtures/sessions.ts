/**
 * Test Fixtures: Sessions
 *
 * Typed session test data for integration and E2E tests.
 */

import { randomUUID } from "crypto";

export interface TestSession {
  id: string;
  session_title?: string;
  session_date?: string;
  agent?: string;
  project: string;
  decisions?: string[];
  open_threads?: string[];
  closing_reflection?: {
    what_broke?: string;
    what_took_longer?: string;
    do_differently?: string;
    what_worked?: string;
    wrong_assumption?: string;
    scars_applied?: string[];
    capture_as_memory?: string;
  };
  embedding?: number[];
  created_at?: string;
  updated_at?: string;
}

/**
 * Sample CLI session
 */
export const SESSION_CLI_STANDARD: TestSession = {
  id: randomUUID(),
  session_title: "Test Implementation Session",
  session_date: new Date().toISOString().split("T")[0],
  agent: "CLI",
  project: "gitmem_test",
  decisions: ["Use Vitest for testing", "Add Zod validation"],
  open_threads: ["Performance optimization for large datasets"],
  closing_reflection: {
    what_broke: "Initial schema had missing index on created_at column.",
    what_took_longer: "Understanding the Testcontainers API took longer than expected.",
    do_differently: "Start with integration tests earlier in the development cycle.",
    what_worked: "File-based caching significantly improved recall latency.",
    wrong_assumption: "Assumed mocks would catch all database issues.",
    scars_applied: ["Done ≠ Deployed ≠ Verified Working"],
    capture_as_memory: "Testcontainers setup pattern for pgvector.",
  },
};

/**
 * Sample DAC session
 */
export const SESSION_DAC_QUICK: TestSession = {
  id: randomUUID(),
  session_title: "Quick Bug Fix",
  session_date: new Date().toISOString().split("T")[0],
  agent: "DAC",
  project: "gitmem_test",
  decisions: [],
  open_threads: [],
  // Quick close - no reflection
};

/**
 * Sample CODA-1 session
 */
export const SESSION_CODA_AUTONOMOUS: TestSession = {
  id: randomUUID(),
  session_title: "Autonomous Issue Resolution",
  session_date: new Date().toISOString().split("T")[0],
  agent: "CODA-1",
  project: "gitmem_test",
  decisions: ["Implemented fix per issue description", "Added unit test for regression"],
  open_threads: [],
  closing_reflection: {
    what_broke: "Nothing unexpected.",
    what_took_longer: "Understanding existing test patterns.",
    do_differently: "N/A - straightforward fix.",
    what_worked: "Following existing patterns worked well.",
    wrong_assumption: "None.",
    scars_applied: ["No Tests = No Approval"],
    capture_as_memory: null,
  },
};

/**
 * Sample Brain session
 */
export const SESSION_BRAIN_RESEARCH: TestSession = {
  id: randomUUID(),
  session_title: "Architecture Research",
  session_date: new Date().toISOString().split("T")[0],
  agent: "Brain_Cloud",
  project: "gitmem_test",
  decisions: ["Recommended Testcontainers approach"],
  open_threads: ["pgTAP integration for schema assertions"],
};

/**
 * All test sessions for seeding
 */
export const ALL_TEST_SESSIONS: TestSession[] = [
  SESSION_CLI_STANDARD,
  SESSION_DAC_QUICK,
  SESSION_CODA_AUTONOMOUS,
  SESSION_BRAIN_RESEARCH,
];

/**
 * Create a new session for testing
 */
export function createTestSession(
  options: Partial<TestSession> & { project?: string } = {}
): TestSession {
  return {
    id: randomUUID(),
    session_title: options.session_title || "Test Session",
    session_date: options.session_date || new Date().toISOString().split("T")[0],
    agent: options.agent || "CLI",
    project: options.project || "gitmem_test",
    decisions: options.decisions || [],
    open_threads: options.open_threads || [],
    closing_reflection: options.closing_reflection,
  };
}

/**
 * Create a minimal session (for session_start testing)
 */
export function createMinimalSession(
  agent: string,
  project = "gitmem_test"
): TestSession {
  return {
    id: randomUUID(),
    session_title: "Interactive Session",
    session_date: new Date().toISOString().split("T")[0],
    agent,
    project,
    decisions: [],
    open_threads: [],
  };
}

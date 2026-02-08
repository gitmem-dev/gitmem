/**
 * Vitest Integration Test Configuration
 *
 * Tier 2 tests: Testcontainers with real PostgreSQL + pgvector
 * Requires Docker to be running.
 *
 * Run with: npm run test:integration
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["tests/unit/**", "tests/performance/**", "tests/e2e/**"],

    // Testcontainers need longer timeouts
    testTimeout: 60_000,
    hookTimeout: 60_000,

    // Run serially - containers share resources
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },

    // Environment
    environment: "node",

    // Setup file for Testcontainers lifecycle
    setupFiles: ["./tests/integration/setup.ts"],

    // Global test context
    globals: true,
  },
});

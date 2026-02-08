/**
 * Vitest Smoke Test Configuration
 *
 * Post-build deployment verification.
 * Answers: "Does the built artifact actually work?"
 *
 * Two modes:
 *   npm run test:smoke:free  — CI-safe, no external services
 *   npm run test:smoke:pro   — Requires live Supabase, <15s
 *
 * Run with: npm run test:smoke
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/smoke/**/*.test.ts"],
    exclude: [
      "tests/unit/**",
      "tests/integration/**",
      "tests/performance/**",
      "tests/e2e/**",
    ],

    // Smoke tests should be FAST — 15s timeout per test
    testTimeout: 15_000,
    hookTimeout: 15_000,

    // Run serially — single MCP server process
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },

    environment: "node",

    // No retries — smoke tests must be deterministic
    retry: 0,
  },
});

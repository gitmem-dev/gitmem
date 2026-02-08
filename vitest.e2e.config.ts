/**
 * Vitest E2E Test Configuration
 *
 * Tier 4 tests: Full MCP protocol chain from consumer perspective.
 * Tests go through actual stdio transport, not direct imports.
 *
 * Run with: npm run test:e2e
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    exclude: ["tests/unit/**", "tests/integration/**", "tests/performance/**"],

    // E2E tests need longer timeouts for MCP server startup
    testTimeout: 60_000,
    hookTimeout: 30_000,

    // Run serially - MCP servers share resources
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },

    // Environment
    environment: "node",

    // Retry flaky tests once
    retry: 1,
  },
});

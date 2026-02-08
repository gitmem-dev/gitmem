import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for Tier 1 unit tests.
 *
 * Fast tests (<5s total) that don't require:
 * - Docker/containers
 * - Network connections
 * - Supabase
 *
 * Covers:
 * - Zod schema validation
 * - Pure function logic (cache keys, tier detection)
 * - Golden regression tests
 */
export default defineConfig({
  test: {
    // Include only unit tests
    include: ["tests/unit/**/*.test.ts"],

    // Exclude integration/performance/e2e tests
    exclude: [
      "tests/integration/**",
      "tests/performance/**",
      "tests/e2e/**",
      "node_modules/**",
    ],

    // Fast timeout for unit tests
    testTimeout: 5000,

    // Run tests in parallel
    pool: "threads",

    // Coverage configuration
    coverage: {
      provider: "v8",
      include: ["src/schemas/**/*.ts", "src/services/tier.ts", "src/services/cache.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts"],
    },

    // Environment
    environment: "node",

    // Clear mocks between tests
    clearMocks: true,
    restoreMocks: true,
  },
});

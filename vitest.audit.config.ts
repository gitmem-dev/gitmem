import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for cast file audit tests.
 *
 * Isolated from the main test suite — these tests validate
 * the session recording analysis pipeline.
 */
export default defineConfig({
  test: {
    include: ["tests/audit/**/*.test.ts"],
    exclude: ["node_modules/**"],
    testTimeout: 10000,
    pool: "threads",
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
  },
});

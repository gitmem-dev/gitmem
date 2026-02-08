/**
 * Vitest Performance Test Configuration
 *
 * Tier 3 tests: Benchmark.js microbenchmarks for performance regression detection.
 * These tests measure operation latency with statistical rigor.
 *
 * Run with: npm run test:perf
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/performance/**/*.bench.ts"],
    exclude: ["tests/unit/**", "tests/integration/**", "tests/e2e/**"],

    // Performance tests need longer timeouts
    testTimeout: 120_000,
    hookTimeout: 60_000,

    // Run serially for consistent measurements
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },

    // Environment
    environment: "node",

    // Benchmark mode
    benchmark: {
      include: ["tests/performance/**/*.bench.ts"],
      outputFile: "tests/performance/results.json",
    },
  },
});

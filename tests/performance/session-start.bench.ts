/**
 * Session Start Benchmarks
 *
 * Component-level benchmarks for session_start operation:
 * - decisions cold/cached
 * - wins cold/cached
 * - scar_search
 * - session_create
 *
 * Uses Vitest's built-in benchmark mode for statistical rigor.
 */

import { bench, describe, beforeAll, afterAll } from "vitest";
import { BASELINES, formatBaselineComparison } from "./baselines.js";
import { CacheService, resetCache } from "../../src/services/cache.js";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Test cache directory
const TEST_CACHE_DIR = join(tmpdir(), `gitmem-bench-${Date.now()}`);

// Mock data for benchmarks
const MOCK_DECISIONS = Array.from({ length: 5 }, (_, i) => ({
  id: `decision-${i}`,
  title: `Decision ${i}`,
  decision: `Decision content ${i}`,
  rationale: `Rationale for decision ${i}`,
}));

const MOCK_WINS = Array.from({ length: 8 }, (_, i) => ({
  id: `win-${i}`,
  title: `Win ${i}`,
  description: `Description for win ${i}`,
}));

describe("Session Start Components", () => {
  let cache: CacheService;

  beforeAll(() => {
    // Create test cache directory
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
    mkdirSync(join(TEST_CACHE_DIR, "results"), { recursive: true });

    // Reset and create cache
    resetCache();
    cache = new CacheService(TEST_CACHE_DIR);
  });

  afterAll(() => {
    // Cleanup
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
  });

  bench(
    "cache key generation - decisions",
    () => {
      cache.decisionsKey("orchestra_dev", 5);
    },
    {
      time: 1000,
      iterations: 10000,
    }
  );

  bench(
    "cache key generation - wins",
    () => {
      cache.winsKey("orchestra_dev", 8);
    },
    {
      time: 1000,
      iterations: 10000,
    }
  );

  bench(
    "cache key generation - scar search",
    () => {
      cache.scarSearchKey("deployment verification", "orchestra_dev", 5);
    },
    {
      time: 1000,
      iterations: 10000,
    }
  );

  bench(
    "decisions - cache miss (simulated)",
    async () => {
      // Simulate cache miss - just the lookup cost
      const key = cache.decisionsKey("orchestra_dev", 5);
      await cache.getResult(key);
    },
    {
      time: 2000,
      iterations: 100,
    }
  );

  bench(
    "decisions - cache hit",
    async () => {
      const key = cache.decisionsKey("bench_test", 5);
      // Ensure cache is populated
      await cache.setResult(key, MOCK_DECISIONS, 5 * 60 * 1000);
      // Now benchmark the hit
      await cache.getResult(key);
    },
    {
      time: 2000,
      iterations: 100,
    }
  );

  bench(
    "wins - cache miss (simulated)",
    async () => {
      const key = cache.winsKey("orchestra_dev", 8);
      await cache.getResult(key);
    },
    {
      time: 2000,
      iterations: 100,
    }
  );

  bench(
    "wins - cache hit",
    async () => {
      const key = cache.winsKey("bench_test", 8);
      await cache.setResult(key, MOCK_WINS, 5 * 60 * 1000);
      await cache.getResult(key);
    },
    {
      time: 2000,
      iterations: 100,
    }
  );

  bench(
    "cache write",
    async () => {
      const key = `bench_write_${Date.now()}_${Math.random()}`;
      await cache.setResult(key, MOCK_DECISIONS, 5 * 60 * 1000);
    },
    {
      time: 2000,
      iterations: 50,
    }
  );

  bench(
    "getOrFetchDecisions - cache hit path",
    async () => {
      const result = await cache.getOrFetchDecisions(
        "bench_fetch",
        5,
        async () => MOCK_DECISIONS
      );
      // After first run, should be cached
    },
    {
      time: 2000,
      iterations: 100,
    }
  );

  bench(
    "getOrFetchWins - cache hit path",
    async () => {
      const result = await cache.getOrFetchWins(
        "bench_fetch",
        8,
        async () => MOCK_WINS
      );
    },
    {
      time: 2000,
      iterations: 100,
    }
  );
});

describe("Session Start - Full Flow Simulation", () => {
  let cache: CacheService;

  beforeAll(() => {
    resetCache();
    cache = new CacheService(TEST_CACHE_DIR);
  });

  bench(
    "full session start - cached components",
    async () => {
      // Simulate full session_start with cached data
      const decisions = await cache.getOrFetchDecisions(
        "orchestra_dev",
        5,
        async () => MOCK_DECISIONS
      );

      const wins = await cache.getOrFetchWins(
        "orchestra_dev",
        8,
        async () => MOCK_WINS
      );

      // Simulate local scar search (just array operations)
      const scars = MOCK_DECISIONS.slice(0, 3);

      return { decisions, wins, scars };
    },
    {
      time: 5000,
      iterations: 50,
    }
  );
});

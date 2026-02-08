/**
 * Cold Start Benchmarks
 *
 * Benchmarks for cold start scenarios:
 * - Cache rebuild after deletion
 * - First session start with empty cache
 * - Initial data loading
 */

import { bench, describe, beforeAll, afterAll, beforeEach } from "vitest";
import { CacheService, resetCache } from "../../src/services/cache.js";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Test cache directory
const TEST_CACHE_DIR = join(tmpdir(), `gitmem-cold-bench-${Date.now()}`);

// Simulated data fetchers (what would be API calls in production)
const simulateDecisionsFetch = async () => {
  // Simulate 100ms network latency
  await new Promise((resolve) => setTimeout(resolve, 100));
  return Array.from({ length: 5 }, (_, i) => ({
    id: `decision-${i}`,
    title: `Decision ${i}`,
  }));
};

const simulateWinsFetch = async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return Array.from({ length: 8 }, (_, i) => ({
    id: `win-${i}`,
    title: `Win ${i}`,
  }));
};

const simulateScarsFetch = async (count: number) => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  return Array.from({ length: count }, (_, i) => ({
    id: `scar-${i}`,
    title: `Scar ${i}`,
    embedding: Array.from({ length: 1536 }, () => Math.random()),
  }));
};

describe("Cold Start - Cache Initialization", () => {
  beforeEach(() => {
    // Start with completely clean state
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
    resetCache();
  });

  afterAll(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
  });

  bench(
    "cache service initialization",
    () => {
      // Create new cache directory and service
      const dir = join(TEST_CACHE_DIR, `init-${Date.now()}-${Math.random()}`);
      const cache = new CacheService(dir);
    },
    { time: 3000, iterations: 100 }
  );

  bench(
    "first cache write (creates directory)",
    async () => {
      const dir = join(TEST_CACHE_DIR, `first-write-${Date.now()}-${Math.random()}`);
      const cache = new CacheService(dir);
      await cache.setResult("first-key", { data: "test" }, 60000);
    },
    { time: 3000, iterations: 50 }
  );
});

describe("Cold Start - Session Start (No Cache)", () => {
  let cache: CacheService;

  beforeEach(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
    mkdirSync(join(TEST_CACHE_DIR, "results"), { recursive: true });
    resetCache();
    cache = new CacheService(TEST_CACHE_DIR);
  });

  afterAll(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
  });

  bench(
    "cold session start - decisions only",
    async () => {
      await cache.getOrFetchDecisions("orchestra_dev", 5, simulateDecisionsFetch);
    },
    { time: 10000, iterations: 10 }
  );

  bench(
    "cold session start - wins only",
    async () => {
      await cache.getOrFetchWins("orchestra_dev", 8, simulateWinsFetch);
    },
    { time: 10000, iterations: 10 }
  );

  bench(
    "cold session start - full (decisions + wins)",
    async () => {
      const [decisions, wins] = await Promise.all([
        cache.getOrFetchDecisions("orchestra_dev", 5, simulateDecisionsFetch),
        cache.getOrFetchWins("orchestra_dev", 8, simulateWinsFetch),
      ]);
    },
    { time: 15000, iterations: 5 }
  );
});

describe("Cold Start - Cache Rebuild", () => {
  beforeEach(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
    mkdirSync(join(TEST_CACHE_DIR, "results"), { recursive: true });
    resetCache();
  });

  afterAll(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
  });

  bench(
    "cache rebuild - small dataset (15 scars)",
    async () => {
      const cache = new CacheService(TEST_CACHE_DIR);
      const scars = await simulateScarsFetch(15);
      await cache.setResult("scars:15", scars, 15 * 60 * 1000);
    },
    { time: 10000, iterations: 5 }
  );

  bench(
    "cache rebuild - medium dataset (100 scars)",
    async () => {
      const cache = new CacheService(TEST_CACHE_DIR);
      const scars = await simulateScarsFetch(100);
      await cache.setResult("scars:100", scars, 15 * 60 * 1000);
    },
    { time: 15000, iterations: 3 }
  );
});

describe("Warm vs Cold Comparison", () => {
  let cache: CacheService;

  beforeAll(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
    mkdirSync(join(TEST_CACHE_DIR, "results"), { recursive: true });
    resetCache();
    cache = new CacheService(TEST_CACHE_DIR);
  });

  afterAll(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
  });

  bench(
    "cold then warm - first request (cold)",
    async () => {
      // Clear cache and fetch
      await cache.clear();
      await cache.getOrFetchDecisions("compare", 5, simulateDecisionsFetch);
    },
    { time: 10000, iterations: 5 }
  );

  bench(
    "warm request (after cold)",
    async () => {
      // Ensure cache is populated from previous test
      await cache.getOrFetchDecisions("compare", 5, async () => [
        { id: "1", title: "Cached" },
      ]);
      // Now benchmark warm path
      await cache.getOrFetchDecisions("compare", 5, simulateDecisionsFetch);
    },
    { time: 3000, iterations: 50 }
  );
});

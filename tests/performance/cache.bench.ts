/**
 * Cache Benchmarks
 *
 * Benchmarks for cache operations:
 * - Cache hit/miss cycles
 * - Cache populate
 * - Cache key generation
 * - Cache cleanup
 */

import { bench, describe, beforeAll, afterAll, beforeEach } from "vitest";
import { CacheService, resetCache } from "../../src/services/cache.js";
import { mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";

// Test cache directory
const TEST_CACHE_DIR = join(tmpdir(), `gitmem-cache-bench-${Date.now()}`);

// Mock data of varying sizes
const SMALL_DATA = { id: "1", value: "small" };
const MEDIUM_DATA = Array.from({ length: 100 }, (_, i) => ({
  id: `item-${i}`,
  title: `Item ${i}`,
  description: `Description for item ${i}`,
}));
const LARGE_DATA = Array.from({ length: 1000 }, (_, i) => ({
  id: `item-${i}`,
  title: `Item ${i}`,
  description: `This is a longer description for item ${i}. `.repeat(10),
  metadata: { index: i, timestamp: Date.now() },
}));

describe("Cache Key Generation", () => {
  let cache: CacheService;

  beforeAll(() => {
    resetCache();
    cache = new CacheService(TEST_CACHE_DIR);
  });

  bench(
    "decisionsKey generation",
    () => {
      cache.decisionsKey("test-project", 5);
    },
    { time: 1000, iterations: 50000 }
  );

  bench(
    "winsKey generation",
    () => {
      cache.winsKey("test-project", 8);
    },
    { time: 1000, iterations: 50000 }
  );

  bench(
    "scarSearchKey generation (short query)",
    () => {
      cache.scarSearchKey("test", "test-project", 5);
    },
    { time: 1000, iterations: 50000 }
  );

  bench(
    "scarSearchKey generation (long query)",
    () => {
      cache.scarSearchKey(
        "deployment verification process for production systems",
        "test-project",
        10
      );
    },
    { time: 1000, iterations: 50000 }
  );

  bench(
    "SHA256 hash (baseline comparison)",
    () => {
      createHash("sha256")
        .update("deployment verification process")
        .digest("hex")
        .slice(0, 16);
    },
    { time: 1000, iterations: 50000 }
  );
});

describe("Cache Read Operations", () => {
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
    "cache miss - non-existent key",
    async () => {
      await cache.getResult(`nonexistent-${Math.random()}`);
    },
    { time: 2000, iterations: 500 }
  );

  bench(
    "cache hit - small data",
    async () => {
      const key = "bench-small-data";
      // Ensure populated
      await cache.setResult(key, SMALL_DATA, 60000);
      // Benchmark read
      await cache.getResult(key);
    },
    { time: 2000, iterations: 500 }
  );

  bench(
    "cache hit - medium data (100 items)",
    async () => {
      const key = "bench-medium-data";
      await cache.setResult(key, MEDIUM_DATA, 60000);
      await cache.getResult(key);
    },
    { time: 2000, iterations: 200 }
  );

  bench(
    "cache hit - large data (1000 items)",
    async () => {
      const key = "bench-large-data";
      await cache.setResult(key, LARGE_DATA, 60000);
      await cache.getResult(key);
    },
    { time: 3000, iterations: 50 }
  );
});

describe("Cache Write Operations", () => {
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
    "cache write - small data",
    async () => {
      const key = `bench-write-small-${Date.now()}-${Math.random()}`;
      await cache.setResult(key, SMALL_DATA, 60000);
    },
    { time: 3000, iterations: 100 }
  );

  bench(
    "cache write - medium data (100 items)",
    async () => {
      const key = `bench-write-medium-${Date.now()}-${Math.random()}`;
      await cache.setResult(key, MEDIUM_DATA, 60000);
    },
    { time: 3000, iterations: 50 }
  );

  bench(
    "cache write - large data (1000 items)",
    async () => {
      const key = `bench-write-large-${Date.now()}-${Math.random()}`;
      await cache.setResult(key, LARGE_DATA, 60000);
    },
    { time: 5000, iterations: 20 }
  );
});

describe("Cache Lifecycle", () => {
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

  bench(
    "getOrFetch - cache miss then hit",
    async () => {
      const key = `bench-getorfetch-${Date.now()}-${Math.random()}`;
      // First call: miss, fetch, populate
      await cache.getOrFetchDecisions("bench", 5, async () => MEDIUM_DATA);
      // Second call: hit
      await cache.getOrFetchDecisions("bench", 5, async () => MEDIUM_DATA);
    },
    { time: 3000, iterations: 50 }
  );

  bench(
    "cleanup - 10 expired entries",
    async () => {
      // Create 10 expired entries
      for (let i = 0; i < 10; i++) {
        await cache.setResult(`expired-${i}`, SMALL_DATA, -1000); // Already expired
      }
      // Run cleanup
      await cache.cleanup();
    },
    { time: 5000, iterations: 20 }
  );

  bench(
    "getStats",
    async () => {
      // Populate some entries
      for (let i = 0; i < 5; i++) {
        await cache.setResult(`stats-${i}`, MEDIUM_DATA, 60000);
      }
      await cache.getStats();
    },
    { time: 3000, iterations: 50 }
  );
});

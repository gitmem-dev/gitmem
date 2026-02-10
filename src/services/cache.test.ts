/**
 * CacheService Unit Tests
 *
 * Tests for the GitMem file-based caching layer.
 * Issue: OD-473
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { CacheService, TTL, getCache, resetCache } from "./cache.js";

// Test cache directory (isolated from production)
const TEST_CACHE_DIR = "/tmp/gitmem-cache-test";

describe("CacheService", () => {
  let cache: CacheService;

  beforeEach(() => {
    // Clean up any existing test cache
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
    cache = new CacheService(TEST_CACHE_DIR);
  });

  afterEach(() => {
    // Clean up test cache
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
    resetCache();
  });

  describe("initialization", () => {
    it("creates cache directory on initialization", () => {
      expect(existsSync(TEST_CACHE_DIR)).toBe(true);
      expect(existsSync(join(TEST_CACHE_DIR, "results"))).toBe(true);
    });

    it("is enabled after successful initialization", () => {
      expect(cache.isEnabled()).toBe(true);
    });

    it("can be disabled", () => {
      cache.disable();
      expect(cache.isEnabled()).toBe(false);
    });
  });

  describe("cache key generation", () => {
    it("generates consistent scar search keys", () => {
      const key1 = cache.scarSearchKey("test query", "default", 5);
      const key2 = cache.scarSearchKey("test query", "default", 5);
      expect(key1).toBe(key2);
    });

    it("generates different keys for different queries", () => {
      const key1 = cache.scarSearchKey("query one", "default", 5);
      const key2 = cache.scarSearchKey("query two", "default", 5);
      expect(key1).not.toBe(key2);
    });

    it("generates different keys for different projects", () => {
      const key1 = cache.scarSearchKey("test", "default", 5);
      const key2 = cache.scarSearchKey("test", "other-project", 5);
      expect(key1).not.toBe(key2);
    });

    it("generates different keys for different match counts", () => {
      const key1 = cache.scarSearchKey("test", "default", 3);
      const key2 = cache.scarSearchKey("test", "default", 5);
      expect(key1).not.toBe(key2);
    });

    it("normalizes query text (lowercase, trim)", () => {
      const key1 = cache.scarSearchKey("  Test Query  ", "default", 5);
      const key2 = cache.scarSearchKey("test query", "default", 5);
      expect(key1).toBe(key2);
    });

    it("generates decisions keys", () => {
      const key = cache.decisionsKey("default", 5);
      expect(key).toBe("decisions:default:5");
    });
  });

  describe("setResult and getResult", () => {
    it("stores and retrieves data", async () => {
      const testData = { items: [1, 2, 3], message: "test" };
      await cache.setResult("test-key", testData, 60000);

      const result = await cache.getResult<typeof testData>("test-key");
      expect(result).not.toBeNull();
      expect(result!.data).toEqual(testData);
    });

    it("returns null for non-existent key", async () => {
      const result = await cache.getResult("non-existent");
      expect(result).toBeNull();
    });

    it("returns cache age in milliseconds", async () => {
      const testData = { test: true };
      await cache.setResult("test-key", testData, 60000);

      // Wait a small amount
      await new Promise((r) => setTimeout(r, 10));

      const result = await cache.getResult<typeof testData>("test-key");
      expect(result).not.toBeNull();
      expect(result!.age_ms).toBeGreaterThan(0);
      expect(result!.age_ms).toBeLessThan(1000); // Should be very fast
    });

    it("returns null for expired entries", async () => {
      const testData = { test: true };
      // Set with very short TTL
      await cache.setResult("expiring-key", testData, 1);

      // Wait for expiration
      await new Promise((r) => setTimeout(r, 10));

      const result = await cache.getResult("expiring-key");
      expect(result).toBeNull();
    });

    it("returns null when cache is disabled", async () => {
      cache.disable();
      await cache.setResult("test-key", { test: true }, 60000);

      const result = await cache.getResult("test-key");
      expect(result).toBeNull();
    });
  });

  describe("getOrFetchScarSearch", () => {
    it("returns cached data on hit", async () => {
      const mockData = [{ id: "1", title: "Scar 1" }];
      let fetchCount = 0;
      const fetcher = async () => {
        fetchCount++;
        return mockData;
      };

      // First call - should fetch
      const result1 = await cache.getOrFetchScarSearch(
        "test query",
        "default",
        5,
        fetcher
      );
      expect(result1.cache_hit).toBe(false);
      expect(result1.data).toEqual(mockData);
      expect(fetchCount).toBe(1);

      // Second call - should use cache
      const result2 = await cache.getOrFetchScarSearch(
        "test query",
        "default",
        5,
        fetcher
      );
      expect(result2.cache_hit).toBe(true);
      expect(result2.data).toEqual(mockData);
      expect(result2.cache_age_ms).toBeDefined();
      expect(fetchCount).toBe(1); // Fetcher not called again
    });

    it("fetches on cache miss", async () => {
      const mockData = [{ id: "1", title: "Scar 1" }];
      const fetcher = async () => mockData;

      const result = await cache.getOrFetchScarSearch(
        "new query",
        "default",
        5,
        fetcher
      );

      expect(result.cache_hit).toBe(false);
      expect(result.data).toEqual(mockData);
    });
  });

  describe("getOrFetchDecisions", () => {
    it("returns cached data on hit", async () => {
      const mockData = [{ id: "1", title: "Decision 1" }];
      let fetchCount = 0;
      const fetcher = async () => {
        fetchCount++;
        return mockData;
      };

      // First call - should fetch
      const result1 = await cache.getOrFetchDecisions(
        "default",
        5,
        fetcher
      );
      expect(result1.cache_hit).toBe(false);
      expect(fetchCount).toBe(1);

      // Second call - should use cache
      const result2 = await cache.getOrFetchDecisions(
        "default",
        5,
        fetcher
      );
      expect(result2.cache_hit).toBe(true);
      expect(fetchCount).toBe(1);
    });
  });

  describe("cleanup", () => {
    it("removes expired entries", async () => {
      // Create an expired entry manually
      const expiredEntry = {
        key: "expired-key",
        created_at: Date.now() - 100000,
        expires_at: Date.now() - 50000, // Expired
        data: { test: true },
      };
      const filepath = join(TEST_CACHE_DIR, "results", "expired-key.json");
      writeFileSync(filepath, JSON.stringify(expiredEntry));

      // Create a valid entry
      await cache.setResult("valid-key", { test: true }, 60000);

      // Run cleanup
      const cleaned = await cache.cleanup();
      expect(cleaned).toBe(1);

      // Verify expired entry is gone
      expect(existsSync(filepath)).toBe(false);

      // Verify valid entry remains
      const validResult = await cache.getResult("valid-key");
      expect(validResult).not.toBeNull();
    });
  });

  describe("clear", () => {
    it("removes all cached entries", async () => {
      await cache.setResult("key1", { test: 1 }, 60000);
      await cache.setResult("key2", { test: 2 }, 60000);

      await cache.clear();

      const result1 = await cache.getResult("key1");
      const result2 = await cache.getResult("key2");
      expect(result1).toBeNull();
      expect(result2).toBeNull();
    });
  });

  describe("getStats", () => {
    it("returns cache statistics", async () => {
      await cache.setResult("key1", { test: 1 }, 60000);
      await cache.setResult("key2", { test: 2 }, 60000);

      const stats = await cache.getStats();
      expect(stats.resultCount).toBe(2);
      expect(stats.resultBytes).toBeGreaterThan(0);
      expect(stats.oldestEntry).toBeInstanceOf(Date);
    });

    it("tracks hit rate", async () => {
      await cache.setResult("key1", { test: 1 }, 60000);

      // Generate some hits and misses
      await cache.getResult("key1"); // Hit
      await cache.getResult("key1"); // Hit
      await cache.getResult("nonexistent"); // Miss

      const stats = await cache.getStats();
      expect(stats.hitRate).toBeCloseTo(2 / 3, 1);
    });
  });

  describe("TTL values", () => {
    it("exports correct TTL values", () => {
      expect(TTL.SCAR_SEARCH).toBe(15 * 60 * 1000); // 15 minutes
      expect(TTL.DECISIONS).toBe(5 * 60 * 1000); // 5 minutes
    });
  });

  describe("singleton pattern", () => {
    it("getCache returns same instance", () => {
      // Note: getCache uses default dir which may not be writable in test env
      // This test verifies the singleton behavior, not the cache functionality
      resetCache();
      // Set env var to use test directory
      const originalDir = process.env.GITMEM_CACHE_DIR;
      process.env.GITMEM_CACHE_DIR = TEST_CACHE_DIR;
      try {
        const cache1 = getCache();
        const cache2 = getCache();
        expect(cache1).toBe(cache2);
      } finally {
        process.env.GITMEM_CACHE_DIR = originalDir;
        resetCache();
      }
    });

    it("resetCache creates new instance", () => {
      const originalDir = process.env.GITMEM_CACHE_DIR;
      process.env.GITMEM_CACHE_DIR = TEST_CACHE_DIR;
      try {
        const cache1 = getCache();
        resetCache();
        const cache2 = getCache();
        expect(cache1).not.toBe(cache2);
      } finally {
        process.env.GITMEM_CACHE_DIR = originalDir;
        resetCache();
      }
    });
  });

  describe("error handling", () => {
    it("gracefully handles corrupted cache files", async () => {
      // Write corrupted JSON
      const filepath = join(TEST_CACHE_DIR, "results", "corrupted.json");
      writeFileSync(filepath, "not valid json {{{");

      // Should return null, not throw
      const result = await cache.getResult("corrupted");
      expect(result).toBeNull();
    });

    it("gracefully handles file system errors", async () => {
      // Disable cache to simulate error condition
      cache.disable();

      // Operations should not throw
      await expect(cache.setResult("key", { test: true }, 60000)).resolves.not.toThrow();
      await expect(cache.getResult("key")).resolves.toBeNull();
    });
  });
});

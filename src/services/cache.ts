/**
 * GitMem Cache Service
 *
 * File-based cache for GitMem MCP operations.
 * Caches search results to avoid repeated ww-mcp calls.
 *
 * Design: docs/systems/gitmem-caching.md
 * Issue: OD-473
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";

// Default cache directory
// Uses env var if set, otherwise falls back to user's home directory or /tmp
const DEFAULT_CACHE_DIR = process.env.GITMEM_CACHE_DIR ||
  (process.env.HOME ? `${process.env.HOME}/.cache/gitmem` : "/tmp/gitmem-cache");

// TTL values in milliseconds
const TTL = {
  SCAR_SEARCH: 15 * 60 * 1000,    // 15 minutes
  DECISIONS: 5 * 60 * 1000,       // 5 minutes
  WINS: 5 * 60 * 1000,            // 5 minutes
} as const;

// Max cache sizes
const MAX_RESULT_CACHE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Cached result entry
 */
interface CacheEntry<T> {
  key: string;
  created_at: number;
  expires_at: number;
  data: T;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  resultCount: number;
  resultBytes: number;
  oldestEntry: Date | null;
  hitRate?: number;
}

/**
 * Generate a short hash for cache keys
 */
function hashText(text: string): string {
  return createHash("sha256")
    .update(text.toLowerCase().trim())
    .digest("hex")
    .slice(0, 16);
}

/**
 * CacheService class
 *
 * Provides file-based caching for GitMem operations.
 * Designed for graceful degradation - cache failures never block operations.
 */
export class CacheService {
  private cacheDir: string;
  private resultsDir: string;
  private enabled: boolean = true;

  // Stats tracking
  private hits: number = 0;
  private misses: number = 0;

  constructor(cacheDir: string = DEFAULT_CACHE_DIR) {
    this.cacheDir = cacheDir;
    this.resultsDir = join(cacheDir, "results");
    this.init();
  }

  /**
   * Initialize cache directories
   */
  private init(): void {
    try {
      if (!existsSync(this.cacheDir)) {
        mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
      }
      if (!existsSync(this.resultsDir)) {
        mkdirSync(this.resultsDir, { recursive: true, mode: 0o700 });
      }
    } catch (error) {
      console.warn("[cache] Failed to initialize cache directory:", error);
      this.enabled = false;
    }
  }

  /**
   * Check if cache is enabled and working
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Disable cache (for testing or on errors)
   */
  disable(): void {
    this.enabled = false;
  }

  /**
   * Generate cache key for scar search
   */
  scarSearchKey(query: string, project: string, matchCount: number): string {
    return `scar_search:${hashText(query)}:${project}:${matchCount}`;
  }

  /**
   * Generate cache key for decisions
   */
  decisionsKey(project: string, limit: number): string {
    return `decisions:${project}:${limit}`;
  }

  /**
   * Generate cache key for wins
   */
  winsKey(project: string, limit: number): string {
    return `wins:${project}:${limit}`;
  }

  /**
   * Get cached result
   */
  async getResult<T>(key: string): Promise<{ data: T; age_ms: number } | null> {
    if (!this.enabled) return null;

    try {
      const filename = this.keyToFilename(key);
      const filepath = join(this.resultsDir, filename);

      if (!existsSync(filepath)) {
        this.misses++;
        return null;
      }

      const content = readFileSync(filepath, "utf-8");
      const entry = JSON.parse(content) as CacheEntry<T>;

      // Check expiration
      const now = Date.now();
      if (now > entry.expires_at) {
        // Expired - delete and return null
        try {
          unlinkSync(filepath);
        } catch {
          // Ignore delete errors
        }
        this.misses++;
        console.log(`[cache] EXPIRED: ${key}`);
        return null;
      }

      this.hits++;
      const age_ms = now - entry.created_at;
      console.log(`[cache] HIT: ${key} (age: ${age_ms}ms)`);
      return { data: entry.data, age_ms };
    } catch (error) {
      console.warn(`[cache] Error reading ${key}:`, error);
      this.misses++;
      return null;
    }
  }

  /**
   * Set cached result
   */
  async setResult<T>(key: string, data: T, ttlMs: number): Promise<void> {
    if (!this.enabled) return;

    try {
      const now = Date.now();
      const entry: CacheEntry<T> = {
        key,
        created_at: now,
        expires_at: now + ttlMs,
        data,
      };

      const filename = this.keyToFilename(key);
      const filepath = join(this.resultsDir, filename);
      const content = JSON.stringify(entry, null, 2);

      writeFileSync(filepath, content, { mode: 0o600 });
      console.log(`[cache] SET: ${key} (TTL: ${ttlMs}ms)`);
    } catch (error) {
      console.warn(`[cache] Error writing ${key}:`, error);
      // Don't disable cache on write errors - might be transient
    }
  }

  /**
   * Convenience method: get or fetch scar search results
   */
  async getOrFetchScarSearch<T>(
    query: string,
    project: string,
    matchCount: number,
    fetcher: () => Promise<T>
  ): Promise<{ data: T; cache_hit: boolean; cache_age_ms?: number }> {
    const key = this.scarSearchKey(query, project, matchCount);
    const cached = await this.getResult<T>(key);

    if (cached) {
      return { data: cached.data, cache_hit: true, cache_age_ms: cached.age_ms };
    }

    // Cache miss - fetch from source
    const data = await fetcher();

    // Cache the result (async, don't await)
    this.setResult(key, data, TTL.SCAR_SEARCH).catch(() => {});

    return { data, cache_hit: false };
  }

  /**
   * Convenience method: get or fetch decisions
   */
  async getOrFetchDecisions<T>(
    project: string,
    limit: number,
    fetcher: () => Promise<T>
  ): Promise<{ data: T; cache_hit: boolean; cache_age_ms?: number }> {
    const key = this.decisionsKey(project, limit);
    const cached = await this.getResult<T>(key);

    if (cached) {
      return { data: cached.data, cache_hit: true, cache_age_ms: cached.age_ms };
    }

    // Cache miss - fetch from source
    const data = await fetcher();

    // Cache the result (async, don't await)
    this.setResult(key, data, TTL.DECISIONS).catch(() => {});

    return { data, cache_hit: false };
  }

  /**
   * Convenience method: get or fetch wins
   */
  async getOrFetchWins<T>(
    project: string,
    limit: number,
    fetcher: () => Promise<T>
  ): Promise<{ data: T; cache_hit: boolean; cache_age_ms?: number }> {
    const key = this.winsKey(project, limit);
    const cached = await this.getResult<T>(key);

    if (cached) {
      return { data: cached.data, cache_hit: true, cache_age_ms: cached.age_ms };
    }

    // Cache miss - fetch from source
    const data = await fetcher();

    // Cache the result (async, don't await)
    this.setResult(key, data, TTL.WINS).catch(() => {});

    return { data, cache_hit: false };
  }

  /**
   * Clean up expired entries
   */
  async cleanup(): Promise<number> {
    if (!this.enabled) return 0;

    let cleaned = 0;
    try {
      const files = readdirSync(this.resultsDir);
      const now = Date.now();

      for (const file of files) {
        if (!file.endsWith(".json")) continue;

        const filepath = join(this.resultsDir, file);
        try {
          const content = readFileSync(filepath, "utf-8");
          const entry = JSON.parse(content) as CacheEntry<unknown>;

          if (now > entry.expires_at) {
            unlinkSync(filepath);
            cleaned++;
          }
        } catch {
          // Delete corrupted files
          try {
            unlinkSync(filepath);
            cleaned++;
          } catch {
            // Ignore
          }
        }
      }

      if (cleaned > 0) {
        console.log(`[cache] Cleaned up ${cleaned} expired entries`);
      }
    } catch (error) {
      console.warn("[cache] Error during cleanup:", error);
    }

    return cleaned;
  }

  /**
   * Clear all cached data
   */
  async clear(): Promise<void> {
    try {
      const files = readdirSync(this.resultsDir);
      for (const file of files) {
        try {
          unlinkSync(join(this.resultsDir, file));
        } catch {
          // Ignore individual file errors
        }
      }
      console.log("[cache] Cache cleared");
    } catch (error) {
      console.warn("[cache] Error clearing cache:", error);
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<CacheStats> {
    const stats: CacheStats = {
      resultCount: 0,
      resultBytes: 0,
      oldestEntry: null,
    };

    if (!this.enabled) return stats;

    try {
      const files = readdirSync(this.resultsDir);
      let oldestTime = Infinity;

      for (const file of files) {
        if (!file.endsWith(".json")) continue;

        const filepath = join(this.resultsDir, file);
        try {
          const fileStat = statSync(filepath);
          stats.resultCount++;
          stats.resultBytes += fileStat.size;

          const content = readFileSync(filepath, "utf-8");
          const entry = JSON.parse(content) as CacheEntry<unknown>;
          if (entry.created_at < oldestTime) {
            oldestTime = entry.created_at;
          }
        } catch {
          // Skip problematic files
        }
      }

      if (oldestTime !== Infinity) {
        stats.oldestEntry = new Date(oldestTime);
      }

      // Calculate hit rate
      const total = this.hits + this.misses;
      if (total > 0) {
        stats.hitRate = this.hits / total;
      }
    } catch (error) {
      console.warn("[cache] Error getting stats:", error);
    }

    return stats;
  }

  /**
   * Convert cache key to safe filename
   */
  private keyToFilename(key: string): string {
    // Replace unsafe chars with underscores, keep it readable
    return key.replace(/[^a-zA-Z0-9_:-]/g, "_") + ".json";
  }
}

// Singleton instance
let cacheInstance: CacheService | null = null;

/**
 * Get the cache service singleton
 */
export function getCache(): CacheService {
  if (!cacheInstance) {
    cacheInstance = new CacheService();
  }
  return cacheInstance;
}

/**
 * Reset cache instance (for testing)
 */
export function resetCache(): void {
  cacheInstance = null;
}

// Export TTL values for external use
export { TTL };

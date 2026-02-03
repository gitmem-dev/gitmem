/**
 * Unified Storage Abstraction
 *
 * Routes to LocalFileStorage (free tier) or Supabase (pro/dev tier)
 * based on the detected tier. Tools call getStorage() instead of
 * importing supabase-client directly.
 */

import { hasSupabase, getTableName } from "./tier.js";
import type { RelevantScar } from "../types/index.js";

/**
 * Storage backend interface
 */
export interface StorageBackend {
  /**
   * Query records from a collection
   */
  query<T = unknown>(
    collection: string,
    options?: {
      select?: string;
      filters?: Record<string, string>;
      order?: string;
      limit?: number;
    }
  ): Promise<T[]>;

  /**
   * Get a single record by ID
   */
  get<T = unknown>(collection: string, id: string): Promise<T | null>;

  /**
   * Upsert (insert or update) a record
   */
  upsert(collection: string, data: Record<string, unknown>): Promise<unknown>;

  /**
   * Search for relevant scars
   */
  search(query: string, k?: number): Promise<RelevantScar[]>;
}

/**
 * Supabase storage backend (pro/dev tier)
 */
class SupabaseStorage implements StorageBackend {
  async query<T = unknown>(
    collection: string,
    options: {
      select?: string;
      filters?: Record<string, string>;
      order?: string;
      limit?: number;
    } = {}
  ): Promise<T[]> {
    // Dynamic import to avoid loading Supabase in free tier
    const supabase = await import("./supabase-client.js");
    const table = getTableName(collection);

    return supabase.directQuery<T>(table, {
      select: options.select || "*",
      filters: options.filters || {},
      order: options.order,
      limit: options.limit,
    });
  }

  async get<T = unknown>(collection: string, id: string): Promise<T | null> {
    const results = await this.query<T>(collection, {
      filters: { id: `eq.${id}` },
      limit: 1,
    });
    return results[0] || null;
  }

  async upsert(collection: string, data: Record<string, unknown>): Promise<unknown> {
    const supabase = await import("./supabase-client.js");
    const table = getTableName(collection);
    return supabase.directUpsert(table, data);
  }

  async search(query: string, k = 5): Promise<RelevantScar[]> {
    // For pro/dev, local vector search is handled separately in recall.ts
    // This is a fallback that uses Supabase scar search via MCP
    const supabase = await import("./supabase-client.js");

    try {
      const results = await supabase.scarSearch<RelevantScar>(query, k);
      return Array.isArray(results) ? results : [];
    } catch (error) {
      console.error("[storage] Supabase search failed:", error);
      return [];
    }
  }
}

/**
 * Local file storage backend (free tier)
 */
class LocalStorage implements StorageBackend {
  async query<T = unknown>(
    collection: string,
    options: {
      select?: string;
      filters?: Record<string, string>;
      order?: string;
      limit?: number;
    } = {}
  ): Promise<T[]> {
    const { getLocalFileStorage } = await import("./local-file-storage.js");
    const storage = getLocalFileStorage();
    return storage.list<T & Record<string, unknown>>(collection, options) as Promise<T[]>;
  }

  async get<T = unknown>(collection: string, id: string): Promise<T | null> {
    const { getLocalFileStorage } = await import("./local-file-storage.js");
    const storage = getLocalFileStorage();
    return storage.get<T & Record<string, unknown>>(collection, id) as Promise<T | null>;
  }

  async upsert(collection: string, data: Record<string, unknown>): Promise<unknown> {
    const { getLocalFileStorage } = await import("./local-file-storage.js");
    const storage = getLocalFileStorage();
    return storage.upsert(collection, data as Record<string, unknown> & { id: string });
  }

  async search(query: string, k = 5): Promise<RelevantScar[]> {
    const { getLocalFileStorage } = await import("./local-file-storage.js");
    const storage = getLocalFileStorage();
    return storage.keywordSearch(query, k);
  }
}

// Singleton
let _storage: StorageBackend | null = null;

/**
 * Get the storage backend for the current tier
 */
export function getStorage(): StorageBackend {
  if (!_storage) {
    _storage = hasSupabase() ? new SupabaseStorage() : new LocalStorage();
  }
  return _storage;
}

/**
 * Reset storage (for testing)
 */
export function resetStorage(): void {
  _storage = null;
}

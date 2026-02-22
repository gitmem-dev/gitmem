/**
 * Local File Storage — Free Tier Backend
 *
 * Stores scars, sessions, decisions, and scar usage as JSON files
 * in the .gitmem/ directory (defaults to ~/.gitmem, overridable via GITMEM_DIR).
 *
 * Provides keyword-based search (no embeddings needed).
 */

import * as fs from "fs";
import * as path from "path";
import { bm25Search, type BM25Document } from "./bm25.js";
import { getGitmemDir } from "./gitmem-dir.js";
import type { RelevantScar } from "../types/index.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const WARN_FILE_SIZE = 1 * 1024 * 1024; // 1MB

export class LocalFileStorage {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath || getGitmemDir();
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }
  }

  private getFilePath(collection: string): string {
    return path.join(this.basePath, `${collection}.json`);
  }

  private readCollection<T>(collection: string): T[] {
    const filePath = this.getFilePath(collection);
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as T[];
    } catch {
      console.error(`[local-storage] Failed to read ${collection}.json, starting fresh`);
      return [];
    }
  }

  private writeCollection<T>(collection: string, data: T[]): void {
    const filePath = this.getFilePath(collection);
    const json = JSON.stringify(data, null, 2);
    const size = Buffer.byteLength(json, "utf-8");

    if (size > WARN_FILE_SIZE) {
      console.error(`[local-storage] Warning: ${collection}.json is ${(size / 1024).toFixed(0)}KB`);
    }

    if (size > MAX_FILE_SIZE) {
      console.error(`[local-storage] ${collection}.json exceeds 10MB, evicting oldest entries`);
      // Keep most recent 80% of entries
      const trimmed = data.slice(Math.floor(data.length * 0.2));
      fs.writeFileSync(filePath, JSON.stringify(trimmed, null, 2), "utf-8");
      return;
    }

    fs.writeFileSync(filePath, json, "utf-8");
  }

  /**
   * List records with optional filters
   */
  async list<T extends Record<string, unknown>>(
    collection: string,
    options: {
      filters?: Record<string, string>;
      order?: string;
      limit?: number;
    } = {}
  ): Promise<T[]> {
    let records = this.readCollection<T>(collection);

    // Apply simple filters
    if (options.filters) {
      for (const [key, value] of Object.entries(options.filters)) {
        const cleanValue = value.startsWith("eq.") ? value.slice(3) : value;
        if (key === "is_active" && cleanValue === "true") {
          // is_active defaults to true when not explicitly set
          records = records.filter((r) => r[key] !== false);
        } else {
          records = records.filter((r) => String(r[key]) === cleanValue);
        }
      }
    }

    // Apply ordering
    if (options.order) {
      const [field, direction] = options.order.split(".");
      const asc = direction !== "desc";
      records.sort((a, b) => {
        const av = String(a[field] || "");
        const bv = String(b[field] || "");
        return asc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }

    // Apply limit
    if (options.limit) {
      records = records.slice(0, options.limit);
    }

    return records;
  }

  /**
   * Get a single record by ID
   */
  async get<T extends Record<string, unknown>>(
    collection: string,
    id: string
  ): Promise<T | null> {
    const records = this.readCollection<T>(collection);
    return records.find((r) => r.id === id) || null;
  }

  /**
   * Upsert a record (insert or update by ID)
   */
  async upsert<T extends Record<string, unknown>>(
    collection: string,
    data: T & { id: string }
  ): Promise<T> {
    const records = this.readCollection<T>(collection);
    const existingIndex = records.findIndex((r) => r.id === data.id);

    if (existingIndex >= 0) {
      records[existingIndex] = { ...records[existingIndex], ...data };
    } else {
      records.push(data);
    }

    this.writeCollection(collection, records);
    return data;
  }

  /**
   * Delete a record by ID
   */
  async delete(collection: string, id: string): Promise<boolean> {
    const records = this.readCollection<Record<string, unknown>>(collection);
    const filtered = records.filter((r) => r.id !== id);
    if (filtered.length === records.length) return false;
    this.writeCollection(collection, filtered);
    return true;
  }

  /**
   * BM25-ranked search for scars (free tier alternative to semantic search)
   *
   * Field boosts: title (3x), keywords (2x), description (1x)
   * Uses stemming, IDF weighting, and document length normalization.
   */
  async keywordSearch(query: string, k = 5): Promise<RelevantScar[]> {
    const learnings = this.readCollection<Record<string, unknown>>("learnings")
      .filter((l) => l.is_active !== false);
    if (learnings.length === 0) return [];

    // Build BM25 documents with field boosting
    const docs: BM25Document[] = learnings.map((l) => ({
      id: String(l.id),
      fields: [
        { text: String(l.title || ""), boost: 3 },
        { text: ((l.keywords as string[]) || []).join(" "), boost: 2 },
        { text: String(l.description || ""), boost: 1 },
      ],
    }));

    const results = bm25Search(query, docs, k);

    // Map back to RelevantScar
    const byId = new Map(learnings.map((l) => [String(l.id), l]));
    const mapped: RelevantScar[] = [];
    for (const r of results) {
      const l = byId.get(r.id);
      if (!l) continue;
      // Deprioritize starter scars (0.7x multiplier)
      const isStarter = !!(l as Record<string, unknown>).is_starter;
      const adjustedSimilarity = isStarter ? r.similarity * 0.7 : r.similarity;
      mapped.push({
        id: r.id,
        title: String(l.title),
        learning_type: String(l.learning_type || "scar"),
        description: String(l.description),
        severity: String(l.severity || "medium"),
        counter_arguments: (l.counter_arguments as string[]) || [],
        similarity: adjustedSimilarity,
        is_starter: isStarter || undefined,
      });
    }
    // Re-sort after starter penalty (earned scars float up)
    return mapped.sort((a, b) => b.similarity - a.similarity);
  }

  /**
   * Get the count of learnings stored locally
   */
  getLearningCount(): number {
    return this.readCollection("learnings").length;
  }

  /**
   * Load starter scars from a JSON file into local storage
   */
  async loadStarterScars(scarsPath: string): Promise<number> {
    try {
      const raw = fs.readFileSync(scarsPath, "utf-8");
      const scars = JSON.parse(raw) as Array<Record<string, unknown> & { id: string }>;
      const existing = this.readCollection<Record<string, unknown>>("learnings");
      const existingIds = new Set(existing.map((e) => e.id));

      let loaded = 0;
      const now = new Date().toISOString();
      for (const scar of scars) {
        if (!existingIds.has(scar.id)) {
          // Stamp created_at to install time so starter scars don't show stale ages
          existing.push({ ...scar, created_at: now });
          loaded++;
        }
      }

      if (loaded > 0) {
        this.writeCollection("learnings", existing);
      }

      return loaded;
    } catch (error) {
      console.error("[local-storage] Failed to load starter scars:", error);
      return 0;
    }
  }
}

// Singleton instance
let _instance: LocalFileStorage | null = null;

export function getLocalFileStorage(): LocalFileStorage {
  if (!_instance) {
    _instance = new LocalFileStorage();
  }
  return _instance;
}

export function resetLocalFileStorage(): void {
  _instance = null;
}

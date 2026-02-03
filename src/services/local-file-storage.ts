/**
 * Local File Storage — Free Tier Backend
 *
 * Stores scars, sessions, decisions, and scar usage as JSON files
 * in the .gitmem/ directory of the current project.
 *
 * Provides keyword-based search (no embeddings needed).
 */

import * as fs from "fs";
import * as path from "path";
import type { RelevantScar } from "../types/index.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const WARN_FILE_SIZE = 1 * 1024 * 1024; // 1MB

export class LocalFileStorage {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath || path.join(process.cwd(), ".gitmem");
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
        records = records.filter((r) => String(r[key]) === cleanValue);
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
   * Keyword-based search for scars (free tier alternative to semantic search)
   *
   * Scores by: title match (3x), keyword match (2x), description match (1x)
   */
  async keywordSearch(query: string, k = 5): Promise<RelevantScar[]> {
    const learnings = this.readCollection<Record<string, unknown>>("learnings");
    const queryTokens = tokenize(query.toLowerCase());

    if (queryTokens.length === 0) return [];

    const maxScore = queryTokens.length * 6; // max possible per token: 3+2+1

    const scored = learnings.map((l) => {
      let score = 0;
      const titleTokens = tokenize(String(l.title || "").toLowerCase());
      const descTokens = tokenize(String(l.description || "").toLowerCase());
      const kwTokens = ((l.keywords as string[]) || []).map((k) => k.toLowerCase());

      for (const qt of queryTokens) {
        if (titleTokens.some((t) => t.includes(qt) || qt.includes(t))) score += 3;
        if (kwTokens.some((k) => k.includes(qt) || qt.includes(k))) score += 2;
        if (descTokens.some((t) => t.includes(qt) || qt.includes(t))) score += 1;
      }

      return {
        learning: l,
        score,
        similarity: Math.round((score / maxScore) * 1000) / 1000,
      };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((s) => ({
        id: String(s.learning.id),
        title: String(s.learning.title),
        description: String(s.learning.description),
        severity: String(s.learning.severity || "medium"),
        counter_arguments: (s.learning.counter_arguments as string[]) || [],
        similarity: s.similarity,
      }));
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
      for (const scar of scars) {
        if (!existingIds.has(scar.id)) {
          existing.push(scar);
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

/**
 * Tokenize text into words, stripping punctuation
 */
function tokenize(text: string): string[] {
  return text
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
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

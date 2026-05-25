/**
 * Local-to-Supabase Migration
 *
 * Migrates existing free-tier local .gitmem/ data to Supabase when
 * a user upgrades to Pro. Called during `activate` after schema is
 * verified and credentials are saved.
 *
 * Collections migrated:
 *   - learnings (scars, wins, patterns, anti-patterns)
 *   - sessions
 *   - decisions
 *   - scar_usage
 *
 * Threads are NOT migrated — they remain local (thread lifecycle is
 * tied to .gitmem/threads.json and managed by session_start).
 *
 * Migration is idempotent: uses Supabase upsert (merge-duplicates)
 * so re-running is safe. Existing Supabase records with same ID are
 * updated, not duplicated.
 */

import * as fs from "fs";
import * as path from "path";
import { getGitmemDir } from "../services/gitmem-dir.js";

/** Collections that map to Supabase tables */
const MIGRATABLE_COLLECTIONS = ["learnings", "sessions", "decisions", "scar_usage"] as const;

/** Fields that should NOT be sent to Supabase (local-only or computed) */
const STRIP_FIELDS = new Set(["is_starter"]);

/** Fields that Supabase will reject if null (remove instead of sending null) */
const NULLABLE_STRIP = new Set(["embedding"]);

export interface MigrationResult {
  migrated: Record<string, number>;
  skipped: Record<string, number>;
  errors: Record<string, string[]>;
  total: number;
  hasLocalData: boolean;
}

/**
 * Check if there is local data worth migrating
 */
export function hasLocalData(gitmemDir?: string): boolean {
  const dir = gitmemDir || getGitmemDir();
  for (const collection of MIGRATABLE_COLLECTIONS) {
    const filePath = path.join(dir, `${collection}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (Array.isArray(data) && data.length > 0) return true;
      } catch {
        // Corrupt file — skip
      }
    }
  }
  return false;
}

/**
 * Read a local collection JSON file
 */
function readLocalCollection(dir: string, collection: string): Record<string, unknown>[] {
  const filePath = path.join(dir, `${collection}.json`);
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Clean a record for Supabase insertion:
 * - Strip local-only fields
 * - Remove null values for non-nullable columns
 * - Ensure id exists
 */
function cleanRecord(record: Record<string, unknown>): Record<string, unknown> | null {
  if (!record.id) return null;

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (STRIP_FIELDS.has(key)) continue;
    if (NULLABLE_STRIP.has(key) && (value === null || value === undefined)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

/**
 * Migrate local .gitmem data to Supabase
 *
 * @param supabaseUrl - User's Supabase project URL
 * @param supabaseKey - User's service role key
 * @param tablePrefix - Table prefix (default: "gitmem_")
 * @param gitmemDir   - Override .gitmem directory path
 * @param onProgress  - Callback for progress reporting
 */
export async function migrateLocalToSupabase(opts: {
  supabaseUrl: string;
  supabaseKey: string;
  tablePrefix?: string;
  gitmemDir?: string;
  onProgress?: (msg: string) => void;
}): Promise<MigrationResult> {
  const { supabaseUrl, supabaseKey, tablePrefix = "gitmem_", onProgress } = opts;
  const dir = opts.gitmemDir || getGitmemDir();
  const log = onProgress || ((msg: string) => console.log(msg));

  const result: MigrationResult = {
    migrated: {},
    skipped: {},
    errors: {},
    total: 0,
    hasLocalData: false,
  };

  const restUrl = `${supabaseUrl}/rest/v1`;

  for (const collection of MIGRATABLE_COLLECTIONS) {
    const records = readLocalCollection(dir, collection);
    const tableName = `${tablePrefix}${collection}`;

    result.migrated[collection] = 0;
    result.skipped[collection] = 0;
    result.errors[collection] = [];

    if (records.length === 0) continue;
    result.hasLocalData = true;

    log(`  Migrating ${records.length} ${collection}...`);

    for (const record of records) {
      const cleaned = cleanRecord(record);
      if (!cleaned) {
        result.skipped[collection]++;
        continue;
      }

      try {
        const response = await fetch(`${restUrl}/${tableName}`, {
          method: "POST",
          headers: {
            "apikey": supabaseKey,
            "Authorization": `Bearer ${supabaseKey}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal,resolution=merge-duplicates",
            "Content-Profile": "public",
          },
          body: JSON.stringify(cleaned),
          signal: AbortSignal.timeout(10_000),
        });

        if (response.ok) {
          result.migrated[collection]++;
        } else {
          const text = await response.text();
          // Only log first 3 errors per collection to avoid spam
          if (result.errors[collection].length < 3) {
            result.errors[collection].push(
              `${String(cleaned.id).substring(0, 8)}: ${response.status} - ${text.substring(0, 100)}`
            );
          }
          result.skipped[collection]++;
        }
      } catch (err) {
        if (result.errors[collection].length < 3) {
          result.errors[collection].push(
            `${String(cleaned.id).substring(0, 8)}: ${err instanceof Error ? err.message : "Unknown error"}`
          );
        }
        result.skipped[collection]++;
      }

      result.total++;
    }
  }

  return result;
}

/**
 * Rename local collection files after successful migration
 * Adds .pre-migration suffix so data isn't lost but won't be re-read by free tier
 */
export function archiveLocalData(gitmemDir?: string): string[] {
  const dir = gitmemDir || getGitmemDir();
  const archived: string[] = [];

  for (const collection of MIGRATABLE_COLLECTIONS) {
    const filePath = path.join(dir, `${collection}.json`);
    if (fs.existsSync(filePath)) {
      const archivePath = `${filePath}.pre-migration`;
      // Don't overwrite existing archive
      if (!fs.existsSync(archivePath)) {
        fs.renameSync(filePath, archivePath);
        archived.push(collection);
      }
    }
  }

  return archived;
}

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

/**
 * Known columns per table — only these fields are sent to Supabase.
 * PostgREST rejects POSTs with unknown columns, so we must whitelist.
 * This prevents accumulated local fields from different code versions
 * from causing migration failures.
 */
const KNOWN_COLUMNS: Record<string, Set<string>> = {
  learnings: new Set([
    "id", "learning_type", "title", "description", "severity", "scar_type",
    "counter_arguments", "problem_context", "solution_approach", "applies_when",
    "keywords", "domain", "embedding", "project", "source_date",
    "source_linear_issue", "persona_name", "why_this_matters",
    "action_protocol", "self_check_criteria", "is_active",
    "decay_multiplier", "repeat_mistake", "related_scar_id",
    "repeat_mistake_details", "created_at", "updated_at",
  ]),
  sessions: new Set([
    "id", "session_title", "session_date", "agent", "project",
    "linear_issue", "recording_path", "transcript_path", "decisions",
    "open_threads", "closing_reflection", "close_compliance",
    "rapport_summary", "embedding", "created_at", "updated_at",
  ]),
  decisions: new Set([
    "id", "decision_date", "title", "decision", "rationale",
    "alternatives_considered", "personas_involved", "docs_affected",
    "linear_issue", "session_id", "project", "embedding", "created_at",
  ]),
  scar_usage: new Set([
    "id", "scar_id", "session_id", "agent", "issue_id",
    "issue_identifier", "reference_type", "reference_context",
    "surfaced_at", "acknowledged_at", "referenced",
    "execution_successful", "variant_id", "created_at",
  ]),
};

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
 * Columns that are TEXT in Supabase but may be stored as arrays locally.
 * During migration, arrays are joined with newlines to fit the TEXT column.
 * This prevents PostgREST 400 errors from type mismatches.
 */
const TEXT_COERCE_FIELDS = new Set([
  "action_protocol",
  "self_check_criteria",
  "why_this_matters",
]);

/**
 * Clean a record for Supabase insertion:
 * - Strip local-only fields
 * - Remove null values for non-nullable columns
 * - Only include fields that exist in the target table schema
 * - Coerce arrays to strings for TEXT columns
 * - Ensure id exists
 */
function cleanRecord(record: Record<string, unknown>, collection: string): Record<string, unknown> | null {
  if (!record.id) return null;

  const knownCols = KNOWN_COLUMNS[collection];
  const cleaned: Record<string, unknown> = {};
  const droppedFields: string[] = [];

  for (const [key, value] of Object.entries(record)) {
    if (STRIP_FIELDS.has(key)) continue;
    if (NULLABLE_STRIP.has(key) && (value === null || value === undefined)) continue;
    // Only include fields that exist in the target table
    if (knownCols && !knownCols.has(key)) {
      droppedFields.push(key);
      continue;
    }
    // Coerce arrays to strings for TEXT columns (schema says TEXT, code uses string[])
    if (TEXT_COERCE_FIELDS.has(key) && Array.isArray(value)) {
      cleaned[key] = value.join("\n");
      continue;
    }
    cleaned[key] = value;
  }

  if (droppedFields.length > 0) {
    console.error(`[migrate] Record ${String(record.id).substring(0, 8)}: dropped unknown fields: ${droppedFields.join(", ")}`);
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

  // Migration log file — captures all details for debugging
  const logLines: string[] = [];
  const logFile = path.join(dir, "migration.log");
  const mlog = (msg: string) => {
    const ts = new Date().toISOString();
    logLines.push(`[${ts}] ${msg}`);
  };
  mlog(`Migration started: ${supabaseUrl} (prefix: ${tablePrefix})`);

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

    if (records.length === 0) {
      mlog(`${collection}: no local data`);
      continue;
    }
    result.hasLocalData = true;
    mlog(`${collection}: ${records.length} records to migrate → ${tableName}`);

    log(`  Migrating ${records.length} ${collection}...`);

    for (const record of records) {
      const cleaned = cleanRecord(record, collection);
      if (!cleaned) {
        result.skipped[collection]++;
        const errMsg = `${String(record.id || "no-id").substring(0, 8)}: skipped (missing id)`;
        result.errors[collection].push(errMsg);
        mlog(`${collection} SKIP: ${errMsg}`);
        result.total++;
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
          mlog(`${collection} OK: ${String(cleaned.id).substring(0, 8)} (${cleaned.title || ""})`);
        } else {
          const text = await response.text();
          const errMsg = `${String(cleaned.id).substring(0, 8)}: ${response.status} - ${text.substring(0, 200)}`;
          result.errors[collection].push(errMsg);
          mlog(`${collection} FAIL: ${errMsg}`);
          mlog(`${collection} FAIL payload: ${JSON.stringify(Object.keys(cleaned))}`);
          result.skipped[collection]++;
        }
      } catch (err) {
        const errMsg = `${String(cleaned.id).substring(0, 8)}: ${err instanceof Error ? err.message : "Unknown error"}`;
        result.errors[collection].push(errMsg);
        mlog(`${collection} ERROR: ${errMsg}`);
        result.skipped[collection]++;
      }

      result.total++;
    }
  }

  // Write migration log to disk for debugging
  mlog(`Migration complete: migrated=${JSON.stringify(result.migrated)} skipped=${JSON.stringify(result.skipped)}`);
  try {
    fs.writeFileSync(logFile, logLines.join("\n") + "\n", "utf-8");
    log(`  Migration log: ${logFile}`);
  } catch {
    // Non-fatal — log file write failure shouldn't block migration
  }

  return result;
}

/**
 * Check if there are .pre-migration backup files that can be re-imported.
 * This handles the case where a previous migration partially failed —
 * the user runs `activate` again and we pick up from the backups.
 */
export function hasPreMigrationData(gitmemDir?: string): boolean {
  const dir = gitmemDir || getGitmemDir();
  for (const collection of MIGRATABLE_COLLECTIONS) {
    const backupPath = path.join(dir, `${collection}.json.pre-migration`);
    if (fs.existsSync(backupPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
        if (Array.isArray(data) && data.length > 0) return true;
      } catch {
        // Corrupt backup
      }
    }
  }
  return false;
}

/**
 * Re-import from .pre-migration backup files.
 * Same as migrateLocalToSupabase but reads from *.json.pre-migration files.
 * Idempotent: uses upsert (merge-duplicates) so re-running is safe.
 */
export async function reimportFromBackups(opts: {
  supabaseUrl: string;
  supabaseKey: string;
  tablePrefix?: string;
  gitmemDir?: string;
  onProgress?: (msg: string) => void;
}): Promise<MigrationResult> {
  const dir = opts.gitmemDir || getGitmemDir();

  // Temporarily restore .pre-migration files as .json for the migration function
  const restored: string[] = [];
  for (const collection of MIGRATABLE_COLLECTIONS) {
    const backupPath = path.join(dir, `${collection}.json.pre-migration`);
    const livePath = path.join(dir, `${collection}.json`);
    if (fs.existsSync(backupPath) && !fs.existsSync(livePath)) {
      // Copy (not move) backup to live path for migration
      fs.copyFileSync(backupPath, livePath);
      restored.push(collection);
    }
  }

  // Run migration
  const result = await migrateLocalToSupabase(opts);

  // Clean up: remove the restored copies (backups remain untouched)
  for (const collection of restored) {
    const livePath = path.join(dir, `${collection}.json`);
    try {
      fs.unlinkSync(livePath);
    } catch {
      // Non-fatal
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

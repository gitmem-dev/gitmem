#!/usr/bin/env npx tsx
/**
 * One-Time Thread Migration Script (OD-625)
 *
 * Migrates existing thread entries from local .gitmem/threads.json files
 * and Supabase session records into the new `orchestra_threads` table.
 *
 * Usage:
 *   npx tsx scripts/migrate-threads-to-supabase.ts --dry-run
 *   npx tsx scripts/migrate-threads-to-supabase.ts
 *
 * Sources:
 *   1. /workspace/.gitmem/threads.json
 *   2. /workspace/gitmem/.gitmem/threads.json
 *   3. /workspace/orchestra/.gitmem/threads.json
 *   4. orchestra_sessions table (open_threads JSONB from recent sessions)
 *
 * Steps:
 *   - Collect threads from all sources
 *   - Normalize mixed formats (strings, JSON-in-text, ThreadObjects)
 *   - Deduplicate by text similarity (case-insensitive exact + substring containment)
 *   - Classify as operational vs backlog
 *   - Map status: "open" -> "active", "resolved" -> "resolved"
 *   - Write backup to scripts/thread-migration-backup.json
 *   - Upsert to orchestra_threads (unless --dry-run)
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { normalizeThreads } from "../src/services/thread-manager.js";
import type { ThreadObject } from "../src/types/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");

const THREAD_FILE_PATHS = [
  "/workspace/.gitmem/threads.json",
  "/workspace/gitmem/.gitmem/threads.json",
  "/workspace/orchestra/.gitmem/threads.json",
];

const BACKUP_PATH = path.resolve(__dirname, "thread-migration-backup.json");
const TARGET_TABLE = "orchestra_threads";
const PROJECT = "orchestra_dev";

// Operational thread keywords (case-insensitive)
const OPERATIONAL_KEYWORDS = [
  "mcp restart",
  "uncommitted",
  "migration verify",
  "git commit",
  "git push",
  "needs restart",
  "needs git commit",
  "not committed",
  "verify _lite view",
];

// ---------------------------------------------------------------------------
// Supabase configuration (mirrors supabase-client.ts pattern)
// ---------------------------------------------------------------------------

function loadSupabaseConfig(): { url: string; key: string } {
  let url = process.env.SUPABASE_URL || "";
  let key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "";

  // Try mcp-config.json if env vars not set
  if (!url || !key) {
    const configPaths = [
      process.env.MCP_CONFIG_PATH,
      "/home/claude/mcp-config.json",
      "/home/node/mcp-config.json",
    ];
    for (const p of configPaths) {
      if (!p) continue;
      try {
        const raw = fs.readFileSync(p, "utf-8");
        const config = JSON.parse(raw);
        // Look for supabase/gitmem server env vars
        for (const serverName of Object.keys(config.mcpServers || {})) {
          const server = config.mcpServers[serverName];
          const env = server?.env || {};
          if (env.SUPABASE_URL && !url) url = env.SUPABASE_URL;
          if (env.SUPABASE_SERVICE_ROLE_KEY && !key) key = env.SUPABASE_SERVICE_ROLE_KEY;
        }
        if (url && key) break;
      } catch {
        // skip
      }
    }
  }

  return { url, key };
}

const supabaseConfig = loadSupabaseConfig();

async function supabaseUpsert(data: Record<string, unknown>): Promise<void> {
  if (!supabaseConfig.url || !supabaseConfig.key) {
    throw new Error(
      "Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  const restUrl = `${supabaseConfig.url}/rest/v1/${TARGET_TABLE}`;

  const response = await fetch(restUrl, {
    method: "POST",
    headers: {
      apikey: supabaseConfig.key,
      Authorization: `Bearer ${supabaseConfig.key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation,resolution=merge-duplicates",
      "Content-Profile": "public",
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase upsert error: ${response.status} - ${text.slice(0, 300)}`);
  }

  const result = (await response.json()) as unknown[];
  if (!result || result.length === 0) {
    throw new Error(
      `Supabase upsert returned empty result. Check RLS policies on ${TARGET_TABLE}.`
    );
  }
}

async function supabaseQuery<T>(
  table: string,
  options: {
    select?: string;
    filters?: Record<string, string>;
    order?: string;
    limit?: number;
  } = {}
): Promise<T[]> {
  if (!supabaseConfig.url || !supabaseConfig.key) {
    throw new Error("Supabase not configured");
  }

  const restUrl = `${supabaseConfig.url}/rest/v1/${table}`;
  const url = new URL(restUrl);

  url.searchParams.set("select", options.select || "*");

  if (options.filters) {
    for (const [key, value] of Object.entries(options.filters)) {
      const filterValue = value.includes(".") ? value : `eq.${value}`;
      url.searchParams.set(key, filterValue);
    }
  }

  if (options.order) {
    url.searchParams.set("order", options.order);
  }

  if (options.limit) {
    url.searchParams.set("limit", String(options.limit));
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      apikey: supabaseConfig.key,
      Authorization: `Bearer ${supabaseConfig.key}`,
      "Content-Type": "application/json",
      "Accept-Profile": "public",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase query error: ${response.status} - ${text.slice(0, 300)}`);
  }

  return response.json() as Promise<T[]>;
}

// ---------------------------------------------------------------------------
// Source: Local .gitmem/threads.json files
// ---------------------------------------------------------------------------

interface RawFileSource {
  path: string;
  threads: unknown[];
}

function collectFromFiles(): RawFileSource[] {
  const sources: RawFileSource[] = [];

  for (const filePath of THREAD_FILE_PATHS) {
    try {
      if (!fs.existsSync(filePath)) {
        console.log(`  [skip] ${filePath} — file not found`);
        continue;
      }
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (!Array.isArray(raw)) {
        console.log(`  [skip] ${filePath} — not an array`);
        continue;
      }
      console.log(`  [read] ${filePath} — ${raw.length} entries`);
      sources.push({ path: filePath, threads: raw });
    } catch (err) {
      console.log(
        `  [error] ${filePath} — ${err instanceof Error ? err.message : err}`
      );
    }
  }

  return sources;
}

// ---------------------------------------------------------------------------
// Source: Supabase sessions (open_threads JSONB)
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  session_date: string;
  open_threads: unknown[] | null;
}

async function collectFromSessions(): Promise<{
  sessions: SessionRow[];
  threads: ThreadObject[];
}> {
  try {
    const rows = await supabaseQuery<SessionRow>("orchestra_sessions", {
      select: "id,session_date,open_threads",
      filters: {
        open_threads: "not.is.null",
        project: "orchestra_dev",
      },
      order: "created_at.desc",
      limit: 20,
    });

    console.log(`  [supabase] Found ${rows.length} sessions with open_threads`);

    const allThreads: ThreadObject[] = [];
    for (const row of rows) {
      if (!row.open_threads || !Array.isArray(row.open_threads)) continue;
      const normalized = normalizeThreads(
        row.open_threads as (string | ThreadObject)[],
        row.id
      );
      allThreads.push(...normalized);
    }

    console.log(
      `  [supabase] Extracted ${allThreads.length} thread entries from sessions`
    );
    return { sessions: rows, threads: allThreads };
  } catch (err) {
    console.log(
      `  [supabase-error] ${err instanceof Error ? err.message : err}`
    );
    return { sessions: [], threads: [] };
  }
}

// ---------------------------------------------------------------------------
// Normalize & Flatten
// ---------------------------------------------------------------------------

function flattenFileSources(sources: RawFileSource[]): ThreadObject[] {
  const all: ThreadObject[] = [];
  for (const source of sources) {
    const normalized = normalizeThreads(
      source.threads as (string | ThreadObject)[],
      undefined
    );
    all.push(...normalized);
  }
  return all;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

interface DeduplicatedThread {
  /** The canonical thread chosen to represent this concept */
  canonical: ThreadObject;
  /** All raw thread entries that mapped to this concept */
  duplicates: ThreadObject[];
}

function cleanText(t: ThreadObject): string {
  let text = t.text;

  // If text is a JSON string wrapping another thread, extract the inner text/note
  if (text.startsWith("{")) {
    try {
      const inner = JSON.parse(text);
      text = inner.text || inner.note || inner.item || text;
    } catch {
      // not JSON, use as-is
    }
  }

  return text.toLowerCase().trim();
}

/**
 * Extract the "original" thread ID from a thread entry.
 * Some entries have JSON text wrapping another thread ID: {"id":"t-05a7ecb6","status":"open","note":"..."}
 * For those, the original ID is the inner id, not the outer wrapper id.
 */
function extractOriginalId(t: ThreadObject): string {
  if (t.text.startsWith("{")) {
    try {
      const inner = JSON.parse(t.text);
      if (inner.id && typeof inner.id === "string" && inner.id.startsWith("t-")) {
        return inner.id;
      }
    } catch {
      // not JSON
    }
  }
  return t.id;
}

/**
 * Normalize text for fuzzy comparison:
 * - Lowercase and trim
 * - Remove numbers that vary (e.g., "30+" vs "28+")
 * - Remove common filler words
 */
function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .trim()
    // Remove varying numbers like "28+", "30+", "31"
    .replace(/\d+\+?/g, "N")
    // Collapse whitespace
    .replace(/\s+/g, " ");
}

function deduplicateThreads(threads: ThreadObject[]): DeduplicatedThread[] {
  // Union-Find structure for grouping threads
  const parent = new Map<number, number>();
  const rank = new Map<number, number>();

  function find(i: number): number {
    if (!parent.has(i)) { parent.set(i, i); rank.set(i, 0); }
    if (parent.get(i) !== i) parent.set(i, find(parent.get(i)!));
    return parent.get(i)!;
  }

  function union(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    const rankA = rank.get(ra) || 0;
    const rankB = rank.get(rb) || 0;
    if (rankA < rankB) { parent.set(ra, rb); }
    else if (rankA > rankB) { parent.set(rb, ra); }
    else { parent.set(rb, ra); rank.set(ra, rankA + 1); }
  }

  // Pre-compute cleaned text and original IDs for each thread
  const cleaned: string[] = threads.map(cleanText);
  const originalIds: string[] = threads.map(extractOriginalId);
  const normalized: string[] = cleaned.map(normalizeForComparison);

  // Phase 1: Group by same original thread ID
  const idIndex = new Map<string, number[]>();
  for (let i = 0; i < threads.length; i++) {
    const oid = originalIds[i];
    const list = idIndex.get(oid) || [];
    list.push(i);
    idIndex.set(oid, list);
  }
  for (const [, indices] of idIndex) {
    for (let j = 1; j < indices.length; j++) {
      union(indices[0], indices[j]);
    }
  }

  // Phase 2: Group by exact cleaned text
  const textIndex = new Map<string, number[]>();
  for (let i = 0; i < threads.length; i++) {
    const key = cleaned[i];
    if (!key) continue;
    const list = textIndex.get(key) || [];
    list.push(i);
    textIndex.set(key, list);
  }
  for (const [, indices] of textIndex) {
    for (let j = 1; j < indices.length; j++) {
      union(indices[0], indices[j]);
    }
  }

  // Phase 3: Group by substring containment (long text contains short text)
  const sortedByLength = Array.from({ length: threads.length }, (_, i) => i)
    .sort((a, b) => cleaned[b].length - cleaned[a].length);

  for (let i = 0; i < sortedByLength.length; i++) {
    const longIdx = sortedByLength[i];
    const longText = cleaned[longIdx];
    if (!longText) continue;

    for (let j = i + 1; j < sortedByLength.length; j++) {
      const shortIdx = sortedByLength[j];
      const shortText = cleaned[shortIdx];
      if (!shortText || shortText.length < 10) continue; // Skip very short texts

      if (longText.includes(shortText)) {
        union(longIdx, shortIdx);
      }
    }
  }

  // Phase 4: Group by normalized text (catches "30+" vs "28+" variations)
  const normIndex = new Map<string, number[]>();
  for (let i = 0; i < threads.length; i++) {
    const key = normalized[i];
    if (!key) continue;
    const list = normIndex.get(key) || [];
    list.push(i);
    normIndex.set(key, list);
  }
  for (const [, indices] of normIndex) {
    for (let j = 1; j < indices.length; j++) {
      union(indices[0], indices[j]);
    }
  }

  // Collect groups
  const groups = new Map<number, number[]>();
  for (let i = 0; i < threads.length; i++) {
    const root = find(i);
    const list = groups.get(root) || [];
    list.push(i);
    groups.set(root, list);
  }

  // Pick canonical from each group
  const results: DeduplicatedThread[] = [];

  for (const [, indices] of groups) {
    const group = indices.map((i) => threads[i]);

    // Sort: prefer resolved (to carry resolution data),
    // then by created_at ascending (oldest first),
    // then by text length descending (most descriptive)
    const sorted = [...group].sort((a, b) => {
      // Prefer resolved
      if (a.status === "resolved" && b.status !== "resolved") return -1;
      if (b.status === "resolved" && a.status !== "resolved") return 1;

      // Prefer oldest created_at
      const aDate = a.created_at || "9999";
      const bDate = b.created_at || "9999";
      if (aDate !== bDate) return aDate.localeCompare(bDate);

      // Prefer longest (most descriptive) clean text
      return cleanText(b).length - cleanText(a).length;
    });

    const canonical = { ...sorted[0] };

    // If canonical text is a JSON wrapper, unwrap it for the final record
    if (canonical.text.startsWith("{")) {
      try {
        const inner = JSON.parse(canonical.text);
        canonical.text = inner.text || inner.note || inner.item || canonical.text;
      } catch {
        // keep as-is
      }
    }

    // Use the original thread ID (not the wrapper ID) as the canonical ID
    const bestOriginalId = extractOriginalId(sorted[0]);
    canonical.id = bestOriginalId;

    // Merge resolution data from any resolved duplicate
    for (const dup of group) {
      if (dup.status === "resolved" && !canonical.resolved_at && dup.resolved_at) {
        canonical.status = "resolved";
        canonical.resolved_at = dup.resolved_at;
        canonical.resolution_note = dup.resolution_note || canonical.resolution_note;
        canonical.resolved_by_session = dup.resolved_by_session || canonical.resolved_by_session;
      }
      // Use earliest created_at
      if (dup.created_at && (!canonical.created_at || dup.created_at < canonical.created_at)) {
        canonical.created_at = dup.created_at;
      }
      // Use earliest source_session
      if (dup.source_session && !canonical.source_session) {
        canonical.source_session = dup.source_session;
      }
    }

    results.push({
      canonical,
      duplicates: group,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classifyThread(text: string): "operational" | "backlog" {
  const lower = text.toLowerCase();
  for (const keyword of OPERATIONAL_KEYWORDS) {
    if (lower.includes(keyword)) return "operational";
  }
  return "backlog";
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

function mapStatus(localStatus: string): "active" | "resolved" {
  if (localStatus === "resolved") return "resolved";
  return "active";
}

// ---------------------------------------------------------------------------
// Build Supabase row
// ---------------------------------------------------------------------------

interface OrchestraThreadRow {
  thread_id: string;
  text: string;
  status: string;
  thread_class: string;
  vitality_score: number;
  last_touched_at: string;
  touch_count: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  source_session: string | null;
  resolved_by_session: string | null;
  related_issues: string[];
  domain: string[];
  project: string;
  metadata: Record<string, unknown>;
}

function extractIssueReferences(text: string): string[] {
  const matches = text.match(/(?:OD|GIT|WW)-\d+/g);
  return matches ? [...new Set(matches)] : [];
}

function extractDomain(text: string): string[] {
  const domains: string[] = [];
  const lower = text.toLowerCase();

  if (lower.includes("gitmem") || lower.includes("git-")) domains.push("gitmem");
  if (lower.includes("coda") || lower.includes("agent")) domains.push("agents");
  if (lower.includes("migration") || lower.includes("supabase")) domains.push("infrastructure");
  if (lower.includes("enforcement") || lower.includes("roadmap")) domains.push("enforcement");
  if (lower.includes("doc-debt") || lower.includes("docs")) domains.push("documentation");
  if (lower.includes("session") || lower.includes("thread")) domains.push("session-lifecycle");
  if (lower.includes("linear") || lower.includes("mcp")) domains.push("integrations");
  if (lower.includes("npm") || lower.includes("publish") || lower.includes("release")) domains.push("release");

  return domains.length > 0 ? domains : ["general"];
}

function isValidUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function buildRow(deduped: DeduplicatedThread): OrchestraThreadRow {
  const { canonical, duplicates } = deduped;
  const now = new Date().toISOString();

  return {
    thread_id: canonical.id,
    text: canonical.text,
    status: mapStatus(canonical.status),
    thread_class: classifyThread(canonical.text),
    vitality_score: canonical.status === "resolved" ? 0.0 : 1.0,
    last_touched_at: canonical.resolved_at || canonical.created_at || now,
    touch_count: duplicates.length,
    created_at: canonical.created_at || now,
    updated_at: now,
    resolved_at: canonical.resolved_at || null,
    resolution_note: canonical.resolution_note || null,
    source_session:
      canonical.source_session && isValidUuid(canonical.source_session)
        ? canonical.source_session
        : null,
    resolved_by_session:
      canonical.resolved_by_session && isValidUuid(canonical.resolved_by_session)
        ? canonical.resolved_by_session
        : null,
    related_issues: extractIssueReferences(canonical.text),
    domain: extractDomain(canonical.text),
    project: PROJECT,
    metadata: {
      migration_source: "OD-625",
      migration_date: now,
      duplicate_count: duplicates.length,
      original_ids: duplicates.map((d) => d.id),
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Thread Migration to Supabase (OD-625) ===");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(
    `Supabase: ${supabaseConfig.url ? "configured" : "NOT configured"}`
  );
  console.log("");

  // Step 1: Collect from files
  console.log("--- Step 1: Collecting from local files ---");
  const fileSources = collectFromFiles();
  const fileThreads = flattenFileSources(fileSources);
  console.log(`  Total from files: ${fileThreads.length} entries`);
  console.log("");

  // Step 2: Collect from Supabase sessions
  console.log("--- Step 2: Collecting from Supabase sessions ---");
  let sessionResult: { sessions: SessionRow[]; threads: ThreadObject[] };
  if (supabaseConfig.url && supabaseConfig.key) {
    sessionResult = await collectFromSessions();
  } else {
    console.log("  [skip] Supabase not configured, skipping session source");
    sessionResult = { sessions: [], threads: [] };
  }
  console.log("");

  // Step 3: Combine all sources
  const allRawThreads = [...fileThreads, ...sessionResult.threads];
  const sourceCount =
    fileSources.length + (sessionResult.sessions.length > 0 ? 1 : 0);
  console.log(
    `Found ${allRawThreads.length} raw threads across ${sourceCount} sources`
  );
  console.log("");

  // Step 4: Save backup BEFORE any dedup/writes
  console.log("--- Step 3: Saving backup ---");
  const backup = {
    migration_date: new Date().toISOString(),
    issue: "OD-625",
    file_sources: fileSources.map((s) => ({
      path: s.path,
      count: s.threads.length,
      threads: s.threads,
    })),
    session_threads: sessionResult.threads,
    session_count: sessionResult.sessions.length,
    total_raw: allRawThreads.length,
  };
  fs.writeFileSync(BACKUP_PATH, JSON.stringify(backup, null, 2));
  console.log(`  Backup saved to: ${BACKUP_PATH}`);
  console.log("");

  // Step 5: Deduplicate
  console.log("--- Step 4: Deduplicating ---");
  const deduplicated = deduplicateThreads(allRawThreads);

  const operationalCount = deduplicated.filter(
    (d) => classifyThread(d.canonical.text) === "operational"
  ).length;
  const backlogCount = deduplicated.length - operationalCount;
  const activeCount = deduplicated.filter(
    (d) => mapStatus(d.canonical.status) === "active"
  ).length;
  const resolvedCount = deduplicated.length - activeCount;

  console.log(
    `Deduplicated to ${deduplicated.length} unique threads (${operationalCount} operational, ${backlogCount} backlog)`
  );
  console.log(`  Status: ${activeCount} active, ${resolvedCount} resolved`);
  console.log("");

  // Step 6: Build rows
  const rows = deduplicated.map(buildRow);

  // Step 7: Display or upsert
  if (DRY_RUN) {
    console.log("--- DRY RUN: Threads that would be created ---");
    console.log("");
    for (const row of rows) {
      console.log(`  [${row.status}] [${row.thread_class}] ${row.thread_id}`);
      console.log(`    text: ${row.text}`);
      console.log(`    created_at: ${row.created_at}`);
      console.log(`    touch_count: ${row.touch_count}`);
      console.log(`    issues: ${row.related_issues.join(", ") || "(none)"}`);
      console.log(`    domain: ${row.domain.join(", ")}`);
      if (row.resolved_at) {
        console.log(`    resolved_at: ${row.resolved_at}`);
        console.log(`    resolution_note: ${row.resolution_note || "(none)"}`);
      }
      console.log("");
    }
    console.log(`=== DRY RUN COMPLETE: ${rows.length} threads would be created ===`);
  } else {
    console.log("--- Step 5: Upserting to Supabase ---");
    let successCount = 0;
    let failCount = 0;

    for (const row of rows) {
      try {
        await supabaseUpsert(row);
        successCount++;
        console.log(`  [ok] ${row.thread_id}: ${row.text.slice(0, 60)}...`);
      } catch (err) {
        failCount++;
        console.log(
          `  [FAIL] ${row.thread_id}: ${err instanceof Error ? err.message : err}`
        );
      }
    }

    console.log("");
    console.log(
      `=== MIGRATION COMPLETE: ${successCount} created, ${failCount} failed ===`
    );
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

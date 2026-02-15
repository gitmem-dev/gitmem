/**
 * Supabase MCP Client
 *
 * HTTP client for ww-mcp Edge Function following the pattern from
 * agents/coda/src/services/supabase-mcp.js
 *
 * Uses JSON-RPC 2.0 protocol over HTTPS.
 * Integrates with CacheService for performance (OD-473).
 */

import type {
  Project,
  SupabaseListOptions,
  SupabaseSearchOptions,
} from "../types/index.js";
import { getCache } from "./cache.js";

// Configuration from environment
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "";

// Direct REST API base URL
const SUPABASE_REST_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1` : "";

/**
 * Check if Supabase is configured
 */
export function isConfigured(): boolean {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

/**
 * Get the ww-mcp Edge Function URL
 */
function getMcpUrl(): string {
  return `${SUPABASE_URL}/functions/v1/ww-mcp`;
}

/**
 * Call the ww-mcp Edge Function
 */
async function callMcp<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
  if (!isConfigured()) {
    throw new Error("Supabase not configured - check SUPABASE_URL and SUPABASE_KEY/SUPABASE_SERVICE_ROLE_KEY");
  }

  const mcpUrl = getMcpUrl();

  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${toolName}-${Date.now()}`,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MCP HTTP error: ${response.status} - ${text.slice(0, 200)}`);
  }

  const result = await response.json() as {
    error?: { message: string };
    result?: {
      content?: Array<{ text: string }>;
    };
  };

  if (result.error) {
    throw new Error(`MCP error: ${JSON.stringify(result.error)}`);
  }

  // Parse the result content
  if (result.result?.content?.[0]?.text) {
    return JSON.parse(result.result.content[0].text) as T;
  }

  return result.result as T;
}

/**
 * List records from a table with optional filters
 */
export async function listRecords<T = unknown>(
  options: SupabaseListOptions
): Promise<T[]> {
  const { table, columns, filters, limit = 50, orderBy } = options;

  const args: Record<string, unknown> = {
    table,
    limit,
  };

  if (columns) {
    args.columns = columns;
  }

  if (filters) {
    args.filters = filters;
  }

  if (orderBy) {
    args.orderBy = orderBy;
  }

  const result = await callMcp<{ data: T[] }>("list_records", args);
  return result.data || [];
}

/**
 * Get a single record by ID
 */
export async function getRecord<T = unknown>(
  table: string,
  id: string
): Promise<T | null> {
  const result = await callMcp<{ data: T }>("get_record", { table, id });
  return result.data || null;
}

/**
 * Upsert (insert or update) a record
 */
export async function upsertRecord<T = unknown>(
  table: string,
  data: Record<string, unknown>
): Promise<T> {
  const result = await callMcp<{ data: T; record?: T }>("upsert_record", {
    table,
    data,
  });

  // ww-mcp returns { data: record, operation: 'insert'|'update', embedding_generated: bool }
  return result.data || (result as unknown as T);
}

/**
 * Semantic search across tables
 */
export async function semanticSearch<T = unknown>(
  options: SupabaseSearchOptions
): Promise<T[]> {
  const { query, tables, match_count = 10, project } = options;

  const args: Record<string, unknown> = {
    query,
    match_count,
  };

  if (tables && tables.length > 0) {
    args.tables = tables;
  }

  if (project) {
    args.project = project;
  }

  const result = await callMcp<{ results: T[] }>("semantic_search", args);
  return result.results || [];
}

// ============================================================================
// DIRECT SUPABASE QUERIES (bypass ww-mcp for bulk operations)
// ============================================================================

/**
 * Query Supabase REST API directly (bypasses ww-mcp)
 *
 * Used for bulk operations like loading all scars with embeddings.
 * ww-mcp doesn't return embeddings by default to avoid bloated responses,
 * but for local vector search we need them.
 */
export async function directQuery<T = unknown>(
  table: string,
  options: {
    select?: string;
    filters?: Record<string, string>;
    order?: string;
    limit?: number;
  } = {}
): Promise<T[]> {
  if (!isConfigured()) {
    throw new Error("Supabase not configured");
  }

  const { select = "*", filters = {}, order, limit } = options;

  // Build query URL
  const url = new URL(`${SUPABASE_REST_URL}/${table}`);
  url.searchParams.set("select", select);

  // Add filters (PostgREST syntax)
  // If value already contains an operator (e.g., "in.(...)"), use as-is
  // Otherwise, prefix with "eq." for equality
  for (const [key, value] of Object.entries(filters)) {
    const filterValue = value.includes('.') ? value : `eq.${value}`;
    url.searchParams.set(key, filterValue);
  }

  // Add ordering
  if (order) {
    url.searchParams.set("order", order);
  }

  // Add limit
  if (limit) {
    url.searchParams.set("limit", String(limit));
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
      "Accept-Profile": "public",  // Required: explicitly use public schema
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase REST error: ${response.status} - ${text.slice(0, 200)}`);
  }

  return response.json() as Promise<T[]>;
}

/**
 * Paginated fetch — retrieves ALL matching rows using PostgREST Range headers.
 * Use instead of directQuery when the result set may exceed a single page.
 *
 * @param pageSize  Rows per request (default 1000)
 * @param maxRows   Safety cap to prevent runaway queries (default 10000)
 */
export async function directQueryAll<T = unknown>(
  table: string,
  options: {
    select?: string;
    filters?: Record<string, string>;
    order?: string;
  } = {},
  pageSize: number = 1000,
  maxRows: number = 10000
): Promise<T[]> {
  if (!isConfigured()) {
    throw new Error("Supabase not configured");
  }

  const { select = "*", filters = {}, order } = options;
  const allRows: T[] = [];
  let offset = 0;

  while (offset < maxRows) {
    const url = new URL(`${SUPABASE_REST_URL}/${table}`);
    url.searchParams.set("select", select);

    for (const [key, value] of Object.entries(filters)) {
      const filterValue = value.includes('.') ? value : `eq.${value}`;
      url.searchParams.set(key, filterValue);
    }

    if (order) {
      url.searchParams.set("order", order);
    }

    const rangeEnd = offset + pageSize - 1;

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        "Range": `${offset}-${rangeEnd}`,
        "Range-Unit": "items",
        "Prefer": "count=exact",
        "Accept-Profile": "public",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Supabase REST error: ${response.status} - ${text.slice(0, 200)}`);
    }

    const rows = await response.json() as T[];
    allRows.push(...rows);

    // Check Content-Range header: "0-999/1234" or "*/0" for empty
    const contentRange = response.headers.get("content-range");
    if (!contentRange || rows.length < pageSize) {
      break; // No more rows or last page
    }

    const match = contentRange.match(/\/(\d+)/);
    if (match) {
      const total = parseInt(match[1]);
      if (offset + pageSize >= total) break;
    }

    offset += pageSize;
  }

  return allRows;
}

/**
 * Knowledge triple from knowledge_triples table (OD-466)
 */
export interface KnowledgeTriple {
  subject: string;
  predicate: string;
  object: string;
  event_time: string;
  decay_weight: number;
  half_life_days: number;
  decay_floor: number;
  source_id: string;
}

/**
 * Fetch related knowledge triples for a set of scar IDs (OD-466)
 *
 * Queries knowledge_triples table where source_id matches any of the provided scar IDs.
 * Returns triples grouped by source_id for easy attachment to scars.
 */
export async function fetchRelatedTriples(
  scarIds: string[]
): Promise<Map<string, KnowledgeTriple[]>> {
  const result = new Map<string, KnowledgeTriple[]>();

  if (scarIds.length === 0 || !isConfigured()) {
    return result;
  }

  try {
    const triples = await directQuery<KnowledgeTriple>("knowledge_triples", {
      select: "subject,predicate,object,event_time,decay_weight,half_life_days,decay_floor,source_id",
      filters: {
        source_id: `in.(${scarIds.join(",")})`,
      },
    });

    for (const triple of triples) {
      const existing = result.get(triple.source_id) || [];
      existing.push(triple);
      result.set(triple.source_id, existing);
    }
  } catch (error) {
    console.error("[fetchRelatedTriples] Failed:", error instanceof Error ? error.message : error);
  }

  return result;
}

/**
 * Upsert a record directly to Supabase REST API (bypasses ww-mcp)
 *
 * Used for tests where ww-mcp authentication is problematic.
 * Uses Supabase REST API's upsert capability with Prefer: resolution=merge-duplicates.
 */
export async function directUpsert<T = unknown>(
  table: string,
  data: Record<string, unknown>
): Promise<T> {
  if (!isConfigured()) {
    throw new Error("Supabase not configured");
  }

  const url = `${SUPABASE_REST_URL}/${table}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation,resolution=merge-duplicates",
      "Content-Profile": "public",  // Schema for write operations
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase upsert error: ${response.status} - ${text.slice(0, 200)}`);
  }

  const result = await response.json() as T[];

  // OD-539: Validate that write actually happened
  // Supabase can return 200 OK with empty array [] when:
  // - RLS policy blocks the write
  // - Constraint violation handled gracefully
  // - Database trigger cancels the insert
  // - Schema mismatch
  if (!result || result.length === 0) {
    throw new Error(
      `Supabase upsert returned empty result for table '${table}'. ` +
      `This usually means the write was silently blocked. ` +
      `Check: (1) RLS policies on ${table}, (2) NOT NULL constraints, (3) database triggers, (4) correct schema`
    );
  }

  return result[0] as T;
}

/**
 * Patch (partial update) existing records in Supabase REST API.
 *
 * Uses HTTP PATCH for true partial updates — only the provided fields are
 * modified.  Unlike directUpsert (POST + merge-duplicates), this does NOT
 * try to INSERT first, so NOT NULL columns that aren't changing can be
 * omitted from `data`.
 *
 * @param table   Target table name
 * @param filters PostgREST filter to identify the row(s) to update
 * @param data    Fields to update (partial — omitted columns stay unchanged)
 */
export async function directPatch<T = unknown>(
  table: string,
  filters: Record<string, string>,
  data: Record<string, unknown>
): Promise<T[]> {
  if (!isConfigured()) {
    throw new Error("Supabase not configured");
  }

  const url = new URL(`${SUPABASE_REST_URL}/${table}`);

  // Apply filters (same logic as directQuery)
  for (const [key, value] of Object.entries(filters)) {
    const filterValue = value.includes(".") ? value : `eq.${value}`;
    url.searchParams.set(key, filterValue);
  }

  const response = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
      "Content-Profile": "public",
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase patch error: ${response.status} - ${text.slice(0, 200)}`);
  }

  return response.json() as Promise<T[]>;
}

/**
 * Load all learnings with embeddings directly from Supabase
 *
 * This bypasses ww-mcp because we need the embedding vectors for local search.
 * Returns learnings (scars, patterns, wins, anti-patterns) with full embedding data.
 *
 * NOTE: Changed from "scars only" to "all learning types" (OD-542 related fix)
 */
export async function loadScarsWithEmbeddings<T = unknown>(
  project?: string,
  limit = 500
): Promise<T[]> {
  console.error(`[supabase-direct] Loading learnings with embeddings${project ? ` for project: ${project}` : " (all projects)"}`);
  const startTime = Date.now();

  try {
    const filters: Record<string, string> = {
      learning_type: "in.(scar,pattern,win,anti_pattern)",
      is_active: "eq.true",
    };
    if (project) {
      filters.project = project;
    }

    const learnings = await directQuery<T>("orchestra_learnings", {
      select: "id,title,description,severity,counter_arguments,applies_when,source_linear_issue,project,embedding,updated_at,learning_type",
      filters,
      order: "updated_at.desc",
      limit,
    });

    const elapsed = Date.now() - startTime;
    console.error(`[supabase-direct] Loaded ${learnings.length} learnings in ${elapsed}ms`);

    return learnings;
  } catch (error) {
    console.error("[supabase-direct] Failed to load learnings:", error);
    throw error;
  }
}

/**
 * Scar search with severity weighting
 */
export async function scarSearch<T = unknown>(
  query: string,
  matchCount = 5,
  project?: Project
): Promise<T[]> {
  const args: Record<string, unknown> = {
    query,
    match_count: matchCount,
  };

  if (project) {
    args.project = project;
  }

  const result = await callMcp<{ results: T[] }>("scar_search", args);
  return result.results || [];
}

/**
 * Scar search with caching (OD-473)
 *
 * Returns cached results if available, otherwise fetches and caches.
 */
export async function cachedScarSearch<T = unknown>(
  query: string,
  matchCount = 5,
  project: Project = "default"
): Promise<{ results: T[]; cache_hit: boolean; cache_age_ms?: number }> {
  const cache = getCache();

  const { data, cache_hit, cache_age_ms } = await cache.getOrFetchScarSearch<T[]>(
    query,
    project,
    matchCount,
    async () => scarSearch<T>(query, matchCount, project)
  );

  return { results: data, cache_hit, cache_age_ms };
}

/**
 * List records with caching for decisions (OD-473)
 */
export async function cachedListDecisions<T = unknown>(
  project: Project = "default",
  limit = 5
): Promise<{ data: T[]; cache_hit: boolean; cache_age_ms?: number }> {
  const cache = getCache();

  const { data, cache_hit, cache_age_ms } = await cache.getOrFetchDecisions<T[]>(
    project,
    limit,
    async () =>
      listRecords<T>({
        table: "orchestra_decisions_lite",
        limit,
        orderBy: { column: "created_at", ascending: false },
      })
  );

  return { data, cache_hit, cache_age_ms };
}

/**
 * List records with caching for wins
 */
export async function cachedListWins<T = unknown>(
  project: Project = "default",
  limit = 8,
  columns?: string
): Promise<{ data: T[]; cache_hit: boolean; cache_age_ms?: number }> {
  const cache = getCache();

  const { data, cache_hit, cache_age_ms } = await cache.getOrFetchWins<T[]>(
    project,
    limit,
    async () =>
      listRecords<T>({
        table: "orchestra_learnings_lite",
        columns,
        filters: {
          learning_type: "win",
          project,
        },
        limit,
        orderBy: { column: "created_at", ascending: false },
      })
  );

  return { data, cache_hit, cache_age_ms };
}

// ============================================================================
// STORAGE API (for transcript persistence - OD-467)
// ============================================================================

const TRANSCRIPT_BUCKET = "session-transcripts";

/**
 * Upload a file to Supabase Storage
 */
export async function uploadFile(
  bucket: string,
  path: string,
  content: string | Buffer,
  contentType = "application/json"
): Promise<{ path: string }> {
  if (!isConfigured()) {
    throw new Error("Supabase not configured");
  }

  const storageUrl = `${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`;

  const response = await fetch(storageUrl, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: content,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Storage upload error: ${response.status} - ${text.slice(0, 200)}`);
  }

  return { path: `${bucket}/${path}` };
}

/**
 * Download a file from Supabase Storage
 */
export async function downloadFile(
  bucket: string,
  path: string
): Promise<string> {
  if (!isConfigured()) {
    throw new Error("Supabase not configured");
  }

  const storageUrl = `${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`;

  const response = await fetch(storageUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Storage download error: ${response.status} - ${text.slice(0, 200)}`);
  }

  return response.text();
}

/**
 * Save a session transcript to storage
 */
export async function saveTranscript(
  sessionId: string,
  transcript: string,
  metadata: {
    project?: string;
    agent?: string;
    format?: "json" | "markdown";
  } = {}
): Promise<{ transcript_path: string; size_bytes: number; patch_warning?: string }> {
  const { project = "default", agent = "unknown", format = "json" } = metadata;
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const extension = format === "markdown" ? "md" : "json";
  const path = `${project}/${agent}/${date}/${sessionId}.${extension}`;

  const contentType = format === "markdown" ? "text/markdown" : "application/json";
  const content = format === "json" ? transcript : transcript;

  await uploadFile(TRANSCRIPT_BUCKET, path, content, contentType);

  // Update the session record with transcript_path (direct REST API)
  let patch_warning: string | undefined;
  try {
    await directPatch("orchestra_sessions",
      { id: sessionId },
      { transcript_path: path }
    );
  } catch (error) {
    // File is saved; session record update failed — warn, don't fail
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Failed to update session with transcript_path:", msg);
    patch_warning = `Session record not updated with transcript_path: ${msg}`;
  }

  return {
    transcript_path: path,
    size_bytes: Buffer.byteLength(content, "utf8"),
    patch_warning,
  };
}

/**
 * Retrieve a session transcript from storage
 */
export async function getTranscript(
  sessionId: string
): Promise<{ transcript: string; path: string } | null> {
  // First, get the session to find transcript_path
  const session = await getRecord<{ transcript_path?: string }>(
    "orchestra_sessions",
    sessionId
  );

  if (!session?.transcript_path) {
    return null;
  }

  // Download the transcript
  const transcript = await downloadFile(TRANSCRIPT_BUCKET, session.transcript_path);

  return {
    transcript,
    path: session.transcript_path,
  };
}

/**
 * Thread Supabase Service
 *
 * Provides Supabase CRUD operations for the threads table.
 * Supabase is the source of truth; local .gitmem/threads.json is a cache.
 *
 * Uses directQuery/directUpsert (PostgREST) like other Supabase operations
 * in this codebase. Graceful fallback: if Supabase is unreachable, callers
 * fall back to local file operations.
 */

import * as supabase from "./supabase-client.js";
import { hasSupabase, getTableName } from "./tier.js";
import { computeVitality, computeLifecycleStatus, detectThreadClass } from "./thread-vitality.js";
import type { ThreadClass, LifecycleStatus } from "./thread-vitality.js";
import { normalizeText, deduplicateThreadList } from "./thread-dedup.js";
import type { ThreadWithEmbedding } from "./thread-dedup.js";
import type { ThreadObject, Project } from "../types/index.js";

// ---------- Supabase Row Types ----------

/** Shape of a row in threads / threads_lite */
export interface ThreadRow {
  id: string;           // UUID primary key
  thread_id: string;    // "t-XXXXXXXX"
  text: string;
  status: string;       // emerging|active|cooling|dormant|archived|resolved
  thread_class: string; // operational|backlog
  vitality_score: number;
  last_touched_at: string;
  touch_count: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  source_session: string | null;   // UUID
  resolved_by_session: string | null; // UUID
  related_issues: string[] | null;
  domain: string[] | null;
  project: string;
  metadata: Record<string, unknown>;
}

/** Display-enriched thread info for session_start (Phase 6) */
export interface ThreadDisplayInfo {
  thread: ThreadObject;
  vitality_score: number;
  lifecycle_status: LifecycleStatus;
  thread_class: string;
  days_since_touch: number;
}

// ---------- Mapping Helpers ----------

/**
 * Map a local ThreadObject to a Supabase row for insert/upsert.
 */
export function threadObjectToRow(
  thread: ThreadObject,
  project: Project = "default",
  embedding?: string | null
): Record<string, unknown> {
  const now = new Date();
  const createdAt = thread.created_at || now.toISOString();
  const threadClass: ThreadClass = detectThreadClass(thread.text);

  // Phase 6: Use lifecycle status for new threads (will be "emerging" if < 24h old)
  const { lifecycle_status, vitality } = computeLifecycleStatus({
    last_touched_at: createdAt,
    touch_count: 1,
    created_at: createdAt,
    thread_class: threadClass,
    current_status: mapStatusToSupabase(thread.status),
  }, now);

  return {
    thread_id: thread.id,              // "t-XXXXXXXX" -> thread_id column
    text: thread.text,
    status: thread.status === "resolved" ? "resolved" : lifecycle_status,
    thread_class: threadClass,
    vitality_score: vitality.vitality_score,
    last_touched_at: createdAt,
    touch_count: 1,
    created_at: createdAt,
    resolved_at: thread.resolved_at || null,
    resolution_note: thread.resolution_note || null,
    source_session: thread.source_session || null,
    resolved_by_session: thread.resolved_by_session || null,
    project,
    metadata: {},
    ...(embedding != null && { embedding }),
  };
}

/**
 * Map a Supabase row to a local ThreadObject.
 */
export function rowToThreadObject(row: ThreadRow): ThreadObject {
  // Strip stale thread ID prefixes baked into text (e.g., "t-489d9c6c: actual text")
  const text = row.text.replace(/^t-[a-f0-9]+:\s*/i, "");
  return {
    id: row.thread_id,                 // thread_id column -> ThreadObject.id
    text,
    status: mapStatusFromSupabase(row.status),
    created_at: row.created_at,
    ...(row.last_touched_at && { last_touched_at: row.last_touched_at }),
    ...(row.resolved_at && { resolved_at: row.resolved_at }),
    ...(row.source_session && { source_session: row.source_session }),
    ...(row.resolved_by_session && { resolved_by_session: row.resolved_by_session }),
    ...(row.resolution_note && { resolution_note: row.resolution_note }),
  };
}

/**
 * Map local ThreadObject status ("open"|"resolved") to Supabase status.
 * Phase 1: "open" -> "active", "resolved" -> "resolved"
 */
function mapStatusToSupabase(status: string): string {
  if (status === "open") return "active";
  if (status === "resolved") return "resolved";
  // Pass through any Supabase-native statuses
  return status;
}

/**
 * Map Supabase status to local ThreadObject status.
 * Phase 1: Any non-resolved status -> "open"
 */
function mapStatusFromSupabase(status: string): "open" | "resolved" {
  if (status === "resolved") return "resolved";
  return "open";  // emerging, active, cooling, dormant, archived -> "open" for backward compat
}

// ---------- CRUD Operations ----------

/**
 * Create a thread in Supabase.
 * Returns the created row or null if Supabase is unavailable.
 */
export async function createThreadInSupabase(
  thread: ThreadObject,
  project: Project = "default",
  embedding?: string | null
): Promise<ThreadRow | null> {
  if (!hasSupabase() || !supabase.isConfigured()) {
    return null;
  }

  try {
    const row = threadObjectToRow(thread, project, embedding);
    const result = await supabase.directUpsert<ThreadRow>(
      getTableName("threads"),
      row
    );
    console.error(`[thread-supabase] Created thread ${thread.id} in Supabase`);
    return result;
  } catch (error) {
    console.error("[thread-supabase] Failed to create thread:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Resolve a thread in Supabase by thread_id.
 * Updates status, resolved_at, resolution_note, resolved_by_session.
 * Returns true if update succeeded.
 */
export async function resolveThreadInSupabase(
  threadId: string,
  options: {
    resolvedAt?: string;
    resolutionNote?: string;
    resolvedBySession?: string;
  } = {}
): Promise<boolean> {
  if (!hasSupabase() || !supabase.isConfigured()) {
    return false;
  }

  try {
    // First, find the UUID primary key for this thread_id
    const rows = await supabase.directQuery<ThreadRow>(getTableName("threads"), {
      select: "id,thread_id",
      filters: { thread_id: threadId },
      limit: 1,
    });

    if (rows.length === 0) {
      console.error(`[thread-supabase] Thread ${threadId} not found in Supabase (will proceed with local-only)`);
      return false;
    }

    const uuid = rows[0].id;
    const patchData: Record<string, unknown> = {
      status: "resolved",
      resolved_at: options.resolvedAt || new Date().toISOString(),
    };

    if (options.resolutionNote) {
      patchData.resolution_note = options.resolutionNote;
    }
    if (options.resolvedBySession) {
      patchData.resolved_by_session = options.resolvedBySession;
    }

    await supabase.directPatch(getTableName("threads"), { id: uuid }, patchData);
    console.error(`[thread-supabase] Resolved thread ${threadId} in Supabase`);
    return true;
  } catch (error) {
    console.error("[thread-supabase] Failed to resolve thread:", error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * List threads from Supabase with project filter.
 * Uses threads_lite view (no embedding column).
 * Returns null if Supabase is unavailable (caller should fall back to local).
 */
export async function listThreadsFromSupabase(
  project: Project = "default",
  options: {
    statusFilter?: string;
    includeResolved?: boolean;
  } = {}
): Promise<ThreadObject[] | null> {
  if (!hasSupabase() || !supabase.isConfigured()) {
    return null;
  }

  try {
    const filters: Record<string, string> = {
      project,
    };

    // Apply status filter unless including all
    if (!options.includeResolved && options.statusFilter) {
      if (options.statusFilter === "open") {
        // "open" in local status = all non-terminal Supabase statuses
        filters.status = "not.in.(resolved,archived)";
      } else if (options.statusFilter === "resolved") {
        filters.status = "resolved";
      } else {
        // Pass through any Supabase-native status
        filters.status = options.statusFilter;
      }
    } else if (!options.includeResolved) {
      // Default: exclude resolved and archived
      filters.status = "not.in.(resolved,archived)";
    }

    const rows = await supabase.directQuery<ThreadRow>(getTableName("threads_lite"), {
      select: "*",
      filters,
      order: "vitality_score.desc,last_touched_at.desc",
      limit: 100,
    });

    const threads = deduplicateThreadList(rows.map(rowToThreadObject));
    console.error(`[thread-supabase] Listed ${threads.length} threads from Supabase (${rows.length - threads.length} duplicates removed)`);
    return threads;
  } catch (error) {
    console.error("[thread-supabase] Failed to list threads:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Load active (non-archived, non-resolved) threads from Supabase for session_start.
 * Uses threads_lite view ordered by vitality_score DESC.
 * Returns null if Supabase is unavailable.
 */
export async function loadActiveThreadsFromSupabase(
  project: Project = "default"
): Promise<{ open: ThreadObject[]; displayInfo: ThreadDisplayInfo[] } | null> {
  if (!hasSupabase() || !supabase.isConfigured()) {
    return null;
  }

  try {
    // Get only non-resolved, non-archived threads (open/active only)
    const rows = await supabase.directQuery<ThreadRow>(getTableName("threads_lite"), {
      select: "*",
      filters: {
        project,
        status: "not.in.(archived,dormant,resolved)",
      },
      order: "vitality_score.desc,last_touched_at.desc",
      limit: 50,
    });

    const now = new Date();
    const open: ThreadObject[] = [];
    const displayInfo: ThreadDisplayInfo[] = [];

    // Deduplicate by text content (mirrors aggregateThreads logic)
    const seenText = new Set<string>();
    const seenIds = new Set<string>();

    for (const row of rows) {
      const key = normalizeText(row.text || "");
      if (seenIds.has(row.id) || (key && seenText.has(key))) continue;
      seenIds.add(row.id);
      if (key) seenText.add(key);

      open.push(rowToThreadObject(row));

      // Phase 6: Compute lifecycle display info for open threads
      const lastTouched = new Date(row.last_touched_at);
      const daysSinceTouch = Math.max(
        (now.getTime() - lastTouched.getTime()) / (1000 * 60 * 60 * 24),
        0
      );
      const { lifecycle_status } = computeLifecycleStatus({
        last_touched_at: row.last_touched_at,
        touch_count: row.touch_count,
        created_at: row.created_at,
        thread_class: (row.thread_class as ThreadClass) || "backlog",
        current_status: row.status,
        dormant_since: (row.metadata as Record<string, unknown>)?.dormant_since as string | undefined,
      }, now);

      displayInfo.push({
        thread: rowToThreadObject(row),
        vitality_score: row.vitality_score,
        lifecycle_status,
        thread_class: row.thread_class || "backlog",
        days_since_touch: Math.round(daysSinceTouch),
      });
    }

    const dupsRemoved = rows.length - open.length;
    console.error(`[thread-supabase] Loaded ${open.length} open threads from Supabase (${dupsRemoved} duplicates removed)`);
    return { open, displayInfo };
  } catch (error) {
    console.error("[thread-supabase] Failed to load active threads:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Touch threads in Supabase — increment touch_count and update last_touched_at.
 * Called during session_close for threads that were referenced during the session.
 */
export async function touchThreadsInSupabase(
  threadIds: string[]
): Promise<void> {
  if (!hasSupabase() || !supabase.isConfigured() || threadIds.length === 0) {
    return;
  }

  for (const threadId of threadIds) {
    try {
      // Fetch current state (need created_at and thread_class for vitality recomputation)
      const rows = await supabase.directQuery<ThreadRow>(getTableName("threads"), {
        select: "id,touch_count,created_at,thread_class,status",
        filters: { thread_id: threadId },
        limit: 1,
      });

      if (rows.length === 0) continue;

      const row = rows[0];

      // Skip resolved/archived threads — no point recomputing vitality
      if (row.status === "resolved" || row.status === "archived") continue;

      const now = new Date();
      const newTouchCount = (row.touch_count || 0) + 1;
      const nowIso = now.toISOString();

      // Recompute lifecycle status (Phase 6: includes emerging/archival logic)
      const { lifecycle_status, vitality } = computeLifecycleStatus({
        last_touched_at: nowIso,
        touch_count: newTouchCount,
        created_at: row.created_at,
        thread_class: (row.thread_class as ThreadClass) || "backlog",
        current_status: row.status,
        dormant_since: (row.metadata as Record<string, unknown>)?.dormant_since as string | undefined,
      }, now);

      // Track dormant_since in metadata for archival computation
      const metadata: Record<string, unknown> = { ...(row.metadata || {}) };
      if (lifecycle_status === "dormant" && row.status !== "dormant") {
        metadata.dormant_since = nowIso;
      } else if (lifecycle_status !== "dormant") {
        delete metadata.dormant_since;
      }

      await supabase.directPatch(getTableName("threads"), { id: row.id }, {
        touch_count: newTouchCount,
        last_touched_at: nowIso,
        vitality_score: vitality.vitality_score,
        status: lifecycle_status,
        metadata,
      });
    } catch (error) {
      console.error(`[thread-supabase] Failed to touch thread ${threadId}:`, error instanceof Error ? error.message : error);
      // Continue with other threads
    }
  }
}

/**
 * Batch create/update threads in Supabase.
 * Used by session_close to sync thread state.
 * New threads (not in Supabase) get created; existing threads get touched.
 */
export async function syncThreadsToSupabase(
  threads: ThreadObject[],
  project: Project = "default",
  sessionId?: string
): Promise<void> {
  if (!hasSupabase() || !supabase.isConfigured() || threads.length === 0) {
    return;
  }

  //  Load existing open threads once upfront for text-based dedup.
  // Prevents duplicate creation when closing ceremony generates new thread IDs
  // for threads that already exist with the same (or similar) text.
  let existingOpenThreads: { thread_id: string; text: string; status: string }[] = [];
  try {
    existingOpenThreads = await supabase.directQuery<{ thread_id: string; text: string; status: string }>(
      getTableName("threads"),
      {
        select: "thread_id,text,status",
        filters: {
          project,
          status: "not.in.(resolved,archived)",
        },
        limit: 200,
      }
    );
  } catch (err) {
    console.error("[thread-supabase] Failed to load existing threads for dedup (proceeding without):", err instanceof Error ? err.message : err);
  }

  // Build normalized text → thread_id lookup for dedup
  const textToExistingId = new Map<string, string>();
  for (const t of existingOpenThreads) {
    const key = normalizeText(t.text);
    if (key && !textToExistingId.has(key)) {
      textToExistingId.set(key, t.thread_id);
    }
  }

  for (const thread of threads) {
    try {
      // Check if thread exists in Supabase by ID
      const existing = await supabase.directQuery<ThreadRow>(getTableName("threads"), {
        select: "id,thread_id,status",
        filters: { thread_id: thread.id },
        limit: 1,
      });

      if (existing.length === 0) {
        // Thread ID not found — check for text-based duplicate before creating
        const normalizedNewText = normalizeText(thread.text || "");
        const matchedThreadId = normalizedNewText ? textToExistingId.get(normalizedNewText) : undefined;

        if (matchedThreadId) {
          // Duplicate text found — touch existing instead of creating
          console.error(`[thread-supabase] Dedup: "${thread.id}" matches existing "${matchedThreadId}" by text — touching instead of creating`);
          await touchThreadsInSupabase([matchedThreadId]);
        } else {
          // Genuinely new thread — create it
          await createThreadInSupabase(thread, project);
          // Register in lookup so subsequent threads in this batch also dedup
          if (normalizedNewText) {
            textToExistingId.set(normalizedNewText, thread.id);
          }
        }
      } else if (thread.status === "resolved" && existing[0].status !== "resolved") {
        // Thread was resolved during this session
        await resolveThreadInSupabase(thread.id, {
          resolvedAt: thread.resolved_at,
          resolutionNote: thread.resolution_note,
          resolvedBySession: thread.resolved_by_session || sessionId,
        });
      } else {
        // Existing thread, just touch it
        await touchThreadsInSupabase([thread.id]);
      }
    } catch (error) {
      console.error(`[thread-supabase] Failed to sync thread ${thread.id}:`, error instanceof Error ? error.message : error);
      // Continue with other threads
    }
  }
}

// ---------- Archival (Phase 6) ----------

/**
 * Archive dormant threads that have been dormant for 30+ days.
 * Reads metadata.dormant_since to determine eligibility.
 * Called at session_start as fire-and-forget.
 */
export async function archiveDormantThreads(
  project: Project = "default",
  dormantDays: number = 30
): Promise<{ archived_count: number; archived_ids: string[] }> {
  if (!hasSupabase() || !supabase.isConfigured()) {
    return { archived_count: 0, archived_ids: [] };
  }

  try {
    // Fetch dormant threads
    const rows = await supabase.directQuery<ThreadRow>(getTableName("threads"), {
      select: "id,thread_id,metadata",
      filters: {
        project,
        status: "dormant",
      },
      limit: 100,
    });

    const now = new Date();
    const archived_ids: string[] = [];

    for (const row of rows) {
      const dormantSince = (row.metadata as Record<string, unknown>)?.dormant_since as string | undefined;
      if (!dormantSince) continue;

      const dormantStart = new Date(dormantSince);
      const daysDormant = (now.getTime() - dormantStart.getTime()) / (1000 * 60 * 60 * 24);

      if (daysDormant >= dormantDays) {
        await supabase.directPatch(getTableName("threads"), { id: row.id }, {
          status: "archived",
        });
        archived_ids.push(row.thread_id);
      }
    }

    if (archived_ids.length > 0) {
      console.error(`[thread-supabase] Auto-archived ${archived_ids.length} dormant threads: ${archived_ids.join(", ")}`);
    }

    return { archived_count: archived_ids.length, archived_ids };
  } catch (error) {
    console.error("[thread-supabase] Failed to archive dormant threads:", error instanceof Error ? error.message : error);
    return { archived_count: 0, archived_ids: [] };
  }
}

// ---------- Embedding Queries (Phase 3) ----------

/**
 * Parse embedding from Supabase REST API response.
 * REST returns vector columns as JSON strings, not arrays.
 */
function parseEmbedding(raw: string | number[] | null | undefined): number[] | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Invalid JSON
    }
  }
  return null;
}

/**
 * Load open threads WITH embeddings from Supabase for dedup comparison.
 * Uses the full threads table (not _lite view) to include embedding column.
 * Returns null if Supabase is unavailable.
 */
export async function loadOpenThreadEmbeddings(
  project: Project = "default"
): Promise<ThreadWithEmbedding[] | null> {
  if (!hasSupabase() || !supabase.isConfigured()) {
    return null;
  }

  try {
    const rows = await supabase.directQuery<{
      thread_id: string;
      text: string;
      embedding: string | number[] | null;
    }>(getTableName("threads"), {
      select: "thread_id,text,embedding",
      filters: {
        project,
        status: "not.in.(resolved,archived)",
      },
      limit: 100,
    });

    console.error(`[thread-supabase] Loaded ${rows.length} thread embeddings for dedup`);
    return rows.map((row) => ({
      thread_id: row.thread_id,
      text: row.text,
      embedding: parseEmbedding(row.embedding),
    }));
  } catch (error) {
    console.error("[thread-supabase] Failed to load thread embeddings:", error instanceof Error ? error.message : error);
    return null;
  }
}

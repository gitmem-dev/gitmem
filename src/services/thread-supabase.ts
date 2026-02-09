/**
 * Thread Supabase Service (OD-620, OD-621, OD-622, OD-623, OD-624)
 *
 * Provides Supabase CRUD operations for the orchestra_threads table.
 * Supabase is the source of truth; local .gitmem/threads.json is a cache.
 *
 * Uses directQuery/directUpsert (PostgREST) like other Supabase operations
 * in this codebase. Graceful fallback: if Supabase is unreachable, callers
 * fall back to local file operations.
 */

import * as supabase from "./supabase-client.js";
import { hasSupabase } from "./tier.js";
import type { ThreadObject, Project } from "../types/index.js";

// ---------- Supabase Row Types ----------

/** Shape of a row in orchestra_threads / orchestra_threads_lite */
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

// ---------- Mapping Helpers ----------

/**
 * Map a local ThreadObject to a Supabase row for insert/upsert.
 * Leaves embedding null (Phase 3 concern).
 */
export function threadObjectToRow(
  thread: ThreadObject,
  project: Project = "orchestra_dev"
): Record<string, unknown> {
  return {
    thread_id: thread.id,              // "t-XXXXXXXX" -> thread_id column
    text: thread.text,
    status: mapStatusToSupabase(thread.status),
    thread_class: "backlog",           // Phase 1 default
    vitality_score: 1.0,               // Phase 2 concern
    last_touched_at: thread.created_at || new Date().toISOString(),
    touch_count: 1,
    created_at: thread.created_at || new Date().toISOString(),
    resolved_at: thread.resolved_at || null,
    resolution_note: thread.resolution_note || null,
    source_session: thread.source_session || null,
    resolved_by_session: thread.resolved_by_session || null,
    project,
    metadata: {},
  };
}

/**
 * Map a Supabase row to a local ThreadObject.
 */
export function rowToThreadObject(row: ThreadRow): ThreadObject {
  return {
    id: row.thread_id,                 // thread_id column -> ThreadObject.id
    text: row.text,
    status: mapStatusFromSupabase(row.status),
    created_at: row.created_at,
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
  project: Project = "orchestra_dev"
): Promise<ThreadRow | null> {
  if (!hasSupabase() || !supabase.isConfigured()) {
    return null;
  }

  try {
    const row = threadObjectToRow(thread, project);
    const result = await supabase.directUpsert<ThreadRow>(
      "orchestra_threads",
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
    const rows = await supabase.directQuery<ThreadRow>("orchestra_threads", {
      select: "id,thread_id",
      filters: { thread_id: threadId },
      limit: 1,
    });

    if (rows.length === 0) {
      console.error(`[thread-supabase] Thread ${threadId} not found in Supabase (will proceed with local-only)`);
      return false;
    }

    const uuid = rows[0].id;
    const updateData: Record<string, unknown> = {
      id: uuid,
      status: "resolved",
      resolved_at: options.resolvedAt || new Date().toISOString(),
    };

    if (options.resolutionNote) {
      updateData.resolution_note = options.resolutionNote;
    }
    if (options.resolvedBySession) {
      updateData.resolved_by_session = options.resolvedBySession;
    }

    await supabase.directUpsert("orchestra_threads", updateData);
    console.error(`[thread-supabase] Resolved thread ${threadId} in Supabase`);
    return true;
  } catch (error) {
    console.error("[thread-supabase] Failed to resolve thread:", error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * List threads from Supabase with project filter.
 * Uses orchestra_threads_lite view (no embedding column).
 * Returns null if Supabase is unavailable (caller should fall back to local).
 */
export async function listThreadsFromSupabase(
  project: Project = "orchestra_dev",
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
      // Map local status to Supabase status for filtering
      const supabaseStatus = mapStatusToSupabase(options.statusFilter);
      filters.status = supabaseStatus;
    } else if (!options.includeResolved) {
      // Default: exclude resolved
      filters.status = "not.eq.resolved";
    }

    const rows = await supabase.directQuery<ThreadRow>("orchestra_threads_lite", {
      select: "*",
      filters,
      order: "vitality_score.desc,last_touched_at.desc",
      limit: 100,
    });

    console.error(`[thread-supabase] Listed ${rows.length} threads from Supabase`);
    return rows.map(rowToThreadObject);
  } catch (error) {
    console.error("[thread-supabase] Failed to list threads:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Load active (non-archived, non-resolved) threads from Supabase for session_start.
 * Uses orchestra_threads_lite view ordered by vitality_score DESC.
 * Returns null if Supabase is unavailable.
 */
export async function loadActiveThreadsFromSupabase(
  project: Project = "orchestra_dev"
): Promise<{ open: ThreadObject[]; recentlyResolved: ThreadObject[] } | null> {
  if (!hasSupabase() || !supabase.isConfigured()) {
    return null;
  }

  try {
    // Get all non-archived threads (both active and recently resolved)
    const rows = await supabase.directQuery<ThreadRow>("orchestra_threads_lite", {
      select: "*",
      filters: {
        project,
        status: "not.in.(archived)",
      },
      order: "vitality_score.desc,last_touched_at.desc",
      limit: 100,
    });

    const open: ThreadObject[] = [];
    const recentlyResolved: ThreadObject[] = [];

    // Recently resolved = resolved in last 14 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);
    const cutoffStr = cutoff.toISOString();

    for (const row of rows) {
      const thread = rowToThreadObject(row);
      if (row.status === "resolved") {
        if (row.resolved_at && row.resolved_at >= cutoffStr) {
          recentlyResolved.push(thread);
        }
        // Older resolved threads are skipped
      } else {
        open.push(thread);
      }
    }

    console.error(`[thread-supabase] Loaded ${open.length} open, ${recentlyResolved.length} recently resolved threads from Supabase`);
    return { open, recentlyResolved };
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
      // Fetch current state
      const rows = await supabase.directQuery<ThreadRow>("orchestra_threads", {
        select: "id,touch_count",
        filters: { thread_id: threadId },
        limit: 1,
      });

      if (rows.length === 0) continue;

      const row = rows[0];
      await supabase.directUpsert("orchestra_threads", {
        id: row.id,
        touch_count: (row.touch_count || 0) + 1,
        last_touched_at: new Date().toISOString(),
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
  project: Project = "orchestra_dev",
  sessionId?: string
): Promise<void> {
  if (!hasSupabase() || !supabase.isConfigured() || threads.length === 0) {
    return;
  }

  for (const thread of threads) {
    try {
      // Check if thread exists in Supabase
      const existing = await supabase.directQuery<ThreadRow>("orchestra_threads", {
        select: "id,thread_id,status",
        filters: { thread_id: thread.id },
        limit: 1,
      });

      if (existing.length === 0) {
        // New thread — create it
        await createThreadInSupabase(thread, project);
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

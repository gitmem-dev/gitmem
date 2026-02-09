/**
 * resolve_thread Tool (OD-thread-lifecycle, OD-621)
 *
 * Mark an open thread as resolved. Supports resolution by:
 * - thread_id: exact match (preferred)
 * - text_match: case-insensitive substring match (fallback)
 *
 * OD-621: Updates Supabase (source of truth) + local file (cache).
 * Falls back to local-only if Supabase is unavailable or thread
 * doesn't exist in Supabase.
 *
 * Performance target: <500ms (Supabase update + file write)
 */

import { v4 as uuidv4 } from "uuid";
import { getThreads, getCurrentSession } from "../services/session-state.js";
import {
  resolveThread as resolveThreadInList,
  loadThreadsFile,
  saveThreadsFile,
} from "../services/thread-manager.js";
import { resolveThreadInSupabase } from "../services/thread-supabase.js";
import {
  Timer,
  recordMetrics,
  buildPerformanceData,
} from "../services/metrics.js";
import { formatThreadForDisplay } from "../services/timezone.js";
import type { ResolveThreadParams, ResolveThreadResult } from "../types/index.js";

export async function resolveThread(
  params: ResolveThreadParams
): Promise<ResolveThreadResult> {
  const timer = new Timer();
  const metricsId = uuidv4();

  // Validate: need at least one of thread_id or text_match
  if (!params.thread_id && !params.text_match) {
    const latencyMs = timer.stop();
    return {
      success: false,
      error: "Either thread_id or text_match is required",
      performance: buildPerformanceData("resolve_thread", latencyMs, 0),
    };
  }

  // Load threads from session state, fall back to file
  let threads = getThreads();
  let fromFile = false;
  if (threads.length === 0) {
    threads = loadThreadsFile();
    fromFile = true;
  }

  const session = getCurrentSession();
  const sessionId = session?.sessionId;

  // Resolve the thread locally (in-memory / file)
  const resolved = resolveThreadInList(threads, {
    threadId: params.thread_id,
    textMatch: params.text_match,
    sessionId,
    resolutionNote: params.resolution_note,
  });

  if (!resolved) {
    const latencyMs = timer.stop();
    const searchKey = params.thread_id || params.text_match;
    return {
      success: false,
      error: `Thread not found: "${searchKey}"`,
      performance: buildPerformanceData("resolve_thread", latencyMs, 0),
    };
  }

  // Persist to local file (cache)
  saveThreadsFile(threads);

  // OD-621: Update Supabase (source of truth) — graceful fallback on failure
  let supabaseSynced = false;
  const supabaseSuccess = await resolveThreadInSupabase(resolved.id, {
    resolvedAt: resolved.resolved_at,
    resolutionNote: resolved.resolution_note,
    resolvedBySession: resolved.resolved_by_session || sessionId,
  });
  if (supabaseSuccess) {
    supabaseSynced = true;
  }

  const latencyMs = timer.stop();
  const perfData = buildPerformanceData("resolve_thread", latencyMs, 1);

  recordMetrics({
    id: metricsId,
    tool_name: "resolve_thread",
    query_text: `resolve:${params.thread_id || "text:" + params.text_match}`,
    tables_searched: supabaseSynced ? ["orchestra_threads"] : [],
    latency_ms: latencyMs,
    result_count: 1,
    phase_tag: "ad_hoc",
    metadata: {
      thread_id: resolved.id,
      resolution_note: params.resolution_note,
      supabase_synced: supabaseSynced,
    },
  }).catch(() => {});

  return {
    success: true,
    resolved_thread: formatThreadForDisplay(resolved),
    performance: perfData,
  };
}

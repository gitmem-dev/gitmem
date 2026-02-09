/**
 * resolve_thread Tool (OD-thread-lifecycle)
 *
 * Mark an open thread as resolved. Supports resolution by:
 * - thread_id: exact match (preferred)
 * - text_match: case-insensitive substring match (fallback)
 *
 * Updates both in-memory session state and .gitmem/threads.json.
 *
 * Performance target: <100ms (in-memory mutation + file write)
 */

import { v4 as uuidv4 } from "uuid";
import { getThreads, getCurrentSession } from "../services/session-state.js";
import {
  resolveThread as resolveThreadInList,
  loadThreadsFile,
  saveThreadsFile,
} from "../services/thread-manager.js";
import {
  Timer,
  recordMetrics,
  buildPerformanceData,
} from "../services/metrics.js";
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

  // Resolve the thread
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

  // Persist to file
  if (fromFile) {
    saveThreadsFile(threads);
  } else {
    // Session state was mutated in-place; also persist to file
    saveThreadsFile(threads);
  }

  const latencyMs = timer.stop();
  const perfData = buildPerformanceData("resolve_thread", latencyMs, 1);

  recordMetrics({
    id: metricsId,
    tool_name: "resolve_thread",
    query_text: `resolve:${params.thread_id || "text:" + params.text_match}`,
    tables_searched: [],
    latency_ms: latencyMs,
    result_count: 1,
    phase_tag: "ad_hoc",
    metadata: {
      thread_id: resolved.id,
      resolution_note: params.resolution_note,
    },
  }).catch(() => {});

  return {
    success: true,
    resolved_thread: resolved,
    performance: perfData,
  };
}

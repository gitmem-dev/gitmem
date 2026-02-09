/**
 * list_threads Tool (OD-thread-lifecycle)
 *
 * List open threads across recent sessions. Shows unresolved work items
 * that carry over between sessions, with IDs for resolution.
 *
 * Reads from in-memory session state (populated by session_start),
 * falling back to .gitmem/threads.json if no active session.
 *
 * Performance target: <100ms (in-memory read)
 */

import { v4 as uuidv4 } from "uuid";
import { getThreads } from "../services/session-state.js";
import { loadThreadsFile } from "../services/thread-manager.js";
import {
  Timer,
  recordMetrics,
  buildPerformanceData,
} from "../services/metrics.js";
import { formatThreadForDisplay } from "../services/timezone.js";
import type { ListThreadsParams, ListThreadsResult, ThreadObject } from "../types/index.js";

export async function listThreads(
  params: ListThreadsParams
): Promise<ListThreadsResult> {
  const timer = new Timer();
  const metricsId = uuidv4();

  // Load threads from session state, fall back to file
  let allThreads: ThreadObject[] = getThreads();
  if (allThreads.length === 0) {
    allThreads = loadThreadsFile();
  }

  const statusFilter = params.status || "open";
  const includeResolved = params.include_resolved ?? false;

  let threads: ThreadObject[];
  if (includeResolved) {
    threads = allThreads;
  } else {
    threads = allThreads.filter((t) => t.status === statusFilter);
  }

  const totalOpen = allThreads.filter((t) => t.status === "open").length;
  const totalResolved = allThreads.filter((t) => t.status === "resolved").length;

  const latencyMs = timer.stop();
  const perfData = buildPerformanceData("list_threads", latencyMs, threads.length);

  recordMetrics({
    id: metricsId,
    tool_name: "list_threads",
    query_text: `list:${statusFilter}:${includeResolved ? "all" : "filtered"}`,
    tables_searched: [],
    latency_ms: latencyMs,
    result_count: threads.length,
    phase_tag: "ad_hoc",
    metadata: { total_open: totalOpen, total_resolved: totalResolved },
  }).catch(() => {});

  return {
    threads: threads.map(formatThreadForDisplay),
    total_open: totalOpen,
    total_resolved: totalResolved,
    performance: perfData,
  };
}

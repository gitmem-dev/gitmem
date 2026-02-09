/**
 * list_threads Tool (OD-thread-lifecycle, OD-622)
 *
 * List open threads across recent sessions. Shows unresolved work items
 * that carry over between sessions, with IDs for resolution.
 *
 * OD-622: Primary read from Supabase (source of truth).
 * Falls back to in-memory session state, then .gitmem/threads.json
 * if Supabase is unavailable.
 *
 * Performance target: <500ms (Supabase query with fallback)
 */

import { v4 as uuidv4 } from "uuid";
import { getThreads } from "../services/session-state.js";
import { loadThreadsFile } from "../services/thread-manager.js";
import { listThreadsFromSupabase } from "../services/thread-supabase.js";
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

  const statusFilter = params.status || "open";
  const includeResolved = params.include_resolved ?? false;
  const project = params.project || "orchestra_dev";

  let allThreads: ThreadObject[] | null = null;
  let source: "supabase" | "memory" | "file" = "file";

  // OD-622: Try Supabase first (source of truth)
  const supabaseThreads = await listThreadsFromSupabase(project, {
    statusFilter: includeResolved ? undefined : statusFilter,
    includeResolved,
  });

  if (supabaseThreads !== null) {
    allThreads = supabaseThreads;
    source = "supabase";
  }

  // Fallback: in-memory session state
  if (allThreads === null) {
    const memoryThreads = getThreads();
    if (memoryThreads.length > 0) {
      allThreads = memoryThreads;
      source = "memory";
    }
  }

  // Fallback: local file
  if (allThreads === null) {
    allThreads = loadThreadsFile();
    source = "file";
  }

  // Apply filtering for non-Supabase sources (Supabase already filtered)
  let threads: ThreadObject[];
  if (source === "supabase") {
    // Supabase already applied status filter
    threads = allThreads;
  } else if (includeResolved) {
    threads = allThreads;
  } else {
    threads = allThreads.filter((t) => t.status === statusFilter);
  }

  // Count totals (for non-Supabase sources, count from all threads)
  let totalOpen: number;
  let totalResolved: number;
  if (source === "supabase" && !includeResolved) {
    // We only have filtered results from Supabase, so counts are approximate
    totalOpen = threads.length;
    totalResolved = 0;  // We didn't fetch resolved
  } else {
    totalOpen = allThreads.filter((t) => t.status === "open").length;
    totalResolved = allThreads.filter((t) => t.status === "resolved").length;
  }

  const latencyMs = timer.stop();
  const perfData = buildPerformanceData("list_threads", latencyMs, threads.length);

  recordMetrics({
    id: metricsId,
    tool_name: "list_threads",
    query_text: `list:${statusFilter}:${includeResolved ? "all" : "filtered"}`,
    tables_searched: source === "supabase" ? ["orchestra_threads_lite"] : [],
    latency_ms: latencyMs,
    result_count: threads.length,
    phase_tag: "ad_hoc",
    metadata: {
      total_open: totalOpen,
      total_resolved: totalResolved,
      source,
    },
  }).catch(() => {});

  return {
    threads: threads.map(formatThreadForDisplay),
    total_open: totalOpen,
    total_resolved: totalResolved,
    performance: perfData,
  };
}

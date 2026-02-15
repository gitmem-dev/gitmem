/**
 * list_threads Tool (OD-thread-lifecycle, OD-622)
 *
 * List open threads across recent sessions. Shows unresolved work items
 * that carry over between sessions, with IDs for resolution.
 *
 * OD-622: Primary read from Supabase (source of truth).
 * Falls back to session-based aggregation (same as session_start),
 * then in-memory session state, then .gitmem/threads.json.
 *
 * Performance target: <500ms (Supabase query with fallback)
 */

import { v4 as uuidv4 } from "uuid";
import { getThreads, getProject } from "../services/session-state.js";
import { aggregateThreads, loadThreadsFile, mergeThreadStates } from "../services/thread-manager.js";
import { deduplicateThreadList } from "../services/thread-dedup.js"; // OD-641
import { listThreadsFromSupabase } from "../services/thread-supabase.js";
import * as supabase from "../services/supabase-client.js";
import {
  Timer,
  recordMetrics,
  buildPerformanceData,
} from "../services/metrics.js";
import { formatThreadForDisplay } from "../services/timezone.js";
import { wrapDisplay, truncate } from "../services/display-protocol.js";
import type { ListThreadsParams, ListThreadsResult, ThreadObject } from "../types/index.js";

/** Minimal session shape for aggregation (matches session_start) */
interface SessionRecord {
  id: string;
  session_title: string;
  session_date: string;
  open_threads?: (string | ThreadObject)[];
  close_compliance?: Record<string, unknown> | null;
}

// --- Display Formatting ---

/** Format date as short absolute string: "Feb 13" or "Jan 5" */
function shortDate(date: string | Date): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return "—";
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function buildThreadsDisplay(
  threads: ThreadObject[],
  totalOpen: number,
  totalResolved: number
): string {
  const lines: string[] = [];
  lines.push(`gitmem threads · ${totalOpen} open · ${totalResolved} resolved`);
  lines.push("");
  if (threads.length === 0) {
    lines.push("No threads found.");
    return wrapDisplay(lines.join("\n"));
  }

  // Deterministic sort: oldest first by created_at
  const sorted = [...threads].sort((a, b) =>
    a.created_at.localeCompare(b.created_at)
  );

  const NUM_W = 3;
  const TEXT_W = 52;
  const DATE_W = 8;
  const hr = (l: string, j: string, r: string) =>
    `${l}${"─".repeat(NUM_W + 2)}${j}${"─".repeat(TEXT_W + 2)}${j}${"─".repeat(DATE_W + 2)}${r}`;
  const hdr = (l: string, j: string, r: string) =>
    `${l}${"═".repeat(NUM_W + 2)}${j}${"═".repeat(TEXT_W + 2)}${j}${"═".repeat(DATE_W + 2)}${r}`;
  const row = (n: string, t: string, d: string) =>
    `│ ${n.padEnd(NUM_W)} │ ${t.padEnd(TEXT_W)} │ ${d.padStart(DATE_W)} │`;

  lines.push(hr("┌", "┬", "┐"));
  lines.push(row("#", "Thread", "Active"));
  lines.push(hdr("╞", "╪", "╡"));
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const text = truncate(t.text, TEXT_W);
    const date = shortDate(t.last_touched_at || t.created_at);
    lines.push(row(`${i + 1}.`, text, date));
  }
  lines.push(hr("└", "┴", "┘"));

  return wrapDisplay(lines.join("\n"));
}

export async function listThreads(
  params: ListThreadsParams
): Promise<ListThreadsResult> {
  const timer = new Timer();
  const metricsId = uuidv4();

  const statusFilter = params.status || "open";
  const includeResolved = params.include_resolved ?? false;
  const project = params.project || getProject() || "default";

  let allThreads: ThreadObject[] | null = null;
  let source: "supabase" | "aggregation" | "memory" | "file" = "file";

  // OD-622: Try Supabase first (source of truth)
  const supabaseThreads = await listThreadsFromSupabase(project, {
    statusFilter: includeResolved ? undefined : statusFilter,
    includeResolved,
  });

  if (supabaseThreads !== null) {
    allThreads = supabaseThreads;
    source = "supabase";
  }

  // Fallback: aggregate from recent sessions, merged with local file
  // (same pattern as session_start: aggregation + mergeThreadStates with local file)
  if (allThreads === null) {
    try {
      const sessions = await supabase.listRecords<SessionRecord>({
        table: "orchestra_sessions_lite",
        filters: { project },
        limit: 10,
        orderBy: { column: "created_at", ascending: false },
      });

      if (sessions.length > 0) {
        const result = aggregateThreads(sessions);
        const aggregated = [...result.open, ...result.recently_resolved];

        // Merge with local file — mergeThreadStates prefers resolved over open,
        // so local resolve_thread calls survive even if sessions still show "open"
        const fileThreads = loadThreadsFile();
        const merged = fileThreads.length > 0
          ? deduplicateThreadList(mergeThreadStates(aggregated, fileThreads))
          : deduplicateThreadList(aggregated);

        allThreads = merged;
        source = "aggregation";
      }
    } catch (error) {
      console.error("[list_threads] Session aggregation fallback failed:", error instanceof Error ? error.message : error);
    }
  }

  // Fallback: local file only (if aggregation failed entirely)
  if (allThreads === null) {
    allThreads = deduplicateThreadList(loadThreadsFile());
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

  // Count totals
  let totalOpen: number;
  let totalResolved: number;
  if (source === "supabase" && !includeResolved) {
    totalOpen = threads.length;
    totalResolved = 0;
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
    tables_searched: source === "supabase" ? ["orchestra_threads_lite"] : source === "aggregation" ? ["orchestra_sessions_lite"] : [],
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
    display: buildThreadsDisplay(threads, totalOpen, totalResolved),
    performance: perfData,
  };
}

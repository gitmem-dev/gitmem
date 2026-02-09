/**
 * create_thread Tool
 *
 * Create an open thread outside of session close. Threads track
 * unresolved work items that carry across sessions.
 *
 * OD-620: Writes to Supabase (source of truth) + local file (cache).
 * Falls back to local-only if Supabase is unavailable.
 *
 * Performance target: <500ms (Supabase write + file write)
 */

import { v4 as uuidv4 } from "uuid";
import { getThreads, setThreads, getCurrentSession } from "../services/session-state.js";
import {
  generateThreadId,
  loadThreadsFile,
  saveThreadsFile,
} from "../services/thread-manager.js";
import { createThreadInSupabase } from "../services/thread-supabase.js";
import {
  Timer,
  recordMetrics,
  buildPerformanceData,
} from "../services/metrics.js";
import { formatThreadForDisplay } from "../services/timezone.js";
import type { ThreadObject, PerformanceData, Project } from "../types/index.js";

// --- Types ---

export interface CreateThreadParams {
  /** Thread description */
  text: string;
  /** Associated Linear issue (optional) */
  linear_issue?: string;
  /** Project namespace (default: orchestra_dev) */
  project?: Project;
}

export interface CreateThreadResult {
  success: boolean;
  thread?: ThreadObject;
  error?: string;
  total_open: number;
  supabase_synced: boolean;
  performance: PerformanceData;
}

// --- Handler ---

export async function createThread(
  params: CreateThreadParams
): Promise<CreateThreadResult> {
  const timer = new Timer();
  const metricsId = uuidv4();

  if (!params.text || !params.text.trim()) {
    const latencyMs = timer.stop();
    return {
      success: false,
      error: "Thread text is required",
      total_open: 0,
      supabase_synced: false,
      performance: buildPerformanceData("create_thread" as any, latencyMs, 0),
    };
  }

  const session = getCurrentSession();
  const sessionId = session?.sessionId;
  const project = params.project || "orchestra_dev";

  const thread: ThreadObject = {
    id: generateThreadId(),
    text: params.text.trim(),
    status: "open",
    created_at: new Date().toISOString(),
    ...(sessionId && { source_session: sessionId }),
  };

  // OD-620: Write to Supabase (source of truth) — non-blocking on failure
  let supabaseSynced = false;
  const supabaseResult = await createThreadInSupabase(thread, project);
  if (supabaseResult) {
    supabaseSynced = true;
  }

  // Update in-memory session state if active
  let threads = getThreads();
  if (threads.length > 0) {
    threads.push(thread);
    setThreads(threads);
  }

  // Always persist to local file (cache, works with or without active session)
  const fileThreads = loadThreadsFile();
  fileThreads.push(thread);
  saveThreadsFile(fileThreads);

  const totalOpen = fileThreads.filter((t) => t.status === "open").length;

  const latencyMs = timer.stop();
  const perfData = buildPerformanceData("create_thread" as any, latencyMs, 1);

  recordMetrics({
    id: metricsId,
    tool_name: "create_thread" as any,
    query_text: `create:${thread.id}`,
    tables_searched: supabaseSynced ? ["orchestra_threads"] : [],
    latency_ms: latencyMs,
    result_count: 1,
    phase_tag: "ad_hoc",
    metadata: {
      thread_id: thread.id,
      has_session: !!sessionId,
      supabase_synced: supabaseSynced,
    },
  }).catch(() => {});

  return {
    success: true,
    thread: formatThreadForDisplay(thread),
    total_open: totalOpen,
    supabase_synced: supabaseSynced,
    performance: perfData,
  };
}

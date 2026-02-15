/**
 * create_thread Tool
 *
 * Create an open thread outside of session close. Threads track
 * unresolved work items that carry across sessions.
 *
 * OD-620: Writes to Supabase (source of truth) + local file (cache).
 * Falls back to local-only if Supabase is unavailable.
 *
 * Phase 3: Semantic dedup gate — before creating, checks existing open
 * threads by embedding cosine similarity (> 0.85 threshold). Returns
 * existing thread instead of creating a duplicate.
 *
 * Performance target: <500ms (Supabase write + file write)
 */

import { v4 as uuidv4 } from "uuid";
import { getThreads, setThreads, getCurrentSession, getProject } from "../services/session-state.js";
import {
  generateThreadId,
  loadThreadsFile,
  saveThreadsFile,
} from "../services/thread-manager.js";
import {
  createThreadInSupabase,
  loadOpenThreadEmbeddings,
  touchThreadsInSupabase,
} from "../services/thread-supabase.js";
import { checkDuplicate } from "../services/thread-dedup.js";
import { embed, isEmbeddingAvailable } from "../services/embedding.js";
import { writeTriplesForThreadCreation } from "../services/triple-writer.js";
import { getEffectTracker } from "../services/effect-tracker.js";
import { getAgentIdentity } from "../services/agent-detection.js";
import {
  Timer,
  recordMetrics,
  buildPerformanceData,
} from "../services/metrics.js";
import { wrapDisplay, truncate } from "../services/display-protocol.js";
import { formatThreadForDisplay } from "../services/timezone.js";
import type { ThreadWithEmbedding } from "../services/thread-dedup.js";
import type { ThreadObject, PerformanceData, Project } from "../types/index.js";

// --- Types ---

export interface CreateThreadParams {
  /** Thread description */
  text: string;
  /** Associated Linear issue (optional) */
  linear_issue?: string;
  /** Project namespace (default: default) */
  project?: Project;
}

export interface CreateThreadResult {
  success: boolean;
  thread?: ThreadObject;
  error?: string;
  total_open: number;
  supabase_synced: boolean;
  performance: PerformanceData;
  /** Phase 3: true when dedup gate found an existing duplicate */
  deduplicated?: boolean;
  /** Phase 3: dedup gate details */
  dedup?: {
    method: "embedding" | "text_normalization" | "skipped";
    similarity: number | null;
    matched_thread_id: string | null;
  };
  display?: string;
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
      display: wrapDisplay(`Failed: thread text is required`),
    };
  }

  const session = getCurrentSession();
  const sessionId = session?.sessionId;
  const project = params.project || getProject() || "default";
  const trimmedText = params.text.trim();

  // Phase 3: Generate embedding for new text (best-effort)
  let newEmbedding: number[] | null = null;
  if (isEmbeddingAvailable()) {
    try {
      newEmbedding = await embed(trimmedText);
    } catch (err) {
      console.error("[create-thread] Embedding generation failed (continuing without):", err instanceof Error ? err.message : err);
    }
  }

  // Phase 3: Load existing open threads with embeddings for dedup check
  let existingThreads: ThreadWithEmbedding[] = [];
  const loadedFromSupabase = await loadOpenThreadEmbeddings(project);
  if (loadedFromSupabase) {
    existingThreads = loadedFromSupabase;
  } else {
    // Supabase unavailable: use local threads for text-only fallback
    const localThreads = loadThreadsFile().filter((t) => t.status === "open");
    existingThreads = localThreads.map((t) => ({
      thread_id: t.id,
      text: t.text,
      embedding: null,
    }));
  }

  // Phase 3: Run dedup check
  const dedupResult = checkDuplicate(trimmedText, newEmbedding, existingThreads);

  // If duplicate found, touch existing thread and return it
  if (dedupResult.is_duplicate && dedupResult.matched_thread_id) {
    // Touch the existing thread to keep it vital
    await touchThreadsInSupabase([dedupResult.matched_thread_id]);

    const fileThreads = loadThreadsFile();
    const totalOpen = fileThreads.filter((t) => t.status === "open").length;

    // Find the existing thread to return
    const existingThread: ThreadObject = fileThreads.find(
      (t) => t.id === dedupResult.matched_thread_id
    ) || {
      id: dedupResult.matched_thread_id,
      text: dedupResult.matched_text || trimmedText,
      status: "open",
      created_at: new Date().toISOString(),
    };

    const latencyMs = timer.stop();

    recordMetrics({
      id: metricsId,
      tool_name: "create_thread" as any,
      query_text: `dedup:${dedupResult.matched_thread_id}`,
      tables_searched: ["orchestra_threads"],
      latency_ms: latencyMs,
      result_count: 0,
      phase_tag: "ad_hoc",
      metadata: {
        dedup_blocked: true,
        dedup_method: dedupResult.method,
        dedup_similarity: dedupResult.similarity,
        matched_thread_id: dedupResult.matched_thread_id,
      },
    }).catch(() => {});

    return {
      success: true,
      thread: formatThreadForDisplay(existingThread),
      total_open: totalOpen,
      supabase_synced: true,
      performance: buildPerformanceData("create_thread" as any, latencyMs, 0),
      deduplicated: true,
      dedup: {
        method: dedupResult.method,
        similarity: dedupResult.similarity,
        matched_thread_id: dedupResult.matched_thread_id,
      },
      display: wrapDisplay(`Dedup: matched existing thread "${truncate(trimmedText, 60)}"\nID: ${dedupResult.matched_thread_id}`),
    };
  }

  // Not a duplicate — create new thread
  const thread: ThreadObject = {
    id: generateThreadId(),
    text: trimmedText,
    status: "open",
    created_at: new Date().toISOString(),
    ...(sessionId && { source_session: sessionId }),
  };

  // OD-620: Write to Supabase (source of truth) with embedding — non-blocking on failure
  let supabaseSynced = false;
  const embeddingJson = newEmbedding ? JSON.stringify(newEmbedding) : null;
  const supabaseResult = await createThreadInSupabase(thread, project, embeddingJson);
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
      embedding_generated: newEmbedding !== null,
    },
  }).catch(() => {});

  // Phase 4: Knowledge graph triples (fire-and-forget)
  getEffectTracker().track("triple_write", "thread_creation", () =>
    writeTriplesForThreadCreation({
      thread_id: thread.id,
      text: trimmedText,
      linear_issue: params.linear_issue,
      session_id: sessionId,
      project,
      agent: getAgentIdentity(),
    })
  );

  return {
    success: true,
    thread: formatThreadForDisplay(thread),
    total_open: totalOpen,
    supabase_synced: supabaseSynced,
    performance: perfData,
    deduplicated: false,
    dedup: {
      method: dedupResult.method,
      similarity: dedupResult.similarity,
      matched_thread_id: null,
    },
    display: wrapDisplay(`Thread created: "${truncate(trimmedText, 60)}"\nID: ${thread.id} · ${totalOpen} open threads`),
  };
}

/**
 * resolve_thread Tool
 *
 * Mark an open thread as resolved. Supports resolution by:
 * - thread_id: exact match (preferred)
 * - text_match: case-insensitive substring match (fallback)
 *
 * Updates Supabase (source of truth) + local file (cache).
 * Falls back to local-only if Supabase is unavailable or thread
 * doesn't exist in Supabase.
 *
 * Performance target: <500ms (Supabase update + file write)
 */

import { v4 as uuidv4 } from "uuid";
import { getTableName } from "../services/tier.js";
import { getThreads, getCurrentSession } from "../services/session-state.js";
import {
  resolveThread as resolveThreadInList,
  findThreadById,
  loadThreadsFile,
  saveThreadsFile,
} from "../services/thread-manager.js";
import { resolveThreadInSupabase } from "../services/thread-supabase.js";
import { writeTriplesForThreadResolution } from "../services/triple-writer.js";
import { getEffectTracker } from "../services/effect-tracker.js";
import { getAgentIdentity } from "../services/agent-detection.js";
import {
  Timer,
  recordMetrics,
  buildPerformanceData,
} from "../services/metrics.js";
import { wrapDisplay } from "../services/display-protocol.js";
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
      display: wrapDisplay(`Either thread_id or text_match is required`),
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
      display: wrapDisplay(`Thread not found: "${searchKey}"`),
    };
  }

  // Duplicate cascade: if resolution_note says "duplicate of t-XXXX",
  // also resolve the referenced original thread
  const alsoResolved: typeof resolved[] = [];
  if (params.resolution_note) {
    const dupMatch = params.resolution_note.match(/\bduplicate of (t-[a-zA-Z0-9_-]+)\b/i);
    if (dupMatch) {
      const referencedId = dupMatch[1];
      const original = findThreadById(threads, referencedId);
      if (original && original.status === "open") {
        const cascaded = resolveThreadInList(threads, {
          threadId: referencedId,
          sessionId,
          resolutionNote: `Auto-resolved: ${resolved.id} was resolved as duplicate of this thread`,
        });
        if (cascaded) {
          alsoResolved.push(cascaded);
        }
      }
    }
  }

  // Persist to local file (cache)
  saveThreadsFile(threads);

  // Update Supabase (source of truth) — graceful fallback on failure
  let supabaseSynced = false;
  const supabaseSuccess = await resolveThreadInSupabase(resolved.id, {
    resolvedAt: resolved.resolved_at,
    resolutionNote: resolved.resolution_note,
    resolvedBySession: resolved.resolved_by_session || sessionId,
  });
  if (supabaseSuccess) {
    supabaseSynced = true;
  }

  // Sync cascaded resolutions to Supabase too
  for (const cascaded of alsoResolved) {
    await resolveThreadInSupabase(cascaded.id, {
      resolvedAt: cascaded.resolved_at,
      resolutionNote: cascaded.resolution_note,
      resolvedBySession: cascaded.resolved_by_session || sessionId,
    }).catch(() => {});
  }

  const latencyMs = timer.stop();
  const perfData = buildPerformanceData("resolve_thread", latencyMs, 1 + alsoResolved.length);

  recordMetrics({
    id: metricsId,
    tool_name: "resolve_thread",
    query_text: `resolve:${params.thread_id || "text:" + params.text_match}`,
    tables_searched: supabaseSynced ? [getTableName("threads")] : [],
    latency_ms: latencyMs,
    result_count: 1 + alsoResolved.length,
    phase_tag: "ad_hoc",
    metadata: {
      thread_id: resolved.id,
      resolution_note: params.resolution_note,
      supabase_synced: supabaseSynced,
      cascade_resolved: alsoResolved.map(t => t.id),
    },
  }).catch(() => {});

  // Phase 4: Knowledge graph triples (fire-and-forget)
  getEffectTracker().track("triple_write", "thread_resolution", () =>
    writeTriplesForThreadResolution({
      thread_id: resolved.id,
      text: resolved.text,
      resolution_note: params.resolution_note,
      session_id: sessionId,
      project: "default",
      agent: getAgentIdentity(),
    })
  );

  // Triples for cascaded resolutions
  for (const cascaded of alsoResolved) {
    getEffectTracker().track("triple_write", "thread_resolution_cascade", () =>
      writeTriplesForThreadResolution({
        thread_id: cascaded.id,
        text: cascaded.text,
        resolution_note: cascaded.resolution_note,
        session_id: sessionId,
        project: "default",
        agent: getAgentIdentity(),
      })
    );
  }

  let resolveMsg = `Thread resolved: "${resolved.text?.slice(0, 60) || resolved.id}"`;
  if (alsoResolved.length > 0) resolveMsg += `\nAlso resolved: ${alsoResolved.map(t => t.id).join(", ")}`;

  return {
    success: true,
    resolved_thread: formatThreadForDisplay(resolved),
    ...(alsoResolved.length > 0 && {
      also_resolved: alsoResolved.map(formatThreadForDisplay),
    }),
    performance: perfData,
    display: wrapDisplay(resolveMsg),
  };
}

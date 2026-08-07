/**
 * create_thread Tool
 *
 * Create an open thread outside of session close. Threads track
 * unresolved work items that carry across sessions.
 *
 * Writes to Supabase (source of truth) + local file (cache).
 * Falls back to local-only if Supabase is unavailable.
 *
 * Phase 3: Semantic dedup gate — before creating, checks existing open
 * threads by embedding cosine similarity (> 0.85 threshold). Returns
 * existing thread instead of creating a duplicate.
 *
 * Performance target: <500ms (Supabase write + file write)
 */

import { v4 as uuidv4 } from "uuid";
import { getTableName, getTier, hasSupabase } from "../services/tier.js";
import { getThreads, setThreads, getCurrentSession, getProject } from "../services/session-state.js";
import {
  generateThreadId,
  loadThreadsFile,
  saveThreadsFile,
} from "../services/thread-manager.js";
import {
  createThreadInSupabase,
  loadOpenThreadEmbeddings,
  getThreadFromSupabaseById,
} from "../services/thread-supabase.js";
import { checkDuplicate } from "../services/thread-dedup.js";
import { resolveThreadScope } from "../services/thread-scope.js";
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
  /**
   * R2: force a genuinely new thread past a dedup match. Dedup refuses rather
   * than merging, so this is the caller's explicit way through — never a
   * default, because the whole point is that the decision is stated.
   */
  allow_duplicate?: boolean;
}

/**
 * Why a write did not store, when it did not (GIT-67/GIT-63).
 * Absent on success.
 */
export type NotStoredReason =
  | "no_active_session"
  | "duplicate_candidate"
  | "empty_text"
  | "store_unavailable";

/**
 * Where a thread actually landed (R3: every response names its store).
 * `local_only` is the honest middle state from R4 — written somewhere, but
 * not somewhere durable.
 */
export type StoredIn = "supabase" | "local" | "local_only" | null;

export interface CreateThreadResult {
  success: boolean;
  /**
   * Whether a row exists. Distinct from `success` on purpose: a dedup refusal
   * is a well-formed answer to a well-formed request, not a crash.
   */
  stored: boolean;
  /** Whether what was stored survives this machine. */
  durable: boolean;
  /** R3: names the store in-band, which also kills the f104e10d silent-local trap. */
  stored_in: StoredIn;
  reason?: NotStoredReason;
  thread?: ThreadObject;
  error?: string;
  total_open: number;
  supabase_synced: boolean;
  supabase_error?: string;
  performance: PerformanceData;
  /** Phase 3: true when dedup gate found an existing duplicate */
  deduplicated?: boolean;
  /** Phase 3: dedup gate details */
  dedup?: {
    method: "embedding" | "token_overlap" | "text_normalization" | "skipped";
    similarity: number | null;
    matched_thread_id: string | null;
    /** R2: the STORED text of the match, so the caller sees what it collided with. */
    matched_text?: string;
    /** R2: both lengths, so a silent discard is arithmetically visible. */
    stored_length?: number;
    submitted_length?: number;
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
      stored: false,
      durable: false,
      stored_in: null,
      reason: "empty_text",
      error: "Thread text is required",
      total_open: 0,
      supabase_synced: false,
      performance: buildPerformanceData("create_thread" as any, latencyMs, 0),
      display: wrapDisplay(`Not stored: thread text is required`),
    };
  }

  const session = getCurrentSession();
  const sessionId = session?.sessionId;
  const project = params.project || getProject() || "default";
  const trimmedText = params.text.trim();

  // GIT-67 / R5: fail loud with no ID when there is no session to own the
  // write. The reported defect was a success payload carrying a plausible
  // t-xxxxxxxx for a row that never existed — the caller records that ID and
  // moves on, so an invented ID is strictly worse than an error.
  //
  // Tier-relative per R5: on pro the write is refused outright, because the
  // durable store records source_session and an unowned row is a defect. On
  // free the local file is the SOT and sessionless use is legitimate, so the
  // write proceeds and the response says `session: none` rather than implying
  // an ownership it does not have.
  const tier = getTier();
  if (!sessionId && tier !== "free") {
    const latencyMs = timer.stop();
    const message =
      "Not stored: no active session (reason: no_active_session). " +
      "No thread ID has been issued because no row was written. " +
      "Call session_start() first, then retry — or fall back to another record (e.g. the issue tracker) if the session cannot be restored.";

    return {
      success: false,
      stored: false,
      durable: false,
      stored_in: null,
      reason: "no_active_session",
      error: message,
      total_open: 0,
      supabase_synced: false,
      performance: buildPerformanceData("create_thread" as any, latencyMs, 0),
      display: wrapDisplay(message),
    };
  }

  // Phase 3: Generate embedding for new text (best-effort)
  let newEmbedding: number[] | null = null;
  if (isEmbeddingAvailable()) {
    try {
      newEmbedding = await embed(trimmedText);
    } catch (err) {
      console.error("[create-thread] Embedding generation failed (continuing without):", err instanceof Error ? err.message : err);
    }
  }

  // Phase 3 / GIT-69: Load dedup candidates through the one scope resolver.
  // Candidates are this session's own threads in this project — never another
  // session's, which cannot be safely auto-merged (R1).
  const scope = resolveThreadScope({ project, sessionId: sessionId ?? null });

  let existingThreads: ThreadWithEmbedding[] = [];
  const loadedFromSupabase = await loadOpenThreadEmbeddings(scope);
  if (loadedFromSupabase) {
    existingThreads = loadedFromSupabase;
  } else if (scope.sessionId) {
    // Supabase unavailable: use local threads for text-only fallback, held to
    // the same scope the query would have applied.
    const localThreads = loadThreadsFile().filter(
      (t) => t.status === "open" && t.source_session === scope.sessionId
    );
    existingThreads = localThreads.map((t) => ({
      thread_id: t.id,
      text: t.text,
      embedding: null,
    }));
  }

  // Phase 3: Run dedup check
  const dedupResult = checkDuplicate(trimmedText, newEmbedding, existingThreads);

  // GIT-63 / R2: a dedup match REFUSES. It does not merge, and it does not
  // discard.
  //
  // The old behaviour returned the matched thread's ID with the SUBMITTED text
  // rendered beside it and success:true, while the stored row kept its own
  // text and only updated_at moved. The caller believed a handoff was written;
  // the database held the previous session's. Nothing anywhere said the
  // content had been dropped.
  //
  // Everything below renders from the STORED row. The submitted text appears
  // only as a length, never as the thing that got an ID.
  if (dedupResult.is_duplicate && dedupResult.matched_thread_id && !params.allow_duplicate) {
    const matchedId = dedupResult.matched_thread_id;

    // Read the stored row back rather than trusting the dedup candidate cache
    // — the refusal quotes the database, not our copy of it.
    const storedRow = await getThreadFromSupabaseById(matchedId);
    const storedText = storedRow?.text ?? dedupResult.matched_text ?? "";

    const fileThreads = loadThreadsFile();
    const totalOpen = fileThreads.filter((t) => t.status === "open").length;
    const latencyMs = timer.stop();

    recordMetrics({
      id: metricsId,
      tool_name: "create_thread" as any,
      query_text: `dedup_refused:${matchedId}`,
      tables_searched: [getTableName("threads")],
      latency_ms: latencyMs,
      result_count: 0,
      phase_tag: "ad_hoc",
      metadata: {
        dedup_blocked: true,
        dedup_method: dedupResult.method,
        dedup_similarity: dedupResult.similarity,
        matched_thread_id: matchedId,
        submitted_length: trimmedText.length,
        stored_length: storedText.length,
      },
    }).catch(() => {});

    const message =
      `NOT STORED: your text was not written (reason: duplicate_candidate).\n` +
      `It resembles an existing thread in this session${dedupResult.similarity !== null ? ` (similarity ${dedupResult.similarity})` : ""}.\n\n` +
      `Existing thread ${matchedId} — ${storedText.length} chars, unchanged:\n` +
      `  "${truncate(storedText, 120)}"\n\n` +
      `Your submission — ${trimmedText.length} chars, NOT persisted anywhere:\n` +
      `  "${truncate(trimmedText, 120)}"\n\n` +
      `To supersede: resolve_thread("${matchedId}") then create_thread again.\n` +
      `To keep both: create_thread with allow_duplicate: true.`;

    return {
      success: false,
      stored: false,
      durable: false,
      stored_in: null,
      reason: "duplicate_candidate",
      // Deliberately NO `thread` field. Returning a ThreadObject here is how
      // the old code handed back another thread's ID as if it were the
      // caller's; there is no thread to return, because nothing was created.
      total_open: totalOpen,
      supabase_synced: false,
      performance: buildPerformanceData("create_thread" as any, latencyMs, 0),
      deduplicated: true,
      dedup: {
        method: dedupResult.method,
        similarity: dedupResult.similarity,
        matched_thread_id: matchedId,
        matched_text: storedText,
        stored_length: storedText.length,
        submitted_length: trimmedText.length,
      },
      error: message,
      display: wrapDisplay(message),
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

  // Write to Supabase (source of truth) with embedding.
  let supabaseSynced = false;
  let supabaseError: string | undefined;
  const embeddingJson = newEmbedding ? JSON.stringify(newEmbedding) : null;

  if (hasSupabase()) {
    try {
      const supabaseResult = await createThreadInSupabase(thread, project, embeddingJson);
      supabaseSynced = Boolean(supabaseResult);
      if (!supabaseSynced) {
        supabaseError = "write returned no row";
      }
    } catch (err) {
      supabaseError = err instanceof Error ? err.message : String(err);
    }
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
    tables_searched: supabaseSynced ? [getTableName("threads")] : [],
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

  // GIT-63/GIT-67 core convention: render from a post-write READ of the stored
  // row, never from the submitted payload. An ID appears in output only if the
  // row backing it exists.
  //
  // Tier-relative per R3: pro's SOT is the Supabase row, free's is the local
  // record. Each reads back its own store; neither claims the other's.
  const storedRow = supabaseSynced ? await getThreadFromSupabaseById(thread.id) : null;
  const localRecord = loadThreadsFile().find((t) => t.id === thread.id) ?? null;
  const rendered = storedRow ?? localRecord;

  const durable = supabaseSynced && storedRow !== null;
  const storedIn: StoredIn = durable
    ? "supabase"
    : hasSupabase()
      ? "local_only"
      : "local";

  if (!rendered) {
    // Neither store has it. Nothing to render from, so nothing is claimed.
    const message =
      `NOT STORED: the write could not be confirmed in any store (reason: store_unavailable).` +
      (supabaseError ? `\nDurable store: ${supabaseError}` : "");
    return {
      success: false,
      stored: false,
      durable: false,
      stored_in: null,
      reason: "store_unavailable",
      error: message,
      total_open: totalOpen,
      supabase_synced: false,
      supabase_error: supabaseError,
      performance: perfData,
      display: wrapDisplay(message),
    };
  }

  // R4: fail-honest. The local buffer survives — destroying it to signal an
  // error would repeat the crime in reverse — but the response is
  // unmistakably non-success, and no ID is presented as durable.
  const message = durable
    ? `Thread created: "${truncate(rendered.text, 60)}"\nID: ${rendered.id} · ${totalOpen} open threads · stored in supabase`
    : hasSupabase()
      ? `SAVED LOCALLY ONLY — not durable (stored_in: local_only, durable: false).\n` +
        `Thread ${rendered.id}: "${truncate(rendered.text, 60)}"\n` +
        `The durable store did not accept this write${supabaseError ? ` (${supabaseError})` : ""}, so it exists only on this machine and will not reach another session.\n` +
        `Retry when the store is reachable, or record it somewhere durable.`
      : `Thread created: "${truncate(rendered.text, 60)}"\nID: ${rendered.id} · ${totalOpen} open threads · stored in local file` +
        (sessionId ? "" : " · session: none");

  return {
    success: durable || !hasSupabase(),
    stored: true,
    durable,
    stored_in: storedIn,
    thread: formatThreadForDisplay(rendered),
    total_open: totalOpen,
    supabase_synced: supabaseSynced,
    ...(supabaseError ? { supabase_error: supabaseError } : {}),
    performance: perfData,
    deduplicated: false,
    dedup: {
      method: dedupResult.method,
      similarity: dedupResult.similarity,
      matched_thread_id: null,
    },
    display: wrapDisplay(message),
  };
}

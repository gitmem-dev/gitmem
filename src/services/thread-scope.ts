/**
 * Thread Scope Resolver (GIT-69)
 *
 * ONE definition of "the thread store, scoped". Every surface that reads or
 * resolves threads imports from here: session_start's panel, list_threads,
 * resolve_thread, and create_thread's dedup candidate selection.
 *
 * Before this module each of those four computed its own view, and they
 * disagreed in three ways that were invisible from any single call site:
 *
 *   - limit          session_start 50 vs list_threads 100
 *   - status set     session_start excluded "dormant", list_threads did not
 *   - ordering       the dedup loader had no ORDER BY at all
 *
 * Those disagreements are the f02f74ca panel-vs-list defect and the
 * nondeterministic dedup candidate set. Both die here rather than in three
 * separate patches.
 *
 * Scope has two axes:
 *   project     — which namespace's threads are in view
 *   visibility  — "project" (everything in the namespace) or "own_session"
 *                 (only threads this session created)
 *
 * Per ruling R1, dedup uses "own_session": automatic dedup against another
 * session's thread is never safe, because a match there means silently binding
 * this session's content to a thread it does not own. Widening to a
 * parent/descendant lineage arrives here later (GIT-69 item 4) and every
 * consumer inherits it by import.
 *
 * This resolver is downstream of session identity: it consumes whatever
 * (project, sessionId) it is given and scopes correctly relative to them.
 * Deciding *who the caller is* belongs to session recovery (GIT-51), not here.
 */

import { getCurrentSession, getProject } from "./session-state.js";
import type { Project } from "../types/index.js";

// --- Types ---

/** Which threads a caller may see. */
export type ThreadVisibility = "project" | "own_session";

export interface ThreadScope {
  /** Namespace the caller is operating in. */
  project: Project;
  /** Session the caller belongs to, or null when there is no active session. */
  sessionId: string | null;
}

export interface ThreadQuery {
  filters: Record<string, string>;
  order: string;
  limit: number;
}

export interface ThreadQueryOptions {
  visibility: ThreadVisibility;
  /** Terminal statuses to exclude. Defaults to the active-thread set. */
  exclude?: readonly string[];
  limit?: number;
}

// --- Constants ---

/**
 * Deterministic total order for every scoped thread query.
 *
 * vitality and recency rank the rows; thread_id breaks ties. The tiebreaker is
 * not cosmetic — vitality_score is 1 for most rows, so without it the ordering
 * is unstable exactly at the limit boundary, and two identical calls can return
 * different candidate sets. Determinism is an acceptance criterion (R6).
 */
export const THREAD_SCOPE_ORDER =
  "vitality_score.desc,last_touched_at.desc,thread_id.asc";

/** Row cap for scoped queries. One number, so no two surfaces can disagree. */
export const THREAD_SCOPE_LIMIT = 100;

/** Statuses that mean "this thread is no longer live work". */
export const TERMINAL_STATUSES = ["resolved", "archived"] as const;

/**
 * In scope but excluded from a default listing (R7). Dormant threads exist —
 * hiding them from scope would make the panel and the dedup candidate set
 * disagree about what exists. They are filtered at display and counted.
 */
export const DORMANT_STATUSES: readonly string[] = ["dormant"];

/** Statuses excluded from the active-thread view. */
export const INACTIVE_STATUSES = ["resolved", "archived", "dormant"] as const;

// --- Core ---

/**
 * Resolve the caller's thread scope.
 *
 * Explicit overrides win, then the active session, then the configured
 * project. sessionId is null when there is no active session — callers decide
 * what that means for them; "own_session" visibility treats it as "no thread
 * is in scope" rather than silently widening to the whole project.
 */
export function resolveThreadScope(overrides?: {
  project?: Project;
  sessionId?: string | null;
}): ThreadScope {
  const session = getCurrentSession();

  const project =
    overrides?.project ?? getProject() ?? ("default" as Project);

  const sessionId =
    overrides?.sessionId !== undefined
      ? overrides.sessionId
      : session?.sessionId ?? null;

  return { project, sessionId };
}

/**
 * Build the query for a scope. Every scoped read goes through this, so the
 * limit, ordering, and status set cannot drift between surfaces again.
 *
 * Returns null when the scope can select nothing — "own_session" visibility
 * with no active session. That is a real empty set, not an error, and it is
 * deliberately distinct from an unscoped query: callers must not fall back to
 * project-wide results when session identity is missing.
 */
export function buildScopedThreadQuery(
  scope: ThreadScope,
  options: ThreadQueryOptions
): ThreadQuery | null {
  if (options.visibility === "own_session" && !scope.sessionId) {
    return null;
  }

  const exclude = options.exclude ?? INACTIVE_STATUSES;

  const filters: Record<string, string> = {
    project: scope.project,
  };

  if (exclude.length > 0) {
    filters.status = `not.in.(${exclude.join(",")})`;
  }

  if (options.visibility === "own_session") {
    filters.source_session = scope.sessionId as string;
  }

  return {
    filters,
    order: THREAD_SCOPE_ORDER,
    limit: options.limit ?? THREAD_SCOPE_LIMIT,
  };
}

/**
 * Whether a thread is inside a scope, for in-memory filtering of rows that did
 * not come from a scoped query (local file cache, session aggregation).
 *
 * Mirrors buildScopedThreadQuery exactly. If the two ever disagree, the store
 * and the cache disagree — which is the divergence class this module exists to
 * close — so they are tested against the same fixtures.
 */
export function isInScope(
  thread: { project?: string | null; source_session?: string | null },
  scope: ThreadScope,
  visibility: ThreadVisibility
): boolean {
  if (thread.project != null && thread.project !== scope.project) {
    return false;
  }

  if (visibility === "own_session") {
    if (!scope.sessionId) return false;
    if (thread.source_session !== scope.sessionId) return false;
  }

  return true;
}

// --- Honest truncation (R7) ---

/**
 * What the scope actually contained. The three counts must reconcile:
 * listable + dormantHidden === totalInScope.
 */
export interface ThreadScopeCounts {
  /** In scope and eligible for the default listing. */
  listable: number;
  /** In scope, withheld from the default listing because dormant. */
  dormantHidden: number;
  /** Everything the scope selected. */
  totalInScope: number;
}

export interface PanelOmission {
  shown: number;
  dormantHidden: number;
  overCap: number;
  totalInScope: number;
}

/**
 * Split a scope into what a capped panel shows and what it withholds.
 *
 * By construction shown + dormantHidden + overCap === totalInScope. That
 * identity is the point: a panel showing 5 of 47 with no indicator is a
 * green-message pattern in miniature — a display asserting a completeness it
 * does not have.
 */
export function computePanelOmission(
  counts: ThreadScopeCounts,
  maxShow: number
): PanelOmission {
  const shown = Math.max(0, Math.min(counts.listable, maxShow));
  return {
    shown,
    dormantHidden: counts.dormantHidden,
    overCap: Math.max(0, counts.listable - shown),
    totalInScope: counts.totalInScope,
  };
}

/**
 * Render the omission line, or null when the view is complete and there is
 * nothing to disclose. Any capped or filtered view must state what it omitted
 * and where the rest lives (R7).
 */
export function formatOmissionLine(
  omission: PanelOmission,
  fullViewHint = "list_threads for full view"
): string | null {
  const withheld = omission.dormantHidden + omission.overCap;
  if (withheld === 0) return null;

  const parts: string[] = [];
  if (omission.dormantHidden > 0) parts.push(`${omission.dormantHidden} dormant`);
  if (omission.overCap > 0) parts.push(`${omission.overCap} over cap`);

  return `showing ${omission.shown} of ${omission.totalInScope} in scope (${parts.join(", ")}) — ${fullViewHint}`;
}

/**
 * Human-readable scope description, for tool responses that need to say what
 * they searched. Naming the scope in-band is how a caller can tell "no results"
 * from "wrong scope" without reading the source.
 */
export function describeScope(
  scope: ThreadScope,
  visibility: ThreadVisibility
): string {
  return visibility === "own_session"
    ? `project ${scope.project}, session ${scope.sessionId?.slice(0, 8) ?? "none"}`
    : `project ${scope.project}, all sessions`;
}

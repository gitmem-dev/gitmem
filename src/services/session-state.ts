/**
 * Session State Management
 * Track current session context for auto-injecting into recall calls
 * Track surfaced scars for auto-bridging Q6 answers to scar_usage records
 *
 * Maintains in-memory state of the current active session including:
 * - session_id from session_start
 * - linear_issue if working on a Linear issue
 * - agent identity
 * - surfaced scars (accumulated from session_start + recall calls)
 *
 * This allows recall() to always assign variants even without explicit parameters.
 */

import fs from "fs";
import type { SurfacedScar, ScarConfirmation, ScarReflection, Observation, SessionChild, ThreadObject } from "../types/index.js";
import { getSessionPath } from "./gitmem-dir.js";

interface SessionContext {
  sessionId: string;
  linearIssue?: string;
  agent?: string;
  project?: string;              // Thread fix: track active project for list_threads default
  startedAt: Date;
  recallCalled: boolean;         // Track whether recall() was invoked (independent of results)
  surfacedScars: SurfacedScar[]; // Track all scars surfaced during session
  confirmations: ScarConfirmation[]; // Refute-or-obey confirmations for recall-surfaced scars
  reflections: ScarReflection[];    // End-of-session scar reflections (OBEYED/REFUTED)
  observations: Observation[];   // v2 Phase 2: Sub-agent/teammate observations
  children: SessionChild[];      // v2 Phase 2: Child agent records
  threads: ThreadObject[];       // : Working thread state
  feedbackSubmitCount: number;   // Rate limit counter for contribute_feedback
}

// Global session state (single active session per MCP server instance)
let currentSession: SessionContext | null = null;

/**
 * Set the current active session
 * Called by session_start
 */
export function setCurrentSession(context: Omit<SessionContext, 'recallCalled' | 'surfacedScars' | 'confirmations' | 'reflections' | 'observations' | 'children' | 'threads' | 'feedbackSubmitCount'> & { surfacedScars?: SurfacedScar[]; observations?: Observation[]; children?: SessionChild[]; threads?: ThreadObject[] }): void {
  currentSession = {
    ...context,
    recallCalled: false,
    surfacedScars: context.surfacedScars || [],
    confirmations: [],
    reflections: [],
    observations: context.observations || [],
    children: context.children || [],
    threads: context.threads || [],
    feedbackSubmitCount: 0,
  };
  console.error(`[session-state] Active session set: ${context.sessionId}${context.linearIssue ? ` (issue: ${context.linearIssue})` : ''}`);
}

/**
 * Get the current active session
 * Returns null if no session active
 */
export function getCurrentSession(): SessionContext | null {
  return currentSession;
}

/**
 * Clear the current session
 * Called by session_close
 */
export function clearCurrentSession(): void {
  if (currentSession) {
    console.error(`[session-state] Clearing session: ${currentSession.sessionId}`);
  }
  currentSession = null;
}

/**
 * Get the active session's project, or null if no session.
 * Used by list_threads to inherit the correct project default.
 */
export function getProject(): string | null {
  return currentSession?.project || null;
}

/**
 * Check if currently working on a Linear issue
 */
export function hasActiveIssue(): boolean {
  return !!(currentSession?.linearIssue);
}

/**
 * Mark that recall() was called this session (independent of whether it returned scars).
 * Called by recall tool before any early return.
 */
export function setRecallCalled(): void {
  if (currentSession) {
    currentSession.recallCalled = true;
    console.error("[session-state] recall() marked as called");
  }
}

/**
 * Check if recall() was called this session.
 * Used by enforcement to avoid false positives when recall returns 0 scars.
 */
export function isRecallCalled(): boolean {
  return currentSession?.recallCalled ?? false;
}

/**
 * Add surfaced scars to tracking (deduplicates by scar_id)
 * Called by session_start and recall when scars are surfaced.
 */
export function addSurfacedScars(scars: SurfacedScar[]): void {
  if (!currentSession) {
    console.warn("[session-state] Cannot add surfaced scars: no active session");
    return;
  }

  for (const scar of scars) {
    const exists = currentSession.surfacedScars.some(s => s.scar_id === scar.scar_id);
    if (!exists) {
      currentSession.surfacedScars.push(scar);
    }
  }

  console.error(`[session-state] Surfaced scars tracked: ${currentSession.surfacedScars.length} total`);
}

/**
 * Get all surfaced scars for the current session
 */
export function getSurfacedScars(): SurfacedScar[] {
  // Return in-memory if available
  if (currentSession?.surfacedScars && currentSession.surfacedScars.length > 0) {
    return currentSession.surfacedScars;
  }

  // Fallback: recover from per-session file if in-memory was lost (MCP restart)
  if (currentSession?.sessionId) {
    try {
      const sessionFilePath = getSessionPath(currentSession.sessionId, "session.json");
      if (fs.existsSync(sessionFilePath)) {
        const data = JSON.parse(fs.readFileSync(sessionFilePath, "utf-8"));
        if (data.surfaced_scars && Array.isArray(data.surfaced_scars) && data.surfaced_scars.length > 0) {
          currentSession.surfacedScars = data.surfaced_scars;
          console.error(`[session-state] Recovered ${data.surfaced_scars.length} surfaced scars from file`);
          return data.surfaced_scars;
        }
      }
    } catch (error) {
      console.warn("[session-state] Failed to recover surfaced scars from file:", error);
    }
  }

  return [];
}

/**
 * Add scar confirmations (refute-or-obey) to the current session.
 * Called by confirm_scars tool after validation.
 */
export function addConfirmations(confirmations: ScarConfirmation[]): void {
  if (!currentSession) {
    console.warn("[session-state] Cannot add confirmations: no active session");
    return;
  }

  for (const conf of confirmations) {
    // Replace existing confirmation for same scar_id (allow re-confirmation)
    const idx = currentSession.confirmations.findIndex(c => c.scar_id === conf.scar_id);
    if (idx >= 0) {
      currentSession.confirmations[idx] = conf;
    } else {
      currentSession.confirmations.push(conf);
    }
  }

  console.error(`[session-state] Confirmations tracked: ${currentSession.confirmations.length} total`);
}

/**
 * Get all scar confirmations for the current session.
 */
export function getConfirmations(): ScarConfirmation[] {
  return currentSession?.confirmations || [];
}

/**
 * Add end-of-session scar reflections (OBEYED/REFUTED) to the current session.
 * Called by reflect_scars tool after validation.
 */
export function addReflections(reflections: ScarReflection[]): void {
  if (!currentSession) {
    console.warn("[session-state] Cannot add reflections: no active session");
    return;
  }

  for (const ref of reflections) {
    // Replace existing reflection for same scar_id (allow re-reflection)
    const idx = currentSession.reflections.findIndex(r => r.scar_id === ref.scar_id);
    if (idx >= 0) {
      currentSession.reflections[idx] = ref;
    } else {
      currentSession.reflections.push(ref);
    }
  }

  console.error(`[session-state] Reflections tracked: ${currentSession.reflections.length} total`);
}

/**
 * Get all end-of-session scar reflections for the current session.
 */
export function getReflections(): ScarReflection[] {
  return currentSession?.reflections || [];
}

/**
 * Check if there are recall-surfaced scars that haven't been confirmed.
 * Only checks scars with source "recall" — session_start scars don't require confirmation.
 */
export function hasUnconfirmedScars(): boolean {
  if (!currentSession) return false;

  const recallScars = currentSession.surfacedScars.filter(s => s.source === "recall");
  if (recallScars.length === 0) return false;

  const confirmedIds = new Set(currentSession.confirmations.map(c => c.scar_id));
  return recallScars.some(s => !confirmedIds.has(s.scar_id));
}

// Security: cap unbounded arrays to prevent memory exhaustion in long sessions
const MAX_OBSERVATIONS = 500;
const MAX_CHILDREN = 100;

/**
 * v2 Phase 2: Add observations from sub-agents/teammates
 */
export function addObservations(newObs: Observation[]): number {
  if (!currentSession) {
    console.warn("[session-state] Cannot add observations: no active session");
    return 0;
  }
  const timestamped = newObs.map(o => ({
    ...o,
    absorbed_at: o.absorbed_at || new Date().toISOString(),
  }));
  currentSession.observations.push(...timestamped);
  // Cap to prevent memory exhaustion — keep most recent
  if (currentSession.observations.length > MAX_OBSERVATIONS) {
    currentSession.observations = currentSession.observations.slice(-MAX_OBSERVATIONS);
  }
  console.error(`[session-state] Observations tracked: ${currentSession.observations.length} total`);
  return timestamped.length;
}

/**
 * v2 Phase 2: Get all observations for the current session
 */
export function getObservations(): Observation[] {
  return currentSession?.observations || [];
}

/**
 * v2 Phase 2: Register a child agent in the current session
 */
export function addChild(child: SessionChild): void {
  if (!currentSession) {
    console.warn("[session-state] Cannot add child: no active session");
    return;
  }
  // Cap to prevent memory exhaustion — reject silently beyond limit
  if (currentSession.children.length >= MAX_CHILDREN) {
    console.warn(`[session-state] Children cap reached (${MAX_CHILDREN}), ignoring new child: ${child.role}`);
    return;
  }
  currentSession.children.push(child);
  console.error(`[session-state] Child registered: ${child.role} (${child.type}), total: ${currentSession.children.length}`);
}

/**
 * v2 Phase 2: Get all children for the current session
 */
export function getChildren(): SessionChild[] {
  return currentSession?.children || [];
}

/**
 * Compute session activity signals for close type validation.
 * Returns null if no active session (e.g., recovered from registry).
 */
export interface SessionActivity {
  duration_min: number;
  recall_count: number;       // Scars from "recall" (excludes session_start auto-scars)
  observation_count: number;
  children_count: number;
  thread_count: number;       // Open threads in current session
}

export function getSessionActivity(): SessionActivity | null {
  if (!currentSession) return null;

  const durationMs = Date.now() - currentSession.startedAt.getTime();

  return {
    duration_min: durationMs / (1000 * 60),
    recall_count: currentSession.surfacedScars.filter(s => s.source === "recall").length,
    observation_count: currentSession.observations.length,
    children_count: currentSession.children.length,
    thread_count: currentSession.threads.filter(t => t.status === "open").length,
  };
}

/**
 * : Set threads for the current session
 */
export function setThreads(threads: ThreadObject[]): void {
  if (!currentSession) {
    console.warn("[session-state] Cannot set threads: no active session");
    return;
  }
  currentSession.threads = threads;
  console.error(`[session-state] Threads set: ${threads.length} total`);
}

/**
 * : Get threads for the current session
 */
export function getThreads(): ThreadObject[] {
  return currentSession?.threads || [];
}

/**
 * Get the current feedback submission count for rate limiting.
 */
export function getFeedbackCount(): number {
  return currentSession?.feedbackSubmitCount ?? 0;
}

/**
 * Increment and return the feedback submission count.
 */
export function incrementFeedbackCount(): number {
  if (!currentSession) return 0;
  return ++currentSession.feedbackSubmitCount;
}

/**
 * : Resolve a thread in session state by ID.
 * Returns the resolved thread or null if not found.
 */
export function resolveThreadInState(threadId: string, resolutionNote?: string): ThreadObject | null {
  if (!currentSession) return null;
  const thread = currentSession.threads.find((t) => t.id === threadId);
  if (!thread || thread.status === "resolved") return thread || null;

  thread.status = "resolved";
  thread.resolved_at = new Date().toISOString();
  thread.resolved_by_session = currentSession.sessionId;
  if (resolutionNote) thread.resolution_note = resolutionNote;

  console.error(`[session-state] Thread resolved: ${threadId}`);
  return thread;
}

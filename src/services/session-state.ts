/**
 * Session State Management
 * OD-547: Track current session context for auto-injecting into recall calls
 * OD-552: Track surfaced scars for auto-bridging Q6 answers to scar_usage records
 *
 * Maintains in-memory state of the current active session including:
 * - session_id from session_start
 * - linear_issue if working on a Linear issue
 * - agent identity
 * - surfaced scars (accumulated from session_start + recall calls)
 *
 * This allows recall() to always assign variants even without explicit parameters.
 */

import type { SurfacedScar, Observation, SessionChild, ThreadObject } from "../types/index.js";

interface SessionContext {
  sessionId: string;
  linearIssue?: string;
  agent?: string;
  startedAt: Date;
  surfacedScars: SurfacedScar[]; // OD-552: Track all scars surfaced during session
  observations: Observation[];   // v2 Phase 2: Sub-agent/teammate observations
  children: SessionChild[];      // v2 Phase 2: Child agent records
  threads: ThreadObject[];       // OD-thread-lifecycle: Working thread state
}

// Global session state (single active session per MCP server instance)
let currentSession: SessionContext | null = null;

/**
 * Set the current active session
 * Called by session_start
 */
export function setCurrentSession(context: Omit<SessionContext, 'surfacedScars' | 'observations' | 'children' | 'threads'> & { surfacedScars?: SurfacedScar[]; threads?: ThreadObject[] }): void {
  currentSession = {
    ...context,
    surfacedScars: context.surfacedScars || [],
    observations: [],
    children: [],
    threads: context.threads || [],
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
 * Check if currently working on a Linear issue
 */
export function hasActiveIssue(): boolean {
  return !!(currentSession?.linearIssue);
}

/**
 * OD-552: Add surfaced scars to tracking (deduplicates by scar_id)
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
 * OD-552: Get all surfaced scars for the current session
 */
export function getSurfacedScars(): SurfacedScar[] {
  return currentSession?.surfacedScars || [];
}

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
 * OD-thread-lifecycle: Set threads for the current session
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
 * OD-thread-lifecycle: Get threads for the current session
 */
export function getThreads(): ThreadObject[] {
  return currentSession?.threads || [];
}

/**
 * OD-thread-lifecycle: Resolve a thread in session state by ID.
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

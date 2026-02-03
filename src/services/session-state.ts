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

import type { SurfacedScar } from "../types/index.js";

interface SessionContext {
  sessionId: string;
  linearIssue?: string;
  agent?: string;
  startedAt: Date;
  surfacedScars: SurfacedScar[]; // OD-552: Track all scars surfaced during session
}

// Global session state (single active session per MCP server instance)
let currentSession: SessionContext | null = null;

/**
 * Set the current active session
 * Called by session_start
 */
export function setCurrentSession(context: Omit<SessionContext, 'surfacedScars'> & { surfacedScars?: SurfacedScar[] }): void {
  currentSession = {
    ...context,
    surfacedScars: context.surfacedScars || [], // OD-552: Initialize empty if not provided
  };
  console.log(`[session-state] Active session set: ${context.sessionId}${context.linearIssue ? ` (issue: ${context.linearIssue})` : ''}`);
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
    console.log(`[session-state] Clearing session: ${currentSession.sessionId}`);
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

  console.log(`[session-state] Surfaced scars tracked: ${currentSession.surfacedScars.length} total`);
}

/**
 * OD-552: Get all surfaced scars for the current session
 */
export function getSurfacedScars(): SurfacedScar[] {
  return currentSession?.surfacedScars || [];
}

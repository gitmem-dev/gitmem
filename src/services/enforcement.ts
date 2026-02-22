/**
 * Server-Side Enforcement Layer
 *
 * Advisory warnings that surface in tool responses when the agent
 * hasn't followed the recall → confirm → act protocol.
 *
 * Design principles:
 * - Advisory, not blocking: warnings append to responses, never prevent execution
 * - Zero overhead on compliant calls: only fires when state is missing
 * - Universal: works in ALL MCP clients, no IDE hooks needed
 * - Lightweight: pure in-memory checks, no I/O
 */

import { getCurrentSession, hasUnconfirmedScars, getSurfacedScars, isRecallCalled } from "./session-state.js";

export interface EnforcementResult {
  /** Warning text to prepend to tool response (null = clean, no warning) */
  warning: string | null;
}

/**
 * Tools that require an active session to function properly.
 * Read-only/administrative tools are excluded.
 */
const SESSION_REQUIRED_TOOLS = new Set([
  "recall", "gitmem-r",
  "confirm_scars", "gitmem-cs", "gm-confirm",
  "session_close", "gitmem-sc", "gm-close",
  "session_refresh", "gitmem-sr", "gm-refresh",
  "create_learning", "gitmem-cl", "gm-scar",
  "create_decision", "gitmem-cd",
  "record_scar_usage", "gitmem-rs",
  "record_scar_usage_batch", "gitmem-rsb",
  "prepare_context", "gitmem-pc", "gm-pc",
  "absorb_observations", "gitmem-ao", "gm-absorb",
  "create_thread", "gitmem-ct", "gm-thread-new",
  "resolve_thread", "gitmem-rt", "gm-resolve",
  "save_transcript", "gitmem-st",
]);

/**
 * Tools that represent "consequential actions" — the agent is creating
 * or modifying state. These should ideally happen after recall + confirm.
 */
const CONSEQUENTIAL_TOOLS = new Set([
  "create_learning", "gitmem-cl", "gm-scar",
  "create_decision", "gitmem-cd",
  "create_thread", "gitmem-ct", "gm-thread-new",
  "session_close", "gitmem-sc", "gm-close",
]);

/**
 * Tools that are always safe — no enforcement checks needed.
 * Includes session_start (which creates the session), read-only tools,
 * and administrative tools.
 */
const EXEMPT_TOOLS = new Set([
  "session_start", "gitmem-ss", "gm-open",
  "search", "gitmem-search", "gm-search",
  "log", "gitmem-log", "gm-log",
  "analyze", "gitmem-analyze", "gm-analyze",
  "graph_traverse", "gitmem-graph", "gm-graph",
  "list_threads", "gitmem-lt", "gm-threads",
  "cleanup_threads", "gitmem-cleanup", "gm-cleanup",
  "promote_suggestion", "gitmem-ps", "gm-promote",
  "dismiss_suggestion", "gitmem-ds", "gm-dismiss",
  "archive_learning", "gitmem-al", "gm-archive",
  "get_transcript", "gitmem-gt",
  "search_transcripts", "gitmem-stx", "gm-stx",
  "gitmem-help",
  "health", "gitmem-health", "gm-health",
  "gitmem-cache-status", "gm-cache-s",
  "gitmem-cache-health", "gm-cache-h",
  "gitmem-cache-flush", "gm-cache-f",
]);

/**
 * Run pre-dispatch enforcement checks for a tool call.
 *
 * Returns a warning string to prepend to the response, or null if clean.
 * Never blocks execution — always advisory.
 */
export function checkEnforcement(toolName: string): EnforcementResult {
  // Exempt tools skip all checks
  if (EXEMPT_TOOLS.has(toolName)) {
    return { warning: null };
  }

  const session = getCurrentSession();

  // Check 1: No active session
  if (!session && SESSION_REQUIRED_TOOLS.has(toolName)) {
    return {
      warning: [
        "--- gitmem enforcement ---",
        "No active session. Call session_start() first to initialize memory context.",
        "Without a session, scars won't be tracked and the closing ceremony can't run.",
        "---",
      ].join("\n"),
    };
  }

  // If no session and not session-required, skip remaining checks
  if (!session) {
    return { warning: null };
  }

  // Check 2: Unconfirmed scars before consequential action
  if (CONSEQUENTIAL_TOOLS.has(toolName) && hasUnconfirmedScars()) {
    const recallScars = getSurfacedScars().filter(s => s.source === "recall");
    const confirmedCount = session.confirmations?.length || 0;
    const pendingCount = recallScars.length - confirmedCount;

    return {
      warning: [
        "--- gitmem enforcement ---",
        `${pendingCount} recalled scar(s) await confirmation.`,
        "Call confirm_scars() with APPLYING/N_A/REFUTED for each before proceeding.",
        "Unconfirmed scars may contain warnings relevant to what you're about to do.",
        "---",
      ].join("\n"),
    };
  }

  // Check 3: No recall before consequential action
  // Uses recallCalled boolean to avoid false positives when recall returns 0 scars
  if (CONSEQUENTIAL_TOOLS.has(toolName) && !isRecallCalled()) {
    return {
      warning: [
        "--- gitmem enforcement ---",
        "No recall() was run this session before this action.",
        "Consider calling recall() first to check for relevant institutional memory.",
        "Past mistakes and patterns may prevent repeating known issues.",
        "---",
      ].join("\n"),
    };
  }

  return { warning: null };
}

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
import path from "path";
import type { AgentIdentity, SurfacedScar, ScarConfirmation, ScarReflection, Observation, SessionChild, ThreadObject } from "../types/index.js";
import { getSessionPath, getGitmemDir, sanitizePathComponent } from "./gitmem-dir.js";
import { findResumableSessionOnDisk, listActiveSessions, getRegistryFingerprint } from "./active-sessions.js";
import { withLockSync } from "./file-lock.js";
import { getWriterIdentity } from "./process-identity.js";

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
  /**
   * GIT-51: set when this session was recovered from disk and session.json
   * disagreed with the registry about which project it belongs to. Carried on
   * the context so a consumer can see that its scope rests on a resolved
   * conflict rather than on agreement.
   */
  recoveryConflict?: boolean;
  /**
   * GIT-93: set when a recall() attempt failed to reach the store, cleared when
   * one succeeds.
   *
   * "No scars surfaced" has two causes that used to be indistinguishable:
   * retrieval ran and found nothing relevant, or retrieval never ran. Only the
   * first is safe to proceed on. Without this, confirm_scars answered both with
   * "Proceed freely" — a green result for a broken store, which is how a
   * retrieval path that had never worked survived indefinitely (the *_scar_search
   * RPC 404'd on every call since it was written and nothing downstream said so).
   */
  recallFailure?: { message: string; at: string } | null;
}

// Global session state (single active session per MCP server instance)
let currentSession: SessionContext | null = null;

// GIT-51: recovery reads the registry and a session file, so it does not repeat
// while nothing has changed. Reset whenever state is set or cleared.
let recoveryAttempted = false;

// GIT-51 (reconciliation): the registry fingerprint at the last FAILED recovery.
//
// A plain boolean latch was permanently fail-closed in one real scenario: the
// SessionStart hook runs as a separate CLI process (scar 55d1bccd), so a
// session can appear in the registry AFTER this process has already tried and
// failed to recover. With GIT-67's R5 guard now refusing sessionless writes on
// pro, that combination turns one early miss into every subsequent write being
// refused for the life of the process — a fail-closed bug replacing a fail-open
// one.
//
// Keying the latch on the registry's mtime keeps the I/O-avoidance the boolean
// was for (no repeated reads while nothing changed) without making the failure
// permanent.
let lastFailedRecoveryFingerprint: number | null | undefined = undefined;

/**
 * Set the current active session
 * Called by session_start
 */
export function setCurrentSession(context: Omit<SessionContext, 'recallCalled' | 'surfacedScars' | 'confirmations' | 'reflections' | 'observations' | 'children' | 'threads' | 'feedbackSubmitCount'> & { surfacedScars?: SurfacedScar[]; confirmations?: ScarConfirmation[]; observations?: Observation[]; children?: SessionChild[]; threads?: ThreadObject[] }): void {
  // GIT-128: what the session file already holds is part of the session. A
  // resume, refresh or restart used to start from whatever the caller passed,
  // and the next write replaced the file's confirmations with that.
  const onDisk = readOwnSessionFile(context.sessionId);
  currentSession = {
    ...context,
    recallCalled: false,
    surfacedScars: mergeSurfaced(onDisk?.surfaced_scars, context.surfacedScars),
    confirmations: mergeConfirmations(onDisk?.confirmations, context.confirmations),
    reflections: [],
    observations: context.observations || [],
    children: context.children || [],
    threads: context.threads || [],
    feedbackSubmitCount: 0,
  };
  recoveryAttempted = false;
  console.error(`[session-state] Active session set: ${context.sessionId}${context.linearIssue ? ` (issue: ${context.linearIssue})` : ''}`);
}

// --- GIT-128: append-only session file writes, by the session's own server ---

/** session.json's path without creating the session directory as a side effect. */
function existingSessionFile(sessionId: string): string | null {
  try {
    sanitizePathComponent(sessionId, "sessionId");
    const p = path.join(getGitmemDir(), "sessions", sessionId, "session.json");
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

function readOwnSessionFile(sessionId: string): { surfaced_scars?: unknown; confirmations?: unknown } | null {
  try {
    const p = existingSessionFile(sessionId);
    if (!p) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return data?.session_id === sessionId ? data : null;
  } catch {
    return null;
  }
}

/** Existing entries first and untouched; new scar ids appended. */
function mergeSurfaced(existing: unknown, added: SurfacedScar[] | undefined): SurfacedScar[] {
  const out: SurfacedScar[] = Array.isArray(existing) ? [...existing] : [];
  for (const scar of added || []) {
    if (!out.some((s) => s.scar_id === scar.scar_id)) out.push(scar);
  }
  return out;
}

const confirmationKey = (c: ScarConfirmation) => `${c.scar_id}|${c.confirmed_at}|${c.writer?.server_pid ?? ""}`;

/** Union of two confirmation logs. Nothing is replaced; a re-confirmation is a new entry. */
function mergeConfirmations(existing: unknown, added: ScarConfirmation[] | undefined): ScarConfirmation[] {
  const out: ScarConfirmation[] = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set(out.map(confirmationKey));
  for (const conf of added || []) {
    if (!seen.has(confirmationKey(conf))) {
      out.push(conf);
      seen.add(confirmationKey(conf));
    }
  }
  return out;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read-modify-write session.json under a per-session lock, only while this
 * process serves the session.
 *
 * If session.json names another live server, that server owns the session
 * now and this process must not write into it; the caller is told so instead
 * of the write being dropped or, worse, landing in someone else's session.
 */
function updateOwnSessionFile(
  sessionId: string,
  mutate: (data: Record<string, unknown>) => void,
): { ok: true } | { ok: false; reason: string } {
  try {
    const sessionFilePath = existingSessionFile(sessionId);
    if (!sessionFilePath) return { ok: true }; // nothing on disk to keep in step
    return withLockSync(path.join(path.dirname(sessionFilePath), "session.lock"), () => {
      const data = JSON.parse(fs.readFileSync(sessionFilePath, "utf-8"));
      const filePid = typeof data.pid === "number" ? data.pid : null;
      if (filePid !== null && filePid !== process.pid && isPidAlive(filePid)) {
        return { ok: false as const, reason: `session ${sessionId.slice(0, 8)} is served by another gitmem process (pid ${filePid})` };
      }
      mutate(data);
      const tmp = `${sessionFilePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, sessionFilePath);
      return { ok: true as const };
    });
  } catch (error) {
    return { ok: false, reason: `could not write session file: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * GIT-51: Rebuild in-memory session state from disk after an MCP server restart.
 *
 * Session identity used to live only in `currentSession`, which dies with the
 * process, and only session_start could rebuild it. Agents don't call
 * session_start again mid-session, so every session-required tool reported "No
 * active session" for the rest of a session that was alive and healthy — and
 * session_close couldn't resolve which session to close.
 *
 * Recovery runs here instead, so *any* tool call re-binds identity.
 *
 * GIT-89: identity now resolves from the per-session directories rather than
 * from the active-sessions registry. Registry-gated recovery could not rescue a
 * session whose registry entry was lost or written under a different .gitmem
 * root — the common case in practice — even with session.json intact on disk.
 * The registry is repaired from the scan instead of gating it.
 *
 * Returns null when there is genuinely no session — never invents one.
 */
function recoverSessionFromDisk(): SessionContext | null {
  try {
    // GIT-89: snapshot the registry's view BEFORE resolving. Resolution repairs
    // the registry from disk, so reading it afterwards would compare session.json
    // against a copy of itself and never see a disagreement.
    const registryBefore = listActiveSessions();

    const entry = findResumableSessionOnDisk();
    if (!entry) return null;

    const registryEntry = registryBefore.find((s) => s.session_id === entry.session_id) ?? null;
    const sessionFilePath = getSessionPath(entry.session_id, "session.json");
    if (!fs.existsSync(sessionFilePath)) return null;

    const data = JSON.parse(fs.readFileSync(sessionFilePath, "utf-8"));
    if (!data.session_id) return null;

    // GIT-51 (reconciliation): explicit precedence with loud disagreement.
    //
    // This was `data.project || entry.project` — a silent two-source fallback.
    // When session.json and the registry disagree, session.json won and nothing
    // said so, and every downstream consumer inherited a project the registry
    // never agreed to. GIT-69's scope resolver keys on (project, sessionId), so
    // a wrong project here scopes the whole session to the wrong namespace —
    // the cross-project leak class arriving through a new door.
    //
    // Precedence is unchanged and now documented: session.json is authoritative
    // because it is written by the session itself, while the registry entry is
    // an index that can lag. The difference is that a conflict is now recorded
    // and logged rather than resolved in silence.
    //
    // GIT-89: compared against the pre-resolution registry snapshot. `entry` is
    // derived from session.json now, so comparing the two would always agree.
    const recoveryConflict =
      Boolean(data.project) &&
      Boolean(registryEntry?.project) &&
      data.project !== registryEntry?.project;

    if (recoveryConflict) {
      console.error(
        `[session-state] RECOVERY CONFLICT for ${String(data.session_id).slice(0, 8)}: ` +
        `session.json project "${data.project}" != registry project "${registryEntry?.project}". ` +
        `Using session.json (authoritative); registry entry is a lagging index.`
      );
    }

    setCurrentSession({
      sessionId: data.session_id,
      linearIssue: data.linear_issue,
      agent: data.agent || entry.agent,
      project: data.project ?? entry.project,
      startedAt: data.started_at ? new Date(data.started_at) : new Date(entry.started_at),
      surfacedScars: Array.isArray(data.surfaced_scars) ? data.surfaced_scars : [],
      // GIT-128: confirmations survive the restart too; confirm_scars credits them.
      confirmations: Array.isArray(data.confirmations) ? data.confirmations : [],
      threads: Array.isArray(data.threads) ? data.threads : [],
      recoveryConflict,
    });

    // GIT-89: restore the recall flag. setCurrentSession resets it to false,
    // which would make enforcement Check 3 warn that recall never ran in a
    // session where it had — a false alarm that survives the identity fix.
    if (currentSession && data.recall_called === true) {
      currentSession.recallCalled = true;
    }

    // GIT-93: restore an unresolved retrieval failure too. A restart must not
    // launder a broken store into a clean slate — otherwise the very event this
    // session state exists to survive becomes a way to lose the warning.
    if (currentSession && data.recall_failure) {
      currentSession.recallFailure = data.recall_failure;
    }

    console.error(
      `[session-state] Recovered session ${data.session_id.slice(0, 8)} from disk after MCP restart ` +
      `(${currentSession?.surfacedScars.length ?? 0} surfaced scars)`
    );
    return currentSession;
  } catch (error) {
    console.warn("[session-state] Failed to recover session from disk:", error);
    return null;
  }
}

/**
 * Resolve the active session, recovering from disk if in-memory state was lost
 * to an MCP server restart (GIT-51).
 */
export function resolveCurrentSession(): SessionContext | null {
  if (currentSession) return currentSession;

  // Retry whenever the registry has changed since the last failure — another
  // process (the SessionStart hook) may have registered a session in between.
  const fingerprint = getRegistryFingerprint();
  if (recoveryAttempted && lastFailedRecoveryFingerprint === fingerprint) {
    return null;
  }

  recoveryAttempted = true;
  const recovered = recoverSessionFromDisk();
  lastFailedRecoveryFingerprint = recovered ? undefined : fingerprint;
  return recovered;
}

/**
 * Get the current active session
 * Returns null if no session active
 */
export function getCurrentSession(): SessionContext | null {
  return resolveCurrentSession();
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
  recoveryAttempted = false;
}

/**
 * Get the active session's project, or null if no session.
 * Used by list_threads to inherit the correct project default.
 */
export function getProject(): string | null {
  // GIT-89: resolves rather than reading in-memory state. After a restart this
  // returned null and callers silently fell back to project "default", scoping
  // the rest of the session to the wrong namespace.
  return resolveCurrentSession()?.project || null;
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
 *
 * GIT-89: persisted to session.json. This flag drove enforcement Check 3 ("No
 * recall() was run this session"), and it lived only in memory — so after an
 * MCP restart every create_learning / create_decision / session_close warned
 * that recall had never run, in sessions where it demonstrably had. That is the
 * same class of false alarm as the "No active session" banner: a warning the
 * agent learns to read past, which is what erodes the enforcement layer.
 */
export function setRecallCalled(): void {
  const session = resolveCurrentSession();
  if (!session) return;

  session.recallCalled = true;
  console.error("[session-state] recall() marked as called");

  try {
    const sessionFilePath = getSessionPath(session.sessionId, "session.json");
    if (!fs.existsSync(sessionFilePath)) return;
    const data = JSON.parse(fs.readFileSync(sessionFilePath, "utf-8"));
    if (data.recall_called === true) return; // already recorded — no write
    data.recall_called = true;
    fs.writeFileSync(sessionFilePath, JSON.stringify(data, null, 2));
  } catch (error) {
    // Non-fatal: the flag still holds for this process.
    console.warn("[session-state] Failed to persist recall_called:", error);
  }
}

/**
 * GIT-93: record that a recall() attempt could not reach the store.
 *
 * Persisted alongside recall_called so it survives an MCP restart, for the same
 * reason: the failure outlives the process that observed it, and a restart must
 * not turn a broken store into an apparently clean one.
 */
export function setRecallFailure(message: string): void {
  const session = resolveCurrentSession();
  if (!session) return;

  const failure = { message, at: new Date().toISOString() };
  session.recallFailure = failure;
  console.error(`[session-state] recall() failure recorded: ${message.slice(0, 120)}`);

  try {
    const sessionFilePath = getSessionPath(session.sessionId, "session.json");
    if (!fs.existsSync(sessionFilePath)) return;
    const data = JSON.parse(fs.readFileSync(sessionFilePath, "utf-8"));
    data.recall_failure = failure;
    fs.writeFileSync(sessionFilePath, JSON.stringify(data, null, 2));
  } catch (error) {
    // Non-fatal: the flag still holds for this process.
    console.warn("[session-state] Failed to persist recall_failure:", error);
  }
}

/**
 * GIT-93: clear the failure marker after a recall() that reached the store.
 *
 * Cleared on success rather than on attempt, and regardless of how many scars
 * came back: a successful search returning nothing is a real answer, while a
 * failed one is not an answer at all. Only the former should let confirm_scars
 * say "proceed".
 */
export function clearRecallFailure(): void {
  const session = resolveCurrentSession();
  if (!session || !session.recallFailure) return;

  session.recallFailure = null;

  try {
    const sessionFilePath = getSessionPath(session.sessionId, "session.json");
    if (!fs.existsSync(sessionFilePath)) return;
    const data = JSON.parse(fs.readFileSync(sessionFilePath, "utf-8"));
    if (!data.recall_failure) return; // nothing recorded — no write
    delete data.recall_failure;
    fs.writeFileSync(sessionFilePath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.warn("[session-state] Failed to clear recall_failure:", error);
  }
}

/**
 * GIT-93: the unresolved retrieval failure for this session, if any.
 *
 * Returns null when retrieval last succeeded — which is the only state in which
 * an empty scar set means "nothing relevant" rather than "nothing was asked".
 */
export function getRecallFailure(): { message: string; at: string } | null {
  return resolveCurrentSession()?.recallFailure ?? null;
}

/**
 * Check if recall() was called this session.
 * Used by enforcement to avoid false positives when recall returns 0 scars.
 */
export function isRecallCalled(): boolean {
  // GIT-89: resolves rather than reading in-memory state, so the flag restored
  // from session.json is visible to callers that reach this directly.
  return resolveCurrentSession()?.recallCalled ?? false;
}

/**
 * Add surfaced scars to tracking (deduplicates by scar_id)
 * Called by session_start and recall when scars are surfaced.
 *
 * GIT-89: returns whether the scars were actually tracked.
 *
 * This used to read `currentSession` directly and, when it was null, log a
 * console warning and return. That was the silent discard behind the
 * recall/confirm_scars asymmetry (scar 810a1624): recall printed scars to the
 * agent, nothing recorded that it had, and confirm_scars later rejected with
 * nothing to confirm. The agent saw a green "no scars to confirm" for scars it
 * had just been shown.
 *
 * Two changes close that gap. Identity is resolved (so a session recovered
 * after an MCP restart still tracks), and the outcome is returned so callers
 * can fail as loudly as confirm_scars does instead of proceeding as if tracked.
 */
export function addSurfacedScars(scars: SurfacedScar[]): boolean {
  const session = resolveCurrentSession();
  if (!session) {
    console.warn("[session-state] Cannot add surfaced scars: no active session");
    return false;
  }

  // GIT-128: refuse before tracking anything if another live server owns the
  // session — tracking in memory alone would show this agent scars its gate
  // never sees.
  const writer = getWriterIdentity((session.agent as AgentIdentity) || "Unknown");
  const stamped = scars.map((s) => (s.writer ? s : { ...s, writer }));
  const persisted = persistSurfacedScars(session, stamped);
  if (!persisted.ok) {
    console.warn(`[session-state] Surfaced scars not tracked: ${persisted.reason}`);
    return false;
  }

  session.surfacedScars = mergeSurfaced(session.surfacedScars, stamped);
  console.error(`[session-state] Surfaced scars tracked: ${session.surfacedScars.length} total`);
  return true;
}

/**
 * GIT-89: Write surfaced scars through to session.json.
 *
 * Surfacing has to outlive the process that did it. If it lives only in memory,
 * an MCP restart between recall and confirm_scars loses it, and the identity
 * break turns into a tracking break. Centralised here so there is exactly one
 * writer — callers previously did this inline and only on their own success path.
 *
 * GIT-128: appends to what the file holds rather than replacing it with this
 * process's in-memory list, and only while this process serves the session.
 */
function persistSurfacedScars(session: SessionContext, added: SurfacedScar[]): { ok: true } | { ok: false; reason: string } {
  return updateOwnSessionFile(session.sessionId, (data) => {
    data.surfaced_scars = mergeSurfaced(data.surfaced_scars, mergeSurfaced(session.surfacedScars, added));
  });
}

/**
 * Get all surfaced scars for the current session
 */
export function getSurfacedScars(): SurfacedScar[] {
  // Resolve identity first — after an MCP restart this rebuilds currentSession
  // (including its scars) from the session file (GIT-51).
  const session = resolveCurrentSession();

  // Return in-memory if available
  if (session?.surfacedScars && session.surfacedScars.length > 0) {
    return session.surfacedScars;
  }

  // Fallback: re-read the resolved session's file. Covers the case where
  // identity survived but the scars array did not — e.g. scars were appended by
  // another process, or by this session before an in-place refresh.
  //
  // GIT-51: this deliberately reads only the *resolved* session's file. The
  // previous "newest session on this host" fallback could hand one session
  // another concurrent session's scars.
  if (session?.sessionId) {
    try {
      const sessionFilePath = getSessionPath(session.sessionId, "session.json");
      if (fs.existsSync(sessionFilePath)) {
        const data = JSON.parse(fs.readFileSync(sessionFilePath, "utf-8"));
        if (data.surfaced_scars && Array.isArray(data.surfaced_scars) && data.surfaced_scars.length > 0) {
          session.surfacedScars = data.surfaced_scars;
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
 *
 * GIT-128: append-only, in memory and in session.json, each entry stamped with
 * its writer. This used to replace by scar_id in memory and write only the
 * latest batch to the file, so a second confirm_scars call — from this agent
 * or from another client attached to the same file — erased the first.
 * Returns why the confirmations could not be recorded, or null on success.
 */
export function addConfirmations(confirmations: ScarConfirmation[]): string | null {
  const session = resolveCurrentSession();
  if (!session) {
    console.warn("[session-state] Cannot add confirmations: no active session");
    return "no active session";
  }

  const writer = getWriterIdentity((session.agent as AgentIdentity) || "Unknown");
  const stamped = confirmations.map((c) => (c.writer ? c : { ...c, writer }));
  const persisted = updateOwnSessionFile(session.sessionId, (data) => {
    data.confirmations = mergeConfirmations(data.confirmations, stamped);
    data.surfaced_scars = mergeSurfaced(data.surfaced_scars, session.surfacedScars);
  });
  if (!persisted.ok) {
    console.warn(`[session-state] Confirmations not recorded: ${persisted.reason}`);
    return persisted.reason;
  }

  session.confirmations = mergeConfirmations(session.confirmations, stamped);
  console.error(`[session-state] Confirmations tracked: ${session.confirmations.length} entries`);
  return null;
}

/**
 * The current confirmation for each scar: the latest entry per scar_id.
 * The full history is getConfirmationLog().
 */
export function getConfirmations(): ScarConfirmation[] {
  const latest = new Map<string, ScarConfirmation>();
  for (const conf of currentSession?.confirmations || []) {
    latest.set(conf.scar_id, conf);
  }
  return [...latest.values()];
}

/** GIT-128: every confirmation recorded in this session, oldest first. */
export function getConfirmationLog(): ScarConfirmation[] {
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

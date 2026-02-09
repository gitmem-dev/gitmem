/**
 * session_start Tool
 *
 * Initialize session, detect agent, load institutional context.
 * Returns last session, relevant scars, and recent decisions.
 *
 * Performance target: <1500ms (OD-429, revised Feb 2026)
 *
 * OD-473: Uses local vector search for consistent scar results.
 * No file-based caching = no race conditions = deterministic results.
 */

import * as fs from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import { detectAgent } from "../services/agent-detection.js";
import * as supabase from "../services/supabase-client.js";
import { ensureInitialized, isLocalSearchAvailable } from "../services/startup.js";
import { localScarSearch } from "../services/local-vector-search.js";
import { hasSupabase } from "../services/tier.js";
import { getStorage } from "../services/storage.js";
import {
  Timer,
  recordMetrics,
  calculateContextBytes,
  PERFORMANCE_TARGETS,
  buildPerformanceData,
  buildComponentPerformance,
} from "../services/metrics.js";
import { setCurrentSession, getCurrentSession, addSurfacedScars, getSurfacedScars, setThreads } from "../services/session-state.js"; // OD-547, OD-552
import { aggregateThreads, saveThreadsFile, loadThreadsFile, mergeThreadStates } from "../services/thread-manager.js"; // OD-thread-lifecycle
import { setGitmemDir, getGitmemDir, getSessionPath } from "../services/gitmem-dir.js";
import { registerSession, findSessionByHostPid, pruneStale, migrateFromLegacy } from "../services/active-sessions.js";
import * as os from "os";
import { formatDate } from "../services/timezone.js";
import type { PerformanceBreakdown, ComponentPerformance, SurfacedScar } from "../types/index.js";
import type {
  SessionStartParams,
  SessionStartResult,
  LastSession,
  RelevantScar,
  RecentDecision,
  RecentWin,
  AgentIdentity,
  Project,
  ThreadObject,
} from "../types/index.js";

// Supabase record types
interface SessionRecord {
  id: string;
  session_title: string;
  session_date: string;
  decisions?: (string | { title: string; decision?: string })[];
  open_threads?: (string | ThreadObject)[];
  close_compliance?: Record<string, unknown> | null;
  // From lite view (counts only)
  decision_count?: number;
  open_thread_count?: number;
}

/**
 * Normalize decisions from mixed formats (strings or objects) to string[].
 * Historical sessions (pre-2026) stored {title, decision} objects.
 * Current code stores title strings only.
 */
function normalizeDecisions(decisions: (string | { title: string; decision?: string })[]): string[] {
  return decisions.map((d) =>
    typeof d === "string" ? d : d.title
  );
}

interface ScarRecord {
  id: string;
  title: string;
  description: string;
  severity: string;
  counter_arguments?: string[];
  similarity?: number;
}

interface DecisionRecord {
  id: string;
  title: string;
  decision: string;
  decision_date: string;
  project?: string;
}

interface WinRecord {
  id: string;
  title: string;
  description: string;
  created_at: string;
  source_linear_issue?: string;
}

/**
 * Aggregate open threads across multiple recent sessions.
 * Deduplicates by exact lowercase match. Excludes PROJECT STATE: threads
 * (handled separately). Only includes sessions from the last maxAgeDays.
 */
// aggregateOpenThreads replaced by aggregateThreads from thread-manager.ts (OD-thread-lifecycle)

/**
 * Load the last CLOSED session for this agent.
 * Filters out orphaned sessions (those without close_compliance).
 * Uses _lite view for performance (OD-460 added arrays to view).
 *
 * OD-489: Returns timing and network call info for instrumentation.
 */
async function loadLastSession(
  agent: AgentIdentity,
  project: Project
): Promise<{
  session: LastSession | null;
  aggregated_open_threads: ThreadObject[];
  recently_resolved_threads: ThreadObject[];
  latency_ms: number;
  network_call: boolean;
}> {
  const timer = new Timer();

  try {
    // Use _lite view for performance (excludes embedding)
    // OD-460: View now includes decisions/open_threads arrays
    const sessions = await supabase.listRecords<SessionRecord>({
      table: "orchestra_sessions_lite",
      filters: { agent, project },
      limit: 10, // Get several to find a closed one + aggregate threads
      orderBy: { column: "created_at", ascending: false },
    });

    const latency_ms = timer.stop();

    // Aggregate open threads across last 5 closed sessions (OD-thread-lifecycle: returns ThreadObject[])
    const threadResult = aggregateThreads(sessions);
    const aggregated_open_threads = threadResult.open;
    const recently_resolved_threads = threadResult.recently_resolved;
    console.error(`[session_start] Aggregated ${aggregated_open_threads.length} open threads, ${recently_resolved_threads.length} recently resolved`);

    if (sessions.length === 0) {
      return { session: null, aggregated_open_threads, recently_resolved_threads, latency_ms, network_call: true };
    }

    // Find the most recent session that was properly closed
    const closedSession = sessions.find((s) => s.close_compliance != null);

    if (!closedSession) {
      // Fall back to most recent if none are closed (shouldn't happen often)
      console.error("[session_start] No closed sessions found, using most recent");
      const session = sessions[0];
      return {
        session: {
          id: session.id,
          title: session.session_title || "Untitled Session",
          date: formatDate(session.session_date),
          key_decisions: normalizeDecisions(session.decisions || []),
          open_threads: session.open_threads || [],
        },
        aggregated_open_threads,
        recently_resolved_threads,
        latency_ms,
        network_call: true,
      };
    }

    return {
      session: {
        id: closedSession.id,
        title: closedSession.session_title || "Untitled Session",
        date: formatDate(closedSession.session_date),
        key_decisions: normalizeDecisions(closedSession.decisions || []),
        open_threads: closedSession.open_threads || [],
      },
      aggregated_open_threads,
      recently_resolved_threads,
      latency_ms,
      network_call: true, // Always hits Supabase (no caching for sessions yet)
    };
  } catch (error) {
    console.error("[session_start] Failed to load last session:", error);
    return { session: null, aggregated_open_threads: [], recently_resolved_threads: [], latency_ms: timer.stop(), network_call: true };
  }
}

/**
 * Query relevant scars based on issue or session context
 *
 * OD-473: Uses local vector search for deterministic results.
 * - No file-based cache = no race conditions
 * - Same query = same results every time
 * - No Supabase hit = fast & scalable
 *
 * OD-489: Returns timing and network call info for instrumentation.
 */
async function queryRelevantScars(
  issueTitle?: string,
  issueDescription?: string,
  issueLabels?: string[],
  project?: Project,
  lastSession?: LastSession | null
): Promise<{
  scars: RelevantScar[];
  local_search: boolean;
  latency_ms: number;
  network_call: boolean;
}> {
  const proj = project || "orchestra_dev";
  const timer = new Timer();

  try {
    // Build query from available context
    const queryParts: string[] = [];
    if (issueTitle) queryParts.push(issueTitle);
    if (issueDescription) queryParts.push(issueDescription.slice(0, 200));
    if (issueLabels?.length) queryParts.push(issueLabels.join(" "));

    // Use last session context if no issue context provided
    // Include title, decisions, and open threads for richer scar matching
    if (queryParts.length === 0 && lastSession) {
      if (lastSession.title && lastSession.title !== "Interactive Session") {
        queryParts.push(lastSession.title);
      }
      if (lastSession.key_decisions?.length) {
        // Include up to 3 decisions to avoid query bloat
        queryParts.push(lastSession.key_decisions.slice(0, 3).join(" "));
      }
      if (lastSession.open_threads?.length) {
        // Include up to 3 open threads
        queryParts.push(lastSession.open_threads.slice(0, 3).map(t => typeof t === "string" ? t : t.text).join(" "));
      }
    }

    // Default query only if nothing else available
    const query = queryParts.length > 0
      ? queryParts.join(" ")
      : "deployment verification testing integration";

    // Ensure local search is initialized
    await ensureInitialized(proj);

    // Use local vector search if available (OD-473)
    if (isLocalSearchAvailable(proj)) {
      console.error("[session_start] Using local vector search");
      const scars = await localScarSearch(query, 5, proj);
      const latency_ms = timer.stop();
      return {
        scars,
        local_search: true,
        latency_ms,
        network_call: false, // LOCAL - no network call!
      };
    }

    // Fallback to Supabase if local search not available
    console.error("[session_start] Falling back to Supabase scar search");
    const { results } = await supabase.cachedScarSearch<ScarRecord>(
      query,
      5,
      proj
    );

    const scars = results.map((scar) => ({
      id: scar.id,
      title: scar.title,
      severity: scar.severity || "medium",
      description: scar.description || "",
      counter_arguments: scar.counter_arguments || [],
      similarity: scar.similarity || 0,
    }));

    const latency_ms = timer.stop();
    return {
      scars,
      local_search: false,
      latency_ms,
      network_call: true, // REMOTE - hit Supabase
    };
  } catch (error) {
    console.error("[session_start] Failed to query scars:", error);
    return {
      scars: [],
      local_search: false,
      latency_ms: timer.stop(),
      network_call: true, // Assume network was attempted
    };
  }
}

/**
 * Load recent decisions with caching (OD-473)
 *
 * OD-489: Returns timing and network call info for instrumentation.
 */
async function loadRecentDecisions(
  project: Project,
  limit = 5
): Promise<{
  decisions: RecentDecision[];
  cache_hit: boolean;
  cache_age_ms?: number;
  latency_ms: number;
  network_call: boolean;
}> {
  const timer = new Timer();

  try {
    // Use cached decisions query (OD-473)
    // Fetch extra to account for date filtering
    const { data: decisions, cache_hit, cache_age_ms } = await supabase.cachedListDecisions<DecisionRecord>(
      project,
      limit + 5
    );

    // Filter by project in memory if needed (ww-mcp filters may not work with views)
    const filtered = project
      ? decisions.filter((d) => d.project === project)
      : decisions;

    // Time-scope to last 5 days — stale decisions add noise, not context
    const decisionCutoff = new Date();
    decisionCutoff.setDate(decisionCutoff.getDate() - 5);
    const decisionCutoffStr = decisionCutoff.toISOString().split("T")[0];
    const timeScoped = filtered.filter((d) => d.decision_date >= decisionCutoffStr);

    const latency_ms = timer.stop();
    console.error(`[session_start] Loaded ${decisions.length} decisions, ${filtered.length} after project filter, ${timeScoped.length} after 5-day scope, cache_hit=${cache_hit}`);

    const result = timeScoped.slice(0, limit).map((d) => ({
      id: d.id,
      title: d.title,
      decision: d.decision,
      date: formatDate(d.decision_date),
    }));

    return {
      decisions: result,
      cache_hit,
      cache_age_ms,
      latency_ms,
      network_call: !cache_hit, // Network call only if cache miss
    };
  } catch (error) {
    console.error("[session_start] Failed to load decisions:", error);
    return {
      decisions: [],
      cache_hit: false,
      latency_ms: timer.stop(),
      network_call: true,
    };
  }
}

/**
 * Load recent wins from institutional memory.
 * Queries orchestra_learnings_lite for learning_type="win".
 * Runs in parallel with scars/decisions — hidden by scar search bottleneck.
 */
async function loadRecentWins(
  project: Project,
  limit = 3,
  maxAgeDays = 7
): Promise<{
  wins: RecentWin[];
  cache_hit: boolean;
  cache_age_ms?: number;
  latency_ms: number;
  network_call: boolean;
}> {
  const timer = new Timer();

  try {
    // Use cached wins query (same pattern as cachedListDecisions)
    const { data: records, cache_hit, cache_age_ms } = await supabase.cachedListWins<WinRecord>(
      project,
      limit + 5, // Fetch extra for date filtering
      "id,title,description,created_at,source_linear_issue"
    );

    const latency_ms = timer.stop();

    // Filter to last N days in-memory
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);
    const cutoffStr = cutoff.toISOString();

    const filtered = records
      .filter((r) => r.created_at >= cutoffStr)
      .slice(0, limit);

    const wins = filtered.map((r) => ({
      id: r.id,
      title: r.title,
      description: (r.description || "").slice(0, 200),
      date: formatDate(r.created_at.split("T")[0]),
      source_issue: r.source_linear_issue,
    }));

    console.error(`[session_start] Loaded ${records.length} wins, ${wins.length} after date filter, cache_hit=${cache_hit}`);

    return {
      wins,
      cache_hit,
      cache_age_ms,
      latency_ms,
      network_call: !cache_hit,
    };
  } catch (error) {
    console.error("[session_start] Failed to load wins:", error);
    return {
      wins: [],
      cache_hit: false,
      latency_ms: timer.stop(),
      network_call: true,
    };
  }
}

/**
 * Create a new session record
 *
 * OD-489: Returns timing and network call info for instrumentation.
 */
async function createSessionRecord(
  agent: AgentIdentity,
  project: Project,
  linearIssue?: string
): Promise<{ session_id: string; latency_ms: number; network_call: boolean }> {
  const sessionId = uuidv4();
  const today = new Date().toISOString().split("T")[0];
  const timer = new Timer();

  try {
    // OD-cast: Capture asciinema recording path from Docker entrypoint
    const recordingPath = process.env.GITMEM_RECORDING_PATH || null;

    await supabase.directUpsert("orchestra_sessions", {
      id: sessionId,
      session_date: today,
      session_title: linearIssue ? `Session for ${linearIssue}` : "Interactive Session",
      project,
      agent,
      linear_issue: linearIssue || null,
      recording_path: recordingPath,
      // Will be populated on close
      decisions: [],
      open_threads: [],
      closing_reflection: null,
      close_compliance: null,
    });
    return {
      session_id: sessionId,
      latency_ms: timer.stop(),
      network_call: true, // Always writes to Supabase
    };
  } catch (error) {
    console.error("[session_start] Failed to create session record:", error);
    // Return ID anyway - session can be created on close
    return {
      session_id: sessionId,
      latency_ms: timer.stop(),
      network_call: true, // Network was attempted
    };
  }
}

/**
 * Free tier session_start — all-local, no Supabase
 */
async function sessionStartFree(
  params: SessionStartParams,
  env: { entrypoint: string | null; docker: boolean; hostname: string; agent: AgentIdentity },
  agent: AgentIdentity,
  project: Project,
  timer: Timer,
  metricsId: string,
  existingSessionId?: string
): Promise<SessionStartResult> {
  const storage = getStorage();
  const isResuming = !!existingSessionId;
  const sessionId = existingSessionId || uuidv4();
  const today = new Date().toISOString().split("T")[0];

  // Load last session from local storage
  let lastSession: LastSession | null = null;
  let freeAggregatedThreads: ThreadObject[] = [];
  let freeRecentlyResolved: ThreadObject[] = [];
  try {
    const sessions = await storage.query<SessionRecord & Record<string, unknown>>("sessions", {
      order: "session_date.desc",
      limit: 10,
    });
    // Aggregate threads across recent sessions (OD-thread-lifecycle)
    const freeThreadResult = aggregateThreads(sessions as SessionRecord[]);
    freeAggregatedThreads = freeThreadResult.open;
    freeRecentlyResolved = freeThreadResult.recently_resolved;

    const closedSession = sessions.find((s) => s.close_compliance != null) || sessions[0];
    if (closedSession) {
      lastSession = {
        id: closedSession.id,
        title: closedSession.session_title || "Untitled Session",
        date: formatDate(closedSession.session_date),
        key_decisions: normalizeDecisions(closedSession.decisions || []),
        open_threads: closedSession.open_threads || [],
      };
    }
  } catch (error) {
    console.error("[session_start] Failed to load last session:", error);
  }

  // Query scars using keyword search
  let scars: RelevantScar[] = [];
  try {
    const queryParts: string[] = [];
    if (params.issue_title) queryParts.push(params.issue_title);
    if (params.issue_description) queryParts.push(params.issue_description.slice(0, 200));
    if (params.issue_labels?.length) queryParts.push(params.issue_labels.join(" "));
    if (queryParts.length === 0 && lastSession) {
      if (lastSession.title && lastSession.title !== "Untitled Session") {
        queryParts.push(lastSession.title);
      }
    }
    const query = queryParts.length > 0 ? queryParts.join(" ") : "deployment verification testing";
    scars = await storage.search(query, 5);
  } catch (error) {
    console.error("[session_start] Failed to query scars:", error);
  }

  // Load recent decisions from local storage (time-scoped to 5 days)
  let decisions: RecentDecision[] = [];
  try {
    const decisionRecords = await storage.query<DecisionRecord & Record<string, unknown>>("decisions", {
      order: "decision_date.desc",
      limit: 8,
    });
    const freeDecisionCutoff = new Date();
    freeDecisionCutoff.setDate(freeDecisionCutoff.getDate() - 5);
    const freeDecisionCutoffStr = freeDecisionCutoff.toISOString().split("T")[0];
    decisions = decisionRecords
      .filter((d) => d.decision_date >= freeDecisionCutoffStr)
      .slice(0, 3)
      .map((d) => ({
        id: d.id,
        title: d.title,
        decision: d.decision,
        date: formatDate(d.decision_date),
      }));
  } catch (error) {
    console.error("[session_start] Failed to load decisions:", error);
  }

  // Load recent wins from local storage (last 7 days)
  let freeWins: RecentWin[] = [];
  try {
    const winRecords = await storage.query<WinRecord & Record<string, unknown>>("learnings", {
      order: "created_at.desc",
      limit: 8,
    });
    const winCutoff = new Date();
    winCutoff.setDate(winCutoff.getDate() - 7);
    const winCutoffStr = winCutoff.toISOString();
    freeWins = winRecords
      .filter((w) => (w as Record<string, unknown>).learning_type === "win" && w.created_at >= winCutoffStr)
      .slice(0, 3)
      .map((w) => ({
        id: w.id,
        title: w.title,
        description: (w.description || "").slice(0, 200),
        date: formatDate(w.created_at.split("T")[0]),
        source_issue: w.source_linear_issue,
      }));
  } catch (error) {
    console.error("[session_start] Failed to load wins:", error);
  }

  // Create session record locally (skip if resuming existing session)
  if (!isResuming) {
    try {
      await storage.upsert("sessions", {
        id: sessionId,
        session_date: today,
        session_title: params.linear_issue ? `Session for ${params.linear_issue}` : "Interactive Session",
        project,
        agent,
        linear_issue: params.linear_issue || null,
        decisions: [],
        open_threads: [],
        closing_reflection: null,
        close_compliance: null,
      });
    } catch (error) {
      console.error("[session_start] Failed to create session record:", error);
    }
  } else {
    console.error(`[session_start] Resuming session ${sessionId} — skipping record creation`);
  }

  const latencyMs = timer.stop();
  const projectState = lastSession?.open_threads
    ?.map((t) => typeof t === "string" ? t : t.text)
    .find((t) => t.startsWith("PROJECT STATE:"))
    ?.replace(/^PROJECT STATE:\s*/, "");

  const performance = buildPerformanceData("session_start", latencyMs, scars.length + decisions.length + (lastSession ? 1 : 0), {
    memoriesSurfaced: scars.map((s) => s.id),
    similarityScores: scars.map((s) => s.similarity),
    search_mode: "local",
  });

  const surfacedAt = new Date().toISOString();
  const surfacedScars: SurfacedScar[] = scars.map((scar) => ({
    scar_id: scar.id,
    scar_title: scar.title,
    scar_severity: scar.severity || "medium",
    surfaced_at: surfacedAt,
    source: "session_start" as const,
  }));

  // GIT-20: Persist to per-session dir, legacy file, and registry
  // writeSessionFiles merges with existing file threads to preserve mid-session creations
  let freeMergedThreads = freeAggregatedThreads;
  try {
    freeMergedThreads = writeSessionFiles(sessionId, agent, project, surfacedScars, freeAggregatedThreads);
  } catch (error) {
    console.warn("[session_start] Failed to persist session files:", error);
  }

  setCurrentSession({
    sessionId,
    linearIssue: params.linear_issue,
    agent,
    startedAt: new Date(),
    surfacedScars,
    threads: freeMergedThreads,
  });

  const freeResult: SessionStartResult = {
    session_id: sessionId,
    agent,
    ...(isResuming && { resumed: true }),
    detected_environment: env,
    last_session: lastSession,
    ...(projectState && { project_state: projectState }),
    ...(freeMergedThreads.length > 0 && { open_threads: freeMergedThreads }),
    ...(freeRecentlyResolved.length > 0 && { recently_resolved: freeRecentlyResolved }),
    relevant_scars: scars,
    recent_decisions: decisions,
    ...(freeWins.length > 0 && { recent_wins: freeWins }),
    performance,
  };
  freeResult.display = formatStartDisplay(freeResult);
  return freeResult;
}

/**
 * Read session state from per-session directory or legacy file.
 * Tries per-session dir first, falls back to legacy active-session.json.
 */
function readSessionFile(sessionId: string): Record<string, unknown> | null {
  try {
    const sessionFilePath = getSessionPath(sessionId, "session.json");
    if (fs.existsSync(sessionFilePath)) {
      return JSON.parse(fs.readFileSync(sessionFilePath, "utf-8"));
    }
  } catch { /* fall through */ }

  try {
    const legacyPath = path.join(getGitmemDir(), "active-session.json");
    if (fs.existsSync(legacyPath)) {
      return JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
    }
  } catch { /* fall through */ }

  return null;
}

/**
 * Restore in-memory session state from a session data object.
 * Shared by checkExistingSession() for both registry and legacy paths.
 */
function restoreSessionState(
  existing: Record<string, unknown>,
  fallbackAgent: AgentIdentity,
): { sessionId: string; agent: AgentIdentity; linearIssue?: string } {
  setCurrentSession({
    sessionId: existing.session_id as string,
    linearIssue: existing.linear_issue as string | undefined,
    agent: (existing.agent as AgentIdentity) || fallbackAgent,
    startedAt: existing.started_at ? new Date(existing.started_at as string) : new Date(),
    surfacedScars: (existing.surfaced_scars as SurfacedScar[]) || [],
  });

  if (Array.isArray(existing.surfaced_scars) && existing.surfaced_scars.length) {
    addSurfacedScars(existing.surfaced_scars as SurfacedScar[]);
  }

  return {
    sessionId: existing.session_id as string,
    agent: (existing.agent as AgentIdentity) || fallbackAgent,
    linearIssue: existing.linear_issue as string | undefined,
  };
}

/**
 * GIT-20 / OD-558: Check for existing active session and return it if found.
 *
 * Uses the active-sessions registry (hostname+PID) to identify THIS process's
 * session, preventing cross-process session theft on shared filesystems.
 * Falls back to legacy active-session.json for backward compatibility.
 */
function checkExistingSession(
  agent: AgentIdentity,
  force?: boolean
): { sessionId: string; agent: AgentIdentity; linearIssue?: string } | null {
  if (force) {
    console.error("[session_start] force=true, skipping active session guard");
    return null;
  }

  try {
    // GIT-23: Migrate from old active-session.json format if needed
    migrateFromLegacy();

    // GIT-20: Prune stale sessions from crashed/dead containers
    pruneStale();

    // GIT-20: Check registry for THIS process's session (hostname + PID match)
    const mySession = findSessionByHostPid(os.hostname(), process.pid);
    if (mySession) {
      console.error(`[session_start] Found own session in registry: ${mySession.session_id} (host: ${mySession.hostname}, pid: ${mySession.pid})`);
      const data = readSessionFile(mySession.session_id);
      if (data && data.session_id) {
        console.error(`[session_start] Resuming own session: ${mySession.session_id}`);
        return restoreSessionState(data, agent);
      }
      // Registry entry exists but session file is missing — fall through to create new
      console.warn(`[session_start] Registry entry found but session file missing for ${mySession.session_id}`);
    }

    // Legacy fallback: check active-session.json
    const activeSessionPath = path.join(process.cwd(), ".gitmem", "active-session.json");
    if (fs.existsSync(activeSessionPath)) {
      const raw = fs.readFileSync(activeSessionPath, "utf8");
      const existing = JSON.parse(raw);
      if (existing.session_id) {
        // GIT-20: Only resume legacy file if it belongs to this process
        // (hostname+pid match) or if it's a pre-migration file (no hostname/pid fields)
        const sameHost = !existing.hostname || existing.hostname === os.hostname();
        const samePid = !existing.pid || existing.pid === process.pid;
        if (sameHost && samePid) {
          console.error(`[session_start] Resuming session from legacy file: ${existing.session_id}`);
          return restoreSessionState(existing, agent);
        }
        console.error(`[session_start] Legacy file belongs to another process (host: ${existing.hostname}, pid: ${existing.pid}), skipping`);
      }
    }
  } catch (error) {
    console.error("[session_start] Error checking existing sessions:", error);
  }

  return null;
}

/**
 * GIT-20: Write session state to per-session directory, legacy file, and registry.
 * Consolidates write logic used by session_start (main + free) and session_refresh.
 */
function writeSessionFiles(
  sessionId: string,
  agent: AgentIdentity,
  project: Project,
  surfacedScars: SurfacedScar[],
  threads: ThreadObject[],
  recordingPath?: string | null,
  isRefresh?: boolean,
): ThreadObject[] {
  const gitmemDir = path.join(process.cwd(), ".gitmem");
  if (!fs.existsSync(gitmemDir)) {
    fs.mkdirSync(gitmemDir, { recursive: true });
  }
  setGitmemDir(gitmemDir);

  const data = {
    session_id: sessionId,
    agent,
    started_at: new Date().toISOString(),
    project,
    hostname: os.hostname(),
    pid: process.pid,
    surfaced_scars: surfacedScars,
    threads,
    ...(recordingPath && { recording_path: recordingPath }),
    ...(isRefresh && { last_refreshed: new Date().toISOString() }),
  };

  // 1. Per-session directory (GIT-20)
  try {
    const sessionFilePath = getSessionPath(sessionId, "session.json");
    fs.writeFileSync(sessionFilePath, JSON.stringify(data, null, 2));
    console.error(`[session_start] Session state written to ${sessionFilePath}`);
  } catch (error) {
    console.warn("[session_start] Failed to write per-session file:", error);
  }

  // 2. Legacy active-session.json (backward compat for recall/session_close)
  try {
    fs.writeFileSync(
      path.join(gitmemDir, "active-session.json"),
      JSON.stringify(data, null, 2)
    );
  } catch (error) {
    console.warn("[session_start] Failed to write legacy active-session.json:", error);
  }

  // 3. Register in active-sessions registry (skip on refresh — already registered)
  if (!isRefresh) {
    registerSession({
      session_id: sessionId,
      agent,
      started_at: data.started_at,
      hostname: os.hostname(),
      pid: process.pid,
      project,
    });
  }

  // 4. Threads file — merge with existing to preserve mid-session creations AND resolutions.
  // mergeThreadStates prefers resolved over open (so local resolve_thread calls survive
  // even if Supabase still has the thread as "open" from an older/unclosed session).
  // It also preserves local-only threads (created mid-session via create_thread).
  const existingFileThreads = loadThreadsFile();
  const merged = existingFileThreads.length > 0
    ? mergeThreadStates(threads, existingFileThreads)
    : threads;
  if (merged.length > 0) {
    saveThreadsFile(merged);
  }
  return merged;
}

/**
 * Format pre-formatted display string for session_start/session_refresh results.
 * Agents echo this verbatim for consistent CLI output.
 */
function formatStartDisplay(result: SessionStartResult): string {
  const lines: string[] = [];

  // Header
  const label = result.refreshed ? "SESSION REFRESH" : (result.resumed ? "SESSION RESUMED" : "SESSION START");
  lines.push(`${label} — ACTIVE`);
  lines.push(`Session: ${result.session_id.slice(0, 8)} | Agent: ${result.agent}`);

  // Last session
  if (result.last_session) {
    const title = result.last_session.title.length > 70
      ? result.last_session.title.slice(0, 67) + "..."
      : result.last_session.title;
    lines.push("");
    lines.push(`Last session: "${title}" (${result.last_session.date})`);
    if (result.last_session.key_decisions?.length) {
      for (const d of result.last_session.key_decisions.slice(0, 3)) {
        lines.push(`  Decision: ${d}`);
      }
    }
  }

  // Open threads
  if (result.open_threads?.length) {
    lines.push("");
    lines.push(`Open threads (${result.open_threads.length}):`);
    for (const t of result.open_threads.slice(0, 8)) {
      const text = t.text.length > 70 ? t.text.slice(0, 67) + "..." : t.text;
      lines.push(`  ${t.id}: ${text}`);
    }
    if (result.open_threads.length > 8) {
      lines.push(`  ... and ${result.open_threads.length - 8} more`);
    }
  }

  // Relevant scars
  if (result.relevant_scars?.length) {
    lines.push("");
    lines.push(`Relevant scars (${result.relevant_scars.length}):`);
    for (const s of result.relevant_scars.slice(0, 5)) {
      const severity = (s.severity || "medium").toUpperCase();
      const title = s.title.length > 60 ? s.title.slice(0, 57) + "..." : s.title;
      lines.push(`  [${severity}] ${title}`);
    }
  }

  // Recent decisions
  if (result.recent_decisions?.length) {
    lines.push("");
    lines.push(`Recent decisions (${result.recent_decisions.length}):`);
    for (const d of result.recent_decisions.slice(0, 3)) {
      lines.push(`  - ${d.title} (${d.date})`);
    }
  }

  // Recent wins
  if (result.recent_wins?.length) {
    lines.push("");
    lines.push(`Recent wins (${result.recent_wins.length}):`);
    for (const w of result.recent_wins.slice(0, 3)) {
      lines.push(`  - ${w.title} (${w.date})`);
    }
  }

  return lines.join("\n");
}

/**
 * Execute session_start tool
 *
 * OD-489: Returns detailed performance breakdown for test harness validation.
 * Key metrics: network_calls_made, fully_local, breakdown per component.
 *
 * OD-558: Guards against overwriting existing active sessions.
 * Returns existing session if active-session.json exists (idempotent).
 * Pass force=true to override.
 */
export async function sessionStart(
  params: SessionStartParams
): Promise<SessionStartResult> {
  const timer = new Timer();
  const metricsId = uuidv4();

  // 1. Detect agent (or use provided)
  const env = detectAgent();
  const agent = params.agent_identity || env.agent;
  const project: Project = params.project || "orchestra_dev";

  // OD-558: Check for existing active session — reuse session_id but still load full context
  const existingSession = checkExistingSession(agent, params.force);
  const isResuming = existingSession !== null;

  // Free tier: all-local path
  if (!hasSupabase()) {
    return sessionStartFree(params, env, agent, project, timer, metricsId, existingSession?.sessionId);
  }

  // 2. Load last session first (needed for scar context)
  // OD-489: Track timing and network calls
  const lastSessionResult = await loadLastSession(agent, project);
  const lastSession = lastSessionResult.session;

  // 3. Load scars, decisions, and wins in parallel
  // OD-473: Scars use local vector search (deterministic, no race conditions)
  // Pass full lastSession for richer context (title + decisions + open_threads)
  // Wins query runs parallel — hidden by scar search bottleneck (~611ms > ~300ms)
  const [scarsResult, decisionsResult, winsResult] = await Promise.all([
    queryRelevantScars(
      params.issue_title,
      params.issue_description,
      params.issue_labels,
      project,
      lastSession
    ),
    loadRecentDecisions(project, 3),
    loadRecentWins(project, 3, 7),
  ]);

  const scars = scarsResult.scars;
  const decisions = decisionsResult.decisions;
  const wins = winsResult.wins;
  const usedLocalSearch = scarsResult.local_search;

  // OD-552: Build surfaced scar list for tracking
  const surfacedAt = new Date().toISOString();
  const surfacedScars: SurfacedScar[] = scars.map((scar) => ({
    scar_id: scar.id,
    scar_title: scar.title,
    scar_severity: scar.severity || "medium",
    surfaced_at: surfacedAt,
    source: "session_start" as const,
  }));

  // 4. Create session record (skip if resuming existing session — OD-558)
  let sessionId: string;
  let sessionCreateResult: { session_id: string; latency_ms: number; network_call: boolean };
  if (isResuming) {
    sessionId = existingSession!.sessionId;
    sessionCreateResult = { session_id: sessionId, latency_ms: 0, network_call: false };
    console.error(`[session_start] Resuming session ${sessionId} — skipping record creation`);
  } else {
    sessionCreateResult = await createSessionRecord(agent, project, params.linear_issue);
    sessionId = sessionCreateResult.session_id;
  }

  const latencyMs = timer.stop();
  const memoriesSurfaced = scars.map((s) => s.id);
  const similarityScores = scars.map((s) => s.similarity);

  // OD-534: Extract PROJECT STATE from last session if present
  const projectState = lastSession?.open_threads
    ?.map((t) => typeof t === "string" ? t : t.text)
    .find(t => t.startsWith("PROJECT STATE:"))
    ?.replace(/^PROJECT STATE:\s*/, "");

  // OD-489: Build detailed performance breakdown for test harness
  const breakdown: PerformanceBreakdown = {
    last_session: buildComponentPerformance(
      lastSessionResult.latency_ms,
      "supabase", // Last session always from Supabase (no caching yet)
      lastSessionResult.network_call,
      lastSessionResult.network_call ? "miss" : "hit"
    ),
    scar_search: buildComponentPerformance(
      scarsResult.latency_ms,
      usedLocalSearch ? "local_cache" : "supabase",
      scarsResult.network_call,
      usedLocalSearch ? "hit" : "miss"
    ),
    decisions: buildComponentPerformance(
      decisionsResult.latency_ms,
      decisionsResult.cache_hit ? "local_cache" : "supabase",
      decisionsResult.network_call,
      decisionsResult.cache_hit ? "hit" : "miss"
    ),
    wins: buildComponentPerformance(
      winsResult.latency_ms,
      winsResult.cache_hit ? "local_cache" : "supabase",
      winsResult.network_call,
      winsResult.cache_hit ? "hit" : "miss"
    ),
    session_create: buildComponentPerformance(
      sessionCreateResult.latency_ms,
      "supabase", // Session create always writes to Supabase
      sessionCreateResult.network_call,
      "not_applicable" // Write operation, not a cache lookup
    ),
  };

  // Build performance data with detailed breakdown
  const performance = buildPerformanceData(
    "session_start",
    latencyMs,
    scars.length + decisions.length + wins.length + (lastSession ? 1 : 0),
    {
      memoriesSurfaced,
      similarityScores,
      search_mode: usedLocalSearch ? "local" : "remote",
      breakdown,
    }
  );

  // Capture recording path from Docker entrypoint env var
  const recordingPath = process.env.GITMEM_RECORDING_PATH || undefined;

  const aggregatedThreads = lastSessionResult.aggregated_open_threads;
  const recentlyResolvedThreads = lastSessionResult.recently_resolved_threads;

  // GIT-20: Persist to per-session dir, legacy file, and active-sessions registry
  // writeSessionFiles merges aggregated threads with existing file threads to preserve
  // mid-session creations (e.g. create_thread calls that haven't been session_closed yet)
  let mergedThreads = aggregatedThreads;
  try {
    mergedThreads = writeSessionFiles(sessionId, agent, project, surfacedScars, aggregatedThreads, recordingPath);
  } catch (error) {
    console.warn("[session_start] Failed to persist session files:", error);
  }

  // OD-547: Set active session for variant assignment in recall
  // OD-552: Initialize with surfaced scars for auto-bridge at close time
  // OD-thread-lifecycle: Initialize with merged threads (aggregated + mid-session preserved)
  setCurrentSession({
    sessionId,
    linearIssue: params.linear_issue,
    agent,
    startedAt: new Date(),
    surfacedScars,
    threads: mergedThreads,
  });

  const result: SessionStartResult = {
    session_id: sessionId,
    agent,
    ...(isResuming && { resumed: true }),
    detected_environment: env,
    last_session: lastSession,
    ...(projectState && { project_state: projectState }), // OD-534
    ...(mergedThreads.length > 0 && {
      open_threads: mergedThreads,
    }),
    ...(recentlyResolvedThreads.length > 0 && {
      recently_resolved: recentlyResolvedThreads,
    }),
    relevant_scars: scars,
    recent_decisions: decisions,
    ...(wins.length > 0 && { recent_wins: wins }),
    ...(recordingPath && { recording_path: recordingPath }),
    performance,
  };

  // Record metrics
  recordMetrics({
    id: metricsId,
    session_id: sessionId,
    agent: agent as "CLI" | "DAC" | "CODA-1" | "Brain_Local" | "Brain_Cloud",
    tool_name: "session_start",
    query_text: [params.issue_title, params.issue_description].filter(Boolean).join(" ").slice(0, 500),
    tables_searched: usedLocalSearch
      ? ["orchestra_sessions_lite", "orchestra_decisions_lite", "orchestra_learnings_lite"]
      : ["orchestra_sessions_lite", "orchestra_learnings", "orchestra_decisions_lite", "orchestra_learnings_lite"],
    latency_ms: latencyMs,
    result_count: scars.length,
    similarity_scores: similarityScores,
    context_bytes: calculateContextBytes(result),
    phase_tag: "session_start",
    linear_issue: params.linear_issue,
    memories_surfaced: memoriesSurfaced,
    metadata: {
      project,
      has_last_session: !!lastSession,
      scars_count: scars.length,
      decisions_count: decisions.length,
      wins_count: wins.length,
      open_threads_count: lastSessionResult.aggregated_open_threads.length,
      used_local_search: usedLocalSearch, // OD-473: deterministic local search
      decisions_cache_hit: decisionsResult.cache_hit,
      // OD-489: Detailed instrumentation
      network_calls_made: performance.network_calls_made,
      fully_local: performance.fully_local,
    },
  }).catch(() => {});

  result.display = formatStartDisplay(result);
  return result;
}

/**
 * session_refresh Tool
 *
 * Re-surfaces institutional context for the current active session
 * without creating a new session ID. Same context pipeline as session_start
 * (last session, scars, decisions, wins, threads) but skips session creation.
 *
 * Use when: mid-session context refresh after compaction, long gaps, or
 * when you need to remember where you left off.
 */
export interface SessionRefreshParams {
  project?: Project;
}

export async function sessionRefresh(
  params: SessionRefreshParams
): Promise<SessionStartResult> {
  const timer = new Timer();
  const metricsId = uuidv4();

  // 1. Get active session — in-memory first, then file fallback
  const currentSession = getCurrentSession();
  let sessionId: string;
  let agent: AgentIdentity;
  let project: Project;

  if (currentSession) {
    sessionId = currentSession.sessionId;
    agent = (currentSession.agent as AgentIdentity) || "CLI";
    project = params.project || "orchestra_dev";
  } else {
    // GIT-20: Fallback — check registry for this process, then legacy file
    const mySession = findSessionByHostPid(os.hostname(), process.pid);
    let raw: Record<string, unknown> | null = null;

    if (mySession) {
      raw = readSessionFile(mySession.session_id);
    }
    if (!raw) {
      // Try legacy active-session.json
      try {
        const legacyPath = path.join(process.cwd(), ".gitmem", "active-session.json");
        if (fs.existsSync(legacyPath)) {
          raw = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
        }
      } catch { /* fall through */ }
    }
    if (!raw || !raw.session_id) {
      return {
        session_id: "",
        agent: "CLI",
        refreshed: true,
        message: "No active session — call session_start first",
        performance: buildPerformanceData("session_refresh", timer.stop(), 0),
      };
    }
    sessionId = raw.session_id as string;
    agent = (raw.agent as AgentIdentity) || "CLI";
    project = params.project || (raw.project as Project) || "orchestra_dev";
  }

  // Free tier: all-local path (reuse session_start free path)
  if (!hasSupabase()) {
    return {
      session_id: sessionId,
      agent,
      refreshed: true,
      message: "Free tier — limited context available. Use recall for scar queries.",
      performance: buildPerformanceData("session_refresh", timer.stop(), 0),
    };
  }

  // 2. Run context pipeline in parallel (same as session_start lines 735-752)
  const lastSessionResult = await loadLastSession(agent, project);
  const lastSession = lastSessionResult.session;

  const [scarsResult, decisionsResult, winsResult] = await Promise.all([
    queryRelevantScars(undefined, undefined, undefined, project, lastSession),
    loadRecentDecisions(project, 3),
    loadRecentWins(project, 3, 7),
  ]);

  const scars = scarsResult.scars;
  const decisions = decisionsResult.decisions;
  const wins = winsResult.wins;
  const usedLocalSearch = scarsResult.local_search;

  // 3. Build surfaced scars and merge with existing
  const surfacedAt = new Date().toISOString();
  const newSurfacedScars: SurfacedScar[] = scars.map((scar) => ({
    scar_id: scar.id,
    scar_title: scar.title,
    scar_severity: scar.severity || "medium",
    surfaced_at: surfacedAt,
    source: "session_start" as const, // Same source — this is a refresh of start context
  }));

  // Merge: add new scars to existing (addSurfacedScars deduplicates by scar_id)
  addSurfacedScars(newSurfacedScars);

  const refreshAggregatedThreads = lastSessionResult.aggregated_open_threads;
  const recentlyResolvedThreads = lastSessionResult.recently_resolved_threads;

  // 4. Extract PROJECT STATE (OD-534)
  const projectState = lastSession?.open_threads
    ?.map((t) => typeof t === "string" ? t : t.text)
    .find(t => t.startsWith("PROJECT STATE:"))
    ?.replace(/^PROJECT STATE:\s*/, "");

  // 5. Build performance breakdown
  const latencyMs = timer.stop();
  const breakdown: PerformanceBreakdown = {
    last_session: buildComponentPerformance(
      lastSessionResult.latency_ms, "supabase",
      lastSessionResult.network_call,
      lastSessionResult.network_call ? "miss" : "hit"
    ),
    scar_search: buildComponentPerformance(
      scarsResult.latency_ms,
      usedLocalSearch ? "local_cache" : "supabase",
      scarsResult.network_call,
      usedLocalSearch ? "hit" : "miss"
    ),
    decisions: buildComponentPerformance(
      decisionsResult.latency_ms,
      decisionsResult.cache_hit ? "local_cache" : "supabase",
      decisionsResult.network_call,
      decisionsResult.cache_hit ? "hit" : "miss"
    ),
    wins: buildComponentPerformance(
      winsResult.latency_ms,
      winsResult.cache_hit ? "local_cache" : "supabase",
      winsResult.network_call,
      winsResult.cache_hit ? "hit" : "miss"
    ),
  };

  const memoriesSurfaced = scars.map((s) => s.id);
  const similarityScores = scars.map((s) => s.similarity);
  const performance = buildPerformanceData(
    "session_refresh", latencyMs,
    scars.length + decisions.length + wins.length + (lastSession ? 1 : 0),
    { memoriesSurfaced, similarityScores, search_mode: usedLocalSearch ? "local" : "remote", breakdown }
  );

  const recordingPath = process.env.GITMEM_RECORDING_PATH || undefined;

  const result: SessionStartResult = {
    session_id: sessionId,
    agent,
    refreshed: true,
    detected_environment: detectAgent(),
    last_session: lastSession,
    ...(projectState && { project_state: projectState }),
    // open_threads and setCurrentSession filled after merge below
    relevant_scars: scars,
    recent_decisions: decisions,
    ...(wins.length > 0 && { recent_wins: wins }),
    ...(recordingPath && { recording_path: recordingPath }),
    performance,
  };

  // GIT-20: Update per-session dir and legacy file with refreshed context
  // writeSessionFiles merges with existing file threads to preserve mid-session creations
  let refreshMergedThreads = refreshAggregatedThreads;
  try {
    const allSurfacedScars = [...(Array.isArray(getSurfacedScars()) ? getSurfacedScars() : []), ...newSurfacedScars];
    refreshMergedThreads = writeSessionFiles(sessionId, agent, project, allSurfacedScars, refreshAggregatedThreads, recordingPath, true);
    console.error(`[session_refresh] Context refreshed for session ${sessionId}`);
  } catch (error) {
    console.warn("[session_refresh] Failed to update session files:", error);
  }

  // Add merged threads to result
  if (refreshMergedThreads.length > 0) {
    result.open_threads = refreshMergedThreads;
  }
  if (recentlyResolvedThreads.length > 0) {
    result.recently_resolved = recentlyResolvedThreads;
  }

  // 7. Update in-memory session state with merged threads
  setCurrentSession({
    sessionId,
    agent,
    startedAt: currentSession?.startedAt || new Date(),
    surfacedScars: [...(currentSession?.surfacedScars || []), ...newSurfacedScars],
    threads: refreshMergedThreads,
    linearIssue: currentSession?.linearIssue,
  });

  // Record metrics
  recordMetrics({
    id: metricsId,
    session_id: sessionId,
    agent: agent as "CLI" | "DAC" | "CODA-1" | "Brain_Local" | "Brain_Cloud",
    tool_name: "session_refresh",
    query_text: "mid-session context refresh",
    tables_searched: usedLocalSearch
      ? ["orchestra_sessions_lite", "orchestra_decisions_lite", "orchestra_learnings_lite"]
      : ["orchestra_sessions_lite", "orchestra_learnings", "orchestra_decisions_lite", "orchestra_learnings_lite"],
    latency_ms: latencyMs,
    result_count: scars.length,
    similarity_scores: similarityScores,
    context_bytes: calculateContextBytes(result),
    phase_tag: "session_refresh",
    memories_surfaced: memoriesSurfaced,
    metadata: {
      project,
      has_last_session: !!lastSession,
      scars_count: scars.length,
      decisions_count: decisions.length,
      wins_count: wins.length,
      open_threads_count: refreshMergedThreads.length,
      used_local_search: usedLocalSearch,
      network_calls_made: performance.network_calls_made,
      fully_local: performance.fully_local,
    },
  }).catch(() => {});

  result.display = formatStartDisplay(result);
  return result;
}

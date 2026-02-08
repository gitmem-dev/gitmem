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
import { setCurrentSession, addSurfacedScars } from "../services/session-state.js"; // OD-547, OD-552
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
} from "../types/index.js";

// Supabase record types
interface SessionRecord {
  id: string;
  session_title: string;
  session_date: string;
  decisions?: string[];
  open_threads?: string[];
  close_compliance?: Record<string, unknown> | null;
  // From lite view (counts only)
  decision_count?: number;
  open_thread_count?: number;
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
function aggregateOpenThreads(
  sessions: SessionRecord[],
  maxSessions = 5,
  maxAgeDays = 14
): string[] {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
  const cutoffStr = cutoffDate.toISOString().split("T")[0];

  const closedSessions = sessions
    .filter((s) => s.close_compliance != null && s.session_date >= cutoffStr)
    .slice(0, maxSessions);

  const seen = new Set<string>();
  const threads: string[] = [];

  for (const session of closedSessions) {
    for (const thread of session.open_threads || []) {
      // Skip PROJECT STATE threads (handled separately via OD-534)
      if (typeof thread === "string" && thread.startsWith("PROJECT STATE:")) continue;
      // Parse JSON thread objects if present (some sessions store {item, context})
      let threadText = thread;
      if (typeof thread === "string" && thread.startsWith("{")) {
        try {
          const parsed = JSON.parse(thread);
          threadText = parsed.item || thread;
        } catch {
          // Not JSON, use as-is
        }
      }
      const key = String(threadText).toLowerCase().trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        threads.push(String(threadText));
      }
    }
  }

  return threads;
}

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
  aggregated_open_threads: string[];
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

    // Aggregate open threads across last 5 closed sessions (free — data already fetched)
    const aggregated_open_threads = aggregateOpenThreads(sessions);
    console.error(`[session_start] Aggregated ${aggregated_open_threads.length} open threads from recent sessions`);

    if (sessions.length === 0) {
      return { session: null, aggregated_open_threads, latency_ms, network_call: true };
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
          date: session.session_date,
          key_decisions: session.decisions || [],
          open_threads: session.open_threads || [],
        },
        aggregated_open_threads,
        latency_ms,
        network_call: true,
      };
    }

    return {
      session: {
        id: closedSession.id,
        title: closedSession.session_title || "Untitled Session",
        date: closedSession.session_date,
        key_decisions: closedSession.decisions || [],
        open_threads: closedSession.open_threads || [],
      },
      aggregated_open_threads,
      latency_ms,
      network_call: true, // Always hits Supabase (no caching for sessions yet)
    };
  } catch (error) {
    console.error("[session_start] Failed to load last session:", error);
    return { session: null, aggregated_open_threads: [], latency_ms: timer.stop(), network_call: true };
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
        queryParts.push(lastSession.open_threads.slice(0, 3).join(" "));
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
      date: d.decision_date,
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
      date: r.created_at.split("T")[0],
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
  metricsId: string
): Promise<SessionStartResult> {
  const storage = getStorage();
  const sessionId = uuidv4();
  const today = new Date().toISOString().split("T")[0];

  // Load last session from local storage
  let lastSession: LastSession | null = null;
  let freeAggregatedThreads: string[] = [];
  try {
    const sessions = await storage.query<SessionRecord & Record<string, unknown>>("sessions", {
      order: "session_date.desc",
      limit: 10,
    });
    // Aggregate threads across recent sessions
    freeAggregatedThreads = aggregateOpenThreads(sessions as SessionRecord[]);

    const closedSession = sessions.find((s) => s.close_compliance != null) || sessions[0];
    if (closedSession) {
      lastSession = {
        id: closedSession.id,
        title: closedSession.session_title || "Untitled Session",
        date: closedSession.session_date,
        key_decisions: closedSession.decisions || [],
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
        date: d.decision_date,
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
        date: w.created_at.split("T")[0],
        source_issue: w.source_linear_issue,
      }));
  } catch (error) {
    console.error("[session_start] Failed to load wins:", error);
  }

  // Create session record locally
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

  const latencyMs = timer.stop();
  const projectState = lastSession?.open_threads?.find((t) => t.startsWith("PROJECT STATE:"))
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

  // Persist active session file
  try {
    const activeSessionPath = path.join(process.cwd(), ".gitmem", "active-session.json");
    const activeSessionDir = path.dirname(activeSessionPath);
    if (!fs.existsSync(activeSessionDir)) {
      fs.mkdirSync(activeSessionDir, { recursive: true });
    }
    fs.writeFileSync(
      activeSessionPath,
      JSON.stringify({ session_id: sessionId, agent, started_at: new Date().toISOString(), project, surfaced_scars: surfacedScars }, null, 2)
    );
  } catch (error) {
    console.warn("[session_start] Failed to persist active session file:", error);
  }

  setCurrentSession({
    sessionId,
    linearIssue: params.linear_issue,
    agent,
    startedAt: new Date(),
    surfacedScars,
  });

  return {
    session_id: sessionId,
    agent,
    detected_environment: env,
    last_session: lastSession,
    ...(projectState && { project_state: projectState }),
    ...(freeAggregatedThreads.length > 0 && { open_threads: freeAggregatedThreads }),
    relevant_scars: scars,
    recent_decisions: decisions,
    ...(freeWins.length > 0 && { recent_wins: freeWins }),
    performance,
  };
}

/**
 * OD-558: Check for existing active session and return it if found.
 * Prevents accidental overwrites from duplicate session_start calls,
 * compaction recovery, or parallel processes.
 */
function checkExistingSession(
  agent: AgentIdentity,
  force?: boolean
): SessionStartResult | null {
  if (force) {
    console.error("[session_start] force=true, skipping active session guard");
    return null;
  }

  try {
    const activeSessionPath = path.join(process.cwd(), ".gitmem", "active-session.json");
    if (fs.existsSync(activeSessionPath)) {
      const raw = fs.readFileSync(activeSessionPath, "utf8");
      const existing = JSON.parse(raw);
      if (existing.session_id) {
        console.error(`[session_start] Existing active session found: ${existing.session_id}`);

        // Restore in-memory session state so subsequent tools work correctly
        setCurrentSession({
          sessionId: existing.session_id,
          linearIssue: existing.linear_issue,
          agent: existing.agent || agent,
          startedAt: existing.started_at ? new Date(existing.started_at) : new Date(),
          surfacedScars: existing.surfaced_scars || [],
        });

        // Restore surfaced scars for auto-bridge
        if (existing.surfaced_scars?.length) {
          addSurfacedScars(existing.surfaced_scars);
        }

        return {
          session_id: existing.session_id,
          agent: existing.agent || agent,
          resumed: true,
          message: `Existing active session found (${existing.session_id}). Use force=true to override.`,
        };
      }
    }
  } catch (error) {
    // File doesn't exist, is corrupted, or can't be read — proceed normally
    console.error("[session_start] No valid active session file found, creating new session");
  }

  return null;
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

  // OD-558: Check for existing active session before creating a new one
  const existingSession = checkExistingSession(agent, params.force);
  if (existingSession) {
    return existingSession;
  }

  // Free tier: all-local path
  if (!hasSupabase()) {
    return sessionStartFree(params, env, agent, project, timer, metricsId);
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

  // 4. Create session record
  // OD-489: Track timing and network calls
  const sessionCreateResult = await createSessionRecord(agent, project, params.linear_issue);
  const sessionId = sessionCreateResult.session_id;

  const latencyMs = timer.stop();
  const memoriesSurfaced = scars.map((s) => s.id);
  const similarityScores = scars.map((s) => s.similarity);

  // OD-534: Extract PROJECT STATE from last session if present
  const projectState = lastSession?.open_threads?.find(t => t.startsWith("PROJECT STATE:"))
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

  const result: SessionStartResult = {
    session_id: sessionId,
    agent,
    detected_environment: env,
    last_session: lastSession,
    ...(projectState && { project_state: projectState }), // OD-534
    ...(lastSessionResult.aggregated_open_threads.length > 0 && {
      open_threads: lastSessionResult.aggregated_open_threads,
    }),
    relevant_scars: scars,
    recent_decisions: decisions,
    ...(wins.length > 0 && { recent_wins: wins }),
    ...(recordingPath && { recording_path: recordingPath }),
    performance,
  };

  // OD-549: Persist session_id to .gitmem/active-session.json for compaction survival
  // Uses .gitmem/ (not .claude/) so this works in any IDE — Cursor, Windsurf, etc.
  // Container lifecycle ensures cleanup — file dies with the container.
  try {
    const activeSessionPath = path.join(process.cwd(), ".gitmem", "active-session.json");
    const activeSessionDir = path.dirname(activeSessionPath);
    if (!fs.existsSync(activeSessionDir)) {
      fs.mkdirSync(activeSessionDir, { recursive: true });
    }
    fs.writeFileSync(
      activeSessionPath,
      JSON.stringify({
        session_id: sessionId,
        agent,
        started_at: new Date().toISOString(),
        project,
        surfaced_scars: surfacedScars, // OD-552: Persist for session close auto-bridge
        ...(recordingPath && { recording_path: recordingPath }),
      }, null, 2)
    );
    console.error(`[session_start] Active session persisted to ${activeSessionPath}`);
  } catch (error) {
    // Non-fatal: session works fine without file persistence
    console.warn("[session_start] Failed to persist active session file:", error);
  }

  // OD-547: Set active session for variant assignment in recall
  // OD-552: Initialize with surfaced scars for auto-bridge at close time
  setCurrentSession({
    sessionId,
    linearIssue: params.linear_issue,
    agent,
    startedAt: new Date(),
    surfacedScars,
  });

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

  return result;
}

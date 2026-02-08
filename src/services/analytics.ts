/**
 * Analytics Service (OD-567)
 *
 * Shared analytics engine for session insights. Powers both the
 * gitmem-analyze MCP tool (CLI) and the GitMem Console dashboard.
 *
 * Uses directQuery for raw Supabase REST access (no ww-mcp dependency).
 */

import { directQuery } from "./supabase-client.js";
import type { Project } from "../types/index.js";

// --- Types ---

export interface SessionRecord {
  id: string;
  session_title: string | null;
  session_date: string;
  agent: string;
  linear_issue: string | null;
  decisions: unknown[];
  open_threads: string[];
  closing_reflection: ClosingReflection | null;
  close_compliance: CloseCompliance | null;
  created_at: string;
  project: string;
}

interface ClosingReflection {
  what_broke?: string;
  what_took_longer?: string;
  do_differently?: string;
  what_worked?: string;
  wrong_assumption?: string;
  scars_applied?: string | string[];
  human_additions?: string;
}

interface CloseCompliance {
  agent?: string;
  close_type?: string;
  scars_applied?: number;
  learnings_stored?: number;
  checklist_displayed?: boolean;
  human_asked_for_corrections?: boolean;
  questions_answered_by_agent?: boolean;
}

export interface AgentBreakdown {
  agent: string;
  session_count: number;
  decisions_total: number;
  threads_total: number;
  close_types: Record<string, number>;
}

export interface SummaryAnalytics {
  period: { start: string; end: string; days: number };
  total_sessions: number;
  sessions_with_reflections: number;
  sessions_with_issues: number;
  total_decisions: number;
  total_open_threads: number;
  agents: AgentBreakdown[];
  close_type_distribution: Record<string, number>;
  top_issues: Array<{ issue: string; session_count: number }>;
}

// --- Query Layer ---

/**
 * Fetch sessions within a date range.
 * Selects only the fields needed for analytics (no embedding column).
 */
export async function querySessionsByDateRange(
  startDate: string,
  endDate: string,
  project: Project,
  agentFilter?: string
): Promise<SessionRecord[]> {
  const filters: Record<string, string> = {
    project: `eq.${project}`,
    "created_at": `gte.${startDate}`,
  };

  // Add end date filter — use a second filter key with PostgREST AND
  // PostgREST doesn't support two filters on same column directly,
  // so we use created_at with gte for start and lte appended via raw
  const sessions = await directQuery<SessionRecord>("orchestra_sessions", {
    select: "id,session_title,session_date,agent,linear_issue,decisions,open_threads,closing_reflection,close_compliance,created_at,project",
    filters,
    order: "created_at.desc",
    limit: 500,
  });

  // Client-side filter for end date and agent (PostgREST limitation with dual date filters)
  return sessions.filter(s => {
    const inRange = s.created_at <= endDate;
    const matchesAgent = !agentFilter || s.agent === agentFilter;
    return inRange && matchesAgent;
  });
}

// --- Scar Usage & Repeat Mistake Types ---

export interface ScarUsageRecord {
  scar_id: string;
  scar_title: string | null;
  scar_severity: string | null;
  agent: string | null;
  reference_type: string;
  execution_successful: boolean | null;
  surfaced_at: string;
}

export interface RepeatMistakeRecord {
  id: string;
  title: string;
  related_scar_id: string | null;
  repeat_mistake_details: { reason?: string } | null;
  created_at: string;
}

export interface BlindspotsData {
  period: { start: string; end: string; days: number };
  total_scars_surfaced: number;
  total_scar_usages: number;

  ignored_scars: Array<{
    scar_id: string;
    title: string;
    severity: string;
    times_surfaced: number;
    times_ignored: number;
    ignore_rate: number;
    agents: string[];
  }>;

  failed_applications: Array<{
    scar_id: string;
    title: string;
    times_applied: number;
    times_failed: number;
    failure_rate: number;
  }>;

  repeat_mistakes: Array<{
    id: string;
    title: string;
    original_scar_title: string;
    reason: string;
    created_at: string;
  }>;

  agent_effectiveness: Array<{
    agent: string;
    scars_surfaced: number;
    scars_applied: number;
    application_rate: number;
    success_rate: number;
  }>;

  severity_breakdown: Array<{
    severity: string;
    surfaced: number;
    applied: number;
    ignored: number;
    application_rate: number;
  }>;
}

// --- Scar Usage & Repeat Mistake Queries ---

/**
 * Fetch scar_usage records within a date range.
 */
export async function queryScarUsageByDateRange(
  startDate: string,
  _endDate: string,
  _project: Project,
  agentFilter?: string
): Promise<ScarUsageRecord[]> {
  const filters: Record<string, string> = {
    surfaced_at: `gte.${startDate}`,
  };

  const usages = await directQuery<ScarUsageRecord>("scar_usage", {
    select: "scar_id,scar_title,scar_severity,agent,reference_type,execution_successful,surfaced_at",
    filters,
    order: "surfaced_at.desc",
    limit: 500,
  });

  // Client-side filter for end date and agent
  return usages.filter(u => {
    const inRange = u.surfaced_at <= _endDate;
    const matchesAgent = !agentFilter || u.agent === agentFilter;
    return inRange && matchesAgent;
  });
}

/**
 * Fetch repeat mistakes from orchestra_learnings within a date range.
 */
export async function queryRepeatMistakes(
  startDate: string,
  _endDate: string,
  project: Project
): Promise<RepeatMistakeRecord[]> {
  const filters: Record<string, string> = {
    repeat_mistake: "eq.true",
    project: `eq.${project}`,
    created_at: `gte.${startDate}`,
  };

  const repeats = await directQuery<RepeatMistakeRecord>("orchestra_learnings", {
    select: "id,title,related_scar_id,repeat_mistake_details,created_at",
    filters,
    order: "created_at.desc",
    limit: 100,
  });

  // Client-side end date filter
  return repeats.filter(r => r.created_at <= _endDate);
}

/**
 * Resolve scar titles and severities from orchestra_learnings for scar_usage
 * records that have null/missing title data.
 */
export async function enrichScarUsageTitles(
  usages: ScarUsageRecord[]
): Promise<ScarUsageRecord[]> {
  // Collect scar_ids that need title resolution
  const idsNeedingResolution = new Set<string>();
  for (const u of usages) {
    if (!u.scar_title) {
      idsNeedingResolution.add(u.scar_id);
    }
  }

  if (idsNeedingResolution.size === 0) return usages;

  // Fetch titles from orchestra_learnings
  const ids = Array.from(idsNeedingResolution);
  const learnings = await directQuery<{ id: string; title: string; severity: string }>(
    "orchestra_learnings",
    {
      select: "id,title,severity",
      filters: {
        id: `in.(${ids.join(",")})`,
      },
    }
  );

  // Build lookup map
  const titleMap = new Map<string, { title: string; severity: string }>();
  for (const l of learnings) {
    titleMap.set(l.id, { title: l.title, severity: l.severity });
  }

  // Enrich usages
  return usages.map(u => {
    if (!u.scar_title) {
      const resolved = titleMap.get(u.scar_id);
      if (resolved) {
        return { ...u, scar_title: resolved.title, scar_severity: resolved.severity };
      }
    }
    return u;
  });
}

/**
 * Compute blindspots analytics from scar usage and repeat mistake data.
 */
export function computeBlindspots(
  usages: ScarUsageRecord[],
  repeatMistakes: RepeatMistakeRecord[],
  days: number
): BlindspotsData {
  // Unique scars surfaced
  const scarIds = new Set(usages.map(u => u.scar_id));

  // --- 1. Ignored scars ---
  const scarGroupMap = new Map<string, ScarUsageRecord[]>();
  for (const u of usages) {
    const list = scarGroupMap.get(u.scar_id) || [];
    list.push(u);
    scarGroupMap.set(u.scar_id, list);
  }

  const ignored_scars = Array.from(scarGroupMap.entries())
    .map(([scar_id, records]) => {
      const times_surfaced = records.length;
      const times_ignored = records.filter(r => r.reference_type === "none").length;
      const agentSet = new Set<string>();
      for (const r of records) {
        if (r.reference_type === "none" && r.agent) agentSet.add(r.agent);
      }
      return {
        scar_id,
        title: records[0]?.scar_title || "Unknown",
        severity: records[0]?.scar_severity || "unknown",
        times_surfaced,
        times_ignored,
        ignore_rate: times_surfaced > 0 ? times_ignored / times_surfaced : 0,
        agents: Array.from(agentSet),
      };
    })
    .filter(s => s.times_ignored > 0)
    .sort((a, b) => b.ignore_rate - a.ignore_rate);

  // --- 2. Failed applications ---
  const failed_applications = Array.from(scarGroupMap.entries())
    .map(([scar_id, records]) => {
      const applied = records.filter(r => r.reference_type !== "none");
      const times_applied = applied.length;
      const times_failed = applied.filter(r => r.execution_successful === false).length;
      return {
        scar_id,
        title: records[0]?.scar_title || "Unknown",
        times_applied,
        times_failed,
        failure_rate: times_applied > 0 ? times_failed / times_applied : 0,
      };
    })
    .filter(s => s.times_failed > 0)
    .sort((a, b) => b.failure_rate - a.failure_rate);

  // --- 3. Repeat mistakes ---
  // Build a title lookup from usages for related_scar_id resolution
  const scarTitleMap = new Map<string, string>();
  for (const u of usages) {
    if (u.scar_title) scarTitleMap.set(u.scar_id, u.scar_title);
  }

  const repeat_mistakes = repeatMistakes.map(rm => ({
    id: rm.id,
    title: rm.title,
    original_scar_title: (rm.related_scar_id && scarTitleMap.get(rm.related_scar_id)) || "Unknown",
    reason: rm.repeat_mistake_details?.reason || "Not specified",
    created_at: rm.created_at,
  }));

  // --- 4. Agent effectiveness ---
  const agentMap = new Map<string, { surfaced: number; applied: number; successful: number }>();
  for (const u of usages) {
    const agent = u.agent || "Unknown";
    const entry = agentMap.get(agent) || { surfaced: 0, applied: 0, successful: 0 };
    entry.surfaced++;
    if (u.reference_type !== "none") {
      entry.applied++;
      if (u.execution_successful === true) entry.successful++;
    }
    agentMap.set(agent, entry);
  }

  const agent_effectiveness = Array.from(agentMap.entries())
    .map(([agent, stats]) => ({
      agent,
      scars_surfaced: stats.surfaced,
      scars_applied: stats.applied,
      application_rate: stats.surfaced > 0 ? stats.applied / stats.surfaced : 0,
      success_rate: stats.applied > 0 ? stats.successful / stats.applied : 0,
    }))
    .sort((a, b) => b.scars_surfaced - a.scars_surfaced);

  // --- 5. Severity breakdown ---
  const sevMap = new Map<string, { surfaced: number; applied: number; ignored: number }>();
  for (const u of usages) {
    const sev = u.scar_severity || "unknown";
    const entry = sevMap.get(sev) || { surfaced: 0, applied: 0, ignored: 0 };
    entry.surfaced++;
    if (u.reference_type === "none") {
      entry.ignored++;
    } else {
      entry.applied++;
    }
    sevMap.set(sev, entry);
  }

  const severity_breakdown = Array.from(sevMap.entries())
    .map(([severity, stats]) => ({
      severity,
      surfaced: stats.surfaced,
      applied: stats.applied,
      ignored: stats.ignored,
      application_rate: stats.surfaced > 0 ? stats.applied / stats.surfaced : 0,
    }))
    .sort((a, b) => b.surfaced - a.surfaced);

  // Date range
  const dates = usages.map(u => u.surfaced_at).sort();
  const start = dates[0] || new Date().toISOString();
  const end = dates[dates.length - 1] || new Date().toISOString();

  return {
    period: { start: start.slice(0, 10), end: end.slice(0, 10), days },
    total_scars_surfaced: scarIds.size,
    total_scar_usages: usages.length,
    ignored_scars,
    failed_applications,
    repeat_mistakes,
    agent_effectiveness,
    severity_breakdown,
  };
}

// --- Aggregation Layer ---

/**
 * Compute basic summary statistics from a set of sessions.
 */
export function computeSummary(sessions: SessionRecord[], days: number): SummaryAnalytics {
  const agentMap = new Map<string, AgentBreakdown>();
  const closeTypeCounts: Record<string, number> = {};
  const issueCounts = new Map<string, number>();
  let totalDecisions = 0;
  let totalThreads = 0;
  let sessionsWithReflections = 0;
  let sessionsWithIssues = 0;

  for (const session of sessions) {
    // Agent breakdown
    const agent = session.agent || "Unknown";
    if (!agentMap.has(agent)) {
      agentMap.set(agent, {
        agent,
        session_count: 0,
        decisions_total: 0,
        threads_total: 0,
        close_types: {},
      });
    }
    const ab = agentMap.get(agent)!;
    ab.session_count++;

    // Decisions
    const decisionCount = Array.isArray(session.decisions) ? session.decisions.length : 0;
    totalDecisions += decisionCount;
    ab.decisions_total += decisionCount;

    // Open threads
    const threadCount = Array.isArray(session.open_threads) ? session.open_threads.length : 0;
    totalThreads += threadCount;
    ab.threads_total += threadCount;

    // Close compliance
    const closeType = session.close_compliance?.close_type || "no_close";
    closeTypeCounts[closeType] = (closeTypeCounts[closeType] || 0) + 1;
    ab.close_types[closeType] = (ab.close_types[closeType] || 0) + 1;

    // Closing reflections
    if (session.closing_reflection && session.closing_reflection.what_broke) {
      sessionsWithReflections++;
    }

    // Linear issues
    if (session.linear_issue) {
      sessionsWithIssues++;
      const issue = session.linear_issue;
      issueCounts.set(issue, (issueCounts.get(issue) || 0) + 1);
    }
  }

  // Sort issues by session count
  const topIssues = Array.from(issueCounts.entries())
    .map(([issue, session_count]) => ({ issue, session_count }))
    .sort((a, b) => b.session_count - a.session_count)
    .slice(0, 10);

  // Date range
  const dates = sessions.map(s => s.created_at).sort();
  const start = dates[0] || new Date().toISOString();
  const end = dates[dates.length - 1] || new Date().toISOString();

  return {
    period: { start: start.slice(0, 10), end: end.slice(0, 10), days },
    total_sessions: sessions.length,
    sessions_with_reflections: sessionsWithReflections,
    sessions_with_issues: sessionsWithIssues,
    total_decisions: totalDecisions,
    total_open_threads: totalThreads,
    agents: Array.from(agentMap.values()).sort((a, b) => b.session_count - a.session_count),
    close_type_distribution: closeTypeCounts,
    top_issues: topIssues,
  };
}

/**
 * Extract and aggregate closing reflections from sessions.
 * Returns arrays of each reflection field for further analysis.
 */
export function aggregateClosingReflections(sessions: SessionRecord[]): {
  what_broke: Array<{ text: string; session_id: string; agent: string; date: string }>;
  what_worked: Array<{ text: string; session_id: string; agent: string; date: string }>;
  wrong_assumptions: Array<{ text: string; session_id: string; agent: string; date: string }>;
  do_differently: Array<{ text: string; session_id: string; agent: string; date: string }>;
} {
  const result = {
    what_broke: [] as Array<{ text: string; session_id: string; agent: string; date: string }>,
    what_worked: [] as Array<{ text: string; session_id: string; agent: string; date: string }>,
    wrong_assumptions: [] as Array<{ text: string; session_id: string; agent: string; date: string }>,
    do_differently: [] as Array<{ text: string; session_id: string; agent: string; date: string }>,
  };

  for (const session of sessions) {
    const ref = session.closing_reflection;
    if (!ref) continue;

    const meta = {
      session_id: session.id,
      agent: session.agent,
      date: session.created_at.slice(0, 10),
    };

    if (ref.what_broke && ref.what_broke.trim()) {
      result.what_broke.push({ text: ref.what_broke, ...meta });
    }
    if (ref.what_worked && ref.what_worked.trim()) {
      result.what_worked.push({ text: ref.what_worked, ...meta });
    }
    if (ref.wrong_assumption && ref.wrong_assumption.trim()) {
      result.wrong_assumptions.push({ text: ref.wrong_assumption, ...meta });
    }
    if (ref.do_differently && ref.do_differently.trim()) {
      result.do_differently.push({ text: ref.do_differently, ...meta });
    }
  }

  return result;
}

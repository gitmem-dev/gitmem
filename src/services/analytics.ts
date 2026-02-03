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

/**
 * log Tool (OD-561)
 *
 * Chronological listing of recent learnings, like `git log`.
 * Pure read-only operation with no side effects.
 *
 * Uses directQuery to Supabase REST API (no ww-mcp dependency).
 * Free tier reads from local .gitmem/ storage.
 *
 * Performance target: 500ms
 */

import * as supabase from "../services/supabase-client.js";
import { hasSupabase } from "../services/tier.js";
import { getProject } from "../services/session-state.js";
import { getStorage } from "../services/storage.js";
import {
  Timer,
  recordMetrics,
  buildPerformanceData,
  buildComponentPerformance,
} from "../services/metrics.js";
import { v4 as uuidv4 } from "uuid";
import { formatTimestamp } from "../services/timezone.js";
import { wrapDisplay, relativeTime, truncate, SEV, TYPE } from "../services/display-protocol.js";
import type { Project, PerformanceBreakdown, PerformanceData } from "../types/index.js";

// --- Types ---

export interface LogParams {
  limit?: number;
  project?: Project;
  learning_type?: "scar" | "win" | "pattern";
  severity?: "critical" | "high" | "medium" | "low";
  since?: number; // days to look back
}

export interface LogEntry {
  id: string;
  title: string;
  learning_type: string;
  severity: string;
  created_at: string;
  source_linear_issue?: string;
  project: string;
  persona_name?: string;
}

export interface LogResult {
  entries: LogEntry[];
  total: number;
  filters: {
    project: string;
    learning_type?: string;
    severity?: string;
    since_days?: number;
    since_date?: string;
  };
  display?: string;
  performance: PerformanceData;
}

// --- Display Formatting ---

function buildLogDisplay(entries: LogEntry[], total: number, filters: LogResult["filters"]): string {
  const lines: string[] = [];
  lines.push(`gitmem log · ${total} entries · ${filters.project}`);
  const fp: string[] = [];
  if (filters.learning_type) fp.push(`type=${filters.learning_type}`);
  if (filters.severity) fp.push(`severity=${filters.severity}`);
  if (filters.since_days) fp.push(`since ${filters.since_days}d`);
  if (fp.length > 0) lines.push(`Filters: ${fp.join(", ")}`);
  lines.push("");
  if (entries.length === 0) {
    lines.push("No learnings found.");
    return wrapDisplay(lines.join("\n"));
  }
  for (const e of entries) {
    const te = TYPE[e.learning_type] || "·";
    const se = SEV[e.severity] || "⚪";
    const t = truncate(e.title, 50);
    const time = relativeTime(e.created_at);
    const issue = e.source_linear_issue ? `  ${e.source_linear_issue}` : "";
    lines.push(`${te} ${se} ${t.padEnd(52)} ${time.padStart(6)}${issue}`);
  }
  lines.push("");
  const counts: Record<string, number> = {};
  for (const e of entries) {
    counts[e.learning_type] = (counts[e.learning_type] || 0) + 1;
  }
  const cp = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, n]) => `${n} ${type}${n !== 1 ? "s" : ""}`);
  lines.push(`${total} total: ${cp.join(", ")}`);
  return wrapDisplay(lines.join("\n"));
}

// --- Implementation ---

export async function log(params: LogParams): Promise<LogResult> {
  const timer = new Timer();
  const metricsId = uuidv4();

  const limit = params.limit || 10;
  const project: Project = params.project || getProject() as Project || "default";
  const typeFilter = params.learning_type;
  const severityFilter = params.severity;
  const sinceDays = params.since;

  // Compute since date if provided
  let sinceDate: string | undefined;
  if (sinceDays && sinceDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() - sinceDays);
    sinceDate = d.toISOString();
  }

  // FREE TIER: read from local storage
  if (!hasSupabase()) {
    try {
      const queryTimer = new Timer();
      const storage = getStorage();

      const filters: Record<string, string> = {};
      if (typeFilter) filters.learning_type = typeFilter;
      if (severityFilter) filters.severity = severityFilter;

      const records = await storage.query<LogEntry>("learnings", {
        filters,
        order: "created_at.desc",
        limit,
      });

      // Post-filter by since date (local storage doesn't support gte filters)
      let filtered = records;
      if (sinceDate) {
        filtered = filtered.filter(r => r.created_at >= sinceDate!);
      }
      filtered = filtered.slice(0, limit);

      const queryLatencyMs = queryTimer.stop();
      const latencyMs = timer.stop();

      const filtersObj = {
        project,
        learning_type: typeFilter,
        severity: severityFilter,
        since_days: sinceDays,
        since_date: sinceDate ? formatTimestamp(sinceDate) : undefined,
      };

      return {
        entries: filtered.map(e => ({ ...e, created_at: formatTimestamp(e.created_at) })),
        total: filtered.length,
        filters: filtersObj,
        display: buildLogDisplay(filtered, filtered.length, filtersObj),
        performance: buildPerformanceData("log", latencyMs, filtered.length, {
          search_mode: "local",
        }),
      };
    } catch (error) {
      const latencyMs = timer.stop();
      return {
        entries: [],
        total: 0,
        filters: { project },
        display: buildLogDisplay([], 0, { project }),
        performance: buildPerformanceData("log", latencyMs, 0),
      };
    }
  }

  // PRO/DEV TIER: Direct Supabase REST query
  if (!supabase.isConfigured()) {
    const latencyMs = timer.stop();
    return {
      entries: [],
      total: 0,
      filters: { project },
      display: buildLogDisplay([], 0, { project }),
      performance: buildPerformanceData("log", latencyMs, 0),
    };
  }

  try {
    const queryTimer = new Timer();

    // Build PostgREST filters
    const filters: Record<string, string> = {
      project,
      is_active: "eq.true",
    };
    if (typeFilter) {
      filters.learning_type = typeFilter;
    }
    if (severityFilter) {
      filters.severity = severityFilter;
    }
    if (sinceDate) {
      filters.created_at = `gte.${sinceDate}`;
    }

    const records = await supabase.directQuery<LogEntry>("orchestra_learnings", {
      select: "id,title,learning_type,severity,created_at,source_linear_issue,project,persona_name",
      filters,
      order: "created_at.desc",
      limit,
    });

    const queryLatencyMs = queryTimer.stop();
    const latencyMs = timer.stop();

    const breakdown: PerformanceBreakdown = {
      scar_search: buildComponentPerformance(
        queryLatencyMs,
        "supabase",
        true,
        "not_applicable"
      ),
    };

    const perfData = buildPerformanceData("log", latencyMs, records.length, {
      breakdown,
      search_mode: "remote",
    });

    // Record metrics (fire and forget)
    recordMetrics({
      id: metricsId,
      tool_name: "log",
      tables_searched: ["orchestra_learnings"],
      latency_ms: latencyMs,
      result_count: records.length,
      phase_tag: "ad_hoc",
      metadata: { project, limit, typeFilter, severityFilter, sinceDays },
    }).catch(() => {});

    const filtersObj = {
      project,
      learning_type: typeFilter,
      severity: severityFilter,
      since_days: sinceDays,
      since_date: sinceDate ? formatTimestamp(sinceDate) : undefined,
    };

    return {
      entries: records.map(e => ({ ...e, created_at: formatTimestamp(e.created_at) })),
      total: records.length,
      filters: filtersObj,
      display: buildLogDisplay(records, records.length, filtersObj),
      performance: perfData,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[log] Query failed:", message);
    const latencyMs = timer.stop();
    return {
      entries: [],
      total: 0,
      filters: { project },
      display: buildLogDisplay([], 0, { project }),
      performance: buildPerformanceData("log", latencyMs, 0),
    };
  }
}

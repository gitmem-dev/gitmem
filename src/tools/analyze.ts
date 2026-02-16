/**
 * analyze Tool
 *
 * Session analytics and insights engine. Provides structured analysis
 * of session history, closing reflections, agent patterns, and more.
 *
 * Starts with "summary" lens; expanded with additional lenses in
 * (Tier 1).
 *
 * Performance target: 3000ms
 */

import {
  querySessionsByDateRange,
  computeSummary,
  aggregateClosingReflections,
  queryScarUsageByDateRange,
  queryRepeatMistakes,
  computeBlindspots,
  enrichScarUsageTitles,
  formatSummary,
  formatReflections,
  formatBlindspots,
} from "../services/analytics.js";
import { hasSupabase, getTableName } from "../services/tier.js";
import { getProject } from "../services/session-state.js";
import {
  Timer,
  recordMetrics,
  buildPerformanceData,
} from "../services/metrics.js";
import { v4 as uuidv4 } from "uuid";
import { formatDate } from "../services/timezone.js";
import type { Project, PerformanceData } from "../types/index.js";
import type { SummaryAnalytics, BlindspotsData } from "../services/analytics.js";

// --- Types ---

export type AnalyzeLens = "summary" | "reflections" | "blindspots";

export interface AnalyzeParams {
  lens?: AnalyzeLens;
  days?: number;
  project?: Project;
  agent?: string;
  format?: "json" | "text";
}

export interface AnalyzeResult {
  success: boolean;
  lens: string;
  data?: SummaryAnalytics | ReflectionsData | BlindspotsData | null;
  text?: string;
  error?: string;
  performance: PerformanceData;
}

type ReflectionEntry = { text: string; session_id: string; agent: string; date: string };
type ReflectionCategory = { entries: ReflectionEntry[]; total_count: number };

interface ReflectionsData {
  period: { start: string; end: string; days: number };
  total_sessions_scanned: number;
  sessions_with_reflections: number;
  what_broke: ReflectionCategory;
  what_worked: ReflectionCategory;
  wrong_assumptions: ReflectionCategory;
  do_differently: ReflectionCategory;
}

// --- Implementation ---

export async function analyze(params: AnalyzeParams): Promise<AnalyzeResult> {
  const timer = new Timer();
  const metricsId = uuidv4();
  const lens = params.lens || "summary";
  const days = params.days || 30;
  const project = params.project || getProject() || "default";

  if (!hasSupabase()) {
    return {
      success: false,
      lens,
      data: null,
      text: [
        "## Analytics — Not Available in Local Mode",
        "",
        "`gitmem-analyze` provides session analytics across your full history:",
        "- **summary** — session counts, agent activity, scar usage rates",
        "- **reflections** — aggregated closing reflections (what broke, what worked)",
        "- **blindspots** — scars that exist but aren't being applied",
        "",
        "This feature requires a database backend to query session history at scale.",
        "It is not available in local-only mode.",
      ].join("\n"),
      performance: buildPerformanceData("analyze" as any, 0, 0),
    };
  }

  try {
    // Compute date range
    const endDate = new Date().toISOString();
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    let data: SummaryAnalytics | ReflectionsData | BlindspotsData | null = null;

    switch (lens) {
      case "summary":
      case "reflections": {
        // Both summary and reflections need sessions
        const sessions = await querySessionsByDateRange(startDate, endDate, project, params.agent);

        if (lens === "summary") {
          data = computeSummary(sessions, days);
        } else {
          const reflections = aggregateClosingReflections(sessions);
          const sessionsWithReflections = sessions.filter(
            s => s.closing_reflection?.what_broke
          ).length;

          data = {
            period: {
              start: formatDate(startDate.slice(0, 10)),
              end: formatDate(endDate.slice(0, 10)),
              days,
            },
            total_sessions_scanned: sessions.length,
            sessions_with_reflections: sessionsWithReflections,
            ...reflections,
          };
        }
        break;
      }

      case "blindspots": {
        const [rawUsages, repeats] = await Promise.all([
          queryScarUsageByDateRange(startDate, endDate, project, params.agent),
          queryRepeatMistakes(startDate, endDate, project),
        ]);
        // Resolve missing scar titles from the learnings table
        const usages = await enrichScarUsageTitles(rawUsages);
        data = computeBlindspots(usages, repeats, days);
        break;
      }

      default:
        return {
          success: false,
          lens,
          data: null,
          error: `Unknown lens: ${lens}. Available: summary, reflections, blindspots`,
          performance: buildPerformanceData("analyze" as any, timer.stop(), 0),
        };
    }

    const latencyMs = timer.stop();
    // Determine result count based on lens type
    const resultCount = data
      ? ("total_sessions" in data ? data.total_sessions
        : "total_sessions_scanned" in data ? data.total_sessions_scanned
        : "total_scar_usages" in data ? data.total_scar_usages
        : 0)
      : 0;
    const perfData = buildPerformanceData(
      "analyze" as any,
      latencyMs,
      resultCount
    );

    // Fire-and-forget metrics
    recordMetrics({
      id: metricsId,
      tool_name: "search" as any, // Closest existing tool name for metrics table
      query_text: `analyze:${lens}:${days}d`,
      latency_ms: latencyMs,
      result_count: resultCount,
      phase_tag: "ad_hoc",
      metadata: { lens, days, agent: params.agent, format: params.format },
    }).catch(() => {});

    // Return formatted text by default, raw JSON if requested
    const fmt = params.format || "text";

    if (fmt === "text" && data) {
      let text = "";
      if (lens === "summary" && "total_sessions" in data) {
        text = formatSummary(data);
      } else if (lens === "reflections" && "total_sessions_scanned" in data) {
        text = formatReflections(data);
      } else if (lens === "blindspots" && "total_scar_usages" in data) {
        text = formatBlindspots(data);
      }

      return {
        success: true,
        lens,
        text,
        performance: perfData,
      };
    }

    return {
      success: true,
      lens,
      data,
      performance: perfData,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const latencyMs = timer.stop();
    return {
      success: false,
      lens,
      data: null,
      error: message,
      performance: buildPerformanceData("analyze" as any, latencyMs, 0),
    };
  }
}

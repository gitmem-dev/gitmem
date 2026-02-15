/**
 * search Tool (OD-560)
 *
 * Semantic search of institutional memory without action context.
 * Unlike recall (which is "I'm about to do X, warn me"), search is
 * pure exploration ("show me what we know about X").
 *
 * No side effects: no variant assignment, no session state mutation,
 * no surfaced scar tracking.
 *
 * Performance target: 500ms
 */

import * as supabase from "../services/supabase-client.js";
import { localScarSearch, isLocalSearchReady } from "../services/local-vector-search.js";
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
import { wrapDisplay, truncate, SEV, TYPE } from "../services/display-protocol.js";
import type { Project, PerformanceBreakdown, PerformanceData } from "../types/index.js";

// --- Types ---

export type LearningType = "scar" | "win" | "pattern" | "anti_pattern";
export type ScarSeverity = "critical" | "high" | "medium" | "low";

export interface SearchParams {
  query: string;
  match_count?: number;
  project?: Project;
  severity?: ScarSeverity;
  learning_type?: LearningType;
}

export interface SearchResultEntry {
  id: string;
  title: string;
  learning_type: string;
  severity: string;
  description: string;
  counter_arguments?: string[];
  similarity: number;
  source_linear_issue?: string;
}

export interface SearchResult {
  query: string;
  project: Project;
  match_count: number;
  results: SearchResultEntry[];
  total_found: number;
  filters_applied: {
    severity?: string;
    learning_type?: string;
  };
  display?: string;
  performance: PerformanceData;
}

// --- Display Formatting ---

function buildSearchDisplay(
  results: SearchResultEntry[],
  total_found: number,
  query: string,
  filters: SearchResult["filters_applied"]
): string {
  const lines: string[] = [];
  lines.push(`gitmem search · ${total_found} results · "${truncate(query, 60)}"`);
  const fp: string[] = [];
  if (filters.severity) fp.push(`severity=${filters.severity}`);
  if (filters.learning_type) fp.push(`type=${filters.learning_type}`);
  if (fp.length > 0) lines.push(`Filters: ${fp.join(", ")}`);
  lines.push("");
  if (results.length === 0) {
    lines.push("No results found.");
    return wrapDisplay(lines.join("\n"));
  }
  for (const r of results) {
    const te = TYPE[r.learning_type] || "·";
    const se = SEV[r.severity] || "⚪";
    const t = truncate(r.title, 50);
    const sim = `(${r.similarity.toFixed(2)})`;
    const issue = r.source_linear_issue ? `  ${r.source_linear_issue}` : "";
    lines.push(`${te} ${se} ${t.padEnd(52)} ${sim}${issue}`);
    lines.push(`   ${truncate(r.description, 80)}`);
  }
  lines.push("");
  lines.push(`${total_found} results found`);
  return wrapDisplay(lines.join("\n"));
}

// --- Implementation ---

interface RawScarResult {
  id: string;
  title: string;
  description: string;
  severity: string;
  learning_type?: string;
  counter_arguments?: string[];
  source_linear_issue?: string;
  similarity?: number;
}

export async function search(params: SearchParams): Promise<SearchResult> {
  const timer = new Timer();
  const metricsId = uuidv4();

  const query = params.query;
  const project: Project = params.project || getProject() as Project || "default";
  const matchCount = params.match_count || 5;
  const severityFilter = params.severity;
  const typeFilter = params.learning_type;

  // Fetch extra results when post-filtering, to ensure enough after trim
  const fetchCount = (severityFilter || typeFilter) ? matchCount * 3 : matchCount;

  // FREE TIER: local keyword search
  if (!hasSupabase()) {
    try {
      const storage = getStorage();
      const rawResults = await storage.search(query, fetchCount);

      let filtered: SearchResultEntry[] = rawResults.map(r => ({
        id: r.id,
        title: r.title,
        learning_type: r.learning_type || "scar",
        severity: r.severity || "medium",
        description: r.description || "",
        counter_arguments: r.counter_arguments || [],
        similarity: r.similarity || 0,
      }));

      if (severityFilter) {
        filtered = filtered.filter(r => r.severity === severityFilter);
      }

      filtered = filtered.slice(0, matchCount);
      const latencyMs = timer.stop();

      const filtersApplied = { severity: severityFilter, learning_type: typeFilter };
      return {
        query,
        project,
        match_count: matchCount,
        results: filtered,
        total_found: filtered.length,
        filters_applied: filtersApplied,
        display: buildSearchDisplay(filtered, filtered.length, query, filtersApplied),
        performance: buildPerformanceData("search", latencyMs, filtered.length, {
          search_mode: "local",
        }),
      };
    } catch (error) {
      const latencyMs = timer.stop();
      return {
        query,
        project,
        match_count: matchCount,
        results: [],
        total_found: 0,
        filters_applied: {},
        display: buildSearchDisplay([], 0, query, {}),
        performance: buildPerformanceData("search", latencyMs, 0),
      };
    }
  }

  // PRO/DEV TIER: vector search
  if (!supabase.isConfigured()) {
    const latencyMs = timer.stop();
    return {
      query,
      project,
      match_count: matchCount,
      results: [],
      total_found: 0,
      filters_applied: {},
      display: buildSearchDisplay([], 0, query, {}),
      performance: buildPerformanceData("search", latencyMs, 0),
    };
  }

  try {
    let rawResults: RawScarResult[] = [];
    let search_mode: "local" | "remote" = "remote";
    let network_call = true;
    let cache_hit = false;
    let cache_age_ms: number | undefined;

    const searchTimer = new Timer();

    if (isLocalSearchReady(project)) {
      search_mode = "local";
      cache_hit = true;
      network_call = false;

      const localResults = await localScarSearch(query, fetchCount, project);
      rawResults = localResults.map(r => ({
        id: r.id,
        title: r.title,
        learning_type: r.learning_type,
        description: r.description,
        severity: r.severity,
        counter_arguments: r.counter_arguments,
        similarity: r.similarity,
      }));
    } else {
      search_mode = "remote";
      const supabaseResult = await supabase.cachedScarSearch<RawScarResult>(
        query, fetchCount, project
      );
      rawResults = supabaseResult.results;
      cache_hit = supabaseResult.cache_hit;
      cache_age_ms = supabaseResult.cache_age_ms;
    }

    const searchLatencyMs = searchTimer.stop();

    // Post-filter by severity and learning_type
    let filtered = rawResults;
    if (severityFilter) {
      filtered = filtered.filter(r => r.severity === severityFilter);
    }
    if (typeFilter) {
      filtered = filtered.filter(r => r.learning_type === typeFilter);
    }
    filtered = filtered.slice(0, matchCount);

    // Map to result entries
    const results: SearchResultEntry[] = filtered.map(r => ({
      id: r.id,
      title: r.title,
      learning_type: r.learning_type || "scar",
      severity: r.severity || "medium",
      description: r.description || "",
      counter_arguments: r.counter_arguments || [],
      similarity: r.similarity || 0,
      source_linear_issue: r.source_linear_issue,
    }));

    const latencyMs = timer.stop();
    const breakdown: PerformanceBreakdown = {
      scar_search: buildComponentPerformance(
        searchLatencyMs,
        search_mode === "local" ? "local_cache" : "supabase",
        network_call,
        network_call ? "miss" : "hit"
      ),
    };

    const perfData = buildPerformanceData("search", latencyMs, results.length, {
      memoriesSurfaced: results.map(r => r.id),
      similarityScores: results.map(r => r.similarity),
      cache_hit,
      cache_age_ms,
      search_mode,
      breakdown,
    });

    // Record metrics (fire and forget)
    recordMetrics({
      id: metricsId,
      tool_name: "search",
      query_text: query,
      tables_searched: search_mode === "local" ? [] : ["orchestra_learnings"],
      latency_ms: latencyMs,
      result_count: results.length,
      similarity_scores: results.map(r => r.similarity),
      phase_tag: "ad_hoc",
      memories_surfaced: results.map(r => r.id),
      metadata: { project, match_count: matchCount, search_mode, severityFilter, typeFilter },
    }).catch(() => {});

    const filtersAppliedFinal = { severity: severityFilter, learning_type: typeFilter };
    return {
      query,
      project,
      match_count: matchCount,
      results,
      total_found: results.length,
      filters_applied: filtersAppliedFinal,
      display: buildSearchDisplay(results, results.length, query, filtersAppliedFinal),
      performance: perfData,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[search] Search failed:", message);
    const latencyMs = timer.stop();
    return {
      query,
      project,
      match_count: matchCount,
      results: [],
      total_found: 0,
      filters_applied: {},
      display: buildSearchDisplay([], 0, query, {}),
      performance: buildPerformanceData("search", latencyMs, 0),
    };
  }
}

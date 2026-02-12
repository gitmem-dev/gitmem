/**
 * GitMem Performance Metrics Service
 *
 * Tracks latency, result counts, and relevance signals for all GitMem tools.
 * Implements OD-429 instrumentation layer.
 */

import { v4 as uuidv4 } from "uuid";
import * as supabase from "./supabase-client.js";
import { getEffectTracker } from "./effect-tracker.js";

/**
 * Tool names that can be tracked
 */
export type ToolName =
  | "recall"
  | "search"
  | "log"
  | "session_start"
  | "session_refresh"
  | "session_close"
  | "create_learning"
  | "create_decision"
  | "record_scar_usage"
  | "record_scar_usage_batch"
  | "save_transcript"
  | "get_transcript"
  | "analyze"
  | "graph_traverse"
  | "prepare_context"
  | "absorb_observations"
  | "list_threads"
  | "resolve_thread"
  | "create_thread"
  | "confirm_scars"
  | "cleanup_threads"
  | "health";

/**
 * Phase tags for context
 */
export type PhaseTag =
  | "session_start"
  | "session_refresh"
  | "session_close"
  | "recall"
  | "learning_capture"
  | "decision_capture"
  | "scar_tracking"
  | "ad_hoc";

/**
 * Agent identities
 */
export type AgentIdentity =
  | "CLI"
  | "DAC"
  | "CODA-1"
  | "Brain_Local"
  | "Brain_Cloud";

/**
 * Metrics data for a query
 */
export interface QueryMetrics {
  id: string;
  session_id?: string;
  agent?: AgentIdentity;
  tool_name: ToolName;
  query_text?: string;
  tables_searched?: string[];
  latency_ms: number;
  result_count: number;
  similarity_scores?: number[];
  context_bytes?: number;
  phase_tag?: PhaseTag;
  linear_issue?: string;
  memories_surfaced?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Performance targets from OD-429
 */
export const PERFORMANCE_TARGETS: Record<ToolName, number> = {
  recall: 2000,
  search: 500,
  log: 500,
  session_start: 750,     // OD-645: Lean start (was 1500)
  session_refresh: 750,   // OD-645: Lean refresh (was 1500)
  session_close: 1500,    // OD-645: Tightened (was 3000)
  create_learning: 3000,
  create_decision: 3000,
  record_scar_usage: 1000,
  record_scar_usage_batch: 2000,
  save_transcript: 5000,  // Large payload upload
  get_transcript: 3000,   // Retrieval
  analyze: 3000,          // Session analytics queries
  graph_traverse: 3000,   // Knowledge graph traversal
  prepare_context: 500,   // Same pipeline as search, different formatter
  absorb_observations: 500, // In-memory + optional upsert
  list_threads: 100,        // In-memory read
  resolve_thread: 100,      // In-memory mutation + file write
  create_thread: 100,       // In-memory mutation + file write
  confirm_scars: 500,       // In-memory validation + file write
  cleanup_threads: 2000,    // Fetch all threads + lifecycle computation
  health: 100,              // In-memory read from EffectTracker
};

/**
 * Timer utility for tracking operation duration
 */
export class Timer {
  private startTime: number;
  private endTime?: number;

  constructor() {
    this.startTime = performance.now();
  }

  stop(): number {
    this.endTime = performance.now();
    return this.elapsed();
  }

  elapsed(): number {
    const end = this.endTime ?? performance.now();
    return Math.round(end - this.startTime);
  }
}

/**
 * Track a query and record metrics.
 *
 * Wrapped by Effect Tracker — failures are recorded instead of swallowed.
 * Callers can still use `.catch(() => {})` but failures will appear in health reports.
 */
export async function recordMetrics(metrics: QueryMetrics): Promise<void> {
  const record: Record<string, unknown> = {
    id: metrics.id,
    session_id: metrics.session_id || null,
    agent: metrics.agent || null,
    tool_name: metrics.tool_name,
    query_text: metrics.query_text || null,
    tables_searched: metrics.tables_searched || null,
    latency_ms: metrics.latency_ms,
    result_count: metrics.result_count,
    similarity_scores: metrics.similarity_scores || null,
    context_bytes: metrics.context_bytes || null,
    phase_tag: metrics.phase_tag || null,
    linear_issue: metrics.linear_issue || null,
    memories_surfaced: metrics.memories_surfaced || null,
    metadata: metrics.metadata || {},
    created_at: new Date().toISOString(),
  };

  const tracker = getEffectTracker();
  await tracker.track("metrics", metrics.tool_name, () =>
    supabase.directUpsert("gitmem_query_metrics", record)
  );
}

/**
 * Re-export performance types from types/index.ts
 * OD-489: Enhanced instrumentation for test harness validation
 */
export type {
  PerformanceData,
  PerformanceBreakdown,
  ComponentPerformance,
  DataSource,
  CacheStatus,
} from "../types/index.js";

import type {
  PerformanceData,
  PerformanceBreakdown,
  ComponentPerformance,
  DataSource,
  CacheStatus,
} from "../types/index.js";

/**
 * Build component performance data (OD-489)
 */
export function buildComponentPerformance(
  latencyMs: number,
  source: DataSource,
  networkCall: boolean,
  cacheStatus: CacheStatus = networkCall ? "miss" : "hit"
): ComponentPerformance {
  return {
    latency_ms: latencyMs,
    source,
    cache_status: cacheStatus,
    network_call: networkCall,
  };
}

/**
 * Count network calls from breakdown (OD-489)
 */
export function countNetworkCalls(breakdown?: PerformanceBreakdown): number {
  if (!breakdown) return 0;
  let count = 0;
  // Read operations
  if (breakdown.last_session?.network_call) count++;
  if (breakdown.scar_search?.network_call) count++;
  if (breakdown.decisions?.network_call) count++;
  if (breakdown.wins?.network_call) count++;
  if (breakdown.session_create?.network_call) count++;
  // Write operations
  if (breakdown.embedding?.network_call) count++;
  if (breakdown.upsert?.network_call) count++;
  if (breakdown.storage_write?.network_call) count++;
  return count;
}

export function buildPerformanceData(
  toolName: ToolName,
  latencyMs: number,
  resultCount: number,
  options?: {
    memoriesSurfaced?: string[];
    similarityScores?: number[];
    cache_hit?: boolean;
    cache_age_ms?: number;
    search_mode?: "local" | "remote";
    // OD-489: Detailed instrumentation
    breakdown?: PerformanceBreakdown;
  }
): PerformanceData {
  const targetMs = PERFORMANCE_TARGETS[toolName];
  const networkCallsMade = countNetworkCalls(options?.breakdown);
  const fullyLocal = networkCallsMade === 0;

  return {
    // Legacy fields
    latency_ms: latencyMs,
    target_ms: targetMs,
    meets_target: latencyMs <= targetMs,
    result_count: resultCount,
    memories_surfaced: options?.memoriesSurfaced,
    similarity_scores: options?.similarityScores,
    cache_hit: options?.cache_hit ?? fullyLocal,
    cache_age_ms: options?.cache_age_ms,
    search_mode: options?.search_mode,

    // OD-489: Detailed instrumentation for test harness
    total_latency_ms: latencyMs,
    network_calls_made: networkCallsMade,
    fully_local: fullyLocal,
    breakdown: options?.breakdown,
  };
}

/**
 * Calculate response size in bytes (approximate)
 */
export function calculateContextBytes(data: unknown): number {
  return new TextEncoder().encode(JSON.stringify(data)).length;
}

/**
 * Wrap an async operation with timing and metrics
 */
export async function withMetrics<T>(
  toolName: ToolName,
  operation: () => Promise<T>,
  options?: {
    sessionId?: string;
    agent?: AgentIdentity;
    queryText?: string;
    tablesSearched?: string[];
    phaseTag?: PhaseTag;
    linearIssue?: string;
  }
): Promise<{ result: T; metrics: QueryMetrics }> {
  const timer = new Timer();
  const metricsId = uuidv4();

  const result = await operation();

  const latencyMs = timer.stop();

  // Extract result count and memories from result if available
  let resultCount = 0;
  let memoriesSurfaced: string[] | undefined;
  let similarityScores: number[] | undefined;

  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;

    // Handle different result shapes
    if (Array.isArray(r.scars)) {
      resultCount = r.scars.length;
      memoriesSurfaced = (r.scars as Array<{ id: string }>).map((s) => s.id);
      similarityScores = (r.scars as Array<{ similarity?: number }>)
        .map((s) => s.similarity)
        .filter((s): s is number => s !== undefined);
    } else if (Array.isArray(r.relevant_scars)) {
      resultCount = r.relevant_scars.length;
      memoriesSurfaced = (r.relevant_scars as Array<{ id: string }>).map(
        (s) => s.id
      );
      similarityScores = (r.relevant_scars as Array<{ similarity?: number }>)
        .map((s) => s.similarity)
        .filter((s): s is number => s !== undefined);
    } else if (r.learning_id) {
      resultCount = 1;
    } else if (r.decision_id) {
      resultCount = 1;
    } else if (r.usage_id) {
      resultCount = 1;
    } else if (r.session_id) {
      resultCount = 1;
    }
  }

  const metrics: QueryMetrics = {
    id: metricsId,
    session_id: options?.sessionId,
    agent: options?.agent,
    tool_name: toolName,
    query_text: options?.queryText,
    tables_searched: options?.tablesSearched,
    latency_ms: latencyMs,
    result_count: resultCount,
    similarity_scores: similarityScores,
    context_bytes: calculateContextBytes(result),
    phase_tag: options?.phaseTag,
    linear_issue: options?.linearIssue,
    memories_surfaced: memoriesSurfaced,
  };

  // Record metrics asynchronously (don't await)
  recordMetrics(metrics).catch(() => {});

  return { result, metrics };
}

/**
 * Update metrics with relevance data (called at session close)
 *
 * Wrapped by Effect Tracker — failures are visible in health reports.
 */
export async function updateRelevanceData(
  sessionId: string,
  memoriesApplied: string[]
): Promise<void> {
  const tracker = getEffectTracker();
  await tracker.track("relevance_update", sessionId, async () => {
    // Get all metrics for this session that surfaced memories
    const metrics = await supabase.listRecords<{
      id: string;
      memories_surfaced?: string[];
    }>({
      table: "gitmem_query_metrics",
      filters: { session_id: sessionId },
    });

    if (!metrics || !Array.isArray(metrics)) return;

    // Update each metric with applied memories
    for (const metric of metrics) {
      if (metric.memories_surfaced && Array.isArray(metric.memories_surfaced)) {
        const applied = metric.memories_surfaced.filter((id: string) =>
          memoriesApplied.includes(id)
        );

        if (applied.length > 0) {
          await supabase.directUpsert("gitmem_query_metrics", {
            id: metric.id,
            memories_applied: applied,
          });
        }
      }
    }
  });
}

/**
 * Detect re-query pattern (similar query with different terms)
 */
export async function detectRequery(
  sessionId: string,
  currentQuery: string,
  toolName: ToolName
): Promise<boolean> {
  try {
    // Get recent queries from same session
    const recentMetrics = await supabase.listRecords<{
      created_at: string;
    }>({
      table: "gitmem_query_metrics",
      filters: { session_id: sessionId, tool_name: toolName },
      limit: 5,
    });

    if (!recentMetrics || !Array.isArray(recentMetrics)) return false;

    // Simple heuristic: if we have multiple queries in short succession, it's a re-query
    const recentCount = recentMetrics.filter((m) => {
      const created = new Date(m.created_at);
      const now = new Date();
      const diffMs = now.getTime() - created.getTime();
      return diffMs < 60000; // Within last minute
    }).length;

    return recentCount >= 2;
  } catch (error) {
    return false;
  }
}

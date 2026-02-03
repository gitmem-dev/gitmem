/**
 * record_scar_usage Tool
 *
 * Track scar application for effectiveness measurement.
 * Records to scar_usage table.
 *
 * Performance target: <1000ms (OD-429)
 */

import { v4 as uuidv4 } from "uuid";
import * as supabase from "../services/supabase-client.js";
import { hasSupabase } from "../services/tier.js";
import { getStorage } from "../services/storage.js";
import {
  Timer,
  recordMetrics,
  buildPerformanceData,
} from "../services/metrics.js";
import type {
  RecordScarUsageParams,
  RecordScarUsageResult,
  PerformanceBreakdown,
} from "../types/index.js";

/**
 * Execute record_scar_usage tool
 */
export async function recordScarUsage(
  params: RecordScarUsageParams
): Promise<RecordScarUsageResult> {
  const timer = new Timer();
  const metricsId = uuidv4();
  const usageId = uuidv4();

  const usageData: Record<string, unknown> = {
    id: usageId,
    scar_id: params.scar_id,
    issue_id: params.issue_id || null,
    issue_identifier: params.issue_identifier || null,
    session_id: params.session_id || null, // OD-552: Session tracking
    agent: params.agent || null, // OD-552: Agent identity
    surfaced_at: params.surfaced_at,
    acknowledged_at: params.acknowledged_at || null,
    referenced: params.reference_type !== "none",
    reference_type: params.reference_type,
    reference_context: params.reference_context,
    execution_successful: params.execution_successful ?? null,
    created_at: new Date().toISOString(),
  };

  try {
    const breakdown: PerformanceBreakdown = {};

    if (hasSupabase()) {
      const upsertStart = Date.now();
      await supabase.directUpsert("scar_usage", usageData);
      breakdown.upsert = {
        latency_ms: Date.now() - upsertStart,
        source: "supabase",
        cache_status: "not_applicable",
        network_call: true,
      };
    } else {
      const upsertStart = Date.now();
      await getStorage().upsert("scar_usage", usageData);
      breakdown.upsert = {
        latency_ms: Date.now() - upsertStart,
        source: "memory",
        cache_status: "not_applicable",
        network_call: false,
      };
    }

    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("record_scar_usage", latencyMs, 1, {
      breakdown,
    });

    // Record metrics
    recordMetrics({
      id: metricsId,
      tool_name: "record_scar_usage",
      tables_searched: ["scar_usage"],
      latency_ms: latencyMs,
      result_count: 1,
      phase_tag: "scar_tracking",
      linear_issue: params.issue_identifier,
      memories_surfaced: [params.scar_id],
      metadata: {
        reference_type: params.reference_type,
        execution_successful: params.execution_successful,
      },
    }).catch(() => {});

    return {
      success: true,
      usage_id: usageId,
      performance: perfData,
    };
  } catch (error) {
    console.error("[record_scar_usage] Failed:", error);
    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("record_scar_usage", latencyMs, 0);
    return {
      success: false,
      usage_id: "",
      performance: perfData,
    };
  }
}

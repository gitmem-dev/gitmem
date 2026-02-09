/**
 * create_decision Tool
 *
 * Log architectural/operational decision to orchestra_decisions.
 * Generates embeddings client-side and writes directly to Supabase REST API,
 * eliminating the ww-mcp Edge Function dependency.
 *
 * Performance target: <3000ms (OD-429)
 */

import { v4 as uuidv4 } from "uuid";
import * as supabase from "../services/supabase-client.js";
import { embed, isEmbeddingAvailable } from "../services/embedding.js";
import { getAgentIdentity } from "../services/agent-detection.js";
import { writeTriplesForDecision } from "../services/triple-writer.js";
import { hasSupabase } from "../services/tier.js";
import { getStorage } from "../services/storage.js";
import {
  Timer,
  recordMetrics,
  buildPerformanceData,
} from "../services/metrics.js";
import type {
  CreateDecisionParams,
  CreateDecisionResult,
  PerformanceBreakdown,
} from "../types/index.js";

/**
 * Execute create_decision tool
 */
export async function createDecision(
  params: CreateDecisionParams
): Promise<CreateDecisionResult> {
  const timer = new Timer();
  const metricsId = uuidv4();
  const decisionId = uuidv4();
  const today = new Date().toISOString().split("T")[0];

  const decisionData: Record<string, unknown> = {
    id: decisionId,
    decision_date: today,
    title: params.title,
    decision: params.decision,
    rationale: params.rationale,
    alternatives_considered: params.alternatives_considered || [],
    personas_involved: params.personas_involved || [],
    docs_affected: params.docs_affected || [],
    linear_issue: params.linear_issue || null,
    session_id: params.session_id || null,
    project: params.project || "orchestra_dev",
    created_at: new Date().toISOString(),
  };

  try {
    const breakdown: PerformanceBreakdown = {};

    if (hasSupabase()) {
      // Pro/Dev tier: Generate embedding and write to Supabase
      if (isEmbeddingAvailable()) {
        try {
          const embedStart = Date.now();
          const embeddingText = `${params.title} | ${params.decision} | ${params.rationale}`;
          const embeddingVector = await embed(embeddingText);
          const embedLatency = Date.now() - embedStart;
          if (embeddingVector) {
            decisionData.embedding = JSON.stringify(embeddingVector);
            console.error(`[create_decision] Embedding generated (${embeddingVector.length} dims)`);
          }
          breakdown.embedding = {
            latency_ms: embedLatency,
            source: "supabase",
            cache_status: "not_applicable",
            network_call: true,
          };
        } catch (embError) {
          console.warn("[create_decision] Embedding generation failed (storing without):", embError);
        }
      }

      // Write directly to Supabase REST API (bypasses ww-mcp)
      const upsertStart = Date.now();
      await supabase.directUpsert("orchestra_decisions", decisionData);
      breakdown.upsert = {
        latency_ms: Date.now() - upsertStart,
        source: "supabase",
        cache_status: "not_applicable",
        network_call: true,
      };

      // OD-466: Auto-create knowledge triples (fire-and-forget)
      writeTriplesForDecision({
        id: decisionId,
        title: params.title,
        decision: params.decision,
        rationale: params.rationale,
        personas_involved: params.personas_involved,
        docs_affected: params.docs_affected,
        linear_issue: params.linear_issue,
        session_id: params.session_id,
        project: (params.project || "orchestra_dev"),
        agent: getAgentIdentity(),
      }).catch((err) => {
        console.warn("[create_decision] Triple generation failed (non-fatal):", err);
      });
    } else {
      // Free tier: Store locally without embedding
      const upsertStart = Date.now();
      await getStorage().upsert("decisions", decisionData);
      breakdown.upsert = {
        latency_ms: Date.now() - upsertStart,
        source: "memory",
        cache_status: "not_applicable",
        network_call: false,
      };
    }

    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("create_decision", latencyMs, 1, {
      breakdown,
    });

    // Record metrics
    recordMetrics({
      id: metricsId,
      session_id: params.session_id,
      tool_name: "create_decision",
      tables_searched: ["orchestra_decisions"],
      latency_ms: latencyMs,
      result_count: 1,
      phase_tag: "decision_capture",
      linear_issue: params.linear_issue,
      metadata: {
        project: params.project || "orchestra_dev",
        alternatives_count: (params.alternatives_considered || []).length,
        write_path: "directUpsert",
      },
    }).catch(() => {});

    return {
      success: true,
      decision_id: decisionId,
      performance: perfData,
    };
  } catch (error) {
    console.error("[create_decision] Failed:", error);
    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("create_decision", latencyMs, 0);
    return {
      success: false,
      decision_id: "",
      performance: perfData,
    };
  }
}

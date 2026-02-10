/**
 * create_learning Tool
 *
 * Create scar, win, or pattern entry in orchestra_learnings.
 * Generates embeddings client-side and writes directly to Supabase REST API,
 * eliminating the ww-mcp Edge Function dependency.
 *
 * Performance target: <3000ms (OD-429)
 */

import { v4 as uuidv4 } from "uuid";
import * as supabase from "../services/supabase-client.js";
import { embed, isEmbeddingAvailable } from "../services/embedding.js";
import { getAgentIdentity } from "../services/agent-detection.js";
import { flushCache } from "../services/startup.js";
import { writeTriplesForLearning } from "../services/triple-writer.js";
import { hasSupabase } from "../services/tier.js";
import { getStorage } from "../services/storage.js";
import {
  Timer,
  recordMetrics,
  buildPerformanceData,
} from "../services/metrics.js";
import type {
  CreateLearningParams,
  CreateLearningResult,
  Project,
  PerformanceBreakdown,
  ComponentPerformance,
} from "../types/index.js";

/**
 * Validate scar-specific requirements
 */
function validateScar(params: CreateLearningParams): string[] {
  const errors: string[] = [];

  if (!params.severity) {
    errors.push("Scars require severity (critical, high, medium, low)");
  }

  if (!params.counter_arguments || params.counter_arguments.length < 2) {
    errors.push("Scars require at least 2 counter_arguments");
  }

  return errors;
}

/**
 * Build embedding text from learning fields
 */
function buildEmbeddingText(params: CreateLearningParams): string {
  const parts = [params.title, params.description];

  if (params.keywords?.length) {
    parts.push(params.keywords.join(", "));
  }
  if (params.domain?.length) {
    parts.push(params.domain.join(", "));
  }
  if (params.counter_arguments?.length) {
    parts.push(params.counter_arguments.join(". "));
  }

  return parts.join(" | ");
}

/**
 * Execute create_learning tool
 */
export async function createLearning(
  params: CreateLearningParams
): Promise<CreateLearningResult> {
  const timer = new Timer();
  const metricsId = uuidv4();

  // Validate based on learning type
  if (params.learning_type === "scar") {
    const errors = validateScar(params);
    if (errors.length > 0) {
      const latencyMs = timer.stop();
      const perfData = buildPerformanceData("create_learning", latencyMs, 0);
      return {
        success: false,
        learning_id: "",
        embedding_generated: false,
        performance: perfData,
      };
    }
  }

  const learningId = uuidv4();

  // Detect agent identity for persona_name
  const agentIdentity = getAgentIdentity();

  // Build learning record
  const learningData: Record<string, unknown> = {
    id: learningId,
    learning_type: params.learning_type,
    title: params.title,
    description: params.description,
    project: params.project || "default",
    source_linear_issue: params.source_linear_issue || null,
    keywords: params.keywords || [],
    domain: params.domain || [],
    created_at: new Date().toISOString(),
    persona_name: agentIdentity,
    source_date: new Date().toISOString().split("T")[0],
    // OD-508: LLM-cooperative enforcement fields (optional)
    ...(params.why_this_matters && { why_this_matters: params.why_this_matters }),
    ...(params.action_protocol && { action_protocol: params.action_protocol }),
    ...(params.self_check_criteria && { self_check_criteria: params.self_check_criteria }),
  };

  // Add type-specific fields
  if (params.learning_type === "scar") {
    learningData.severity = params.severity;
    learningData.scar_type = params.scar_type || "process";
    learningData.counter_arguments = params.counter_arguments;
  }

  if (params.learning_type === "win") {
    learningData.problem_context = params.problem_context || "";
    learningData.solution_approach = params.solution_approach || "";
    learningData.applies_when = params.applies_when || [];
    learningData.severity = params.severity || "medium";
  }

  if (params.learning_type === "pattern") {
    learningData.severity = params.severity || "low";
  }

  try {
    let embeddingGenerated = false;
    const breakdown: PerformanceBreakdown = {};

    if (hasSupabase()) {
      // Pro/Dev tier: Generate embedding and write to Supabase
      if (isEmbeddingAvailable()) {
        try {
          const embedStart = Date.now();
          const embeddingText = buildEmbeddingText(params);
          const embeddingVector = await embed(embeddingText);
          const embedLatency = Date.now() - embedStart;
          if (embeddingVector) {
            // Supabase pgvector expects a JSON string for vector columns
            learningData.embedding = JSON.stringify(embeddingVector);
            embeddingGenerated = true;
            console.error(`[create_learning] Embedding generated (${embeddingVector.length} dims)`);
          }
          breakdown.embedding = {
            latency_ms: embedLatency,
            source: "supabase",
            cache_status: "not_applicable",
            network_call: true,
          };
        } catch (embError) {
          // Non-fatal: store without embedding, log warning
          console.warn("[create_learning] Embedding generation failed (storing without):", embError);
        }
      } else {
        console.warn("[create_learning] No embedding provider configured — storing without embedding");
      }

      console.error(`[create_learning] Attempting directUpsert for learning ${learningId}`);
      console.error(`[create_learning] Learning type: ${params.learning_type}, Project: ${params.project || "default"}`);

      // Write directly to Supabase REST API (bypasses ww-mcp)
      const upsertStart = Date.now();
      const writeResult = await supabase.directUpsert<{ id: string }>("orchestra_learnings", learningData);
      const upsertLatency = Date.now() - upsertStart;
      breakdown.upsert = {
        latency_ms: upsertLatency,
        source: "supabase",
        cache_status: "not_applicable",
        network_call: true,
      };

      // OD-539: Defense in depth - verify write succeeded
      // directUpsert now throws on empty result, but explicit check documents expectation
      if (!writeResult || !writeResult.id) {
        throw new Error(
          `Write verification failed: directUpsert returned ${writeResult ? 'record without id' : 'null/undefined'}. ` +
          `Expected record with id field.`
        );
      }

      console.error(`[create_learning] directUpsert succeeded, verified ID: ${writeResult.id}`);

      // OD-466: Auto-create knowledge triples (fire-and-forget)
      writeTriplesForLearning({
        id: learningId,
        learning_type: params.learning_type,
        title: params.title,
        description: params.description,
        scar_type: params.scar_type,
        source_linear_issue: params.source_linear_issue,
        persona_name: agentIdentity,
        domain: params.domain,
        project: (params.project || "default"),
      }).catch((err) => {
        console.warn("[create_learning] Triple generation failed (non-fatal):", err);
      });

      // Invalidate local cache so next recall picks up the new learning
      const project = (params.project || "default") as Project;
      flushCache(project).catch((err) => {
        console.warn("[create_learning] Cache invalidation failed (non-fatal):", err);
      });
    } else {
      // Free tier: Store locally without embedding
      console.error(`[create_learning] Storing locally: ${learningId}`);
      const upsertStart = Date.now();
      await getStorage().upsert("learnings", learningData);
      breakdown.upsert = {
        latency_ms: Date.now() - upsertStart,
        source: "memory",
        cache_status: "not_applicable",
        network_call: false,
      };
    }

    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("create_learning", latencyMs, 1, {
      breakdown,
    });

    // Record metrics
    recordMetrics({
      id: metricsId,
      tool_name: "create_learning",
      tables_searched: ["orchestra_learnings"],
      latency_ms: latencyMs,
      result_count: 1,
      phase_tag: "learning_capture",
      metadata: {
        learning_type: params.learning_type,
        project: params.project || "default",
        embedding_generated: embeddingGenerated,
        write_path: "directUpsert",
      },
    }).catch(() => {});

    return {
      success: true,
      learning_id: learningId,
      embedding_generated: embeddingGenerated,
      performance: perfData,
    };
  } catch (error) {
    console.error("[create_learning] Failed:", error);
    console.error("[create_learning] Error details:", error instanceof Error ? error.message : String(error));
    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("create_learning", latencyMs, 0);
    return {
      success: false,
      learning_id: "",
      embedding_generated: false,
      performance: perfData,
    };
  }
}

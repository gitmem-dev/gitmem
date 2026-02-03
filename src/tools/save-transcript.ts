/**
 * save_transcript Tool
 *
 * Save full session transcript to Supabase storage for training data,
 * post-mortems, and pattern mining.
 *
 * Issue: OD-467
 */

import { detectAgent } from "../services/agent-detection.js";
import * as supabase from "../services/supabase-client.js";
import { Timer, buildPerformanceData } from "../services/metrics.js";
import type { Project, PerformanceData, PerformanceBreakdown } from "../types/index.js";

export interface SaveTranscriptParams {
  session_id: string;
  transcript: string;
  format?: "json" | "markdown";
  project?: Project;
}

export interface SaveTranscriptResult {
  success: boolean;
  transcript_path?: string;
  size_bytes?: number;
  size_kb?: number;
  estimated_tokens?: number;
  error?: string;
  performance: PerformanceData;
}

/**
 * Execute save_transcript tool
 */
export async function saveTranscript(
  params: SaveTranscriptParams
): Promise<SaveTranscriptResult> {
  const timer = new Timer();

  // Validate required parameters
  if (!params.session_id) {
    const latencyMs = timer.stop();
    return {
      success: false,
      error: "session_id is required",
      performance: buildPerformanceData("save_transcript", latencyMs, 0),
    };
  }

  if (!params.transcript) {
    const latencyMs = timer.stop();
    return {
      success: false,
      error: "transcript content is required",
      performance: buildPerformanceData("save_transcript", latencyMs, 0),
    };
  }

  // Get agent identity for path organization
  const env = detectAgent();
  const agent = env.agent;
  const project = params.project || "orchestra_dev";
  const format = params.format || "json";

  try {
    // Prepare transcript content
    let content: string;
    if (format === "json") {
      // Wrap in metadata if not already JSON
      try {
        JSON.parse(params.transcript);
        content = params.transcript; // Already valid JSON
      } catch {
        // Wrap plain text in JSON structure
        content = JSON.stringify({
          session_id: params.session_id,
          agent,
          project,
          captured_at: new Date().toISOString(),
          transcript: params.transcript,
        }, null, 2);
      }
    } else {
      content = params.transcript;
    }

    // Save to storage
    const writeStart = Date.now();
    const result = await supabase.saveTranscript(
      params.session_id,
      content,
      { project, agent, format }
    );
    const breakdown: PerformanceBreakdown = {
      storage_write: {
        latency_ms: Date.now() - writeStart,
        source: "supabase",
        cache_status: "not_applicable",
        network_call: true,
      },
    };

    const latencyMs = timer.stop();

    // Estimate tokens (rough: ~4 chars per token)
    const estimatedTokens = Math.ceil(result.size_bytes / 4);

    return {
      success: true,
      transcript_path: result.transcript_path,
      size_bytes: result.size_bytes,
      size_kb: Math.round(result.size_bytes / 1024 * 10) / 10,
      estimated_tokens: estimatedTokens,
      performance: buildPerformanceData("save_transcript", latencyMs, 1, {
        breakdown,
      }),
    };
  } catch (error) {
    const latencyMs = timer.stop();
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to save transcript: ${errorMessage}`,
      performance: buildPerformanceData("save_transcript", latencyMs, 0),
    };
  }
}

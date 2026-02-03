/**
 * get_transcript Tool
 *
 * Retrieve a session transcript from Supabase storage.
 *
 * Issue: OD-467
 */

import * as supabase from "../services/supabase-client.js";
import { Timer, buildPerformanceData } from "../services/metrics.js";
import type { PerformanceData } from "../types/index.js";

export interface GetTranscriptParams {
  session_id: string;
}

export interface GetTranscriptResult {
  success: boolean;
  transcript?: string;
  transcript_path?: string;
  size_bytes?: number;
  error?: string;
  performance: PerformanceData;
}

/**
 * Execute get_transcript tool
 */
export async function getTranscript(
  params: GetTranscriptParams
): Promise<GetTranscriptResult> {
  const timer = new Timer();

  // Validate required parameters
  if (!params.session_id) {
    const latencyMs = timer.stop();
    return {
      success: false,
      error: "session_id is required",
      performance: buildPerformanceData("get_transcript", latencyMs, 0),
    };
  }

  try {
    const result = await supabase.getTranscript(params.session_id);

    const latencyMs = timer.stop();

    if (!result) {
      return {
        success: false,
        error: `No transcript found for session ${params.session_id}`,
        performance: buildPerformanceData("get_transcript", latencyMs, 0),
      };
    }

    return {
      success: true,
      transcript: result.transcript,
      transcript_path: result.path,
      size_bytes: Buffer.byteLength(result.transcript, "utf8"),
      performance: buildPerformanceData("get_transcript", latencyMs, 1),
    };
  } catch (error) {
    const latencyMs = timer.stop();
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to retrieve transcript: ${errorMessage}`,
      performance: buildPerformanceData("get_transcript", latencyMs, 0),
    };
  }
}

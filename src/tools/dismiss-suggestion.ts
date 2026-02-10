/**
 * dismiss_suggestion Tool (Phase 5: Implicit Thread Detection)
 *
 * Dismisses a suggested thread. Increments dismissed_count.
 * Suggestions dismissed 3+ times are permanently suppressed.
 *
 * Performance target: <100ms (file read + write)
 */

import {
  loadSuggestions,
  saveSuggestions,
  dismissSuggestionById,
} from "../services/thread-suggestions.js";
import {
  Timer,
  buildPerformanceData,
} from "../services/metrics.js";
import type { PerformanceData, ThreadSuggestion } from "../types/index.js";

// --- Types ---

export interface DismissSuggestionParams {
  suggestion_id: string;
}

export interface DismissSuggestionResult {
  success: boolean;
  suggestion?: ThreadSuggestion;
  error?: string;
  performance: PerformanceData;
}

// --- Handler ---

export async function dismissSuggestion(
  params: DismissSuggestionParams
): Promise<DismissSuggestionResult> {
  const timer = new Timer();

  if (!params.suggestion_id) {
    const latencyMs = timer.stop();
    return {
      success: false,
      error: "suggestion_id is required",
      performance: buildPerformanceData("dismiss_suggestion" as any, latencyMs, 0),
    };
  }

  const suggestions = loadSuggestions();
  const result = dismissSuggestionById(params.suggestion_id, suggestions);

  if (!result) {
    const latencyMs = timer.stop();
    return {
      success: false,
      error: `Suggestion not found: "${params.suggestion_id}"`,
      performance: buildPerformanceData("dismiss_suggestion" as any, latencyMs, 0),
    };
  }

  saveSuggestions(suggestions);

  const latencyMs = timer.stop();
  return {
    success: true,
    suggestion: result,
    performance: buildPerformanceData("dismiss_suggestion" as any, latencyMs, 1),
  };
}

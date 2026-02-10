/**
 * promote_suggestion Tool (Phase 5: Implicit Thread Detection)
 *
 * Promotes a suggested thread to an actual open thread.
 * 1. Load suggestions, find by ID
 * 2. Create thread via createThread()
 * 3. Mark suggestion as promoted with promoted_thread_id
 * 4. Save updated suggestions
 *
 * Performance target: <1000ms (thread creation + file write)
 */

import {
  loadSuggestions,
  saveSuggestions,
  promoteSuggestionById,
} from "../services/thread-suggestions.js";
import { createThread } from "./create-thread.js";
import {
  Timer,
  buildPerformanceData,
} from "../services/metrics.js";
import type { ThreadObject, PerformanceData, Project, ThreadSuggestion } from "../types/index.js";

// --- Types ---

export interface PromoteSuggestionParams {
  suggestion_id: string;
  project?: Project;
}

export interface PromoteSuggestionResult {
  success: boolean;
  thread?: ThreadObject;
  suggestion?: ThreadSuggestion;
  error?: string;
  performance: PerformanceData;
}

// --- Handler ---

export async function promoteSuggestion(
  params: PromoteSuggestionParams
): Promise<PromoteSuggestionResult> {
  const timer = new Timer();

  if (!params.suggestion_id) {
    const latencyMs = timer.stop();
    return {
      success: false,
      error: "suggestion_id is required",
      performance: buildPerformanceData("promote_suggestion" as any, latencyMs, 0),
    };
  }

  const suggestions = loadSuggestions();
  const target = suggestions.find(
    (s) => s.id === params.suggestion_id && s.status === "pending"
  );

  if (!target) {
    const latencyMs = timer.stop();
    return {
      success: false,
      error: `Pending suggestion not found: "${params.suggestion_id}"`,
      performance: buildPerformanceData("promote_suggestion" as any, latencyMs, 0),
    };
  }

  // Create the thread from the suggestion text
  const threadResult = await createThread({
    text: target.text,
    project: params.project,
  });

  if (!threadResult.success || !threadResult.thread) {
    const latencyMs = timer.stop();
    return {
      success: false,
      error: `Thread creation failed: ${threadResult.error || "unknown"}`,
      performance: buildPerformanceData("promote_suggestion" as any, latencyMs, 0),
    };
  }

  // Mark suggestion as promoted
  promoteSuggestionById(params.suggestion_id, threadResult.thread.id, suggestions);
  saveSuggestions(suggestions);

  const latencyMs = timer.stop();
  return {
    success: true,
    thread: threadResult.thread,
    suggestion: target,
    performance: buildPerformanceData("promote_suggestion" as any, latencyMs, 1),
  };
}

/**
 * archive_learning Tool
 *
 * Archives a learning (scar/win/pattern) by setting is_active=false
 * and recording archived_at timestamp. Archived learnings are excluded
 * from recall and search results but preserved for audit trail.
 *
 * Also triggers a local cache flush so the archived scar is immediately
 * removed from in-memory search results.
 */

import { directPatch, isConfigured } from "../services/supabase-client.js";
import { hasSupabase } from "../services/tier.js";
import { flushCache } from "../services/startup.js";
import { Timer, buildPerformanceData } from "../services/metrics.js";
import { wrapDisplay } from "../services/display-protocol.js";

export interface ArchiveLearningParams {
  /** UUID of the learning to archive */
  id: string;
  /** Optional reason for archiving */
  reason?: string;
}

export interface ArchiveLearningResult {
  success: boolean;
  id: string;
  archived_at?: string;
  reason?: string;
  cache_flushed: boolean;
  display?: string;
  error?: string;
  performance_ms: number;
}

export async function archiveLearning(params: ArchiveLearningParams): Promise<ArchiveLearningResult> {
  const timer = new Timer();

  if (!params.id || typeof params.id !== "string") {
    const msg = "Missing required parameter: id (UUID of the learning to archive)";
    return {
      success: false,
      id: "",
      cache_flushed: false,
      display: wrapDisplay(msg),
      error: msg,
      performance_ms: timer.stop(),
    };
  }

  if (!hasSupabase() || !isConfigured()) {
    const msg = "archive_learning requires Supabase (pro/dev tier)";
    return {
      success: false,
      id: params.id,
      cache_flushed: false,
      display: wrapDisplay(msg),
      error: msg,
      performance_ms: timer.stop(),
    };
  }

  try {
    const archivedAt = new Date().toISOString();

    await directPatch("orchestra_learnings", { id: `eq.${params.id}` }, {
      is_active: false,
      archived_at: archivedAt,
    });

    // Flush local cache so archived scar is immediately excluded
    let cacheFlushed = false;
    try {
      await flushCache();
      cacheFlushed = true;
    } catch {
      console.error("[archive-learning] Cache flush failed (non-fatal)");
    }

    const latencyMs = timer.stop();
    const reasonText = params.reason ? ` Reason: ${params.reason}` : "";
    const display = `Archived learning ${params.id}.${reasonText}\nCache ${cacheFlushed ? "flushed" : "flush failed"} (${latencyMs}ms)`;

    return {
      success: true,
      id: params.id,
      archived_at: archivedAt,
      reason: params.reason,
      cache_flushed: cacheFlushed,
      display: wrapDisplay(display),
      performance_ms: latencyMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const latencyMs = timer.stop();
    return {
      success: false,
      id: params.id,
      cache_flushed: false,
      display: wrapDisplay(`Failed to archive learning: ${message}`),
      error: message,
      performance_ms: latencyMs,
    };
  }
}

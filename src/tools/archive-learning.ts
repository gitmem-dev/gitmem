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
import { hasSupabase, getTableName } from "../services/tier.js";
import { getStorage } from "../services/storage.js";
import { flushCache } from "../services/startup.js";
import { Timer } from "../services/metrics.js";
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

  try {
    const archivedAt = new Date().toISOString();
    let cacheFlushed = false;

    if (hasSupabase() && isConfigured()) {
      // Pro/dev: patch in Supabase
      await directPatch(getTableName("learnings"), { id: `eq.${params.id}` }, {
        is_active: false,
        archived_at: archivedAt,
      });

      try {
        await flushCache();
        cacheFlushed = true;
      } catch {
        console.error("[archive-learning] Cache flush failed (non-fatal)");
      }
    } else {
      // Free tier: update in local JSON
      const storage = getStorage();
      const existing = await storage.get<Record<string, unknown>>("learnings", params.id);
      if (!existing) {
        const msg = `Learning ${params.id} not found in local storage`;
        return {
          success: false,
          id: params.id,
          cache_flushed: false,
          display: wrapDisplay(msg),
          error: msg,
          performance_ms: timer.stop(),
        };
      }
      await storage.upsert("learnings", {
        ...existing,
        id: params.id,
        is_active: false,
        archived_at: archivedAt,
      });
    }

    const latencyMs = timer.stop();
    const reasonText = params.reason ? ` Reason: ${params.reason}` : "";
    const display = `Archived learning ${params.id}.${reasonText}\n(${latencyMs}ms)`;

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

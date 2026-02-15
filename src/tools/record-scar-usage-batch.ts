/**
 * Batch Scar Usage Recording Tool
 * Records multiple scar usages in a single call for improved session close performance
 */

import { v4 as uuidv4 } from "uuid";
import * as supabase from "../services/supabase-client.js";
import { Timer, recordMetrics, buildPerformanceData } from "../services/metrics.js";
import type {
  RecordScarUsageBatchParams,
  RecordScarUsageBatchResult,
  ScarUsageEntry,
  Project,
} from "../types/index.js";

const TARGET_LATENCY_MS = 2000; // Target for batch operation

interface ScarRecord {
  id: string;
  title: string;
  description: string;
  scar_type: string;
  severity: string;
}

/**
 * Resolves a scar identifier (UUID or title/description) to a UUID
 * @param identifier - UUID or title/description to resolve
 * @param project - Project filter
 * @returns UUID or null if not found
 */
async function resolveScarIdentifier(
  identifier: string,
  project?: Project
): Promise<string | null> {
  // If it looks like a UUID, return as-is
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(identifier)) {
    return identifier;
  }

  // Otherwise, query by title or description
  try {
    const filters: Record<string, unknown> = {};
    if (project) {
      filters.project = project;
    }

    // Try exact title match first
    const titleResult = await supabase.listRecords<ScarRecord>({
      table: "orchestra_learnings",
      columns: "id,title,description,scar_type,severity",
      filters: { ...filters, title: identifier },
      limit: 1,
    });

    if (titleResult && titleResult.length > 0) {
      return titleResult[0].id;
    }

    // Try partial title match (get more records to search)
    const partialResult = await supabase.listRecords<ScarRecord>({
      table: "orchestra_learnings",
      columns: "id,title,description,scar_type,severity",
      filters: { ...filters },
      limit: 100,
    });

    if (partialResult) {
      // Find by case-insensitive contains
      const match = partialResult.find(
        (record: ScarRecord) =>
          record.title.toLowerCase().includes(identifier.toLowerCase()) ||
          record.description?.toLowerCase().includes(identifier.toLowerCase())
      );
      if (match) {
        return match.id;
      }
    }

    return null;
  } catch (error) {
    console.error(`[record-scar-usage-batch] Error resolving identifier "${identifier}":`, error);
    return null;
  }
}

/**
 * Records multiple scar usages in a single batch operation
 */
export async function recordScarUsageBatch(
  params: RecordScarUsageBatchParams
): Promise<RecordScarUsageBatchResult> {
  const timer = new Timer();
  const metricsId = uuidv4();

  const usageIds: string[] = [];
  const failedIdentifiers: string[] = [];
  let resolvedCount = 0;

  try {
    // Resolve all scar identifiers to UUIDs in parallel
    const resolutionPromises = params.scars.map(async (entry) => {
      const scarId = await resolveScarIdentifier(entry.scar_identifier, params.project);
      return { entry, scarId };
    });

    const resolvedScars = await Promise.all(resolutionPromises);

    // Build usage records for all successfully resolved scars
    const usageRecords = resolvedScars
      .filter(({ scarId }) => scarId !== null)
      .map(({ entry, scarId }) => {
        const usageId = uuidv4();
        return {
          id: usageId,
          scar_id: scarId,
          issue_id: entry.issue_id || null,
          issue_identifier: entry.issue_identifier || null,
          session_id: entry.session_id || null, // OD-552: Session tracking
          agent: entry.agent || null, // OD-552: Agent identity
          surfaced_at: entry.surfaced_at,
          acknowledged_at: entry.acknowledged_at || null,
          referenced: entry.reference_type !== "none",
          reference_type: entry.reference_type,
          reference_context: entry.reference_context,
          execution_successful: entry.execution_successful ?? null,
          variant_id: entry.variant_id || null,
          created_at: new Date().toISOString(),
        };
      });

    // Track failed resolutions
    resolvedScars.forEach(({ entry, scarId }) => {
      if (scarId === null) {
        failedIdentifiers.push(entry.scar_identifier);
      } else {
        resolvedCount++;
      }
    });

    // Insert all usage records in parallel
    const insertPromises = usageRecords.map(async (record) => {
      const result = await supabase.directUpsert<{ id: string }>(
        "scar_usage",
        record
      );
      return result?.id || null;
    });

    const insertResults = await Promise.all(insertPromises);
    usageIds.push(...insertResults.filter((id): id is string => id !== null));

    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("record_scar_usage_batch", latencyMs, usageIds.length);

    // Record metrics asynchronously
    recordMetrics({
      id: metricsId,
      tool_name: "record_scar_usage_batch",
      tables_searched: ["scar_usage", "orchestra_learnings"],
      latency_ms: latencyMs,
      result_count: usageIds.length,
      phase_tag: "scar_tracking",
      metadata: {
        total_scars: params.scars.length,
        resolved_count: resolvedCount,
        failed_count: failedIdentifiers.length,
      },
    }).catch(() => {
      // Swallow errors - metrics are non-critical
    });

    return {
      success: true,
      usage_ids: usageIds,
      resolved_count: resolvedCount,
      failed_count: failedIdentifiers.length,
      failed_identifiers: failedIdentifiers.length > 0 ? failedIdentifiers : undefined,
      performance: perfData,
    };
  } catch (error) {
    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("record_scar_usage_batch", latencyMs, 0);

    console.error("[record-scar-usage-batch] Error recording batch:", error);

    return {
      success: false,
      usage_ids: usageIds,
      resolved_count: resolvedCount,
      failed_count: params.scars.length - resolvedCount,
      failed_identifiers: failedIdentifiers.length > 0 ? failedIdentifiers : undefined,
      performance: perfData,
    };
  }
}

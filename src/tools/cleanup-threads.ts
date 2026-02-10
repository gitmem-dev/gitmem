/**
 * cleanup_threads Tool (Phase 6: Thread Lifecycle)
 *
 * Batch triage tool for thread health review. Groups all non-resolved threads
 * by lifecycle status (active/cooling/dormant) with optional auto-archival.
 *
 * Performance target: <2000ms (fetches all threads, computes lifecycle statuses)
 */

import { v4 as uuidv4 } from "uuid";
import * as supabase from "../services/supabase-client.js";
import { hasSupabase } from "../services/tier.js";
import { computeLifecycleStatus } from "../services/thread-vitality.js";
import { archiveDormantThreads } from "../services/thread-supabase.js";
import type { ThreadRow } from "../services/thread-supabase.js";
import type { ThreadClass, LifecycleStatus } from "../services/thread-vitality.js";
import {
  Timer,
  recordMetrics,
  buildPerformanceData,
} from "../services/metrics.js";
import type { Project } from "../types/index.js";
import type { PerformanceData } from "../services/metrics.js";

// ---------- Types ----------

export interface CleanupThreadsParams {
  project?: Project;
  /** If true, auto-archive dormant threads that have been dormant 30+ days */
  auto_archive?: boolean;
}

interface ThreadSummary {
  thread_id: string;
  text: string;
  lifecycle_status: LifecycleStatus;
  vitality_score: number;
  thread_class: string;
  days_since_touch: number;
  dormant_days?: number;
}

export interface CleanupThreadsResult {
  success: boolean;
  summary: {
    emerging: number;
    active: number;
    cooling: number;
    dormant: number;
    total_open: number;
  };
  groups: {
    emerging: ThreadSummary[];
    active: ThreadSummary[];
    cooling: ThreadSummary[];
    dormant: ThreadSummary[];
  };
  archived_count: number;
  archived_ids: string[];
  performance: PerformanceData;
}

// ---------- Tool Implementation ----------

export async function cleanupThreads(
  params: CleanupThreadsParams
): Promise<CleanupThreadsResult> {
  const timer = new Timer();
  const metricsId = uuidv4();
  const project = (params.project || "orchestra_dev") as Project;

  if (!hasSupabase() || !supabase.isConfigured()) {
    const latencyMs = timer.stop();
    return {
      success: false,
      summary: { emerging: 0, active: 0, cooling: 0, dormant: 0, total_open: 0 },
      groups: { emerging: [], active: [], cooling: [], dormant: [] },
      archived_count: 0,
      archived_ids: [],
      performance: buildPerformanceData("cleanup_threads", latencyMs, 0),
    };
  }

  // Step 1: Auto-archive if requested
  let archived_count = 0;
  let archived_ids: string[] = [];
  if (params.auto_archive) {
    const archiveResult = await archiveDormantThreads(project);
    archived_count = archiveResult.archived_count;
    archived_ids = archiveResult.archived_ids;
  }

  // Step 2: Fetch all non-resolved, non-archived threads
  const rows = await supabase.directQuery<ThreadRow>("orchestra_threads_lite", {
    select: "*",
    filters: {
      project,
      status: "not.in.(resolved,archived)",
    },
    order: "vitality_score.desc,last_touched_at.desc",
    limit: 200,
  });

  // Step 3: Compute lifecycle and group
  const now = new Date();
  const groups: Record<string, ThreadSummary[]> = {
    emerging: [],
    active: [],
    cooling: [],
    dormant: [],
  };

  for (const row of rows) {
    const dormantSince = (row.metadata as Record<string, unknown>)?.dormant_since as string | undefined;
    const { lifecycle_status, vitality } = computeLifecycleStatus({
      last_touched_at: row.last_touched_at,
      touch_count: row.touch_count,
      created_at: row.created_at,
      thread_class: (row.thread_class as ThreadClass) || "backlog",
      current_status: row.status,
      dormant_since: dormantSince,
    }, now);

    const lastTouched = new Date(row.last_touched_at);
    const daysSinceTouch = Math.max(
      (now.getTime() - lastTouched.getTime()) / (1000 * 60 * 60 * 24),
      0
    );

    const summary: ThreadSummary = {
      thread_id: row.thread_id,
      text: row.text,
      lifecycle_status,
      vitality_score: vitality.vitality_score,
      thread_class: row.thread_class || "backlog",
      days_since_touch: Math.round(daysSinceTouch),
    };

    if (lifecycle_status === "dormant" && dormantSince) {
      const dormantStart = new Date(dormantSince);
      summary.dormant_days = Math.round(
        (now.getTime() - dormantStart.getTime()) / (1000 * 60 * 60 * 24)
      );
    }

    const bucket = lifecycle_status === "archived" ? "dormant" : lifecycle_status;
    if (groups[bucket]) {
      groups[bucket].push(summary);
    }
  }

  const latencyMs = timer.stop();
  const totalOpen = groups.emerging.length + groups.active.length + groups.cooling.length + groups.dormant.length;
  const perfData = buildPerformanceData("cleanup_threads", latencyMs, totalOpen);

  recordMetrics({
    id: metricsId,
    tool_name: "cleanup_threads",
    query_text: `cleanup:${project}:auto_archive=${!!params.auto_archive}`,
    tables_searched: ["orchestra_threads_lite"],
    latency_ms: latencyMs,
    result_count: totalOpen,
    phase_tag: "ad_hoc",
    metadata: {
      groups: {
        emerging: groups.emerging.length,
        active: groups.active.length,
        cooling: groups.cooling.length,
        dormant: groups.dormant.length,
      },
      archived_count,
    },
  }).catch(() => {});

  return {
    success: true,
    summary: {
      emerging: groups.emerging.length,
      active: groups.active.length,
      cooling: groups.cooling.length,
      dormant: groups.dormant.length,
      total_open: totalOpen,
    },
    groups: {
      emerging: groups.emerging,
      active: groups.active,
      cooling: groups.cooling,
      dormant: groups.dormant,
    },
    archived_count,
    archived_ids,
    performance: perfData,
  };
}

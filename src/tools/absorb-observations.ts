/**
 * absorb_observations Tool (GitMem v2 Phase 2)
 *
 * Captures observations from sub-agents and teammates.
 * The lead agent parses findings from sub-agent responses,
 * then calls this tool to persist and analyze them.
 *
 * Identifies scar candidates via explicit severity or pattern matching.
 * Observations are stored in-memory (session state) and optionally
 * persisted to Supabase as a fire-and-forget upsert.
 *
 * Performance target: <500ms (in-memory + optional upsert)
 */

import { v4 as uuidv4 } from "uuid";
import { wrapDisplay } from "../services/display-protocol.js";
import { addObservations, getObservations, getCurrentSession } from "../services/session-state.js";
import { hasSupabase, getTableName } from "../services/tier.js";
import * as supabase from "../services/supabase-client.js";
import {
  Timer,
  recordMetrics,
  buildPerformanceData,
} from "../services/metrics.js";
import type { AbsorbObservationsParams, AbsorbObservationsResult, Observation } from "../types/index.js";

// --- Scar Candidate Detection ---

const SCAR_CANDIDATE_PATTERNS = [
  /unexpected/i,
  /failed silently/i,
  /assumed/i,
  /didn['']t realize/i,
  /broken/i,
  /missing/i,
  /no tests?\b/i,
  /data loss/i,
];

function isScarCandidate(obs: Observation): boolean {
  if (obs.severity === "scar_candidate") return true;
  return SCAR_CANDIDATE_PATTERNS.some(p => p.test(obs.text));
}

function buildSuggestion(obs: Observation): string {
  const ctx = obs.context ? ` (in ${obs.context})` : "";
  return `Consider creating a scar for: "${obs.text.slice(0, 80)}"${ctx} — from ${obs.source}`;
}

// --- Main Implementation ---

export async function absorbObservations(
  params: AbsorbObservationsParams
): Promise<AbsorbObservationsResult> {
  const timer = new Timer();
  const metricsId = uuidv4();

  // 1. Add to in-memory session state
  const absorbed = addObservations(params.observations);

  // 2. Identify scar candidates
  const candidates = params.observations.filter(isScarCandidate);
  const suggestions = candidates.map(buildSuggestion);

  // 3. Optionally persist to Supabase (fire-and-forget, non-fatal)
  const session = getCurrentSession();
  if (hasSupabase() && supabase.isConfigured() && session) {
    supabase.directUpsert(getTableName("sessions"), {
      id: session.sessionId,
      task_observations: getObservations(),
    }).catch((err) => {
      console.error("[absorb_observations] Supabase persist failed (non-fatal):", err);
    });
  }

  const latencyMs = timer.stop();
  const perfData = buildPerformanceData("absorb_observations", latencyMs, absorbed);

  // Fire-and-forget metrics
  recordMetrics({
    id: metricsId,
    tool_name: "absorb_observations",
    query_text: `absorb:${params.task_id || "no-task"}:${absorbed} observations`,
    tables_searched: [],
    latency_ms: latencyMs,
    result_count: absorbed,
    phase_tag: "ad_hoc",
    metadata: {
      task_id: params.task_id,
      scar_candidates: candidates.length,
      total_observations: getObservations().length,
    },
  }).catch(() => {});

  const displayLines = [`Absorbed ${absorbed} observations (${candidates.length} scar candidates)`];
  if (suggestions.length > 0) {
    displayLines.push("");
    displayLines.push("Suggestions:");
    for (const s of suggestions) displayLines.push(`  · ${s}`);
  }

  return {
    absorbed,
    scar_candidates: candidates.length,
    suggestions,
    performance: perfData,
    display: wrapDisplay(displayLines.join("\n")),
  };
}

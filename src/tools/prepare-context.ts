/**
 * prepare_context Tool
 *
 * Bridge between global memory and agents that can't call recall directly.
 * The lead agent calls this to generate a portable memory payload that
 * gets injected into sub-agent prompts via the Task tool.
 *
 * Three format modes:
 *   full    — Unlimited, rich markdown (same as recall output)
 *   compact — ~500 tokens, severity + title + one-line per scar
 *   gate    — ~100 tokens, only blocking scars, pass/fail
 *
 * No side effects: no variant assignment, no session state mutation,
 * no surfaced scar tracking.
 *
 * Performance target: <500ms (same pipeline as search)
 */

import * as supabase from "../services/supabase-client.js";
import { localScarSearch, isLocalSearchReady } from "../services/local-vector-search.js";
import { getProject } from "../services/session-state.js";
import { hasSupabase, getTableName } from "../services/tier.js";
import { getStorage } from "../services/storage.js";
import {
  Timer,
  recordMetrics,
  buildPerformanceData,
  buildComponentPerformance,
} from "../services/metrics.js";
import { v4 as uuidv4 } from "uuid";
import { wrapDisplay, productLine } from "../services/display-protocol.js";
import { formatNudgeHeader } from "../services/nudge-variants.js";
import type { Project, PerformanceBreakdown, PerformanceData } from "../types/index.js";
import {
  estimateTokens,
  formatCompact,
  formatGate,
  SEVERITY_EMOJI,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
} from "../hooks/format-utils.js";
import type { FormattableScar } from "../hooks/format-utils.js";

// --- Types ---

export type PrepareContextFormat = "full" | "compact" | "gate";

export interface PrepareContextParams {
  plan: string;
  format: PrepareContextFormat;
  max_tokens?: number;
  agent_role?: string;
  project?: Project;
}

export interface PrepareContextResult {
  memory_payload: string;
  display?: string;
  scars_included: number;
  blocking_scars: number;
  format: string;
  token_estimate: number;
  performance: PerformanceData;
}

// --- Raw scar type (includes required_verification from Supabase) ---

type RawScarRecord = FormattableScar;

/**
 * Format scars in full mode.
 * Rich markdown matching recall's formatResponse output.
 * No token limit.
 */
function formatFull(scars: RawScarRecord[], plan: string): string {
  if (scars.length === 0) {
    return `[INSTITUTIONAL MEMORY — no relevant scars for: "${plan.slice(0, 100)}"]

Proceed with caution — this may be new territory without documented lessons.`;
  }

  const lines: string[] = [
    formatNudgeHeader(scars.length),
    "",
  ];

  // Blocking verification requirements first
  const blockingScars = scars.filter((s) => s.required_verification?.blocking);
  if (blockingScars.length > 0) {
    lines.push("[!!] VERIFICATION REQUIRED BEFORE PROCEEDING");
    lines.push("");

    for (const scar of blockingScars) {
      const rv = scar.required_verification!;
      lines.push(`**${scar.title}**`);
      lines.push(`*When:* ${rv.when}`);
      lines.push("");
      lines.push("**YOU MUST RUN:**");
      for (const query of rv.queries) {
        lines.push("```sql");
        lines.push(query);
        lines.push("```");
      }
      lines.push("");
      lines.push(`**MUST SHOW:** ${rv.must_show}`);
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  for (const scar of scars) {
    const emoji = SEVERITY_EMOJI[scar.severity] || "[?]";
    lines.push(`${emoji} **${scar.title}** (${scar.severity}, score: ${(scar.similarity || 0).toFixed(2)})`);
    lines.push(scar.description);

    if (scar.counter_arguments && scar.counter_arguments.length > 0) {
      lines.push("");
      lines.push("*You might think:*");
      for (const counter of scar.counter_arguments.slice(0, 2)) {
        lines.push(`  - ${counter}`);
      }
    }

    if (scar.why_this_matters) {
      lines.push("");
      lines.push(`**Why this matters:** ${scar.why_this_matters}`);
    }

    if (scar.action_protocol && scar.action_protocol.length > 0) {
      lines.push("");
      lines.push("**Action Protocol:**");
      scar.action_protocol.forEach((step, i) => {
        lines.push(`  ${i + 1}. ${step}`);
      });
    }

    if (scar.self_check_criteria && scar.self_check_criteria.length > 0) {
      lines.push("");
      lines.push("**Self-Check:**");
      for (const criterion of scar.self_check_criteria) {
        lines.push(`  - [ ] ${criterion}`);
      }
    }

    if (scar.source_linear_issue) {
      lines.push(`*Source:* ${scar.source_linear_issue}`);
    }

    lines.push("");
    lines.push("---");
    lines.push("");
  }

  lines.push("**Acknowledge these lessons before proceeding.**");
  return lines.join("\n");
}

// --- Build Result Helper ---

function buildResult(
  scars: RawScarRecord[],
  plan: string,
  format: PrepareContextFormat,
  maxTokens: number,
  timer: Timer,
  metricsId: string,
  project: Project,
  search_mode: "local" | "remote",
  searchLatencyMs?: number,
  network_call?: boolean,
  cache_hit?: boolean,
  cache_age_ms?: number,
): PrepareContextResult {
  let memory_payload: string;
  let scars_included: number;
  let blocking_scars: number;

  switch (format) {
    case "compact": {
      const result = formatCompact(scars, plan, maxTokens);
      memory_payload = result.payload;
      scars_included = result.included;
      blocking_scars = scars.filter((s) => s.required_verification?.blocking).length;
      break;
    }
    case "gate": {
      const result = formatGate(scars);
      memory_payload = result.payload;
      scars_included = result.blocking;
      blocking_scars = result.blocking;
      break;
    }
    case "full":
    default: {
      memory_payload = formatFull(scars, plan);
      scars_included = scars.length;
      blocking_scars = scars.filter((s) => s.required_verification?.blocking).length;
      break;
    }
  }

  const token_estimate = estimateTokens(memory_payload);
  const latencyMs = timer.stop();

  const breakdown: PerformanceBreakdown | undefined = searchLatencyMs !== undefined
    ? {
        scar_search: buildComponentPerformance(
          searchLatencyMs,
          search_mode === "local" ? "local_cache" : "supabase",
          network_call ?? false,
          (network_call ?? false) ? "miss" : "hit"
        ),
      }
    : undefined;

  const perfData = buildPerformanceData("prepare_context", latencyMs, scars_included, {
    memoriesSurfaced: scars.slice(0, scars_included).map((s) => s.id),
    similarityScores: scars.slice(0, scars_included).map((s) => s.similarity || 0),
    cache_hit: cache_hit ?? false,
    cache_age_ms,
    search_mode,
    breakdown,
  });

  // Fire-and-forget metrics
  recordMetrics({
    id: metricsId,
    tool_name: "prepare_context",
    query_text: `prepare_context:${format}:${plan.slice(0, 80)}`,
    tables_searched: search_mode === "local" ? [] : [getTableName("learnings")],
    latency_ms: latencyMs,
    result_count: scars_included,
    phase_tag: "recall",
    metadata: {
      tool: "prepare_context",
      project,
      format,
      max_tokens: maxTokens,
      agent_role: undefined, // Reserved for Phase 3
      token_estimate,
      blocking_scars,
    },
  }).catch(() => {});

  const display = wrapDisplay(
    `${productLine("prepare_context", `${format} · ${scars_included} scars (${blocking_scars} blocking) · ~${token_estimate} tokens`)}\n\n${memory_payload}`
  );

  return {
    memory_payload,
    display,
    scars_included,
    blocking_scars,
    format,
    token_estimate,
    performance: perfData,
  };
}

// --- Main Implementation ---

export async function prepareContext(
  params: PrepareContextParams
): Promise<PrepareContextResult> {
  const timer = new Timer();
  const metricsId = uuidv4();

  const plan = params.plan;
  const format = params.format;
  const project: Project = params.project || getProject() as Project || "default";
  const maxTokens = params.max_tokens || (format === "compact" ? 500 : format === "gate" ? 100 : 10000);
  const matchCount = 5;

  // FREE TIER: local keyword search
  if (!hasSupabase()) {
    try {
      const storage = getStorage();
      const rawResults = await storage.search(plan, matchCount);

      const scars: RawScarRecord[] = rawResults.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description || "",
        severity: r.severity || "medium",
        counter_arguments: r.counter_arguments || [],
        similarity: r.similarity || 0,
      }));

      return buildResult(scars, plan, format, maxTokens, timer, metricsId, project, "local");
    } catch (error) {
      const latencyMs = timer.stop();
      const errPayload = "[INSTITUTIONAL MEMORY — error loading scars]";
      return {
        memory_payload: errPayload,
        display: wrapDisplay(`prepare_context \u00b7 ${format} \u00b7 0 scars (0 blocking) \u00b7 ~0 tokens\n\n${errPayload}`),
        scars_included: 0,
        blocking_scars: 0,
        format,
        token_estimate: 0,
        performance: buildPerformanceData("prepare_context", latencyMs, 0),
      };
    }
  }

  // PRO/DEV TIER: vector search
  if (!supabase.isConfigured()) {
    const latencyMs = timer.stop();
    const notConfigPayload = "[INSTITUTIONAL MEMORY — not configured]";
    return {
      memory_payload: notConfigPayload,
      display: wrapDisplay(`prepare_context \u00b7 ${format} \u00b7 0 scars (0 blocking) \u00b7 ~0 tokens\n\n${notConfigPayload}`),
      scars_included: 0,
      blocking_scars: 0,
      format,
      token_estimate: 0,
      performance: buildPerformanceData("prepare_context", latencyMs, 0),
    };
  }

  try {
    let rawScars: RawScarRecord[] = [];
    let search_mode: "local" | "remote" = "remote";
    let network_call = true;
    let cache_hit = false;
    let cache_age_ms: number | undefined;

    const searchTimer = new Timer();

    if (isLocalSearchReady(project)) {
      search_mode = "local";
      cache_hit = true;
      network_call = false;

      const localResults = await localScarSearch(plan, matchCount, project);
      rawScars = localResults.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        severity: r.severity,
        counter_arguments: r.counter_arguments,
        similarity: r.similarity,
        why_this_matters: r.why_this_matters,
        action_protocol: r.action_protocol,
        self_check_criteria: r.self_check_criteria,
      }));
    } else {
      search_mode = "remote";
      const supabaseResult = await supabase.cachedScarSearch<RawScarRecord>(
        plan, matchCount, project
      );
      rawScars = supabaseResult.results;
      cache_hit = supabaseResult.cache_hit;
      cache_age_ms = supabaseResult.cache_age_ms;
    }

    const searchLatencyMs = searchTimer.stop();

    return buildResult(
      rawScars, plan, format, maxTokens,
      timer, metricsId, project, search_mode,
      searchLatencyMs, network_call, cache_hit, cache_age_ms
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[prepare_context] Search failed:", message);
    const latencyMs = timer.stop();
    const errPayload = `[INSTITUTIONAL MEMORY — error: ${message}]`;
    return {
      memory_payload: errPayload,
      display: wrapDisplay(`prepare_context \u00b7 ${format} \u00b7 0 scars (0 blocking) \u00b7 ~0 tokens\n\n${errPayload}`),
      scars_included: 0,
      blocking_scars: 0,
      format,
      token_estimate: 0,
      performance: buildPerformanceData("prepare_context", latencyMs, 0),
    };
  }
}

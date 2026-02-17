/**
 * recall Tool
 *
 * Check institutional memory for relevant scars before taking action.
 * Core GitMem MVP tool that enables "check before act" workflow.
 *
 * Performance target: <2000ms response time
 *
 * Uses local vector search when available for speed,
 * falls back to Supabase scar_search when local cache isn't ready.
 *
 * After scar search, fetches related knowledge triples and
 * includes them in the formatted response for relationship context.
 */

import * as supabase from "../services/supabase-client.js";
import type { KnowledgeTriple } from "../services/supabase-client.js";
import { localScarSearch, isLocalSearchReady } from "../services/local-vector-search.js";
import { hasSupabase, hasVariants, hasMetrics, getTableName } from "../services/tier.js";
import { getProject } from "../services/session-state.js";
import { getStorage } from "../services/storage.js";
import {
  Timer,
  recordMetrics,
  buildPerformanceData,
  buildComponentPerformance,
  calculateContextBytes,
  PERFORMANCE_TARGETS,
} from "../services/metrics.js";
import {
  getOrAssignVariant,
  formatVariantEnforcement,
  type ScarWithVariant,
} from "../services/variant-assignment.js";
import { addSurfacedScars, getCurrentSession } from "../services/session-state.js";
import { getAgentIdentity } from "../services/agent-detection.js";
import { v4 as uuidv4 } from "uuid";
import * as fs from "fs";
import * as path from "path";
import { getSessionPath } from "../services/gitmem-dir.js";
import { wrapDisplay } from "../services/display-protocol.js";
import { fetchDismissalCounts, type DismissalCounts } from "../services/behavioral-decay.js";
import type { Project, RelevantScar, PerformanceData, PerformanceBreakdown, SurfacedScar } from "../types/index.js";

/**
 * Parameters for recall tool
 */
export interface RecallParams {
  plan: string;
  project?: Project;
  match_count?: number;
  issue_id?: string; // Required for variant assignment
  similarity_threshold?: number; // Minimum similarity to include results
}

/**
 * Required verification block for enforcement gate
 */
interface RequiredVerification {
  when: string;
  queries: string[];
  must_show: string;
  blocking?: boolean;
}

/**
 * Scar record from Supabase search
 */
interface ScarRecord {
  id: string;
  title: string;
  description: string;
  severity: string;
  learning_type?: string;
  counter_arguments?: string[];
  problem_context?: string;
  solution_approach?: string;
  applies_when?: string[];
  domain?: string[];
  keywords?: string[];
  source_linear_issue?: string;
  similarity?: number;
  required_verification?: RequiredVerification;
  // LLM-cooperative enforcement fields
  why_this_matters?: string;
  action_protocol?: string[];
  self_check_criteria?: string[];
  // Behavioral decay
  decay_multiplier?: number;
}

/**
 * Formatted scar for response
 */
interface FormattedScar {
  id: string;
  title: string;
  learning_type?: string;
  severity: string;
  description: string;
  counter_arguments: string[];
  applies_when: string[];
  source_issue?: string;
  similarity: number;
  required_verification?: RequiredVerification;
  variant_info?: ScarWithVariant; // Variant assignment info
  // LLM-cooperative enforcement fields
  why_this_matters?: string;
  action_protocol?: string[];
  self_check_criteria?: string[];
  // Knowledge triples for relationship context
  related_triples?: KnowledgeTriple[];
  // Behavioral decay
  decay_multiplier?: number;
}

/**
 * Result from recall tool
 */
export interface RecallResult {
  activated: boolean;
  plan: string;
  project: Project;
  match_count: number;
  scars: FormattedScar[];
  performance_ms: number;
  formatted_response: string;
  display?: string;
  performance: PerformanceData;
}

/**
 * Format scars into a readable response for Claude
 */
function formatResponse(scars: FormattedScar[], plan: string, dismissals?: Map<string, DismissalCounts>): string {
  if (scars.length === 0) {
    return `No relevant scars found for: "${plan.slice(0, 100)}..."

No past lessons match this plan closely enough. Scars accumulate as you work — create learnings during session close to build institutional memory.`;
  }

  // Check if any scars have required_verification (blocking gates)
  const scarsWithVerification = scars.filter((s) => s.required_verification?.blocking);

  const lines: string[] = [
    "🧠 INSTITUTIONAL MEMORY ACTIVATED",
    "",
    `Found ${scars.length} relevant scar${scars.length === 1 ? "" : "s"} for your plan:`,
    "",
  ];

  // Display blocking verification requirements FIRST and prominently
  if (scarsWithVerification.length > 0) {
    lines.push("═══════════════════════════════════════════════════════════════");
    lines.push("🚨 **VERIFICATION REQUIRED BEFORE PROCEEDING**");
    lines.push("═══════════════════════════════════════════════════════════════");
    lines.push("");

    for (const scar of scarsWithVerification) {
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
      lines.push("⛔ DO NOT write SQL until verification output is shown above.");
      lines.push("");
    }

    lines.push("═══════════════════════════════════════════════════════════════");
    lines.push("");
  }

  for (const scar of scars) {
    const severityEmoji = {
      critical: "🔴",
      high: "🟠",
      medium: "🟡",
      low: "🟢",
    }[scar.severity] || "⚪";

    lines.push(`${severityEmoji} **${scar.title}** (${scar.severity}, score: ${scar.similarity.toFixed(2)}) · id: ${scar.id}`);

    // Inline archival hint: scars with high dismiss rates get annotated
    if (dismissals) {
      const counts = dismissals.get(scar.id);
      if (counts && counts.surfaced >= 5 && (counts.dismissed / counts.surfaced) >= 0.7) {
        lines.push(`  _[${counts.dismissed}x dismissed — consider archiving with gm-archive]_`);
      }
    }

    // Use variant enforcement text if available (blind to variant name)
    if (scar.variant_info?.has_variants && scar.variant_info.variant) {
      const variantText = formatVariantEnforcement(scar.variant_info.variant, scar.title);
      lines.push(variantText);
    } else {
      // Legacy path: use original scar description
      lines.push(scar.description);
    }

    if (scar.counter_arguments.length > 0) {
      lines.push("");
      lines.push("*You might think:*");
      for (const counter of scar.counter_arguments.slice(0, 2)) {
        lines.push(`  - ${counter}`);
      }
    }

    if (scar.applies_when.length > 0) {
      lines.push("");
      lines.push("*Applies when:* " + scar.applies_when.slice(0, 3).join(", "));
    }

    // Render LLM-cooperative enforcement fields
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

    // Render related knowledge triples
    if (scar.related_triples && scar.related_triples.length > 0) {
      lines.push("");
      lines.push("*Related knowledge:*");
      for (const triple of scar.related_triples) {
        lines.push(`  - ${triple.subject} **${triple.predicate}** ${triple.object}`);
      }
    }

    if (scar.source_issue) {
      lines.push(`*Source:* ${scar.source_issue}`);
    }

    lines.push("");
    lines.push("---");
    lines.push("");
  }

  lines.push("**Acknowledge these lessons before proceeding.**");

  return lines.join("\n");
}

/**
 * Execute recall tool
 *
 * Queries the learnings table for scars matching the provided plan
 * using weighted semantic search (severity-weighted, temporally-decayed).
 */
export async function recall(params: RecallParams): Promise<RecallResult> {
  const timer = new Timer();
  const metricsId = uuidv4();

  // Validate required parameter — callers may pass wrong param names
  // (e.g., "action" instead of "plan"), which bypasses TypeScript at runtime
  const plan = params.plan || (params as unknown as Record<string, unknown>).action as string;
  if (!plan || typeof plan !== "string" || plan.trim().length === 0) {
    const latencyMs = timer.stop();
    const msg = "⚠️ Missing required parameter: plan (what you're about to do)";
    return {
      activated: false,
      plan: plan || "",
      project: params.project || getProject() as Project || "default",
      match_count: params.match_count || 3,
      scars: [],
      performance_ms: latencyMs,
      formatted_response: msg,
      display: wrapDisplay(msg),
      performance: buildPerformanceData("recall", latencyMs, 0),
    };
  }
  const project: Project = params.project || getProject() as Project || "default";
  const matchCount = params.match_count || 3;
  const issueId = params.issue_id; // For variant assignment

  // Similarity threshold — suppress weak matches
  // Pro tier: 0.45 calibrated from UX audit (66% N_A rate at 0.35, APPLYING avg 0.55, N_A avg 0.51)
  // Free tier: 0.4 (BM25 scores are relative — top result always 1.0)
  const defaultThreshold = hasSupabase() ? 0.45 : 0.4;
  const similarityThreshold = params.similarity_threshold ?? defaultThreshold;

  // Free tier: use local keyword search
  if (!hasSupabase()) {
    try {
      const searchTimer = new Timer();
      const rawScars = await getStorage().search(plan, matchCount);
      const searchLatencyMs = searchTimer.stop();

      const scars: FormattedScar[] = rawScars
        .map((scar) => ({
          id: scar.id,
          title: scar.title,
          learning_type: scar.learning_type || "scar",
          severity: scar.severity || "medium",
          description: scar.description || "",
          counter_arguments: scar.counter_arguments || [],
          applies_when: [],
          similarity: scar.similarity || 0,
        }))
        // Filter below threshold
        .filter((scar) => scar.similarity >= similarityThreshold);

      const latencyMs = timer.stop();
      const perfData = buildPerformanceData("recall", latencyMs, scars.length, {
        memoriesSurfaced: scars.map((s) => s.id),
        similarityScores: scars.map((s) => s.similarity),
        search_mode: "local",
      });

      const freeFormatted = formatResponse(scars, plan);
      return {
        activated: scars.length > 0,
        plan,
        project,
        match_count: matchCount,
        scars,
        performance_ms: latencyMs,
        formatted_response: freeFormatted,
        display: wrapDisplay(freeFormatted),
        performance: perfData,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const latencyMs = timer.stop();
      const perfData = buildPerformanceData("recall", latencyMs, 0);
      const errMsg = `⚠️ Error querying institutional memory: ${message}`;
      return {
        activated: false,
        plan,
        project,
        match_count: matchCount,
        scars: [],
        performance_ms: latencyMs,
        formatted_response: errMsg,
        display: wrapDisplay(errMsg),
        performance: perfData,
      };
    }
  }

  // Pro/Dev tier: Check Supabase configuration
  if (!supabase.isConfigured()) {
    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("recall", latencyMs, 0);
    const notConfiguredMsg = "⚠️ GitMem not configured - check SUPABASE_URL and SUPABASE_KEY environment variables.";
    return {
      activated: false,
      plan,
      project,
      match_count: matchCount,
      scars: [],
      performance_ms: latencyMs,
      formatted_response: notConfiguredMsg,
      display: wrapDisplay(notConfiguredMsg),
      performance: perfData,
    };
  }

  try {
    let rawScars: ScarRecord[] | RelevantScar[] = [];
    let cache_hit = false;
    let cache_age_ms: number | undefined;
    let search_mode: "local" | "remote" = "remote";
    let network_call = true; // Assume network call until proven otherwise

    // Try local vector search first (fast, no Supabase hit)
    // Falls back to Supabase scar_search if local cache isn't ready
    const searchTimer = new Timer();

    if (isLocalSearchReady(project)) {
      console.error("[recall] Using local vector search");
      search_mode = "local";
      cache_hit = true;
      network_call = false; // LOCAL - no network call!

      const localResults = await localScarSearch(plan, matchCount, project);
      rawScars = localResults;
    } else {
      console.error("[recall] Local cache not ready, using Supabase fallback");
      search_mode = "remote";
      network_call = true; // REMOTE - hits Supabase

      // Fallback to Supabase scar_search via ww-mcp
      const supabaseResult = await supabase.cachedScarSearch<ScarRecord>(
        plan,
        matchCount,
        project
      );
      rawScars = supabaseResult.results;
      cache_hit = supabaseResult.cache_hit;
      cache_age_ms = supabaseResult.cache_age_ms;
    }

    const searchLatencyMs = searchTimer.stop();

    // Assign variants for A/B testing (dev tier only)
    // Agent identity is always available, so variants are always assigned
    const variantTimer = new Timer();
    const variantResults: Map<string, ScarWithVariant> = new Map();

    const agentId = getAgentIdentity();
    const currentSession = getCurrentSession();
    const variantMetadata = {
      issueId: issueId || currentSession?.linearIssue,
      sessionId: currentSession?.sessionId,
    };

    if (hasVariants()) {
      console.error(`[recall] Assigning variants for agent: ${agentId}`);

      // Assign variants in parallel for all scars
      const variantPromises = rawScars.map(async (scar) => {
        const variantInfo = await getOrAssignVariant(agentId, scar.id, variantMetadata);
        return { scarId: scar.id, variantInfo };
      });

      const results = await Promise.all(variantPromises);
      for (const { scarId, variantInfo } of results) {
        variantResults.set(scarId, variantInfo);
      }

      // Record enforcement metrics for variants (dev only)
      if (hasMetrics()) {
        const metricsPromises = results
          .filter(({ variantInfo }) => variantInfo.has_variants && variantInfo.variant)
          .map(async ({ scarId, variantInfo }) => {
            try {
              await supabase.directUpsert("variant_performance_metrics", {
                agent_id: agentId,
                issue_id: variantMetadata.issueId || null,
                session_id: variantMetadata.sessionId || null,
                scar_id: scarId,
                variant_id: variantInfo.variant!.id,
                enforcement_triggered: true,
              });
            } catch (error) {
              console.error(`[recall] Failed to record metrics for scar ${scarId}:`, error);
            }
          });

        // Fire and forget
        Promise.all(metricsPromises).catch((error) => {
          console.error("[recall] Metrics recording error:", error);
        });
      }
    }

    const variantLatencyMs = variantTimer.stop();

    // Fetch related knowledge triples for surfaced scars
    const tripleTimer = new Timer();
    const scarIds = rawScars.map((s) => s.id);
    const triplesMap = await supabase.fetchRelatedTriples(scarIds);
    const tripleLatencyMs = tripleTimer.stop();

    if (triplesMap.size > 0) {
      console.error(`[recall] Found triples for ${triplesMap.size} scars (${tripleLatencyMs}ms)`);
    }

    // Fetch dismissal counts for inline archival hints (non-blocking, graceful fallback)
    let dismissalCounts: Map<string, DismissalCounts> | undefined;
    try {
      dismissalCounts = await fetchDismissalCounts(scarIds);
    } catch (err) {
      console.warn("[recall] Dismissal count fetch failed (non-fatal):", err);
    }

    // Format scars for response
    const scars: FormattedScar[] = rawScars
      .map((scar) => ({
        id: scar.id,
        title: scar.title,
        learning_type: (scar as ScarRecord).learning_type || "scar",
        severity: scar.severity || "medium",
        description: scar.description || "",
        counter_arguments: scar.counter_arguments || [],
        applies_when: (scar as ScarRecord).applies_when || [],
        source_issue: (scar as ScarRecord).source_linear_issue,
        similarity: scar.similarity || 0,
        required_verification: (scar as ScarRecord).required_verification,
        variant_info: variantResults.get(scar.id),
        // LLM-cooperative enforcement fields
        why_this_matters: (scar as ScarRecord).why_this_matters,
        action_protocol: (scar as ScarRecord).action_protocol,
        self_check_criteria: (scar as ScarRecord).self_check_criteria,
        // Knowledge triples
        related_triples: triplesMap.get(scar.id),
        // Behavioral decay
        decay_multiplier: (scar as ScarRecord).decay_multiplier,
      }))
      // Filter below threshold
      .filter((scar) => scar.similarity >= similarityThreshold);

    // Track surfaced scars for auto-bridge at session close
    const recallSurfacedAt = new Date().toISOString();
    const recallSurfacedScars: SurfacedScar[] = scars.map((scar) => ({
      scar_id: scar.id,
      scar_title: scar.title,
      scar_severity: scar.severity || "medium",
      surfaced_at: recallSurfacedAt,
      source: "recall" as const,
      variant_id: variantResults.get(scar.id)?.assignment?.variant_id,
    }));
    addSurfacedScars(recallSurfacedScars);

    // Update per-session dir with accumulated surfaced scars
    try {
      const session = getCurrentSession();
      if (session) {
        const sessionFilePath = getSessionPath(session.sessionId, "session.json");
        if (fs.existsSync(sessionFilePath)) {
          const sessionData = JSON.parse(fs.readFileSync(sessionFilePath, "utf-8"));
          sessionData.surfaced_scars = session.surfacedScars;
          fs.writeFileSync(sessionFilePath, JSON.stringify(sessionData, null, 2));
        }
      }
    } catch (error) {
      // Non-fatal: surfaced scars still tracked in memory
      console.warn("[recall] Failed to update per-session file with surfaced scars:", error);
    }

    const latencyMs = timer.stop();
    const memoriesSurfaced = scars.map((s) => s.id);
    const similarityScores = scars.map((s) => s.similarity);

    // Build detailed performance breakdown for test harness
    const breakdown: PerformanceBreakdown = {
      scar_search: buildComponentPerformance(
        searchLatencyMs,
        search_mode === "local" ? "local_cache" : "supabase",
        network_call,
        network_call ? "miss" : "hit"
      ),
    };

    // Build performance data with detailed breakdown
    const perfData = buildPerformanceData("recall", latencyMs, scars.length, {
      memoriesSurfaced,
      similarityScores,
      cache_hit,
      cache_age_ms,
      search_mode,
      breakdown,
    });

    // Record metrics asynchronously
    const mainFormatted = formatResponse(scars, plan, dismissalCounts);
    const result = {
      activated: scars.length > 0,
      plan,
      project,
      match_count: matchCount,
      scars,
      performance_ms: latencyMs,
      formatted_response: mainFormatted,
      display: wrapDisplay(mainFormatted),
      performance: perfData,
    };

    recordMetrics({
      id: metricsId,
      tool_name: "recall",
      query_text: plan,
      tables_searched: search_mode === "local" ? [] : [getTableName("learnings")],
      latency_ms: latencyMs,
      result_count: scars.length,
      similarity_scores: similarityScores,
      context_bytes: calculateContextBytes(result),
      phase_tag: "recall",
      memories_surfaced: memoriesSurfaced,
      metadata: {
        project,
        match_count: matchCount,
        cache_hit,
        cache_age_ms,
        search_mode,
        // Detailed instrumentation
        network_calls_made: perfData.network_calls_made,
        fully_local: perfData.fully_local,
      },
    }).catch(() => {}); // Don't fail on metrics error

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[recall] Search failed:", message);

    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("recall", latencyMs, 0);
    const mainErrMsg = `⚠️ Error querying institutional memory: ${message}`;

    return {
      activated: false,
      plan,
      project,
      match_count: matchCount,
      scars: [],
      performance_ms: latencyMs,
      formatted_response: mainErrMsg,
      display: wrapDisplay(mainErrMsg),
      performance: perfData,
    };
  }
}

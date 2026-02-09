/**
 * recall Tool
 *
 * Check institutional memory for relevant scars before taking action.
 * Core GitMem MVP tool that enables "check before act" workflow.
 *
 * Performance target: <2000ms response time (OD-429)
 *
 * OD-489: Uses local vector search when available for speed,
 * falls back to Supabase scar_search when local cache isn't ready.
 *
 * OD-466: After scar search, fetches related knowledge triples and
 * includes them in the formatted response for relationship context.
 */

import * as supabase from "../services/supabase-client.js";
import type { KnowledgeTriple } from "../services/supabase-client.js";
import { localScarSearch, isLocalSearchReady } from "../services/local-vector-search.js";
import { hasSupabase, hasVariants, hasMetrics } from "../services/tier.js";
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
import { addSurfacedScars, getCurrentSession } from "../services/session-state.js"; // OD-552
import { getAgentIdentity } from "../services/agent-detection.js"; // OD-547
import { v4 as uuidv4 } from "uuid";
import * as fs from "fs";
import * as path from "path";
import { getGitmemPath } from "../services/gitmem-dir.js";
import type { Project, RelevantScar, PerformanceData, PerformanceBreakdown, SurfacedScar } from "../types/index.js";

/**
 * Parameters for recall tool
 */
export interface RecallParams {
  plan: string;
  project?: Project;
  match_count?: number;
  issue_id?: string; // OD-525: Required for variant assignment
}

/**
 * Required verification block for enforcement gate (OD-487)
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
  // OD-508: LLM-cooperative enforcement fields
  why_this_matters?: string;
  action_protocol?: string[];
  self_check_criteria?: string[];
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
  variant_info?: ScarWithVariant; // OD-525: Variant assignment info
  // OD-508: LLM-cooperative enforcement fields
  why_this_matters?: string;
  action_protocol?: string[];
  self_check_criteria?: string[];
  // OD-466: Knowledge triples for relationship context
  related_triples?: KnowledgeTriple[];
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
  performance: PerformanceData;
}

/**
 * Format scars into a readable response for Claude
 */
function formatResponse(scars: FormattedScar[], plan: string): string {
  if (scars.length === 0) {
    return `No relevant scars found for: "${plan.slice(0, 100)}..."

Proceed with caution - this may be new territory without documented lessons.`;
  }

  // OD-487: Check if any scars have required_verification (blocking gates)
  const scarsWithVerification = scars.filter((s) => s.required_verification?.blocking);

  const lines: string[] = [
    "⚠️ INSTITUTIONAL MEMORY ACTIVATED",
    "",
    `Found ${scars.length} relevant scar${scars.length === 1 ? "" : "s"} for your plan:`,
    "",
  ];

  // OD-487: Display blocking verification requirements FIRST and prominently
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

    lines.push(`${severityEmoji} **${scar.title}** (${scar.severity}, score: ${scar.similarity.toFixed(2)})`);

    // OD-525: Use variant enforcement text if available (blind to variant name)
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

    // OD-530: Render LLM-cooperative enforcement fields (OD-508)
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

    // OD-466: Render related knowledge triples
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
 * Queries orchestra_learnings for scars matching the provided plan
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
    return {
      activated: false,
      plan: plan || "",
      project: params.project || "orchestra_dev",
      match_count: params.match_count || 3,
      scars: [],
      performance_ms: latencyMs,
      formatted_response: "⚠️ Missing required parameter: plan (what you're about to do)",
      performance: buildPerformanceData("recall", latencyMs, 0),
    };
  }
  const project: Project = params.project || "orchestra_dev";
  const matchCount = params.match_count || 3;
  const issueId = params.issue_id; // OD-525: For variant assignment

  // Free tier: use local keyword search
  if (!hasSupabase()) {
    try {
      const searchTimer = new Timer();
      const rawScars = await getStorage().search(plan, matchCount);
      const searchLatencyMs = searchTimer.stop();

      const scars: FormattedScar[] = rawScars.map((scar) => ({
        id: scar.id,
        title: scar.title,
        learning_type: scar.learning_type || "scar",
        severity: scar.severity || "medium",
        description: scar.description || "",
        counter_arguments: scar.counter_arguments || [],
        applies_when: [],
        similarity: scar.similarity || 0,
      }));

      const latencyMs = timer.stop();
      const perfData = buildPerformanceData("recall", latencyMs, scars.length, {
        memoriesSurfaced: scars.map((s) => s.id),
        similarityScores: scars.map((s) => s.similarity),
        search_mode: "local",
      });

      return {
        activated: scars.length > 0,
        plan,
        project,
        match_count: matchCount,
        scars,
        performance_ms: latencyMs,
        formatted_response: formatResponse(scars, plan),
        performance: perfData,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const latencyMs = timer.stop();
      const perfData = buildPerformanceData("recall", latencyMs, 0);
      return {
        activated: false,
        plan,
        project,
        match_count: matchCount,
        scars: [],
        performance_ms: latencyMs,
        formatted_response: `⚠️ Error querying institutional memory: ${message}`,
        performance: perfData,
      };
    }
  }

  // Pro/Dev tier: Check Supabase configuration
  if (!supabase.isConfigured()) {
    const latencyMs = timer.stop();
    const perfData = buildPerformanceData("recall", latencyMs, 0);
    return {
      activated: false,
      plan,
      project,
      match_count: matchCount,
      scars: [],
      performance_ms: latencyMs,
      formatted_response: "⚠️ GitMem not configured - check SUPABASE_URL and SUPABASE_KEY environment variables.",
      performance: perfData,
    };
  }

  try {
    let rawScars: ScarRecord[] | RelevantScar[] = [];
    let cache_hit = false;
    let cache_age_ms: number | undefined;
    let search_mode: "local" | "remote" = "remote";
    let network_call = true; // Assume network call until proven otherwise

    // OD-489: Try local vector search first (fast, no Supabase hit)
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

    // OD-547: Assign variants for A/B testing (dev tier only)
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

      // OD-525: Record enforcement metrics for variants (dev only)
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

    // OD-466: Fetch related knowledge triples for surfaced scars
    const tripleTimer = new Timer();
    const scarIds = rawScars.map((s) => s.id);
    const triplesMap = await supabase.fetchRelatedTriples(scarIds);
    const tripleLatencyMs = tripleTimer.stop();

    if (triplesMap.size > 0) {
      console.error(`[recall] Found triples for ${triplesMap.size} scars (${tripleLatencyMs}ms)`);
    }

    // Format scars for response
    const scars: FormattedScar[] = rawScars.map((scar) => ({
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
      variant_info: variantResults.get(scar.id), // OD-525
      // OD-508: LLM-cooperative enforcement fields
      why_this_matters: (scar as ScarRecord).why_this_matters,
      action_protocol: (scar as ScarRecord).action_protocol,
      self_check_criteria: (scar as ScarRecord).self_check_criteria,
      // OD-466: Knowledge triples
      related_triples: triplesMap.get(scar.id),
    }));

    // OD-552: Track surfaced scars for auto-bridge at session close
    const recallSurfacedAt = new Date().toISOString();
    const recallSurfacedScars: SurfacedScar[] = scars.map((scar) => ({
      scar_id: scar.id,
      scar_title: scar.title,
      scar_severity: scar.severity || "medium",
      surfaced_at: recallSurfacedAt,
      source: "recall" as const,
    }));
    addSurfacedScars(recallSurfacedScars);

    // OD-552: Update active-session.json with accumulated surfaced scars
    try {
      const activeSessionPath = getGitmemPath("active-session.json");
      if (fs.existsSync(activeSessionPath)) {
        const activeSession = JSON.parse(fs.readFileSync(activeSessionPath, "utf-8"));
        const session = getCurrentSession();
        if (session) {
          activeSession.surfaced_scars = session.surfacedScars;
          fs.writeFileSync(activeSessionPath, JSON.stringify(activeSession, null, 2));
        }
      }
    } catch (error) {
      // Non-fatal: surfaced scars still tracked in memory
      console.warn("[recall] Failed to update active-session.json with surfaced scars:", error);
    }

    const latencyMs = timer.stop();
    const memoriesSurfaced = scars.map((s) => s.id);
    const similarityScores = scars.map((s) => s.similarity);

    // OD-489: Build detailed performance breakdown for test harness
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
    const result = {
      activated: scars.length > 0,
      plan,
      project,
      match_count: matchCount,
      scars,
      performance_ms: latencyMs,
      formatted_response: formatResponse(scars, plan),
      performance: perfData,
    };

    recordMetrics({
      id: metricsId,
      tool_name: "recall",
      query_text: plan,
      tables_searched: search_mode === "local" ? [] : ["orchestra_learnings"],
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
        // OD-489: Detailed instrumentation
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

    return {
      activated: false,
      plan,
      project,
      match_count: matchCount,
      scars: [],
      performance_ms: latencyMs,
      formatted_response: `⚠️ Error querying institutional memory: ${message}`,
      performance: perfData,
    };
  }
}

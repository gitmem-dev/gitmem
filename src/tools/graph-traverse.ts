/**
 * graph_traverse Tool
 *
 * Knowledge graph traversal over institutional memory triples.
 * Single tool with 4 lenses: connected_to, produced_by, provenance, stats.
 *
 * No SQL migrations — uses directQuery + client-side assembly.
 * Dataset is small (~668 triples) so full-table fetch is fine for
 * provenance/stats; connected_to/produced_by use targeted PostgREST filters.
 *
 * Performance target: 3000ms
 */

import { directQuery } from "../services/supabase-client.js";
import { hasSupabase } from "../services/tier.js";
import { getProject } from "../services/session-state.js";
import {
  Timer,
  recordMetrics,
  buildPerformanceData,
} from "../services/metrics.js";
import { wrapDisplay } from "../services/display-protocol.js";
import { v4 as uuidv4 } from "uuid";
import type { Project, PerformanceData } from "../types/index.js";

// --- Types ---

export type GraphTraverseLens = "connected_to" | "produced_by" | "provenance" | "stats";

export interface GraphTraverseParams {
  lens: GraphTraverseLens;
  /** Starting node. Examples: "PROJ-123", "cli", "Scar: Done ≠ Deployed" */
  node?: string;
  /** Filter by predicate */
  predicate?: string;
  /** Max chain depth for provenance (default: 3) */
  depth?: number;
  /** Project scope */
  project?: Project;
  /** Max triples to return (default: 50) */
  limit?: number;
}

interface RawTriple {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  event_time: string;
  decay_weight: number;
  source_type: string | null;
  source_id: string | null;
  source_linear_issue: string | null;
  created_by: string | null;
}

interface GraphNode {
  label: string;
  type: string;
  as_subject: RawTriple[];
  as_object: RawTriple[];
}

interface ProvenanceHop {
  depth: number;
  triples: RawTriple[];
}

interface GraphStats {
  total_triples: number;
  predicate_distribution: Record<string, number>;
  top_subjects: Array<{ label: string; count: number }>;
  top_objects: Array<{ label: string; count: number }>;
  issues_by_learning_count: Array<{ issue: string; count: number }>;
  agents_by_contribution: Array<{ agent: string; count: number }>;
}

export interface GraphTraverseResult {
  success: boolean;
  lens: GraphTraverseLens;
  query_node?: string;
  summary: string;
  display?: string;
  node?: GraphNode;
  chain?: ProvenanceHop[];
  stats?: GraphStats;
  total_triples_scanned: number;
  performance: PerformanceData;
}

// --- Constants ---

const SELECT_COLS =
  "id,subject,predicate,object,event_time,decay_weight,source_type,source_id,source_linear_issue,created_by";

const KNOWN_AGENTS = ["cli", "desktop", "autonomous", "local", "cloud", "CLI", "DAC", "CODA-1", "Brain_Local", "Brain_Cloud"];
/** Persona names are resolved dynamically via triple-writer's normalizePersonaLabel */
const KNOWN_PERSONAS: string[] = [];

// --- Node Normalization ---

interface NormalizedNode {
  pattern: string;
  type: string;
}

function normalizeNode(input: string): NormalizedNode {
  const trimmed = input.trim();
  // Sanitize: strip PostgREST structural chars that could escape ilike/or expressions
  const safe = trimmed.replace(/[(),\0]/g, "");

  // Already prefixed: "Scar: Title", "Issue: OD-466", etc.
  if (/^(Scar|Win|Decision|Pattern|Anti-Pattern|Issue|Agent|Persona|Thread):/.test(safe)) {
    return { pattern: `*${safe}*`, type: safe.split(":")[0] };
  }

  // OD-XXX issue pattern
  if (/^OD-\d+$/i.test(safe)) {
    return { pattern: `*${safe.toUpperCase()}*`, type: "Issue" };
  }

  // Known agent names
  if (KNOWN_AGENTS.includes(safe)) {
    return { pattern: `*Agent: ${safe}*`, type: "Agent" };
  }

  // Known persona names
  if (KNOWN_PERSONAS.includes(safe)) {
    return { pattern: `*Persona: ${safe}*`, type: "Persona" };
  }

  // Fallback: fuzzy search
  return { pattern: `*${safe}*`, type: "Unknown" };
}

/** Detect the type label from a subject/object string */
function detectNodeType(label: string): string {
  if (label.startsWith("Scar:")) return "Scar";
  if (label.startsWith("Win:")) return "Win";
  if (label.startsWith("Decision:")) return "Decision";
  if (label.startsWith("Pattern:")) return "Pattern";
  if (label.startsWith("Anti-Pattern:")) return "Anti-Pattern";
  if (label.startsWith("Issue:")) return "Issue";
  if (label.startsWith("Agent:")) return "Agent";
  if (label.startsWith("Persona:")) return "Persona";
  if (label.startsWith("Thread:")) return "Thread";
  return "Unknown";
}

// --- Fetch Helpers ---

async function fetchTriplesByNode(
  pattern: string,
  project: string,
  limit: number,
  predicate?: string
): Promise<RawTriple[]> {
  const filters: Record<string, string> = {
    project,
    or: `(subject.ilike.${pattern},object.ilike.${pattern})`,
  };
  if (predicate) {
    filters.predicate = predicate;
  }
  return directQuery<RawTriple>("knowledge_triples", {
    select: SELECT_COLS,
    filters,
    order: "event_time.desc",
    limit,
  });
}

async function fetchAllTriples(project: string): Promise<RawTriple[]> {
  return directQuery<RawTriple>("knowledge_triples", {
    select: SELECT_COLS,
    filters: { project },
    order: "event_time.desc",
    limit: 2000,
  });
}

// --- Summary Helpers ---

function countByPredicate(triples: RawTriple[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of triples) {
    counts[t.predicate] = (counts[t.predicate] || 0) + 1;
  }
  return counts;
}

function topN(counts: Record<string, number>, n: number): Array<{ label: string; count: number }> {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label, count]) => ({ label, count }));
}

// --- Lens: connected_to ---

async function connectedTo(
  params: GraphTraverseParams,
  timer: Timer
): Promise<GraphTraverseResult> {
  const project = params.project || getProject() || "default";
  const limit = params.limit || 50;
  const { pattern, type } = normalizeNode(params.node!);

  const triples = await fetchTriplesByNode(pattern, project, limit, params.predicate);
  const latencyMs = timer.stop();

  const asSubject = triples.filter((t) => t.subject.toLowerCase().includes(params.node!.toLowerCase()));
  const asObject = triples.filter((t) => t.object.toLowerCase().includes(params.node!.toLowerCase()));

  // Build summary
  const predicateCounts = countByPredicate(triples);
  const predicateParts = Object.entries(predicateCounts)
    .map(([pred, count]) => `${count} ${pred}`)
    .join(", ");

  const summary = triples.length === 0
    ? `No triples found matching "${params.node}".`
    : `${type}: ${params.node} has ${triples.length} connections (${predicateParts}). Appears as subject in ${asSubject.length}, as object in ${asObject.length}.`;

  return {
    success: true,
    lens: "connected_to",
    query_node: params.node,
    summary,
    display: wrapDisplay(summary),
    node: {
      label: params.node!,
      type,
      as_subject: asSubject,
      as_object: asObject,
    },
    total_triples_scanned: triples.length,
    performance: buildPerformanceData("graph_traverse" as any, latencyMs, triples.length),
  };
}

// --- Lens: produced_by ---

async function producedBy(
  params: GraphTraverseParams,
  timer: Timer
): Promise<GraphTraverseResult> {
  const project = params.project || getProject() || "default";
  const limit = params.limit || 100;
  const { pattern } = normalizeNode(params.node!);

  // Find triples where this agent/persona is the object
  const filters: Record<string, string> = {
    project,
    object: `ilike.${pattern}`,
  };
  if (params.predicate) {
    filters.predicate = params.predicate;
  }

  const triples = await directQuery<RawTriple>("knowledge_triples", {
    select: SELECT_COLS,
    filters,
    order: "event_time.desc",
    limit,
  });
  const latencyMs = timer.stop();

  // Group subjects by type
  const byType: Record<string, string[]> = {};
  for (const t of triples) {
    const sType = detectNodeType(t.subject);
    if (!byType[sType]) byType[sType] = [];
    // Deduplicate subjects
    if (!byType[sType].includes(t.subject)) {
      byType[sType].push(t.subject);
    }
  }

  const typeParts = Object.entries(byType)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([type, items]) => `${items.length} ${type.toLowerCase()}${items.length !== 1 ? "s" : ""}`)
    .join(", ");

  const uniqueSubjects = new Set(triples.map((t) => t.subject));
  const summary = triples.length === 0
    ? `No triples found with "${params.node}" as contributor.`
    : `${params.node} contributed to ${uniqueSubjects.size} items: ${typeParts}.`;

  return {
    success: true,
    lens: "produced_by",
    query_node: params.node,
    summary,
    display: wrapDisplay(summary),
    node: {
      label: params.node!,
      type: detectNodeType(`Agent: ${params.node}`).startsWith("Agent") ? "Agent" : "Persona",
      as_subject: [],
      as_object: triples,
    },
    total_triples_scanned: triples.length,
    performance: buildPerformanceData("graph_traverse" as any, latencyMs, triples.length),
  };
}

// --- Lens: provenance ---

async function provenance(
  params: GraphTraverseParams,
  timer: Timer
): Promise<GraphTraverseResult> {
  const project = params.project || getProject() || "default";
  const maxDepth = params.depth || 3;

  // Fetch all triples and traverse in memory
  const allTriples = await fetchAllTriples(project);

  // Build adjacency: subject -> triples where it's the subject
  const subjectIndex = new Map<string, RawTriple[]>();
  for (const t of allTriples) {
    const key = t.subject.toLowerCase();
    if (!subjectIndex.has(key)) subjectIndex.set(key, []);
    subjectIndex.get(key)!.push(t);
  }

  const chain: ProvenanceHop[] = [];
  const visited = new Set<string>();
  const nodePattern = params.node!.toLowerCase();

  // Find starting triples (where subject matches the node)
  let currentNodes: string[] = [];

  // Collect subjects that match the input
  for (const [key] of subjectIndex) {
    if (key.includes(nodePattern)) {
      currentNodes.push(key);
    }
  }

  for (let depth = 1; depth <= maxDepth; depth++) {
    const hopTriples: RawTriple[] = [];
    const nextNodes: string[] = [];

    for (const node of currentNodes) {
      const triples = subjectIndex.get(node) || [];
      for (const t of triples) {
        if (visited.has(t.id)) continue;
        visited.add(t.id);
        hopTriples.push(t);
        // Follow the object as next subject
        const objKey = t.object.toLowerCase();
        if (!currentNodes.includes(objKey) && subjectIndex.has(objKey)) {
          nextNodes.push(objKey);
        }
      }
    }

    if (hopTriples.length === 0) break;
    chain.push({ depth, triples: hopTriples });
    currentNodes = nextNodes;
    if (nextNodes.length === 0) break;
  }

  const latencyMs = timer.stop();
  const totalEdges = chain.reduce((sum, hop) => sum + hop.triples.length, 0);

  // Build summary
  let summary: string;
  if (chain.length === 0) {
    summary = `No provenance chain found for "${params.node}".`;
  } else {
    const hopSummaries = chain.map((hop) => {
      const edges = hop.triples
        .map((t) => `${t.subject.split(":").slice(1).join(":").trim()} --[${t.predicate}]--> ${t.object}`)
        .slice(0, 5); // Cap at 5 per hop for readability
      const more = hop.triples.length > 5 ? ` (+${hop.triples.length - 5} more)` : "";
      return `Hop ${hop.depth}: ${edges.join("; ")}${more}`;
    });
    summary = `Provenance for "${params.node}" (${totalEdges} edges, ${chain.length} hops):\n${hopSummaries.join("\n")}`;
  }

  return {
    success: true,
    lens: "provenance",
    query_node: params.node,
    summary,
    display: wrapDisplay(summary),
    chain,
    total_triples_scanned: allTriples.length,
    performance: buildPerformanceData("graph_traverse" as any, latencyMs, totalEdges),
  };
}

// --- Lens: stats ---

async function stats(
  params: GraphTraverseParams,
  timer: Timer
): Promise<GraphTraverseResult> {
  const project = params.project || getProject() || "default";

  const allTriples = await fetchAllTriples(project);
  const latencyMs = timer.stop();

  // Predicate distribution
  const predicateDist = countByPredicate(allTriples);

  // Top subjects
  const subjectCounts: Record<string, number> = {};
  for (const t of allTriples) {
    subjectCounts[t.subject] = (subjectCounts[t.subject] || 0) + 1;
  }

  // Top objects
  const objectCounts: Record<string, number> = {};
  for (const t of allTriples) {
    objectCounts[t.object] = (objectCounts[t.object] || 0) + 1;
  }

  // Issues by learning count (objects matching "Issue: OD-*")
  const issueCounts: Record<string, number> = {};
  for (const t of allTriples) {
    if (t.object.startsWith("Issue: OD-")) {
      issueCounts[t.object] = (issueCounts[t.object] || 0) + 1;
    }
    if (t.subject.startsWith("Issue: OD-")) {
      issueCounts[t.subject] = (issueCounts[t.subject] || 0) + 1;
    }
  }

  // Agent contributions
  const agentCounts: Record<string, number> = {};
  for (const t of allTriples) {
    if (t.object.startsWith("Agent:") || t.object.startsWith("Persona:")) {
      agentCounts[t.object] = (agentCounts[t.object] || 0) + 1;
    }
  }

  const graphStats: GraphStats = {
    total_triples: allTriples.length,
    predicate_distribution: predicateDist,
    top_subjects: topN(subjectCounts, 10),
    top_objects: topN(objectCounts, 10),
    issues_by_learning_count: topN(issueCounts, 15).map(({ label, count }) => ({
      issue: label,
      count,
    })),
    agents_by_contribution: topN(agentCounts, 10).map(({ label, count }) => ({
      agent: label,
      count,
    })),
  };

  // Build summary
  const predParts = Object.entries(predicateDist)
    .sort((a, b) => b[1] - a[1])
    .map(([pred, count]) => {
      const pct = Math.round((count / allTriples.length) * 100);
      return `${pred}: ${count} (${pct}%)`;
    })
    .join(", ");

  const topIssue = graphStats.issues_by_learning_count[0];
  const topAgent = graphStats.agents_by_contribution[0];

  const summary = [
    `Knowledge graph: ${allTriples.length} triples across ${Object.keys(predicateDist).length} predicates.`,
    `Predicates: ${predParts}.`,
    topIssue ? `Top issue: ${topIssue.issue} (${topIssue.count} connections).` : "",
    topAgent ? `Top contributor: ${topAgent.agent} (${topAgent.count} contributions).` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    success: true,
    lens: "stats",
    summary,
    display: wrapDisplay(summary),
    stats: graphStats,
    total_triples_scanned: allTriples.length,
    performance: buildPerformanceData("graph_traverse" as any, latencyMs, allTriples.length),
  };
}

// --- Main Entry Point ---

export async function graphTraverse(
  params: GraphTraverseParams
): Promise<GraphTraverseResult> {
  const timer = new Timer();
  const lens = params.lens;

  if (!hasSupabase()) {
    const noSupabaseMsg = "Graph traversal requires Supabase connection";
    return {
      success: false,
      lens,
      summary: noSupabaseMsg,
      display: wrapDisplay(noSupabaseMsg),
      total_triples_scanned: 0,
      performance: buildPerformanceData("graph_traverse" as any, timer.stop(), 0),
    };
  }

  // Validate: node required for all lenses except stats
  if (lens !== "stats" && !params.node) {
    const missingNodeMsg = `The '${lens}' lens requires a 'node' parameter (e.g., "PROJ-123", "cli", "Scar: Done ≠ Deployed")`;
    return {
      success: false,
      lens,
      summary: missingNodeMsg,
      display: wrapDisplay(missingNodeMsg),
      total_triples_scanned: 0,
      performance: buildPerformanceData("graph_traverse" as any, timer.stop(), 0),
    };
  }

  try {
    switch (lens) {
      case "connected_to":
        return await connectedTo(params, timer);
      case "produced_by":
        return await producedBy(params, timer);
      case "provenance":
        return await provenance(params, timer);
      case "stats":
        return await stats(params, timer);
      default: {
        const unknownLensMsg = `Unknown lens: ${lens}. Available: connected_to, produced_by, provenance, stats`;
        return {
          success: false,
          lens,
          summary: unknownLensMsg,
          display: wrapDisplay(unknownLensMsg),
          total_triples_scanned: 0,
          performance: buildPerformanceData("graph_traverse" as any, timer.stop(), 0),
        };
      }
    }
  } catch (error) {
    const latencyMs = timer.stop();
    const message = error instanceof Error ? error.message : String(error);
    const failMsg = `Graph traversal failed: ${message}`;
    return {
      success: false,
      lens,
      query_node: params.node,
      summary: failMsg,
      display: wrapDisplay(failMsg),
      total_triples_scanned: 0,
      performance: buildPerformanceData("graph_traverse" as any, latencyMs, 0),
    };
  }
}

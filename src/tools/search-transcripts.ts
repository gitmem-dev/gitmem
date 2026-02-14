/**
 * search_transcripts Tool
 *
 * Semantic search over session transcript chunks.
 * Generates embedding for query, calls match_transcript_chunks RPC,
 * returns ranked results with session context.
 *
 * Thread: Transcript Semantic Search
 */

import { embed } from "../services/embedding.js";
import { Timer, buildPerformanceData } from "../services/metrics.js";
import { getProject } from "../services/session-state.js";
import type { Project, PerformanceData, PerformanceBreakdown } from "../types/index.js";

export interface SearchTranscriptsParams {
  query: string;
  match_count?: number;
  similarity_threshold?: number;
  project?: Project;
}

interface TranscriptChunkResult {
  session_id: string;
  chunk_id: string;
  chunk_index: number;
  content: string;
  chunk_type: string;
  token_count: number;
  session_title: string | null;
  session_date: string | null;
  linear_issue: string | null;
  agent: string | null;
  project: string | null;
  similarity: number;
}

export interface SearchTranscriptsResult {
  query: string;
  results: TranscriptChunkResult[];
  total_found: number;
  display?: string;
  error?: string;
  performance: PerformanceData;
}

/**
 * Format results as readable markdown
 */
function formatDisplay(query: string, results: TranscriptChunkResult[]): string {
  if (results.length === 0) {
    return `No transcript chunks found for: "${query}"`;
  }

  const lines: string[] = [
    `**Transcript Search:** "${query}"`,
    `**Results:** ${results.length} chunks\n`,
  ];

  for (const r of results) {
    const sim = (r.similarity * 100).toFixed(1);
    const date = r.session_date || "unknown";
    const title = r.session_title || "Untitled session";
    const agent = r.agent || "unknown";
    const issue = r.linear_issue ? ` (${r.linear_issue})` : "";

    lines.push(`---`);
    lines.push(`**[${sim}%]** ${title}${issue}`);
    lines.push(`*${date} · ${agent} · chunk #${r.chunk_index} (${r.chunk_type})*`);
    lines.push("");

    // Truncate content for display (max ~300 chars)
    const content = r.content.length > 300
      ? r.content.slice(0, 297) + "..."
      : r.content;
    lines.push(content);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Execute search_transcripts tool
 */
export async function searchTranscripts(
  params: SearchTranscriptsParams
): Promise<SearchTranscriptsResult> {
  const timer = new Timer();

  if (!params.query) {
    const latencyMs = timer.stop();
    return {
      query: "",
      results: [],
      total_found: 0,
      error: "query is required",
      performance: buildPerformanceData("search_transcripts", latencyMs, 0),
    };
  }

  const matchCount = params.match_count ?? 10;
  const similarityThreshold = params.similarity_threshold ?? 0.3;
  const project = params.project || getProject() || null;

  try {
    // 1. Generate embedding for query
    const embedTimer = new Timer();
    const queryEmbedding = await embed(params.query);
    const embedLatencyMs = embedTimer.stop();

    if (!queryEmbedding) {
      const latencyMs = timer.stop();
      return {
        query: params.query,
        results: [],
        total_found: 0,
        error: "No embedding provider configured. Set OPENROUTER_API_KEY or OPENAI_API_KEY.",
        performance: buildPerformanceData("search_transcripts", latencyMs, 0),
      };
    }

    // 2. Call match_transcript_chunks RPC via PostgREST
    const SUPABASE_URL = process.env.SUPABASE_URL || "";
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      const latencyMs = timer.stop();
      return {
        query: params.query,
        results: [],
        total_found: 0,
        error: "Supabase configuration missing",
        performance: buildPerformanceData("search_transcripts", latencyMs, 0),
      };
    }

    const rpcTimer = new Timer();
    const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/match_transcript_chunks`;

    const rpcBody = {
      query_embedding: `[${queryEmbedding.join(",")}]`,
      match_count: matchCount,
      similarity_threshold: similarityThreshold,
      filter_project: project,
    };

    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Profile": "public",
        "Accept-Profile": "public",
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "apikey": SUPABASE_KEY,
      },
      body: JSON.stringify(rpcBody),
    });

    const rpcLatencyMs = rpcTimer.stop();

    if (!response.ok) {
      const errorText = await response.text();
      const latencyMs = timer.stop();
      return {
        query: params.query,
        results: [],
        total_found: 0,
        error: `RPC error (${response.status}): ${errorText.slice(0, 200)}`,
        performance: buildPerformanceData("search_transcripts", latencyMs, 0),
      };
    }

    const results = (await response.json()) as TranscriptChunkResult[];
    const latencyMs = timer.stop();

    const breakdown: PerformanceBreakdown = {
      embedding: {
        latency_ms: embedLatencyMs,
        source: "supabase",
        cache_status: "not_applicable",
        network_call: true,
      },
      scar_search: {
        latency_ms: rpcLatencyMs,
        source: "supabase",
        cache_status: "not_applicable",
        network_call: true,
      },
    };

    return {
      query: params.query,
      results,
      total_found: results.length,
      display: formatDisplay(params.query, results),
      performance: buildPerformanceData("search_transcripts", latencyMs, results.length, {
        breakdown,
      }),
    };
  } catch (error) {
    const latencyMs = timer.stop();
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      query: params.query,
      results: [],
      total_found: 0,
      error: `Search failed: ${errorMessage}`,
      performance: buildPerformanceData("search_transcripts", latencyMs, 0),
    };
  }
}

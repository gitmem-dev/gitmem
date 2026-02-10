/**
 * GitMem MCP Server
 *
 * Registers all tools and handles MCP protocol communication.
 * Tool definitions are in ./tools/definitions.ts
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { sessionStart, sessionRefresh } from "./tools/session-start.js";
import type { SessionRefreshParams } from "./tools/session-start.js";
import { sessionClose } from "./tools/session-close.js";
import { createLearning } from "./tools/create-learning.js";
import { createDecision } from "./tools/create-decision.js";
import { recordScarUsage } from "./tools/record-scar-usage.js";
import { recordScarUsageBatch } from "./tools/record-scar-usage-batch.js";
import { recall } from "./tools/recall.js";
import { confirmScars } from "./tools/confirm-scars.js";
import { saveTranscript } from "./tools/save-transcript.js";
import { getTranscript } from "./tools/get-transcript.js";
import { search } from "./tools/search.js";
import { log } from "./tools/log.js";
import { analyze } from "./tools/analyze.js";
import type { AnalyzeParams } from "./tools/analyze.js";
import { graphTraverse } from "./tools/graph-traverse.js";
import type { GraphTraverseParams } from "./tools/graph-traverse.js";
import { prepareContext } from "./tools/prepare-context.js";
import type { PrepareContextParams } from "./tools/prepare-context.js";
import { absorbObservations } from "./tools/absorb-observations.js";
import { listThreads } from "./tools/list-threads.js";
import { resolveThread } from "./tools/resolve-thread.js";
import { createThread } from "./tools/create-thread.js";
import type { CreateThreadParams } from "./tools/create-thread.js";
import { promoteSuggestion } from "./tools/promote-suggestion.js";
import type { PromoteSuggestionParams } from "./tools/promote-suggestion.js";
import { dismissSuggestion } from "./tools/dismiss-suggestion.js";
import type { DismissSuggestionParams } from "./tools/dismiss-suggestion.js";
import { cleanupThreads } from "./tools/cleanup-threads.js";
import type { CleanupThreadsParams } from "./tools/cleanup-threads.js";
import type { AbsorbObservationsParams, ListThreadsParams, ResolveThreadParams } from "./types/index.js";
import {
  getCacheStatus,
  checkCacheHealth,
  flushCache,
  startBackgroundInit,
} from "./services/startup.js";
import {
  getTier,
  hasSupabase,
  hasCacheManagement,
  hasBatchOperations,
  hasTranscripts,
} from "./services/tier.js";
import { getRegisteredTools } from "./tools/definitions.js";
import type { Project } from "./types/index.js";

import type {
  SessionStartParams,
  SessionCloseParams,
  CreateLearningParams,
  CreateDecisionParams,
  RecordScarUsageParams,
  RecordScarUsageBatchParams,
  SaveTranscriptParams,
  GetTranscriptParams,
  ConfirmScarsParams,
} from "./types/index.js";
import type { RecallParams } from "./tools/recall.js";
import type { SearchParams } from "./tools/search.js";
import type { LogParams } from "./tools/log.js";

/**
 * Create and configure the MCP server
 */
export function createServer(): Server {
  const server = new Server(
    {
      name: "gitmem-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register list tools handler (tier-gated)
  const registeredTools = getRegisteredTools();
  const registeredToolNames = new Set(registeredTools.map(t => t.name));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registeredTools,
  }));

  // Register call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const toolArgs = (args || {}) as Record<string, unknown>;

    // Guard: reject calls to tools not available in current tier
    if (!registeredToolNames.has(name)) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: `Unknown tool: ${name}. Available tools depend on your GitMem tier (current: ${getTier()}).` }),
          },
        ],
        isError: true,
      };
    }

    try {
      let result: unknown;

      switch (name) {
        case "recall":
        case "gitmem-r":
          result = await recall(toolArgs as unknown as RecallParams);
          break;
        case "confirm_scars":
        case "gitmem-cs":
        case "gm-confirm":
          result = await confirmScars(toolArgs as unknown as ConfirmScarsParams);
          break;
        case "session_start":
        case "gitmem-ss":
        case "gm-open":
          result = await sessionStart(toolArgs as unknown as SessionStartParams);
          break;
        case "session_refresh":
        case "gitmem-sr":
        case "gm-refresh":
          result = await sessionRefresh(toolArgs as unknown as SessionRefreshParams);
          break;
        case "session_close":
        case "gitmem-sc":
        case "gm-close":
          result = await sessionClose(toolArgs as unknown as SessionCloseParams);
          break;
        case "create_learning":
        case "gitmem-cl":
        case "gm-scar":
          result = await createLearning(toolArgs as unknown as CreateLearningParams);
          break;
        case "create_decision":
        case "gitmem-cd":
          result = await createDecision(toolArgs as unknown as CreateDecisionParams);
          break;
        case "record_scar_usage":
        case "gitmem-rs":
          result = await recordScarUsage(toolArgs as unknown as RecordScarUsageParams);
          break;
        case "record_scar_usage_batch":
        case "gitmem-rsb":
          result = await recordScarUsageBatch(toolArgs as unknown as RecordScarUsageBatchParams);
          break;
        case "save_transcript":
        case "gitmem-st":
          result = await saveTranscript(toolArgs as unknown as SaveTranscriptParams);
          break;
        case "get_transcript":
        case "gitmem-gt":
          result = await getTranscript(toolArgs as unknown as GetTranscriptParams);
          break;
        case "search":
        case "gitmem-search":
        case "gm-search":
          result = await search(toolArgs as unknown as SearchParams);
          break;
        case "log":
        case "gitmem-log":
        case "gm-log":
          result = await log(toolArgs as unknown as LogParams);
          break;
        case "analyze":
        case "gitmem-analyze":
        case "gm-analyze":
          result = await analyze(toolArgs as unknown as AnalyzeParams);
          break;
        case "prepare_context":
        case "gitmem-pc":
        case "gm-pc":
          result = await prepareContext(toolArgs as unknown as PrepareContextParams);
          break;
        case "absorb_observations":
        case "gitmem-ao":
        case "gm-absorb":
          result = await absorbObservations(toolArgs as unknown as AbsorbObservationsParams);
          break;
        case "list_threads":
        case "gitmem-lt":
        case "gm-threads":
          result = await listThreads(toolArgs as unknown as ListThreadsParams);
          break;
        case "resolve_thread":
        case "gitmem-rt":
        case "gm-resolve":
          result = await resolveThread(toolArgs as unknown as ResolveThreadParams);
          break;
        case "create_thread":
        case "gitmem-ct":
        case "gm-thread-new":
          result = await createThread(toolArgs as unknown as CreateThreadParams);
          break;
        case "promote_suggestion":
        case "gitmem-ps":
        case "gm-promote":
          result = await promoteSuggestion(toolArgs as unknown as PromoteSuggestionParams);
          break;
        case "dismiss_suggestion":
        case "gitmem-ds":
        case "gm-dismiss":
          result = await dismissSuggestion(toolArgs as unknown as DismissSuggestionParams);
          break;
        case "cleanup_threads":
        case "gitmem-cleanup":
        case "gm-cleanup":
          result = await cleanupThreads(toolArgs as unknown as CleanupThreadsParams);
          break;
        case "gitmem-help": {
          const tier = getTier();
          const commands = [
            { alias: "gitmem-r", full: "recall", description: "Check scars before taking action" },
            { alias: "gitmem-cs", full: "confirm_scars", description: "Confirm recalled scars (APPLYING/N_A/REFUTED)" },
            { alias: "gitmem-ss", full: "session_start", description: "Initialize session with context" },
            { alias: "gitmem-sc", full: "session_close", description: "Close session with compliance validation" },
            { alias: "gitmem-cl", full: "create_learning", description: "Create scar/win/pattern entry" },
            { alias: "gitmem-cd", full: "create_decision", description: "Log architectural/operational decision" },
            { alias: "gitmem-rs", full: "record_scar_usage", description: "Track scar application" },
            { alias: "gitmem-search", full: "search", description: "Search institutional memory (exploration)" },
            { alias: "gitmem-log", full: "log", description: "List recent learnings chronologically" },
            { alias: "gitmem-analyze", full: "analyze", description: "Session analytics and insights" },
            { alias: "gitmem-pc", full: "prepare_context", description: "Generate memory payload for sub-agents" },
            { alias: "gitmem-ao", full: "absorb_observations", description: "Capture sub-agent/teammate observations" },
            { alias: "gitmem-lt", full: "list_threads", description: "List open threads across sessions" },
            { alias: "gitmem-rt", full: "resolve_thread", description: "Mark a thread as resolved" },
            { alias: "gitmem-ps", full: "promote_suggestion", description: "Promote a suggested thread to open thread" },
            { alias: "gitmem-ds", full: "dismiss_suggestion", description: "Dismiss a suggested thread" },
            { alias: "gitmem-cleanup", full: "cleanup_threads", description: "Triage threads by lifecycle health" },
          ];
          if (hasBatchOperations()) {
            commands.push({ alias: "gitmem-rsb", full: "record_scar_usage_batch", description: "Track multiple scars (batch)" });
          }
          if (hasTranscripts()) {
            commands.push(
              { alias: "gitmem-st", full: "save_transcript", description: "Save session transcript to storage" },
              { alias: "gitmem-gt", full: "get_transcript", description: "Retrieve session transcript" },
            );
          }
          if (hasCacheManagement()) {
            commands.push(
              { alias: "gitmem-cache-status", full: "cache_status", description: "Show cache status" },
              { alias: "gitmem-cache-health", full: "cache_health", description: "Compare local vs remote" },
              { alias: "gitmem-cache-flush", full: "cache_flush", description: "Force reload from Supabase" },
            );
          }

          // Output colored header directly to terminal (stderr)
          console.error(`
\x1b[31m╔═══════════════════════════════════════════════════════════╗\x1b[0m
\x1b[31m║\x1b[0m                                                           \x1b[31m║\x1b[0m
\x1b[31m║    ██████  ██ ████████ ███    ███ ███████ ███    ███      ║\x1b[0m
\x1b[38;5;208m║   ██       ██    ██    ████  ████ ██      ████  ████      ║\x1b[0m
\x1b[38;5;208m║   ██   ███ ██    ██    ██ ████ ██ █████   ██ ████ ██      ║\x1b[0m
\x1b[33m║   ██    ██ ██    ██    ██  ██  ██ ██      ██  ██  ██      ║\x1b[0m
\x1b[33m║    ██████  ██    ██    ██      ██ ███████ ██      ██      ║\x1b[0m
\x1b[33m║\x1b[0m                                                           \x1b[33m║\x1b[0m
\x1b[38;5;208m║\x1b[0m         \x1b[1;37mInstitutional Memory & Learning System\x1b[0m            \x1b[38;5;208m║\x1b[0m
\x1b[31m║\x1b[0m              \x1b[3;90mNever repeat the same mistake\x1b[0m                \x1b[31m║\x1b[0m
\x1b[31m║\x1b[0m                                                           \x1b[31m║\x1b[0m
\x1b[31m╚═══════════════════════════════════════════════════════════╝\x1b[0m
`);

          // Return plain JSON result (no header - it's already printed above)
          result = {
            version: "0.1.0",
            tier,
            tools_registered: registeredTools.length,
            storage: hasSupabase() ? "supabase" : "local (.gitmem/)",
            commands,
          };
          break;
        }

        // Knowledge graph traversal (Phase 3)
        case "graph_traverse":
        case "gitmem-graph":
        case "gm-graph":
          result = await graphTraverse(toolArgs as unknown as GraphTraverseParams);
          break;

        // Cache management tools (OD-473)
        case "gitmem-cache-status":
        case "gm-cache-s":
          result = getCacheStatus((toolArgs.project as Project) || "orchestra_dev");
          break;

        case "gitmem-cache-health":
        case "gm-cache-h":
          result = await checkCacheHealth((toolArgs.project as Project) || "orchestra_dev");
          break;

        case "gitmem-cache-flush":
        case "gm-cache-f":
          result = await flushCache((toolArgs.project as Project) || "orchestra_dev");
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: (result && typeof result === "object" && "text" in result && typeof result.text === "string")
              ? result.text
              : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Run the server with stdio transport
 *
 * OD-473: Initializes local vector search in background for fast startup.
 * OD-489: Uses direct Supabase queries to get embeddings for local cache.
 *
 * Server starts immediately; cache loads in background.
 * First few queries may use Supabase fallback until cache is ready.
 */
export async function runServer(): Promise<void> {
  const tier = getTier();

  // Start server immediately (don't block on cache loading)
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const toolCount = getRegisteredTools().length;
  const storage = hasSupabase() ? "supabase" : "local";
  console.error(`[gitmem] Tier: ${tier} | Storage: ${storage} | Tools: ${toolCount}`);

  if (hasSupabase()) {
    // Pro/Dev: Initialize local vector search in background (non-blocking)
    // This loads scars with embeddings directly from Supabase REST API
    console.error("[gitmem] Starting background cache initialization...");
    startBackgroundInit("orchestra_dev");

    // Also init weekend_warrior if needed (non-blocking)
    startBackgroundInit("weekend_warrior");

    console.error("[gitmem] Server ready | Cache loading in background");
  } else {
    // Free tier: no Supabase cache to load
    console.error("[gitmem] Server ready | Using local storage (.gitmem/)");
  }
}

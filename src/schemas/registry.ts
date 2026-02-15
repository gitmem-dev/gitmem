/**
 * Schema Registry — maps tool names to Zod schemas for server-level validation.
 *
 * Tools without schemas pass through (logged as warning).
 * Tools WITH schemas get validated before dispatch, producing clean errors
 * instead of runtime crashes from malformed payloads.
 */

import type { ZodSchema } from "zod";

import { RecallParamsSchema } from "./recall.js";
import { SessionStartParamsSchema } from "./session-start.js";
import { SessionCloseParamsSchema } from "./session-close.js";
import { CreateLearningParamsSchema } from "./create-learning.js";
import { CreateDecisionParamsSchema } from "./create-decision.js";
import { RecordScarUsageParamsSchema } from "./record-scar-usage.js";
import { RecordScarUsageBatchParamsSchema } from "./record-scar-usage-batch.js";
import { SearchParamsSchema } from "./search.js";
import { LogParamsSchema } from "./log.js";
import { AnalyzeParamsSchema } from "./analyze.js";
import { SaveTranscriptParamsSchema } from "./save-transcript.js";
import { GetTranscriptParamsSchema } from "./get-transcript.js";
import { SearchTranscriptsParamsSchema } from "./search-transcripts.js";
import { PrepareContextParamsSchema } from "./prepare-context.js";
import { AbsorbObservationsParamsSchema } from "./absorb-observations.js";
import { ListThreadsParamsSchema, ResolveThreadParamsSchema } from "./thread.js";

/**
 * Map of canonical tool names → Zod schemas.
 * Aliases (gitmem-r, gm-open, etc.) are resolved to canonical names before lookup.
 */
const TOOL_SCHEMAS: Record<string, ZodSchema> = {
  recall: RecallParamsSchema,
  session_start: SessionStartParamsSchema,
  session_close: SessionCloseParamsSchema,
  create_learning: CreateLearningParamsSchema,
  create_decision: CreateDecisionParamsSchema,
  record_scar_usage: RecordScarUsageParamsSchema,
  record_scar_usage_batch: RecordScarUsageBatchParamsSchema,
  search: SearchParamsSchema,
  log: LogParamsSchema,
  analyze: AnalyzeParamsSchema,
  save_transcript: SaveTranscriptParamsSchema,
  get_transcript: GetTranscriptParamsSchema,
  search_transcripts: SearchTranscriptsParamsSchema,
  prepare_context: PrepareContextParamsSchema,
  absorb_observations: AbsorbObservationsParamsSchema,
  list_threads: ListThreadsParamsSchema,
  resolve_thread: ResolveThreadParamsSchema,
};

/**
 * Map of alias → canonical name for all tool aliases.
 */
const ALIAS_MAP: Record<string, string> = {
  // recall
  "gitmem-r": "recall",
  // confirm_scars — no schema yet
  "gitmem-cs": "confirm_scars",
  "gm-confirm": "confirm_scars",
  // session_start
  "gitmem-ss": "session_start",
  "gm-open": "session_start",
  // session_refresh — no schema yet
  "gitmem-sr": "session_refresh",
  "gm-refresh": "session_refresh",
  // session_close
  "gitmem-sc": "session_close",
  "gm-close": "session_close",
  // create_learning
  "gitmem-cl": "create_learning",
  "gm-scar": "create_learning",
  // create_decision
  "gitmem-cd": "create_decision",
  // record_scar_usage
  "gitmem-rs": "record_scar_usage",
  // record_scar_usage_batch
  "gitmem-rsb": "record_scar_usage_batch",
  // save_transcript
  "gitmem-st": "save_transcript",
  // get_transcript
  "gitmem-gt": "get_transcript",
  // search_transcripts
  "gitmem-stx": "search_transcripts",
  "gm-stx": "search_transcripts",
  // search
  "gitmem-search": "search",
  "gm-search": "search",
  // log
  "gitmem-log": "log",
  "gm-log": "log",
  // analyze
  "gitmem-analyze": "analyze",
  "gm-analyze": "analyze",
  // prepare_context
  "gitmem-pc": "prepare_context",
  "gm-pc": "prepare_context",
  // absorb_observations
  "gitmem-ao": "absorb_observations",
  "gm-absorb": "absorb_observations",
  // list_threads
  "gitmem-lt": "list_threads",
  "gm-threads": "list_threads",
  // resolve_thread
  "gitmem-rt": "resolve_thread",
  "gm-resolve": "resolve_thread",
  // create_thread — no schema yet
  "gitmem-ct": "create_thread",
  "gm-thread-new": "create_thread",
  // promote_suggestion — no schema yet
  "gitmem-ps": "promote_suggestion",
  "gm-promote": "promote_suggestion",
  // dismiss_suggestion — no schema yet
  "gitmem-ds": "dismiss_suggestion",
  "gm-dismiss": "dismiss_suggestion",
  // cleanup_threads — no schema yet
  "gitmem-cleanup": "cleanup_threads",
  "gm-cleanup": "cleanup_threads",
  // archive_learning — no schema yet
  "gitmem-al": "archive_learning",
  "gm-archive": "archive_learning",
  // graph_traverse — no schema yet
  "gitmem-graph": "graph_traverse",
  "gm-graph": "graph_traverse",
  // health — no params
  "gitmem-health": "health",
  "gm-health": "health",
  // cache tools — no schema
  "gitmem-cache-status": "cache_status",
  "gm-cache-s": "cache_status",
  "gitmem-cache-health": "cache_health",
  "gm-cache-h": "cache_health",
  "gitmem-cache-flush": "cache_flush",
  "gm-cache-f": "cache_flush",
  // help — no params
  "gitmem-help": "help",
};

/**
 * Resolve a tool name (possibly an alias) to its canonical name.
 */
export function resolveToolName(name: string): string {
  return ALIAS_MAP[name] || name;
}

/**
 * Validate tool arguments against the registered schema.
 * Returns null if valid or no schema exists.
 * Returns error string if validation fails.
 */
export function validateToolArgs(name: string, args: Record<string, unknown>): string | null {
  const canonical = resolveToolName(name);
  const schema = TOOL_SCHEMAS[canonical];

  if (!schema) {
    // No schema registered — pass through
    return null;
  }

  const result = schema.safeParse(args);
  if (result.success) {
    return null;
  }

  const errors = result.error.errors.map(
    (e) => `${e.path.length > 0 ? e.path.join(".") + ": " : ""}${e.message}`
  );
  return `Invalid parameters for ${canonical}: ${errors.join("; ")}`;
}

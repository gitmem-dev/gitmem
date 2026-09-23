/**
 * archive_learning Tool
 *
 * Archives a learning (scar/win/pattern) by setting is_active=false
 * and recording archived_at timestamp. Archived learnings are excluded
 * from recall and search results but preserved for audit trail.
 *
 * Also triggers a local cache flush so the archived scar is immediately
 * removed from in-memory search results.
 */

import { directPatch, directQuery, isConfigured } from "../services/supabase-client.js";
import { supportedColumns } from "../services/store-columns.js";
import { hasSupabase, getTableName } from "../services/tier.js";
import { getStorage } from "../services/storage.js";
import { flushCache } from "../services/startup.js";
import { getLocalVectorSearch } from "../services/local-vector-search.js";
import { Timer } from "../services/metrics.js";
import { wrapDisplay } from "../services/display-protocol.js";
import { writeResult, notStored } from "../services/write-result.js";
import type { WriteResult } from "../types/index.js";

export interface ArchiveLearningParams {
  /** UUID or short ID prefix of the learning to archive */
  id: string;
  /** Optional reason for archiving */
  reason?: string;
}

export interface ArchiveLearningResult extends WriteResult {
  id: string;
  archived_at?: string;
  reason?: string;
  cache_flushed: boolean;
  display?: string;
  error?: string;
  performance_ms: number;
}

const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GIT-119: the UUIDs a hex prefix covers, as an inclusive range. uuid values
 * order bytewise, i.e. by their hex digits, so prefix+"000…" .. prefix+"fff…"
 * is exactly the set that starts with the prefix.
 */
export function uuidRangeForPrefix(prefix: string): [string, string] {
  const fmt = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return [fmt(prefix.padEnd(32, "0")), fmt(prefix.padEnd(32, "f"))];
}

/** Ids in the warm local vector index (empty when it is not loaded). */
function localIndexIds(): string[] {
  try {
    return getLocalVectorSearch().getScarIds();
  } catch {
    return [];
  }
}
const HEX_PREFIX_RE = /^[0-9a-f]{4,32}$/i;

/**
 * Resolve a short hex ID prefix to a full UUID.
 * Git-style prefix resolution: accepts 4-32 char hex prefixes.
 * Full UUIDs pass through unchanged.
 */
async function resolveIdPrefix(input: string): Promise<{ id: string } | { error: string }> {
  // Full UUID — pass through
  if (FULL_UUID_RE.test(input)) {
    return { id: input };
  }

  // Validate hex prefix format
  if (!HEX_PREFIX_RE.test(input)) {
    return { error: `Invalid ID format: "${input}". Provide a full UUID or a 4-32 char hex prefix.` };
  }

  const prefix = input.toLowerCase();

  if (hasSupabase() && isConfigured()) {
    // GIT-119: this sent id=like.<prefix>% — Postgres has no LIKE on a UUID
    // column (42883 "operator does not exist: uuid ~~ unknown"), so prefix
    // archiving failed on every store. Resolve from the local index when it
    // has the answer, else ask the store for the UUID range the prefix spans.
    const local = localIndexIds().filter((id) => id.replace(/-/g, "").startsWith(prefix));
    if (local.length === 1) return { id: local[0] };
    if (local.length > 1) {
      return { error: `Ambiguous prefix "${prefix}" — matches multiple learnings: ${local.slice(0, 2).map((m) => m.slice(0, 12) + "…").join(", ")}` };
    }
    const [low, high] = uuidRangeForPrefix(prefix);
    const matches = await directQuery<{ id: string }>(getTableName("learnings"), {
      select: "id",
      filters: { and: `(id.gte.${low},id.lte.${high})` },
      limit: 2,
    });

    if (matches.length === 0) {
      return { error: `No learning found with ID prefix "${prefix}"` };
    }
    if (matches.length > 1) {
      const ids = matches.map(m => m.id.slice(0, 12) + "…").join(", ");
      return { error: `Ambiguous prefix "${prefix}" — matches multiple learnings: ${ids}` };
    }
    return { id: matches[0].id };
  } else {
    // Local storage: scan and filter
    const storage = getStorage();
    const all = await storage.query<{ id: string }>("learnings", {});
    const matches = all.filter(r => r.id.toLowerCase().startsWith(prefix));

    if (matches.length === 0) {
      return { error: `No learning found with ID prefix "${prefix}"` };
    }
    if (matches.length > 1) {
      const ids = matches.map(m => m.id.slice(0, 12) + "…").join(", ");
      return { error: `Ambiguous prefix "${prefix}" — matches multiple learnings: ${ids}` };
    }
    return { id: matches[0].id };
  }
}

export async function archiveLearning(params: ArchiveLearningParams): Promise<ArchiveLearningResult> {
  const timer = new Timer();

  if (!params.id || typeof params.id !== "string") {
    const msg = "Missing required parameter: id (UUID or short ID prefix of the learning to archive)";
    return {
      ...notStored(),
      id: "",
      cache_flushed: false,
      display: wrapDisplay(msg),
      error: msg,
      performance_ms: timer.stop(),
    };
  }

  // Resolve short prefix to full UUID
  const resolved = await resolveIdPrefix(params.id);
  if ("error" in resolved) {
    return {
      ...notStored(),
      id: params.id,
      cache_flushed: false,
      display: wrapDisplay(resolved.error),
      error: resolved.error,
      performance_ms: timer.stop(),
    };
  }
  const resolvedId = resolved.id;

  try {
    const archivedAt = new Date().toISOString();
    let cacheFlushed = false;

    if (hasSupabase() && isConfigured()) {
      // Pro/dev: patch in Supabase
      // archived_at is not in setup.sql; sending it to a store without the
      // column failed the whole PATCH, so the learning was never archived.
      // updated_at (trigger) still records when it happened.
      const learningsTable = getTableName("learnings");
      const hasArchivedAt = (await supportedColumns(learningsTable, ["archived_at"])).has("archived_at");
      const patched = await directPatch(learningsTable, { id: `eq.${resolvedId}` }, {
        is_active: false,
        ...(hasArchivedAt && { archived_at: archivedAt }),
      });
      // GIT-119: a full UUID skips resolution, and PostgREST answers 200 with
      // no rows when nothing matched — so this reported "Archived", durable,
      // for a learning that does not exist.
      if (patched.count === 0) {
        const msg = `No learning ${resolvedId} in the store — nothing was archived`;
        return {
          ...notStored(),
          id: resolvedId,
          cache_flushed: false,
          display: wrapDisplay(msg),
          error: msg,
          performance_ms: timer.stop(),
        };
      }

      try {
        await flushCache();
        cacheFlushed = true;
      } catch {
        console.error("[archive-learning] Cache flush failed (non-fatal)");
      }
    } else {
      // Free tier: update in local JSON
      const storage = getStorage();
      const existing = await storage.get<Record<string, unknown>>("learnings", resolvedId);
      if (!existing) {
        const msg = `Learning ${resolvedId} not found in local storage`;
        return {
          ...notStored(),
          id: resolvedId,
          cache_flushed: false,
          display: wrapDisplay(msg),
          error: msg,
          performance_ms: timer.stop(),
        };
      }
      await storage.upsert("learnings", {
        ...existing,
        id: resolvedId,
        is_active: false,
        archived_at: archivedAt,
      });
    }

    const latencyMs = timer.stop();
    const reasonText = params.reason ? ` Reason: ${params.reason}` : "";
    // Show resolution when input differed from resolved ID
    const idDisplay = params.id !== resolvedId
      ? `${params.id} → ${resolvedId}`
      : resolvedId;
    const display = `Archived learning ${idDisplay}.${reasonText}\n(${latencyMs}ms)`;

    return {
      ...writeResult(hasSupabase()),
      id: resolvedId,
      archived_at: archivedAt,
      reason: params.reason,
      cache_flushed: cacheFlushed,
      display: wrapDisplay(display),
      performance_ms: latencyMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const latencyMs = timer.stop();
    return {
      ...notStored(),
      id: resolvedId,
      cache_flushed: false,
      display: wrapDisplay(`Failed to archive learning: ${message}`),
      error: message,
      performance_ms: latencyMs,
    };
  }
}

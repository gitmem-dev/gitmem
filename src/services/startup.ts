/**
 * GitMem MCP Startup Service
 *
 * Initializes local vector search at server startup.
 * Loads all scars once from Supabase, builds in-memory index.
 * Provides cache management (status, flush, health check).
 *
 * Solves:
 * - Cache consistency (no file-based cache race conditions)
 * - 500-employees-at-8AM (no Supabase contention during session_start)
 * - Cross-container consistency (same data = same results)
 *
 * Issue: OD-473
 */

import * as fs from "fs";
import * as path from "path";
import { isConfigured, loadScarsWithEmbeddings } from "./supabase-client.js";
import {
  initializeLocalSearch,
  reinitializeLocalSearch,
  isLocalSearchReady,
  getLocalVectorSearch,
  getCacheMetadata,
  setCacheTtl,
  clearLocalSearch,
} from "./local-vector-search.js";
import { getConfig, shouldUseLocalSearch } from "./config.js";
import type { Project } from "../types/index.js";

// Track startup state — unified cache, no per-project partitioning
const UNIFIED_KEY = "__all__";
const startupCompleted: Map<string, boolean> = new Map();
const startupPromises: Map<string, Promise<void>> = new Map();
let backgroundRefreshInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Persist scars to disk for hook process consumption.
 *
 * Hook processes (e.g., auto-retrieve-hook.sh → quick-retrieve.js) run as
 * separate child processes without the MCP server's env vars or in-memory
 * cache. This writes a stripped-down scar file (no embeddings) that hook
 * processes can read for keyword search.
 */
function persistScarsForHooks(scars: ScarWithEmbedding[]): void {
  try {
    const gitmemDir = path.join(process.cwd(), ".gitmem", "cache");
    if (!fs.existsSync(gitmemDir)) {
      fs.mkdirSync(gitmemDir, { recursive: true });
    }

    // Strip embeddings (large) — hooks only need searchable fields
    const stripped = scars.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      severity: s.severity,
      counter_arguments: s.counter_arguments,
      project: s.project,
      keywords: s.keywords,
      why_this_matters: s.why_this_matters,
      action_protocol: s.action_protocol,
      self_check_criteria: s.self_check_criteria,
    }));

    const cachePath = path.join(gitmemDir, "hook-scars.json");
    fs.writeFileSync(cachePath, JSON.stringify(stripped));
    console.error(`[startup] Persisted ${stripped.length} scars to ${cachePath} for hook processes`);
  } catch (error) {
    // Non-fatal — hooks will just return nothing
    console.error("[startup] Failed to persist scars for hooks:", error);
  }
}

// Scar record from database (with embedding)
interface ScarWithEmbedding {
  id: string;
  title: string;
  description: string;
  severity: string;
  counter_arguments?: string[];
  project?: string;
  embedding?: number[];
  updated_at?: string;
  keywords?: string[];
  decay_multiplier?: number;
  why_this_matters?: string;
  action_protocol?: string[];
  self_check_criteria?: string[];
  [key: string]: unknown;
}

/**
 * Load all learnings with embeddings from Supabase
 *
 * Uses direct Supabase REST API (bypasses ww-mcp) to get embedding vectors.
 * ww-mcp doesn't return embeddings by default to avoid bloated responses.
 *
 * NOTE: Now loads all learning types (scars, patterns, wins, anti-patterns),
 * not just scars. This fixes the issue where ~64 patterns were being ignored.
 */
async function loadScarsFromSupabase(): Promise<{
  scars: ScarWithEmbedding[];
  latestUpdatedAt: string | null;
}> {
  console.error(`[startup] Loading ALL learnings with embeddings from Supabase (cross-project)`);
  const startTime = Date.now();

  try {
    // Load ALL learnings across projects — semantic similarity handles relevance
    const learnings = await loadScarsWithEmbeddings<ScarWithEmbedding>(undefined, 500);

    const elapsed = Date.now() - startTime;
    console.error(`[startup] Loaded ${learnings.length} learnings in ${elapsed}ms`);

    // Log embedding stats
    const withEmbeddings = learnings.filter((s) => s.embedding && Array.isArray(s.embedding));
    console.error(`[startup] ${withEmbeddings.length}/${learnings.length} learnings have embeddings`);

    // Get latest updated_at for staleness tracking
    const latestUpdatedAt = learnings.length > 0 ? learnings[0].updated_at || null : null;

    return { scars: learnings, latestUpdatedAt };
  } catch (error) {
    console.error("[startup] Failed to load learnings:", error);
    return { scars: [], latestUpdatedAt: null };
  }
}

/**
 * Get remote learning count and latest updated_at for health check
 *
 * Uses direct Supabase REST API for consistency with loadScarsFromSupabase.
 * NOTE: Now loads all learning types (scars, patterns, wins, anti-patterns).
 */
async function getRemoteScarStats(): Promise<{
  count: number;
  latestUpdatedAt: string | null;
}> {
  try {
    // Import directQuery here to avoid circular dependency issues
    const { directQuery } = await import("./supabase-client.js");

    // Quick query to get count and latest timestamp (no embeddings needed)
    // Cross-project — matches unified cache loading
    // Filter embedding=not.is.null to match cache indexing (which skips entries without embeddings)
    const learnings = await directQuery<{ id: string; updated_at?: string }>("orchestra_learnings", {
      select: "id,updated_at",
      filters: {
        learning_type: "in.(scar,pattern,win,anti_pattern)",
        embedding: "not.is.null",
        is_active: "eq.true",
      },
      order: "updated_at.desc",
      limit: 500,
    });

    return {
      count: learnings.length,
      latestUpdatedAt: learnings.length > 0 ? learnings[0].updated_at || null : null,
    };
  } catch (error) {
    console.error("[startup] Failed to get remote stats:", error);
    return { count: -1, latestUpdatedAt: null };
  }
}

/**
 * Initialize GitMem MCP server
 *
 * Call this at server startup to pre-load the scar index.
 * Subsequent session_start calls will use the in-memory index.
 */
export async function initializeGitMem(_project?: Project): Promise<{
  success: boolean;
  scar_count: number;
  elapsed_ms: number;
  search_mode: "local" | "remote";
  error?: string;
}> {
  const startTime = Date.now();
  const config = getConfig();

  // Set TTL from config (unified cache)
  setCacheTtl(config.cacheTtlMinutes);

  // If remote mode, skip local initialization
  if (!shouldUseLocalSearch()) {
    console.error("[startup] Remote search mode, skipping local initialization");
    return {
      success: true,
      scar_count: 0,
      elapsed_ms: Date.now() - startTime,
      search_mode: "remote",
    };
  }

  // Check if Supabase is configured
  if (!isConfigured()) {
    console.warn("[startup] Supabase not configured, local search disabled");
    return {
      success: false,
      scar_count: 0,
      elapsed_ms: Date.now() - startTime,
      search_mode: "local",
      error: "Supabase not configured",
    };
  }

  try {
    // Load ALL scars from Supabase (cross-project unified cache)
    const { scars, latestUpdatedAt } = await loadScarsFromSupabase();

    // Initialize unified local vector search
    await initializeLocalSearch(scars, undefined, latestUpdatedAt || undefined);

    // Persist scars to disk for hook processes (no embeddings)
    persistScarsForHooks(scars);

    const elapsed = Date.now() - startTime;
    const scarCount = getLocalVectorSearch().getScarCount();

    console.error(`[startup] GitMem initialized: ${scarCount} scars indexed (cross-project) in ${elapsed}ms`);

    return {
      success: true,
      scar_count: scarCount,
      elapsed_ms: elapsed,
      search_mode: "local",
    };
  } catch (error) {
    const elapsed = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("[startup] GitMem initialization failed:", errorMsg);

    return {
      success: false,
      scar_count: 0,
      elapsed_ms: elapsed,
      search_mode: "local",
      error: errorMsg,
    };
  }
}

/**
 * Ensure GitMem is initialized (idempotent)
 *
 * Safe to call multiple times - only initializes once.
 */
export async function ensureInitialized(_project?: Project): Promise<void> {
  if (!shouldUseLocalSearch()) {
    return; // Remote mode, nothing to initialize
  }

  if (startupCompleted.get(UNIFIED_KEY) && isLocalSearchReady()) {
    return;
  }

  const existing = startupPromises.get(UNIFIED_KEY);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    const result = await initializeGitMem();
    startupCompleted.set(UNIFIED_KEY, result.success);
    if (!result.success) {
      console.warn(`[startup] GitMem not fully initialized: ${result.error}`);
    }
  })();

  startupPromises.set(UNIFIED_KEY, promise);
  return promise;
}

/**
 * Check if local search is available
 */
export function isLocalSearchAvailable(_project?: Project): boolean {
  if (!shouldUseLocalSearch()) {
    return false; // Remote mode
  }
  return isLocalSearchReady();
}

/**
 * Get initialization status
 */
export function getInitStatus(): {
  complete: boolean;
  search_mode: "local" | "remote";
  default_ready: boolean;
} {
  const config = getConfig();
  return {
    complete: startupCompleted.get(UNIFIED_KEY) ?? false,
    search_mode: config.resolvedSearchMode,
    default_ready: isLocalSearchReady(),
  };
}

// ============================================================================
// CACHE MANAGEMENT
// ============================================================================

export interface CacheStatus {
  search_mode: "local" | "remote";
  initialized: boolean;
  scar_count: number;
  loaded_at: string | null;
  age_minutes: number;
  ttl_minutes: number;
  is_stale: boolean;
  latest_scar_updated_at: string | null;
}

export interface CacheHealth {
  status: "healthy" | "stale" | "out_of_sync" | "unavailable";
  local_scar_count: number;
  remote_scar_count: number;
  local_latest_updated_at: string | null;
  remote_latest_updated_at: string | null;
  needs_refresh: boolean;
  details: string;
}

export interface CacheFlushResult {
  success: boolean;
  previous_scar_count: number;
  new_scar_count: number;
  elapsed_ms: number;
  error?: string;
}

/**
 * Get cache status for a project
 */
export function getCacheStatus(_project?: Project): CacheStatus {
  const config = getConfig();
  const metadata = getCacheMetadata();

  if (config.resolvedSearchMode === "remote") {
    return {
      search_mode: "remote",
      initialized: true,
      scar_count: 0,
      loaded_at: null,
      age_minutes: 0,
      ttl_minutes: config.cacheTtlMinutes,
      is_stale: false,
      latest_scar_updated_at: null,
    };
  }

  if (!metadata) {
    return {
      search_mode: "local",
      initialized: false,
      scar_count: 0,
      loaded_at: null,
      age_minutes: 0,
      ttl_minutes: config.cacheTtlMinutes,
      is_stale: true,
      latest_scar_updated_at: null,
    };
  }

  return {
    search_mode: "local",
    initialized: true,
    scar_count: metadata.scarCount,
    loaded_at: metadata.loadedAt.toISOString(),
    age_minutes: metadata.ageMinutes,
    ttl_minutes: config.cacheTtlMinutes,
    is_stale: metadata.isStale,
    latest_scar_updated_at: metadata.latestUpdatedAt,
  };
}

/**
 * Check cache health against remote Supabase
 */
export async function checkCacheHealth(_project?: Project): Promise<CacheHealth> {
  const config = getConfig();

  if (config.resolvedSearchMode === "remote") {
    return {
      status: "healthy",
      local_scar_count: 0,
      remote_scar_count: 0,
      local_latest_updated_at: null,
      remote_latest_updated_at: null,
      needs_refresh: false,
      details: "Remote search mode - no local cache to check",
    };
  }

  const metadata = getCacheMetadata();
  if (!metadata) {
    return {
      status: "unavailable",
      local_scar_count: 0,
      remote_scar_count: -1,
      local_latest_updated_at: null,
      remote_latest_updated_at: null,
      needs_refresh: true,
      details: "Local search not initialized",
    };
  }

  // Get remote stats (cross-project, matching unified cache)
  const remoteStats = await getRemoteScarStats();

  const localCount = metadata.scarCount;
  const remoteCount = remoteStats.count;
  const localLatest = metadata.latestUpdatedAt;
  const remoteLatest = remoteStats.latestUpdatedAt;

  // Determine health status
  let status: CacheHealth["status"] = "healthy";
  let needsRefresh = false;
  let details = "Cache is current";

  if (metadata.isStale) {
    status = "stale";
    needsRefresh = true;
    details = `Cache age (${metadata.ageMinutes}min) exceeds TTL (${config.cacheTtlMinutes}min)`;
  } else if (remoteCount !== localCount) {
    status = "out_of_sync";
    needsRefresh = true;
    details = `Count mismatch: local=${localCount}, remote=${remoteCount}`;
  } else if (remoteLatest && localLatest && remoteLatest !== localLatest) {
    status = "out_of_sync";
    needsRefresh = true;
    details = `Timestamp mismatch: local=${localLatest}, remote=${remoteLatest}`;
  }

  return {
    status,
    local_scar_count: localCount,
    remote_scar_count: remoteCount,
    local_latest_updated_at: localLatest,
    remote_latest_updated_at: remoteLatest,
    needs_refresh: needsRefresh,
    details,
  };
}

/**
 * Flush and reload the cache
 */
export async function flushCache(_project?: Project): Promise<CacheFlushResult> {
  const startTime = Date.now();
  const config = getConfig();

  if (config.resolvedSearchMode === "remote") {
    return {
      success: true,
      previous_scar_count: 0,
      new_scar_count: 0,
      elapsed_ms: Date.now() - startTime,
      error: "Remote search mode - no cache to flush",
    };
  }

  const previousCount = getLocalVectorSearch().getScarCount();

  try {
    // Load ALL fresh scars (cross-project)
    const { scars, latestUpdatedAt } = await loadScarsFromSupabase();

    // Reinitialize the unified index
    await reinitializeLocalSearch(scars, undefined, latestUpdatedAt || undefined);

    // Update disk cache for hook processes too
    persistScarsForHooks(scars);

    const newCount = getLocalVectorSearch().getScarCount();
    const elapsed = Date.now() - startTime;

    console.error(`[cache] Flushed and reloaded: ${previousCount} → ${newCount} scars in ${elapsed}ms`);

    return {
      success: true,
      previous_scar_count: previousCount,
      new_scar_count: newCount,
      elapsed_ms: elapsed,
    };
  } catch (error) {
    const elapsed = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("[cache] Flush failed:", errorMsg);

    return {
      success: false,
      previous_scar_count: previousCount,
      new_scar_count: previousCount,
      elapsed_ms: elapsed,
      error: errorMsg,
    };
  }
}

/**
 * Check if cache needs refresh based on TTL or staleness
 * Returns true if a refresh is recommended
 */
export async function shouldRefreshCache(_project?: Project): Promise<boolean> {
  const config = getConfig();

  if (!config.staleCheckEnabled) {
    return false;
  }

  if (config.resolvedSearchMode === "remote") {
    return false;
  }

  const metadata = getCacheMetadata();
  if (!metadata) {
    return true; // Not initialized
  }

  return metadata.isStale;
}

/**
 * Auto-refresh cache if stale (call periodically or before critical operations)
 */
export async function autoRefreshIfStale(_project?: Project): Promise<boolean> {
  const needsRefresh = await shouldRefreshCache();

  if (needsRefresh) {
    console.error("[cache] Auto-refreshing stale cache...");
    const result = await flushCache();
    return result.success;
  }

  return false; // No refresh needed
}

// ============================================================================
// BACKGROUND INITIALIZATION (non-blocking startup)
// ============================================================================

/**
 * Start background initialization of local vector search
 *
 * This allows the server to start immediately while scars load in the background.
 * First few queries will use Supabase fallback until cache is ready.
 */
export function startBackgroundInit(_project?: Project): void {
  const config = getConfig();

  if (!shouldUseLocalSearch()) {
    console.error("[startup] Remote search mode, skipping background init");
    return;
  }

  console.error("[startup] Starting background initialization (unified cross-project cache)...");

  // Initialize in background (don't await)
  initializeGitMem()
    .then((result) => {
      if (result.success) {
        console.error(`[startup] Background init complete: ${result.scar_count} scars loaded in ${result.elapsed_ms}ms`);
      } else {
        console.warn(`[startup] Background init failed: ${result.error}`);
      }
    })
    .catch((error) => {
      console.error("[startup] Background init error:", error);
    });

  // Start periodic refresh if configured
  if (config.staleCheckEnabled && config.cacheTtlMinutes > 0) {
    startPeriodicRefresh(config.cacheTtlMinutes);
  }
}

/**
 * Start periodic cache refresh
 *
 * Refreshes the unified local cache every TTL period to keep it fresh.
 */
export function startPeriodicRefresh(intervalMinutes: number): void {
  // Clear any existing interval
  if (backgroundRefreshInterval) {
    clearInterval(backgroundRefreshInterval);
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  console.error(`[startup] Starting periodic refresh every ${intervalMinutes} minutes`);

  backgroundRefreshInterval = setInterval(async () => {
    console.error("[startup] Periodic refresh triggered...");
    try {
      const result = await flushCache();
      if (result.success) {
        console.error(`[startup] Periodic refresh complete: ${result.new_scar_count} scars`);
      } else {
        console.warn(`[startup] Periodic refresh failed: ${result.error}`);
      }
    } catch (error) {
      console.error("[startup] Periodic refresh error:", error);
    }
  }, intervalMs);
}

/**
 * Stop periodic refresh (for cleanup)
 */
export function stopPeriodicRefresh(): void {
  if (backgroundRefreshInterval) {
    clearInterval(backgroundRefreshInterval);
    backgroundRefreshInterval = null;
    console.error("[startup] Periodic refresh stopped");
  }
}

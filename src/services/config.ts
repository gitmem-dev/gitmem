/**
 * GitMem Configuration Service
 *
 * Manages configuration for search mode (local vs remote),
 * cache settings, and Supabase detection.
 *
 * Environment Variables:
 * - GITMEM_SEARCH_MODE: "local" | "remote" | "auto" (default: "auto")
 * - GITMEM_CACHE_TTL_MINUTES: Minutes before cache refresh (default: 15)
 * - GITMEM_STALE_CHECK: "true" | "false" - Check for stale data (default: "true")
 * - SUPABASE_URL: Supabase project URL
 *
 * Issue: OD-473
 */

import { getTier, hasSupabase, getTablePrefix } from "./tier.js";
import type { GitMemTier } from "./tier.js";

export type SearchMode = "local" | "remote" | "auto";

export interface GitMemConfig {
  // Tier
  tier: GitMemTier;
  tablePrefix: string;

  // Search mode
  searchMode: SearchMode;
  resolvedSearchMode: "local" | "remote"; // After auto-detection

  // Cache settings
  cacheTtlMinutes: number;
  staleCheckEnabled: boolean;

  // Supabase detection
  supabaseUrl: string;
  isCloudSupabase: boolean;
  isOnPremSupabase: boolean;
}

// Private IP patterns for on-prem detection
const PRIVATE_IP_PATTERNS = [
  /^https?:\/\/localhost/,
  /^https?:\/\/127\./,
  /^https?:\/\/10\./,
  /^https?:\/\/172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/\[::1\]/,
  /^https?:\/\/\[fe80:/,
];

// Cloud Supabase pattern
const CLOUD_SUPABASE_PATTERN = /\.supabase\.co/;

/**
 * Detect if URL points to cloud Supabase
 */
function isCloudSupabaseUrl(url: string): boolean {
  return CLOUD_SUPABASE_PATTERN.test(url);
}

/**
 * Detect if URL points to on-prem/local Supabase
 */
function isOnPremSupabaseUrl(url: string): boolean {
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(url));
}

/**
 * Resolve "auto" search mode based on Supabase URL
 */
function resolveSearchMode(mode: SearchMode, supabaseUrl: string): "local" | "remote" {
  if (mode === "local") return "local";
  if (mode === "remote") return "remote";

  // Auto-detect based on URL
  if (isCloudSupabaseUrl(supabaseUrl)) {
    // Cloud Supabase = use local search to reduce API calls and latency
    return "local";
  }

  if (isOnPremSupabaseUrl(supabaseUrl)) {
    // On-prem Supabase = query directly, it's fast and always fresh
    return "remote";
  }

  // Unknown URL pattern, default to local for safety
  console.warn(`[config] Unknown Supabase URL pattern: ${supabaseUrl}, defaulting to local search`);
  return "local";
}

/**
 * Load configuration from environment
 */
export function loadConfig(): GitMemConfig {
  const tier = getTier();
  const tablePrefix = getTablePrefix();
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const searchModeEnv = (process.env.GITMEM_SEARCH_MODE || "auto").toLowerCase() as SearchMode;
  const cacheTtlMinutes = parseInt(process.env.GITMEM_CACHE_TTL_MINUTES || "15", 10);
  const staleCheckEnabled = process.env.GITMEM_STALE_CHECK !== "false";

  // Validate search mode
  const searchMode: SearchMode = ["local", "remote", "auto"].includes(searchModeEnv)
    ? searchModeEnv
    : "auto";

  // Free tier: always local, no Supabase detection needed
  const isCloud = hasSupabase() ? isCloudSupabaseUrl(supabaseUrl) : false;
  const isOnPrem = hasSupabase() ? isOnPremSupabaseUrl(supabaseUrl) : false;
  const resolvedMode = hasSupabase() ? resolveSearchMode(searchMode, supabaseUrl) : "local";

  const config: GitMemConfig = {
    tier,
    tablePrefix,
    searchMode,
    resolvedSearchMode: resolvedMode,
    cacheTtlMinutes: Math.max(1, cacheTtlMinutes),
    staleCheckEnabled,
    supabaseUrl,
    isCloudSupabase: isCloud,
    isOnPremSupabase: isOnPrem,
  };

  console.error(`[config] Tier: ${tier} | Table prefix: ${tablePrefix}`);
  console.error(`[config] Search mode: ${searchMode} → ${resolvedMode}`);
  if (hasSupabase()) {
    console.error(`[config] Supabase: ${isCloud ? "cloud" : isOnPrem ? "on-prem" : "unknown"}`);
  }
  console.error(`[config] Cache TTL: ${cacheTtlMinutes} minutes, Stale check: ${staleCheckEnabled}`);

  return config;
}

// Singleton config instance
let configInstance: GitMemConfig | null = null;

/**
 * Get the configuration (loads once, caches)
 */
export function getConfig(): GitMemConfig {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}

/**
 * Reload configuration (for testing or dynamic updates)
 */
export function reloadConfig(): GitMemConfig {
  configInstance = loadConfig();
  return configInstance;
}

/**
 * Check if local search should be used
 */
export function shouldUseLocalSearch(): boolean {
  return getConfig().resolvedSearchMode === "local";
}

/**
 * Check if remote search should be used
 */
export function shouldUseRemoteSearch(): boolean {
  return getConfig().resolvedSearchMode === "remote";
}

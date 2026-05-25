/**
 * GitMem Tier Detection and Feature Flags
 *
 * Three tiers:
 *   free — Local JSON storage, keyword search, zero config
 *   pro  — Supabase + embeddings, semantic search, cloud persistence, variants
 *   dev  — Everything in pro + compliance, transcripts, metrics
 *
 * Detection chain:
 *   1. GITMEM_TIER env var (explicit override — testing/dev)
 *   2. api_key in config.json or GITMEM_API_KEY env var:
 *      a. Check license-cache.json → if valid + not expired (72h) → return cached tier
 *      b. No cache → optimistic "pro" (validated async in runServer)
 *   3. No key + no SUPABASE_URL + no config.supabase_url → free
 *   4. No key + SUPABASE_URL set (env var) → pro (backward compat for us)
 */

import { getLicenseKey, getCachedLicenseTier, getProConfig } from "./license.js";

export type GitMemTier = "free" | "pro" | "dev";

let _tier: GitMemTier | null = null;

/**
 * Detect tier from environment variables, license key, and config
 */
function detectTier(): GitMemTier {
  // 1. Explicit override via env var (testing/dev)
  const explicit = process.env.GITMEM_TIER?.toLowerCase();
  if (explicit === "free" || explicit === "pro" || explicit === "dev") {
    return explicit;
  }

  // 2. License key present → check cache or optimistic pro
  const apiKey = getLicenseKey();
  if (apiKey) {
    // 2a. Check cached validation
    const cachedTier = getCachedLicenseTier();
    if (cachedTier === "pro" || cachedTier === "dev") {
      return cachedTier;
    }
    // 2b. Key present but no valid cache → optimistic pro
    // (validated async in runServer, downgraded if invalid)
    return "pro";
  }

  // 3. No key — check for Supabase URL (env var or config.json)
  const supabaseUrl = process.env.SUPABASE_URL || getProConfig().supabaseUrl;
  if (!supabaseUrl) return "free";

  // 4. Supabase URL set but no license key → backward compat (internal dev)
  if (process.env.GITMEM_DEV === "true" || process.env.GITMEM_DEV === "1") {
    return "dev";
  }

  return "pro";
}

/**
 * Get the current tier (cached after first call)
 */
export function getTier(): GitMemTier {
  if (!_tier) {
    _tier = detectTier();
    console.error(`[gitmem] Tier: ${_tier}`);
  }
  return _tier;
}

/**
 * Force-set tier (used by license validation on failure)
 */
export function setTier(tier: GitMemTier): void {
  _tier = tier;
  console.error(`[gitmem] Tier updated: ${tier}`);
}

/**
 * Reset tier detection (for testing)
 */
export function resetTier(): void {
  _tier = null;
}

// ============================================================================
// Feature flags
// ============================================================================

/** Whether Supabase is available for storage (pro, dev) */
export function hasSupabase(): boolean {
  return getTier() !== "free";
}

/** Whether embedding generation is available (pro, dev) */
export function hasEmbeddings(): boolean {
  return getTier() !== "free";
}

/** Whether session close compliance validation is active (dev only) */
export function hasCompliance(): boolean {
  return getTier() === "dev";
}

/** Whether scar variant A/B testing is active (pro, dev — needs Supabase for assignment storage) */
export function hasVariants(): boolean {
  return getTier() !== "free";
}

/** Whether transcript storage/retrieval is available (dev only) */
export function hasTranscripts(): boolean {
  return getTier() === "dev";
}

/** Whether batch scar usage recording is available (dev only) */
export function hasBatchOperations(): boolean {
  return getTier() === "dev";
}

/** Whether cache management tools are available (pro, dev) */
export function hasCacheManagement(): boolean {
  return getTier() !== "free";
}

/** Whether Pro-tier insights (decay tags, analytics snippets, blindspots) are active (pro, dev) */
export function hasProInsights(): boolean {
  return getTier() !== "free";
}

/** Whether detailed performance metrics recording is active (pro, dev — aligned with hasVariants) */
export function hasMetrics(): boolean {
  return getTier() !== "free";
}

/** Whether advanced agent detection (5-agent matrix) is active (dev only) */
export function hasAdvancedAgentDetection(): boolean {
  return getTier() === "dev";
}

/** Whether multi-project support is active (dev only) */
export function hasMultiProject(): boolean {
  return getTier() === "dev";
}

/** Whether LLM-cooperative enforcement fields are generated (dev only) */
export function hasEnforcementFields(): boolean {
  return getTier() === "dev";
}

/**
 * Get the table prefix for the current tier
 */
export function getTablePrefix(): string {
  // Default prefix for all tiers. Override with GITMEM_TABLE_PREFIX env var.
  return process.env.GITMEM_TABLE_PREFIX || "orchestra_";
}

/**
 * Get the fully-qualified table name for a base table name
 */
export function getTableName(baseName: string): string {
  return `${getTablePrefix()}${baseName}`;
}

/** Whether all tool aliases (gitmem-*, gm-*) should be advertised (default: false) */
export function hasFullAliases(): boolean {
  return process.env.GITMEM_FULL_ALIASES === "1" || process.env.GITMEM_FULL_ALIASES === "true";
}

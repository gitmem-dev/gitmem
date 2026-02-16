/**
 * GitMem Tier Detection and Feature Flags
 *
 * Three tiers:
 *   free — Local JSON storage, keyword search, zero config
 *   pro  — Supabase + embeddings, semantic search, cloud persistence, variants
 *   dev  — Everything in pro + compliance, transcripts, metrics
 *
 * Detection:
 *   GITMEM_TIER=free|pro|dev   (explicit override)
 *   Auto-detect: no SUPABASE_URL → free, GITMEM_DEV=1 → dev, else → pro
 */

export type GitMemTier = "free" | "pro" | "dev";

let _tier: GitMemTier | null = null;

/**
 * Detect tier from environment variables
 */
function detectTier(): GitMemTier {
  const explicit = process.env.GITMEM_TIER?.toLowerCase();
  if (explicit === "free" || explicit === "pro" || explicit === "dev") {
    return explicit;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) return "free";

  // Dev tier markers
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

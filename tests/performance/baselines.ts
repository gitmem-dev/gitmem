/**
 * Performance Baselines
 *
 * Target latencies for each component. Tests fail if measurements exceed
 * these baselines by more than the alert threshold (1.5x).
 *
 * These baselines are derived from:
 * - OD-429 performance targets
 * - 2026-02-03 regression analysis (51s decisions query)
 * - Production measurements on real projects
 */

/**
 * Component-level latency targets (milliseconds)
 */
export const BASELINES = {
  // Session start components
  decisions_cold: 500,
  decisions_cached: 10,
  wins_cold: 500,
  wins_cached: 10,
  scar_search_local: 100,
  scar_search_remote: 2000,
  session_create: 500,
  session_start_total: 750,  // OD-645: Lean start (was 1500)

  // Recall components
  recall_with_scars: 2000,
  recall_empty: 500,

  // Cache operations
  cache_populate: 1000,
  cache_hit: 5,
  cache_miss: 10,
  cache_key_generation: 1,

  // Cold start (no cache)
  cold_start_session: 3000,
  cold_start_cache_rebuild: 2000,

  // Write operations
  create_learning: 3000,
  create_decision: 3000,
  record_scar_usage: 1000,
} as const;

export type BaselineKey = keyof typeof BASELINES;

/**
 * Alert threshold multiplier
 * If measurement > baseline * ALERT_THRESHOLD, test fails
 */
export const ALERT_THRESHOLD = 1.5;

/**
 * Check if a measurement exceeds the baseline
 */
export function exceedsBaseline(key: BaselineKey, measurementMs: number): boolean {
  const baseline = BASELINES[key];
  return measurementMs > baseline * ALERT_THRESHOLD;
}

/**
 * Get baseline info for reporting
 */
export function getBaselineInfo(key: BaselineKey, measurementMs: number): {
  baseline: number;
  measurement: number;
  ratio: number;
  exceeds: boolean;
  status: "pass" | "warn" | "fail";
} {
  const baseline = BASELINES[key];
  const ratio = measurementMs / baseline;
  const exceeds = ratio > ALERT_THRESHOLD;

  let status: "pass" | "warn" | "fail";
  if (ratio <= 1.0) {
    status = "pass";
  } else if (ratio <= ALERT_THRESHOLD) {
    status = "warn";
  } else {
    status = "fail";
  }

  return {
    baseline,
    measurement: measurementMs,
    ratio,
    exceeds,
    status,
  };
}

/**
 * Format baseline comparison for logging
 */
export function formatBaselineComparison(key: BaselineKey, measurementMs: number): string {
  const info = getBaselineInfo(key, measurementMs);
  const icon = info.status === "pass" ? "✅" : info.status === "warn" ? "⚠️" : "❌";
  return `${icon} ${key}: ${info.measurement}ms / ${info.baseline}ms (${info.ratio.toFixed(2)}x)`;
}

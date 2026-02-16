/**
 * Cross-session aggregation: computes min/max/avg/median statistics
 * across all SessionReports.
 */

import type { SessionReport, AggregateReport, MetricSummary } from "./types.js";

/**
 * Build aggregate report from individual session reports.
 */
export function aggregate(
  sessions: SessionReport[],
  skippedActive: number
): AggregateReport {
  const withGitmem = sessions.filter((s) => s.ux_metrics.has_gitmem_activity);
  const withoutGitmem = sessions.filter(
    (s) => !s.ux_metrics.has_gitmem_activity
  );

  // Only compute headline metrics from sessions that have gitmem activity
  const frictionRates = withGitmem.map((s) => s.ux_metrics.zero_friction_rate);
  const relevanceRates = withGitmem.map(
    (s) => s.ux_metrics.scar_relevance_rate
  );
  const overheadPcts = withGitmem.map(
    (s) => s.ux_metrics.ceremony_overhead_pct
  );

  return {
    generated_at: new Date().toISOString(),
    total_files: sessions.length + skippedActive,
    files_with_gitmem: withGitmem.length,
    files_without_gitmem: withoutGitmem.length,
    skipped_active: skippedActive,
    headline_metrics: {
      zero_friction_rate: summarize(frictionRates),
      scar_relevance_rate: summarize(relevanceRates),
      ceremony_overhead_pct: summarize(overheadPcts),
    },
    totals: {
      recalls: sum(sessions.map((s) => s.gitmem_events.recalls)),
      confirms: sum(sessions.map((s) => s.gitmem_events.confirms_attempted)),
      scars_surfaced: sum(sessions.map((s) => s.gitmem_events.scars_surfaced)),
    },
    sessions,
  };
}

function summarize(values: number[]): MetricSummary {
  if (values.length === 0) {
    return { min: 0, max: 0, avg: 0, median: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((a, b) => a + b, 0);

  return {
    min: round2(sorted[0]),
    max: round2(sorted[sorted.length - 1]),
    avg: round2(total / sorted.length),
    median: round2(median(sorted)),
  };
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

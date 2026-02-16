/**
 * Per-session analyzer: streams a .cast file, detects gitmem events,
 * and computes UX metrics.
 */

import { streamCastFile } from "./cast-parser.js";
import { stripAnsi } from "./ansi-stripper.js";
import { detectEvents } from "./event-detectors.js";
import type {
  CastHeader,
  GitmemEvent,
  GitmemEventCounts,
  UxMetrics,
  SessionReport,
} from "./types.js";
import { basename } from "node:path";

/** Estimated seconds per gitmem ceremony interaction */
const CEREMONY_SEC_PER_RECALL = 3;
const CEREMONY_SEC_PER_CONFIRM = 2;
const CEREMONY_SEC_PER_SESSION_START = 2;

/**
 * Analyze a single .cast file and produce a SessionReport.
 */
export async function analyzeSession(filePath: string): Promise<SessionReport> {
  const fileName = basename(filePath);
  const allEvents: GitmemEvent[] = [];
  const recentEvents: GitmemEvent[] = [];

  let header: CastHeader | null = null;
  let lastTimestamp = 0;

  for await (const item of streamCastFile(filePath)) {
    if ("header" in item) {
      header = item.header;
      continue;
    }

    // Strip ANSI and match on each chunk directly.
    // Most gitmem events arrive as complete lines, so fragmentation is rare.
    const cleaned = stripAnsi(item.text);
    const events = detectEvents(cleaned, item.timestamp, recentEvents);
    allEvents.push(...events);

    lastTimestamp = item.timestamp;
  }

  if (!header) {
    throw new Error(`No header found in ${filePath}`);
  }

  const counts = computeCounts(allEvents);
  const durationMin = lastTimestamp / 60;
  const uxMetrics = computeUxMetrics(counts, allEvents, lastTimestamp);

  // Extract date from filename (YYYY-MM-DD_HH-MM-SS.cast)
  const dateMatch = fileName.match(/^(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1] : new Date(header.timestamp * 1000).toISOString().slice(0, 10);

  return {
    file: fileName,
    date,
    start_epoch: header.timestamp,
    duration_min: round2(durationMin),
    gitmem_events: counts,
    ux_metrics: uxMetrics,
  };
}

/**
 * Tally event counts from detected events.
 */
function computeCounts(events: GitmemEvent[]): GitmemEventCounts {
  const counts: GitmemEventCounts = {
    session_starts: 0,
    recalls: 0,
    scars_surfaced: 0,
    confirms_attempted: 0,
    confirms_first_try: 0,
    confirms_rejected: 0,
    scar_applying: 0,
    scar_na: 0,
    scar_refuted: 0,
    searches: 0,
    threads_listed: 0,
    threads_resolved: 0,
    threads_created: 0,
    learnings_created: 0,
    decisions_created: 0,
  };

  // Track confirm sequences: recall → (confirm_rejected)* → confirm_accepted
  let pendingRecall = false;
  let currentConfirmHadRejection = false;

  for (const e of events) {
    switch (e.type) {
      case "session_start":
      case "session_resumed":
        counts.session_starts++;
        break;
      case "recall":
        counts.recalls++;
        pendingRecall = true;
        currentConfirmHadRejection = false;
        break;
      case "scars_found":
        if (e.detail) {
          counts.scars_surfaced += parseInt(e.detail, 10);
        }
        break;
      case "confirm_accepted":
        counts.confirms_attempted++;
        if (!currentConfirmHadRejection) {
          counts.confirms_first_try++;
        }
        pendingRecall = false;
        currentConfirmHadRejection = false;
        break;
      case "confirm_rejected":
        counts.confirms_rejected++;
        counts.confirms_attempted++;
        currentConfirmHadRejection = true;
        break;
      case "scar_applying":
        counts.scar_applying++;
        break;
      case "scar_na":
        counts.scar_na++;
        break;
      case "scar_refuted":
        counts.scar_refuted++;
        break;
      case "search":
        counts.searches++;
        break;
      case "thread_resolved":
        counts.threads_resolved++;
        break;
      case "thread_created":
        counts.threads_created++;
        break;
      case "learning_created":
        counts.learnings_created++;
        break;
      case "decision_created":
        counts.decisions_created++;
        break;
      // gate, unblocked, hook_fire, tool_call — tracked in events but not separate counts
    }
  }

  return counts;
}

/**
 * Compute UX metrics from event counts and timing.
 */
function computeUxMetrics(
  counts: GitmemEventCounts,
  events: GitmemEvent[],
  totalDurationSec: number
): UxMetrics {
  const totalConfirmAttempts = counts.confirms_attempted;
  const totalScarDecisions =
    counts.scar_applying + counts.scar_na + counts.scar_refuted;

  // Zero friction rate: first-try confirms / total confirm sequences
  // A "sequence" is recall → confirm(s). first_try means first confirm was accepted.
  const confirmSequences = counts.confirms_first_try + countSequencesWithRejection(events);
  const zeroFrictionRate =
    confirmSequences > 0
      ? counts.confirms_first_try / confirmSequences
      : 0;

  // Scar relevance: APPLYING / total decisions
  const scarRelevanceRate =
    totalScarDecisions > 0 ? counts.scar_applying / totalScarDecisions : 0;

  // Ceremony overhead: estimated seconds spent on gitmem interactions
  const ceremonyOverheadSec =
    counts.session_starts * CEREMONY_SEC_PER_SESSION_START +
    counts.recalls * CEREMONY_SEC_PER_RECALL +
    totalConfirmAttempts * CEREMONY_SEC_PER_CONFIRM;

  const ceremonyOverheadPct =
    totalDurationSec > 0
      ? (ceremonyOverheadSec / totalDurationSec) * 100
      : 0;

  // Average recall-to-confirm time
  const avgRecallToConfirmSec = computeAvgRecallToConfirm(events);

  const hasGitmemActivity =
    counts.session_starts > 0 ||
    counts.recalls > 0 ||
    counts.searches > 0;

  return {
    zero_friction_rate: round2(zeroFrictionRate),
    scar_relevance_rate: round2(scarRelevanceRate),
    ceremony_overhead_sec: round2(ceremonyOverheadSec),
    ceremony_overhead_pct: round2(ceremonyOverheadPct),
    avg_recall_to_confirm_sec: round2(avgRecallToConfirmSec),
    has_gitmem_activity: hasGitmemActivity,
  };
}

/**
 * Count distinct confirm sequences that had at least one rejection.
 */
function countSequencesWithRejection(events: GitmemEvent[]): number {
  let count = 0;
  let hadRejection = false;

  for (const e of events) {
    if (e.type === "recall") {
      hadRejection = false;
    } else if (e.type === "confirm_rejected") {
      hadRejection = true;
    } else if (e.type === "confirm_accepted") {
      if (hadRejection) count++;
      hadRejection = false;
    }
  }

  return count;
}

/**
 * Compute average seconds between recall events and their next confirm.
 */
function computeAvgRecallToConfirm(events: GitmemEvent[]): number {
  const gaps: number[] = [];
  let lastRecallTimestamp: number | null = null;

  for (const e of events) {
    if (e.type === "recall") {
      lastRecallTimestamp = e.timestamp;
    } else if (
      (e.type === "confirm_accepted" || e.type === "confirm_rejected") &&
      lastRecallTimestamp !== null
    ) {
      gaps.push(e.timestamp - lastRecallTimestamp);
      lastRecallTimestamp = null;
    }
  }

  if (gaps.length === 0) return 0;
  return gaps.reduce((a, b) => a + b, 0) / gaps.length;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

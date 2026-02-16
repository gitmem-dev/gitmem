/**
 * Cast File Audit Pipeline — Type Definitions
 *
 * Interfaces for parsing asciinema .cast files, detecting gitmem events,
 * and producing UX metric reports.
 */

/** Header from asciinema v3 .cast file (first line) */
export interface CastHeader {
  version: number;
  term: {
    cols: number;
    rows: number;
    type?: string;
    theme?: Record<string, string>;
  };
  timestamp: number;
  idle_time_limit?: number;
  command?: string;
}

/** Single output event from a .cast file: [timestamp, "o", text] */
export interface CastEntry {
  timestamp: number;
  eventType: "o" | "i";
  text: string;
}

/** Types of gitmem events we detect in terminal output */
export type GitmemEventType =
  | "session_start"
  | "session_resumed"
  | "recall"
  | "scars_found"
  | "confirm_accepted"
  | "confirm_rejected"
  | "scar_applying"
  | "scar_na"
  | "scar_refuted"
  | "gate"
  | "unblocked"
  | "hook_fire"
  | "search"
  | "thread_resolved"
  | "thread_created"
  | "learning_created"
  | "decision_created"
  | "tool_call";

/** A detected gitmem event with timestamp */
export interface GitmemEvent {
  type: GitmemEventType;
  timestamp: number;
  detail?: string;
}

/** Counts of gitmem events in a session */
export interface GitmemEventCounts {
  session_starts: number;
  recalls: number;
  scars_surfaced: number;
  confirms_attempted: number;
  confirms_first_try: number;
  confirms_rejected: number;
  scar_applying: number;
  scar_na: number;
  scar_refuted: number;
  searches: number;
  threads_listed: number;
  threads_resolved: number;
  threads_created: number;
  learnings_created: number;
  decisions_created: number;
}

/** UX metrics derived from event counts and timing */
export interface UxMetrics {
  /** % of confirm_scars calls that succeeded first try */
  zero_friction_rate: number;
  /** % of surfaced scars marked APPLYING (vs N_A/REFUTED) */
  scar_relevance_rate: number;
  /** Estimated seconds spent on gitmem ceremony */
  ceremony_overhead_sec: number;
  /** ceremony_overhead_sec / total session duration */
  ceremony_overhead_pct: number;
  /** Average seconds between recall and its corresponding confirm */
  avg_recall_to_confirm_sec: number;
  /** Whether this session had any gitmem activity */
  has_gitmem_activity: boolean;
}

/** Full report for a single session */
export interface SessionReport {
  file: string;
  date: string;
  start_epoch: number;
  duration_min: number;
  gitmem_events: GitmemEventCounts;
  ux_metrics: UxMetrics;
}

/** Statistical summary for a numeric metric */
export interface MetricSummary {
  min: number;
  max: number;
  avg: number;
  median: number;
}

/** Cross-session aggregate report */
export interface AggregateReport {
  generated_at: string;
  total_files: number;
  files_with_gitmem: number;
  files_without_gitmem: number;
  skipped_active: number;
  headline_metrics: {
    zero_friction_rate: MetricSummary;
    scar_relevance_rate: MetricSummary;
    ceremony_overhead_pct: MetricSummary;
  };
  totals: {
    recalls: number;
    confirms: number;
    scars_surfaced: number;
  };
  sessions: SessionReport[];
}

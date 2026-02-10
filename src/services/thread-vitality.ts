/**
 * Thread Vitality Scoring (Phase 2) + Lifecycle State Machine (Phase 6)
 *
 * Computes vitality from recency + frequency (two of four eventual components).
 * Importance and relevance deferred to Phases 3-4 (knowledge graph + per-session embeddings).
 *
 * Formula: vitality = W_recency * recency + W_frequency * frequency
 *
 * Phase 2 weights (renormalized from 4-component to 2-component):
 *   recency:   0.55  (original 0.30 / 0.55 total)
 *   frequency: 0.45  (original 0.25 / 0.55 total)
 *
 * Recency: exponential decay based on thread_class half-life
 *   operational: 3-day half-life (short-lived tasks)
 *   backlog: 21-day half-life (long-running concerns)
 *
 * Frequency: log-scaled touch count normalized against thread age
 *   log(touch_count + 1) / log(max(days_alive, 0.01) + 1)
 *
 * Status thresholds:
 *   vitality > 0.5  → "active"
 *   0.2 <= v <= 0.5 → "cooling"
 *   vitality < 0.2  → "dormant"
 *
 * Phase 6 Lifecycle:
 *   EMERGING (< 24h old) → ACTIVE → COOLING → DORMANT → ARCHIVED (30+ days dormant)
 *   Any state → RESOLVED (explicit resolve)
 */

// ---------- Types ----------

export type ThreadClass = "operational" | "backlog";
export type VitalityStatus = "emerging" | "active" | "cooling" | "dormant";

export interface VitalityInput {
  last_touched_at: string;
  touch_count: number;
  created_at: string;
  thread_class: ThreadClass;
}

export interface VitalityResult {
  vitality_score: number;
  status: VitalityStatus;
  recency_component: number;
  frequency_component: number;
}

// Phase 6: Lifecycle state machine
export type LifecycleStatus = "emerging" | "active" | "cooling" | "dormant" | "archived";

export interface LifecycleInput extends VitalityInput {
  current_status: string;   // Current Supabase status
  dormant_since?: string;   // ISO timestamp when thread became dormant (null if not dormant)
}

// ---------- Constants ----------

const WEIGHTS = {
  recency: 0.55,
  frequency: 0.45,
} as const;

const HALF_LIVES: Record<ThreadClass, number> = {
  operational: 3,
  backlog: 21,
};

const STATUS_THRESHOLDS = {
  active: 0.5,
  cooling: 0.2,
} as const;

// Phase 6 lifecycle constants
export const EMERGING_WINDOW_HOURS = 24;
export const ARCHIVAL_DORMANT_DAYS = 30;

const OPERATIONAL_KEYWORDS = [
  "deploy", "fix", "debug", "hotfix", "urgent", "broken",
  "failing", "revert", "rollback", "incident", "outage",
  "blocker", "unblock", "investigate",
];

// ---------- Core Computation ----------

export function computeVitality(input: VitalityInput, now?: Date): VitalityResult {
  const currentTime = now || new Date();

  const recency = computeRecency(
    input.last_touched_at,
    input.thread_class,
    currentTime
  );

  const frequency = computeFrequency(
    input.touch_count,
    input.created_at,
    currentTime
  );

  const vitality_score = clamp(
    WEIGHTS.recency * recency + WEIGHTS.frequency * frequency,
    0,
    1
  );

  const status = vitalityToStatus(vitality_score);

  return {
    vitality_score: round(vitality_score, 4),
    status,
    recency_component: round(recency, 4),
    frequency_component: round(frequency, 4),
  };
}

// ---------- Lifecycle State Machine (Phase 6) ----------

/**
 * Compute the full lifecycle status for a thread.
 * Wraps vitality scoring with age-based emerging window and archival logic.
 *
 * State machine:
 *   EMERGING (< 24h) → ACTIVE → COOLING → DORMANT → ARCHIVED (30+ days dormant)
 *   Any state → RESOLVED (handled externally by resolve_thread)
 */
export function computeLifecycleStatus(
  input: LifecycleInput,
  now?: Date
): { lifecycle_status: LifecycleStatus; vitality: VitalityResult } {
  const currentTime = now || new Date();

  // Terminal states: archived and resolved stay as-is
  if (input.current_status === "archived" || input.current_status === "resolved") {
    const vitality = computeVitality(input, currentTime);
    return {
      lifecycle_status: input.current_status as LifecycleStatus,
      vitality,
    };
  }

  // Emerging window: threads < 24h old
  const created = new Date(input.created_at);
  const hoursAlive = (currentTime.getTime() - created.getTime()) / (1000 * 60 * 60);
  if (hoursAlive < EMERGING_WINDOW_HOURS) {
    const vitality = computeVitality(input, currentTime);
    return { lifecycle_status: "emerging", vitality };
  }

  // Compute vitality for normal lifecycle
  const vitality = computeVitality(input, currentTime);

  // Archival: dormant for 30+ days
  if (
    input.current_status === "dormant" &&
    input.dormant_since
  ) {
    const dormantStart = new Date(input.dormant_since);
    const daysDormant = (currentTime.getTime() - dormantStart.getTime()) / (1000 * 60 * 60 * 24);
    if (daysDormant >= ARCHIVAL_DORMANT_DAYS) {
      return { lifecycle_status: "archived", vitality };
    }
  }

  // Normal vitality-derived status (active/cooling/dormant)
  return { lifecycle_status: vitality.status as LifecycleStatus, vitality };
}

// ---------- Components ----------

function computeRecency(
  lastTouchedAt: string,
  threadClass: ThreadClass,
  now: Date
): number {
  const lastTouched = new Date(lastTouchedAt);
  const daysSinceTouch = Math.max(
    (now.getTime() - lastTouched.getTime()) / (1000 * 60 * 60 * 24),
    0
  );

  const halfLife = HALF_LIVES[threadClass] || HALF_LIVES.backlog;

  // Exponential decay: e^(-ln(2) * t / halfLife)
  return Math.exp(-Math.LN2 * daysSinceTouch / halfLife);
}

function computeFrequency(
  touchCount: number,
  createdAt: string,
  now: Date
): number {
  const created = new Date(createdAt);
  const daysAlive = Math.max(
    (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24),
    0.01
  );

  // log(touchCount + 1) / log(daysAlive + 1), capped at 1.0
  return Math.min(
    Math.log(touchCount + 1) / Math.log(daysAlive + 1),
    1.0
  );
}

// ---------- Status Mapping ----------

export function vitalityToStatus(score: number): VitalityStatus {
  if (score > STATUS_THRESHOLDS.active) return "active";
  if (score >= STATUS_THRESHOLDS.cooling) return "cooling";
  return "dormant";
}

// ---------- Thread Class Detection ----------

export function detectThreadClass(text: string): ThreadClass {
  const lower = text.toLowerCase();
  for (const keyword of OPERATIONAL_KEYWORDS) {
    if (lower.includes(keyword)) return "operational";
  }
  return "backlog";
}

// ---------- Helpers ----------

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

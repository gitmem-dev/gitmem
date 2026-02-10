/**
 * Thread Vitality Scoring (Phase 2)
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
 */

// ---------- Types ----------

export type ThreadClass = "operational" | "backlog";
export type VitalityStatus = "active" | "cooling" | "dormant";

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

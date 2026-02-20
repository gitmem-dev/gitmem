/**
 * Nudge Variant Support
 *
 * Reads GITMEM_NUDGE_VARIANT env var to select alternative header
 * framings for recall/prepare-context output. Used by nudge-bench
 * to A/B test how different wording affects agent compliance.
 *
 * When no env var is set, returns the production default.
 *
 * Variant IDs match nudge-bench/variants/n001-header.ts
 */

export interface NudgeHeader {
  icon: string;
  text: (count: number) => string;
}

const VARIANTS: Record<string, NudgeHeader> = {
  // Production default
  "n001-a-institutional": {
    icon: "🧠",
    text: (n) => `INSTITUTIONAL MEMORY ACTIVATED\n\nFound ${n} relevant scar${n === 1 ? "" : "s"} for your plan:`,
  },
  // Informational/passive
  "n001-b-recalled": {
    icon: "\x1b[38;5;37m⬢\x1b[0m",
    text: (n) => `gitmem ── ${n} learnings recalled`,
  },
  // Obligation
  "n001-c-review": {
    icon: "\x1b[38;5;37m⬢\x1b[0m",
    text: (n) => `gitmem ── ${n} scar${n === 1 ? "" : "s"} to review`,
  },
  // Directive
  "n001-d-directive": {
    icon: "\x1b[38;5;37m⬢\x1b[0m",
    text: (n) => `gitmem ── review ${n} learning${n === 1 ? "" : "s"} before proceeding`,
  },
  // Procedural — ties to confirm_scars
  "n001-e-confirm": {
    icon: "\x1b[38;5;37m⬢\x1b[0m",
    text: (n) => `gitmem ── ${n} scar${n === 1 ? "" : "s"} found — confirm before acting`,
  },
  // Reasoning — explains WHY (Karpathy: reasoning > command)
  "n001-f-reasoning": {
    icon: "\x1b[38;5;37m⬢\x1b[0m",
    text: (n) => `gitmem ── ${n} past mistake${n === 1 ? "" : "s"} detected that may repeat here — review to avoid the same outcome`,
  },
};

const DEFAULT_VARIANT = "n001-c-review";

/**
 * Get the active nudge header based on GITMEM_NUDGE_VARIANT env var.
 * Falls back to production default if unset or invalid.
 */
export function getNudgeHeader(): NudgeHeader {
  const variantId = process.env.GITMEM_NUDGE_VARIANT;
  if (!variantId) return VARIANTS[DEFAULT_VARIANT];
  return VARIANTS[variantId] || VARIANTS[DEFAULT_VARIANT];
}

/**
 * Format the recall header line using the active nudge variant.
 */
export function formatNudgeHeader(scarCount: number): string {
  const header = getNudgeHeader();
  return `${header.icon} ${header.text(scarCount)}`;
}

/**
 * Get the active variant ID (for logging/metrics).
 */
export function getActiveVariantId(): string {
  const variantId = process.env.GITMEM_NUDGE_VARIANT;
  if (variantId && VARIANTS[variantId]) return variantId;
  return DEFAULT_VARIANT;
}

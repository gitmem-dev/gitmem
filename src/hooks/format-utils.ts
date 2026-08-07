/**
 * Shared formatting utilities for scar display.
 *
 * Used by:
 *   - prepare-context.ts (MCP tool for sub-agent injection)
 *   - quick-retrieve.ts  (hook-invoked retrieval for auto-inject)
 */

import { CITATION_LINE } from "../services/display-protocol.js";

// --- Types ---

export interface FormattableScar {
  id: string;
  title: string;
  description: string;
  severity: string;
  counter_arguments?: string[];
  similarity?: number;
  source_linear_issue?: string;
  required_verification?: {
    when: string;
    queries: string[];
    must_show: string;
    blocking?: boolean;
  };
  why_this_matters?: string;
  action_protocol?: string[];
  self_check_criteria?: string[];
}

// --- Severity Constants ---

/** Text severity indicators — no emoji (column width is unpredictable across terminals) */
export const SEVERITY_EMOJI: Record<string, string> = {
  critical: "[!!]",
  high: "[!]",
  medium: "[~]",
  low: "[-]",
};

export const SEVERITY_LABEL: Record<string, string> = {
  critical: "CRITICAL",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
};

export const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// --- Token Estimation ---

/**
 * Estimate tokens from a string.
 * Rough heuristic: ~4 characters per token for English text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// --- Formatters ---

/**
 * Format scars in compact mode.
 * One line per scar: emoji LABEL: Title — first sentence of description.
 * Sorted by severity (critical first). Truncated to token budget.
 */
export function formatCompact(
  scars: FormattableScar[],
  plan: string,
  maxTokens: number
): { payload: string; included: number } {
  const sorted = [...scars].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3)
  );

  const header = `[INSTITUTIONAL MEMORY \u2014 ${sorted.length} scars for: "${plan.slice(0, 60)}"]`;
  const lines: string[] = [header];
  let included = 0;

  for (const scar of sorted) {
    const emoji = SEVERITY_EMOJI[scar.severity] || "[?]";
    const label = SEVERITY_LABEL[scar.severity] || "UNKNOWN";
    const firstSentence = scar.description.split(/\.\s/)[0].slice(0, 120);
    // GIT-74/R14: the id travels with the scar. An instruction ships only on
    // surfaces that render the capability to obey it \u2014 this line asks the
    // sub-agent to cite record IDs, so the record ID has to be on it. ~3 tokens.
    const line = `${emoji} ${label}: ${scar.title} \u2014 ${firstSentence}  id:${scar.id.slice(0, 8)}`;

    // Check token budget before adding (always include at least one)
    const candidate = [...lines, line].join("\n");
    if (estimateTokens(candidate) > maxTokens && included > 0) {
      break;
    }

    lines.push(line);
    included++;
  }

  // Citation reminder for sub-agent context (compact — one line).
  // GIT-74/R14: this was the fourth un-unified literal. R12 unified recall,
  // search and prepare_context and left this one behind, so the drift it fixed
  // could reopen here. One constant, four surfaces.
  if (included > 0) {
    lines.push(CITATION_LINE);
  }

  return { payload: lines.join("\n"), included };
}

/**
 * Format scars in gate mode.
 * Only blocking scars (required_verification.blocking === true).
 * Returns PASS if none found.
 */
export function formatGate(scars: FormattableScar[]): { payload: string; blocking: number } {
  const blockingScars = scars.filter(
    (s) => s.required_verification?.blocking === true
  );

  if (blockingScars.length === 0) {
    return {
      payload: "[MEMORY GATE: PASS \u2014 no blocking scars]",
      blocking: 0,
    };
  }

  const lines: string[] = [
    `[MEMORY GATE: ${blockingScars.length} blocking scar${blockingScars.length === 1 ? "" : "s"}]`,
  ];

  for (const scar of blockingScars) {
    const rv = scar.required_verification!;
    lines.push(`[!!] BLOCK: ${rv.when}`);
    if (rv.queries && rv.queries.length > 0) {
      for (const query of rv.queries) {
        lines.push(`  RUN: ${query}`);
      }
    }
    lines.push(`MUST SHOW: ${rv.must_show}`);
  }

  return { payload: lines.join("\n"), blocking: blockingScars.length };
}

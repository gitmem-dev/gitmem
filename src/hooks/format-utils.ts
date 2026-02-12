/**
 * Shared formatting utilities for scar display.
 *
 * Used by:
 *   - prepare-context.ts (MCP tool for sub-agent injection)
 *   - quick-retrieve.ts  (hook-invoked retrieval for auto-inject)
 */

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

export const SEVERITY_EMOJI: Record<string, string> = {
  critical: "\uD83D\uDD34",
  high: "\uD83D\uDFE0",
  medium: "\uD83D\uDFE1",
  low: "\uD83D\uDFE2",
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
    const emoji = SEVERITY_EMOJI[scar.severity] || "\u26AA";
    const label = SEVERITY_LABEL[scar.severity] || "UNKNOWN";
    const firstSentence = scar.description.split(/\.\s/)[0].slice(0, 120);
    const line = `${emoji} ${label}: ${scar.title} \u2014 ${firstSentence}`;

    // Check token budget before adding (always include at least one)
    const candidate = [...lines, line].join("\n");
    if (estimateTokens(candidate) > maxTokens && included > 0) {
      break;
    }

    lines.push(line);
    included++;
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
    lines.push(`\uD83D\uDEA8 BLOCK: ${rv.when}`);
    if (rv.queries && rv.queries.length > 0) {
      for (const query of rv.queries) {
        lines.push(`  RUN: ${query}`);
      }
    }
    lines.push(`MUST SHOW: ${rv.must_show}`);
  }

  return { payload: lines.join("\n"), blocking: blockingScars.length };
}

/**
 * Display Protocol Utilities
 *
 * Shared helpers for deterministic MCP tool output formatting.
 * All gitmem tools use the `display` field pattern so the LLM
 * echoes pre-formatted output verbatim instead of reformatting JSON.
 *
 * Zero dependencies on other gitmem internals — keep this lightweight.
 */

const DISPLAY_SUFFIX =
  "\n───────────────────────────────────────────────────\n" +
  "DISPLAY PROTOCOL: Echo the content above as your complete response.\n" +
  "Do not add preamble, commentary, or reformat. Output it exactly as-is.";

/**
 * Wrap formatted content with the display protocol suffix.
 */
export function wrapDisplay(content: string): string {
  return content + DISPLAY_SUFFIX;
}

/**
 * Format a relative time string from a date.
 * "2m ago", "3h ago", "5d ago", "2w ago"
 */
export function relativeTime(date: string | Date): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  if (isNaN(then)) return "—";
  const diff = now - then;
  const min = Math.floor(diff / 60000);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  const wk = Math.floor(day / 7);
  if (min < 1) return "now";
  if (min < 60) return `${min}m ago`;
  if (hr < 24) return `${hr}h ago`;
  if (day < 7) return `${day}d ago`;
  if (wk < 52) return `${wk}w ago`;
  return `${Math.floor(day / 365)}y ago`;
}

/**
 * Truncate a string with ellipsis.
 */
export function truncate(str: string, max: number): string {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

/** Severity emoji */
export const SEV: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🟢",
};

/** Learning type emoji */
export const TYPE: Record<string, string> = {
  scar: "⚡",
  win: "🏆",
  pattern: "🔄",
  anti_pattern: "⛔",
};

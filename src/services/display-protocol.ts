/**
 * Display Protocol Utilities
 *
 * Shared helpers for deterministic MCP tool output formatting.
 * All gitmem tools use the `display` field pattern so the LLM
 * echoes pre-formatted output verbatim instead of reformatting JSON.
 *
 * Design system: docs/cli-ux-guidelines.md
 *
 * Zero dependencies on other gitmem internals — keep this lightweight.
 */

// ---------------------------------------------------------------------------
// ANSI color palette — see docs/cli-ux-guidelines.md § Color System
//
// Three semantic colors (red/yellow/green) + two weights (bold/dim).
// NO_COLOR / GITMEM_NO_COLOR / non-TTY disables all ANSI output.
// ---------------------------------------------------------------------------

function useColor(): boolean {
  if (typeof process !== "undefined") {
    if (process.env.NO_COLOR !== undefined) return false;
    if (process.env.GITMEM_NO_COLOR !== undefined) return false;
  }
  return true;
}

const _color = useColor();

/** ANSI escape codes — resolve to empty strings when color is disabled. */
export const ANSI = {
  red:   _color ? "\x1b[31m" : "",   // brand accent (Racing Red)
  yellow: _color ? "\x1b[33m" : "",  // warning / attention
  green: _color ? "\x1b[32m" : "",   // success / positive
  bold:  _color ? "\x1b[1m" : "",    // section headers, emphasis
  dim:   _color ? "\x1b[2m" : "",    // metadata, timestamps, IDs
  reset: _color ? "\x1b[0m" : "",    // always pair with color/weight
} as const;

const { red, yellow, green, bold, dim, reset } = ANSI;

// ---------------------------------------------------------------------------
// Display protocol suffix
// ---------------------------------------------------------------------------

const DISPLAY_SUFFIX =
  "\n───────────────────────────────────────────────────\n" +
  "DISPLAY PROTOCOL: Output the content above verbatim as your response text.\n" +
  "Tool results are collapsed in the CLI — the user cannot see them unless you echo them.\n" +
  "Success: You echoed the content exactly as formatted above.";

/**
 * Wrap formatted content with the display protocol suffix.
 *
 * NOTE: When the PostToolUse display hook is active, this suffix is stripped
 * and the display is routed directly to the terminal. The suffix remains as
 * a fallback for environments without the hook (e.g. Brain Cloud, DAC).
 */
export function wrapDisplay(content: string): string {
  return content + DISPLAY_SUFFIX;
}

// ---------------------------------------------------------------------------
// Brand mark — ripple icon preceding product name
// ---------------------------------------------------------------------------

/** Ripple mark: dim outer ring, red inner ring, bold center dot. */
export const RIPPLE = `${dim}(${reset}${red}(${reset}${bold}●${reset}${red})${reset}${dim})${reset}`;

// ---------------------------------------------------------------------------
// Product line — first line of every tool output
// ---------------------------------------------------------------------------

/**
 * Build the product line: `((●)) gitmem ── <tool> [· detail]`
 * The ripple mark + red "gitmem" form the brand identity.
 */
export function productLine(tool: string, detail?: string): string {
  let line = `${RIPPLE} ${red}gitmem${reset} ── ${tool}`;
  if (detail) line += ` · ${detail}`;
  return line;
}

// ---------------------------------------------------------------------------
// Severity indicators — text brackets, colored by urgency
// ---------------------------------------------------------------------------

/** Severity text indicators with ANSI color */
export const SEV: Record<string, string> = {
  critical: `${red}[!!]${reset}`,
  high:     `${yellow}[!]${reset}`,
  medium:   `[~]`,
  low:      `${dim}[-]${reset}`,
};

/** Severity indicator without color (for non-display contexts) */
export const SEV_PLAIN: Record<string, string> = {
  critical: "[!!]",
  high:     "[!]",
  medium:   "[~]",
  low:      "[-]",
};

// ---------------------------------------------------------------------------
// Learning type labels — colored by semantic meaning
// ---------------------------------------------------------------------------

/** Learning type labels with ANSI color */
export const TYPE: Record<string, string> = {
  scar:         "scar",
  win:          `${green}win${reset}`,
  pattern:      "pat",
  anti_pattern: `${yellow}anti${reset}`,
  decision:     "dec",
};

/** Type labels without color */
export const TYPE_PLAIN: Record<string, string> = {
  scar:         "scar",
  win:          "win",
  pattern:      "pat",
  anti_pattern: "anti",
  decision:     "dec",
};

// ---------------------------------------------------------------------------
// Status indicators
// ---------------------------------------------------------------------------

/** Colored status words */
export const STATUS = {
  ok:       `${green}ok${reset}`,
  fail:     `${red}FAIL${reset}`,
  warn:     `${yellow}WARN${reset}`,
  rejected: `${red}REJECTED${reset}`,
  complete: `${green}COMPLETE${reset}`,
  failed:   `${red}FAILED${reset}`,
  pass:     `${green}+${reset}`,
  miss:     `${red}-${reset}`,
} as const;

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

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

/**
 * Wrap text with dim ANSI (convenience helper).
 */
export function dimText(str: string): string {
  return `${dim}${str}${reset}`;
}

/**
 * Wrap text with bold ANSI (convenience helper).
 */
export function boldText(str: string): string {
  return `${bold}${str}${reset}`;
}

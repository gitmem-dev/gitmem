/**
 * ANSI escape code removal for terminal output.
 * Patterns ported from parse_cast.js with additional coverage.
 */

// CSI sequences: ESC [ ... final_byte (covers colors, cursor movement, etc.)
const CSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

// OSC sequences: ESC ] ... (terminated by BEL or ST)
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// Character set designators: ESC ( x, ESC ) x, etc.
const CHARSET_RE = /\x1b[()#][A-Za-z0-9]/g;

// Other 2-char ESC sequences (ESC followed by a single char, excluding [ and ])
const ESC_RE = /\x1b[^\x5b\x5d(#)]/g;

// Carriage returns
const CR_RE = /\r/g;

// Common spinner characters used by CLI tools
const SPINNER_CHARS = new Set(["\u2722", "\u2736", "\u273B", "\u273D", "\u00B7", "*"]);

// Decoration-only lines (box drawing, horizontal rules)
const DECORATION_RE = /^[…╌─═\-]+$/;

// Block drawing character lines
const BLOCK_RE = /^[█▓░▄\s]+$/;

/**
 * Strip all ANSI escape codes from terminal text.
 */
export function stripAnsi(str: string): string {
  str = str.replace(CSI_RE, "");
  str = str.replace(OSC_RE, "");
  str = str.replace(CHARSET_RE, "");
  str = str.replace(ESC_RE, "");
  str = str.replace(CR_RE, "");
  return str;
}

/**
 * Clean a line of terminal output — strip ANSI and check if it's noise.
 * Returns null if the line should be skipped.
 */
export function cleanLine(line: string): string | null {
  const cleaned = stripAnsi(line);
  const trimmed = cleaned.trim();

  if (trimmed === "") return null;
  if (SPINNER_CHARS.has(trimmed)) return null;
  if (DECORATION_RE.test(trimmed)) return null;
  if (BLOCK_RE.test(trimmed)) return null;
  if (/^\s+$/.test(cleaned)) return null;

  return cleaned;
}

/**
 * Regex-based detection of gitmem events in cleaned terminal output.
 *
 * All patterns match against ANSI-stripped terminal text, not MCP JSON.
 * Uses a rolling text buffer to handle fragmented terminal output.
 */

import type { GitmemEvent, GitmemEventType } from "./types.js";

interface DetectorPattern {
  type: GitmemEventType;
  regex: RegExp;
  extractDetail?: (match: RegExpMatchArray) => string;
  /** If true, skip dedup — allows multiple events of same type in rapid succession */
  noDedupe?: boolean;
}

// Note: \s* instead of \s+ throughout because the Claude CLI renderer
// collapses spaces when overwriting terminal positions after ANSI strip.
// E.g., "INSTITUTIONAL MEMORY ACTIVATED" → "INSTITUTIONALMEMORYACTIVATED"

const PATTERNS: DetectorPattern[] = [
  // Tool calls (general)
  {
    type: "tool_call",
    regex: /gitmem\s*[-–—]\s*(\w+)\s*\(MCP\)/i,
    extractDetail: (m) => m[1],
  },
  // Session active (from session_start)
  {
    type: "session_start",
    regex: /gitmem\s*(?:──|—|[-–])\s*active/i,
  },
  // Session resumed
  {
    type: "session_resumed",
    regex: /gitmem\s*(?:──|—|[-–])\s*resumed/i,
  },
  // Recall result
  {
    type: "recall",
    regex: /INSTITUTIONAL\s*MEMORY\s*ACTIVATED/i,
  },
  // Scars found count
  {
    type: "scars_found",
    regex: /Found\s*(\d+)\s*relevant\s*scars?/i,
    extractDetail: (m) => m[1],
  },
  // Confirm accepted
  {
    type: "confirm_accepted",
    regex: /SCAR\s*CONFIRMATIONS?\s*ACCEPTED/i,
  },
  // Confirm rejected
  {
    type: "confirm_rejected",
    regex: /SCAR\s*CONFIRMATIONS?\s*REJECTED/i,
  },
  // Individual scar decisions — noDedupe because multiple scars appear in quick succession
  {
    type: "scar_applying",
    regex: /→\s*APPLYING/,
    noDedupe: true,
  },
  {
    type: "scar_na",
    regex: /→\s*N_A/,
    noDedupe: true,
  },
  {
    type: "scar_refuted",
    regex: /→\s*REFUTED/,
    noDedupe: true,
  },
  // Gate (acknowledge prompt)
  {
    type: "gate",
    regex: /Acknowledge\s*these\s*lessons/i,
  },
  // Unblocked after confirm
  {
    type: "unblocked",
    regex: /Consequential\s*actions.*unblocked/i,
  },
  // Hook fire
  {
    type: "hook_fire",
    regex: /SessionStart:(?:compact|clear)\s*hook/i,
  },
  // Search
  {
    type: "search",
    regex: /gitmem\s*(?:──|—|[-–])\s*search/i,
  },
  // Thread operations
  {
    type: "thread_resolved",
    regex: /Thread\s*resolved/i,
  },
  {
    type: "thread_created",
    regex: /Thread\s*created/i,
  },
  // Learning/decision creation
  {
    type: "learning_created",
    regex: /(?:Scar|Win|Pattern|Learning)\s*created/i,
  },
  {
    type: "decision_created",
    regex: /Decision\s*(?:created|logged)/i,
  },
];

/** Minimum time gap (seconds) between duplicate events of the same type */
const DEDUP_WINDOW_SEC = 2.0;

/**
 * Detect gitmem events in a chunk of cleaned terminal text.
 * Returns all matched events with timestamps.
 *
 * @param text - ANSI-stripped terminal text
 * @param timestamp - The cast entry timestamp for this text
 * @param recentEvents - Recent events for dedup (modified in-place)
 */
export function detectEvents(
  text: string,
  timestamp: number,
  recentEvents: GitmemEvent[]
): GitmemEvent[] {
  const found: GitmemEvent[] = [];

  for (const pattern of PATTERNS) {
    const match = text.match(pattern.regex);
    if (!match) continue;

    // Dedup: skip if same event type within window (unless noDedupe)
    if (!pattern.noDedupe) {
      const isDuplicate = recentEvents.some(
        (e) =>
          e.type === pattern.type &&
          Math.abs(e.timestamp - timestamp) < DEDUP_WINDOW_SEC
      );
      if (isDuplicate) continue;
    }

    const event: GitmemEvent = {
      type: pattern.type,
      timestamp,
      detail: pattern.extractDetail?.(match),
    };

    found.push(event);
    recentEvents.push(event);
  }

  // Trim recentEvents to keep only last 30 seconds
  while (
    recentEvents.length > 0 &&
    timestamp - recentEvents[0].timestamp > 30
  ) {
    recentEvents.shift();
  }

  return found;
}

/**
 * Rolling text buffer that accumulates cleaned text for pattern matching.
 * Prevents missing events split across multiple terminal output chunks.
 */
export class TextBuffer {
  private buffer = "";
  private readonly maxSize: number;

  constructor(maxSize = 2048) {
    this.maxSize = maxSize;
  }

  /**
   * Add text to the buffer.
   */
  append(text: string): string {
    this.buffer += text;
    // Keep only the tail if buffer exceeds max size
    if (this.buffer.length > this.maxSize) {
      this.buffer = this.buffer.slice(-this.maxSize);
    }
    return this.buffer;
  }

  /**
   * Get text for pattern matching: the new chunk plus a small overlap
   * from previous text (to catch patterns split across chunks).
   */
  getMatchText(newChunkLength: number): string {
    const overlap = 128;
    const start = Math.max(0, this.buffer.length - newChunkLength - overlap);
    return this.buffer.slice(start);
  }

  /**
   * Clear the buffer after events are detected.
   */
  consume(keepLast = 64): void {
    if (this.buffer.length > keepLast) {
      this.buffer = this.buffer.slice(-keepLast);
    }
  }
}

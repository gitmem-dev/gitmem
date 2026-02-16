/**
 * Streaming parser for asciinema v3 .cast files.
 * Uses readline for constant-memory processing of large files.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { CastHeader, CastEntry } from "./types.js";

/**
 * Parse the header (first line) of a .cast file.
 */
export function parseCastHeader(line: string): CastHeader {
  const parsed = JSON.parse(line);
  if (parsed.version !== 3 && parsed.version !== 2) {
    throw new Error(`Unsupported cast version: ${parsed.version}`);
  }
  return parsed as CastHeader;
}

/**
 * Parse a single data line: [timestamp, "o"|"i", "text"]
 */
export function parseCastEntry(line: string): CastEntry | null {
  try {
    const arr = JSON.parse(line);
    if (!Array.isArray(arr) || arr.length < 3) return null;
    return {
      timestamp: arr[0],
      eventType: arr[1],
      text: arr[2],
    };
  } catch {
    return null;
  }
}

/**
 * Stream a .cast file, yielding header then entries.
 * Constant memory — never loads the full file.
 *
 * Handles v3 delta timestamps: accumulates them into cumulative timestamps.
 * Also handles v2 cumulative timestamps (passed through as-is).
 */
export async function* streamCastFile(
  filePath: string
): AsyncGenerator<{ header: CastHeader } | CastEntry> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let isHeader = true;
  let cumulativeTime = 0;
  let isV3 = false;

  for await (const line of rl) {
    if (!line.trim()) continue;

    if (isHeader) {
      isHeader = false;
      const header = parseCastHeader(line);
      isV3 = header.version === 3;
      yield { header };
      continue;
    }

    const entry = parseCastEntry(line);
    if (entry && entry.eventType === "o") {
      if (isV3) {
        // v3: timestamps are deltas, accumulate them
        cumulativeTime += entry.timestamp;
        yield { ...entry, timestamp: cumulativeTime };
      } else {
        yield entry;
      }
    }
  }
}

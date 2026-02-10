/**
 * Thread Lifecycle Manager (OD-thread-lifecycle)
 *
 * Core logic for thread lifecycle management:
 * - ID generation, migration from plain strings to ThreadObject
 * - Aggregation across sessions (replaces aggregateOpenThreads)
 * - Resolution by ID or text match
 * - Local file persistence (.gitmem/threads.json)
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { ThreadObject, ThreadStatus } from "../types/index.js";
import { normalizeText } from "./thread-dedup.js";

// ---------- ID Generation ----------

/**
 * Generate a thread ID: "t-" + 8 hex chars
 */
export function generateThreadId(): string {
  return "t-" + crypto.randomBytes(4).toString("hex");
}

// ---------- Migration ----------

/**
 * Migrate a plain string thread to a ThreadObject.
 */
export function migrateStringThread(text: string, sourceSession?: string): ThreadObject {
  return {
    id: generateThreadId(),
    text,
    status: "open",
    created_at: new Date().toISOString(),
    ...(sourceSession && { source_session: sourceSession }),
  };
}

/**
 * Normalize a mixed array of strings and ThreadObjects into ThreadObject[].
 * Handles backward compatibility with existing plain string threads.
 */
export function normalizeThreads(
  raw: (string | ThreadObject)[],
  sourceSession?: string
): ThreadObject[] {
  return raw.map((item) => {
    if (typeof item === "string") {
      // Try to parse JSON thread objects (some sessions store {item, context} or full ThreadObject)
      if (item.startsWith("{")) {
        try {
          const parsed = JSON.parse(item);
          // If it looks like a ThreadObject already, use it
          if (parsed.id && parsed.text && parsed.status) {
            return parsed as ThreadObject;
          }
          // Handle {id, status, note} format — "note" is an alias for "text"
          // This format appears when threads carry forward between sessions
          if (parsed.id && parsed.note && parsed.status) {
            return {
              id: parsed.id,
              text: parsed.note,
              status: parsed.status,
              created_at: parsed.created_at || new Date().toISOString(),
              ...(sourceSession && { source_session: sourceSession }),
              ...(parsed.resolved_at && { resolved_at: parsed.resolved_at }),
            } as ThreadObject;
          }
          // Legacy format: {item, context} or {text, status} without id
          return migrateStringThread(parsed.item || parsed.text || parsed.note || item, sourceSession);
        } catch {
          // Not valid JSON, treat as plain text
        }
      }
      return migrateStringThread(item, sourceSession);
    }
    // Already a ThreadObject — but validate and repair common field issues
    const obj = item as unknown as Record<string, unknown>;

    // Fix objects with "note" instead of "text" (agent writes {id, status, note})
    if (!obj.text && obj.note && typeof obj.note === "string") {
      return {
        ...item,
        text: obj.note as string,
      } as ThreadObject;
    }

    // Fix objects where "text" is a JSON string containing a thread
    if (typeof obj.text === "string" && (obj.text as string).startsWith("{")) {
      try {
        const inner = JSON.parse(obj.text as string);
        if (inner.id && (inner.text || inner.note)) {
          return {
            id: inner.id,
            text: inner.text || inner.note,
            status: inner.status || item.status,
            created_at: inner.created_at || item.created_at || new Date().toISOString(),
            ...(sourceSession && { source_session: sourceSession }),
            ...(inner.resolved_at && { resolved_at: inner.resolved_at }),
          } as ThreadObject;
        }
      } catch {
        // Not valid JSON in text field, keep as-is
      }
    }

    return item;
  });
}

// ---------- Aggregation ----------

interface SessionRecord {
  id: string;
  session_date: string;
  open_threads?: (string | ThreadObject)[];
  close_compliance?: Record<string, unknown> | null;
}

interface AggregateResult {
  open: ThreadObject[];
  recently_resolved: ThreadObject[];
}

/**
 * Aggregate threads across recent closed sessions.
 * Replaces the old aggregateOpenThreads() function.
 *
 * Returns:
 * - open: deduplicated open threads
 * - recently_resolved: threads resolved in the most recent session
 */
export function aggregateThreads(
  sessions: SessionRecord[],
  maxSessions = 5,
  maxAgeDays = 14
): AggregateResult {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
  const cutoffStr = cutoffDate.toISOString().split("T")[0];

  const closedSessions = sessions
    .filter((s) => s.close_compliance != null && s.session_date >= cutoffStr)
    .slice(0, maxSessions);

  const seenText = new Set<string>();
  const seenIds = new Set<string>();
  const open: ThreadObject[] = [];
  const recentlyResolved: ThreadObject[] = [];

  for (const session of closedSessions) {
    const rawThreads = session.open_threads || [];
    const normalized = normalizeThreads(
      rawThreads as (string | ThreadObject)[],
      session.id
    );

    for (const thread of normalized) {
      // Skip PROJECT STATE threads (handled separately via OD-534)
      if (thread.text.startsWith("PROJECT STATE:")) continue;

      // Deduplicate by both thread ID and normalized text content
      const key = normalizeText(thread.text);
      if (!key || seenText.has(key) || seenIds.has(thread.id)) continue;
      seenText.add(key);
      seenIds.add(thread.id);

      if (thread.status === "resolved") {
        recentlyResolved.push(thread);
      } else {
        open.push(thread);
      }
    }
  }

  return { open, recently_resolved: recentlyResolved };
}

// ---------- Thread Resolution ----------

/**
 * Find a thread by exact ID.
 */
export function findThreadById(threads: ThreadObject[], id: string): ThreadObject | null {
  return threads.find((t) => t.id === id) || null;
}

/**
 * Find a thread by case-insensitive substring match on text.
 * Returns the first match.
 */
export function findThreadByText(threads: ThreadObject[], query: string): ThreadObject | null {
  const lowerQuery = query.toLowerCase().trim();
  return threads.find((t) => t.text.toLowerCase().includes(lowerQuery)) || null;
}

/**
 * Resolve a thread in a list. Returns the resolved thread or null if not found.
 * Mutates the thread object in place.
 */
export function resolveThread(
  threads: ThreadObject[],
  options: {
    threadId?: string;
    textMatch?: string;
    sessionId?: string;
    resolutionNote?: string;
  }
): ThreadObject | null {
  let thread: ThreadObject | null = null;

  if (options.threadId) {
    thread = findThreadById(threads, options.threadId);
  } else if (options.textMatch) {
    thread = findThreadByText(threads, options.textMatch);
  }

  if (!thread) return null;
  if (thread.status === "resolved") return thread; // Already resolved

  thread.status = "resolved";
  thread.resolved_at = new Date().toISOString();
  if (options.sessionId) thread.resolved_by_session = options.sessionId;
  if (options.resolutionNote) thread.resolution_note = options.resolutionNote;

  return thread;
}

// ---------- Local File Persistence ----------

const THREADS_FILENAME = "threads.json";

function getThreadsFilePath(): string {
  const gitmemDir = path.join(process.cwd(), ".gitmem");
  return path.join(gitmemDir, THREADS_FILENAME);
}

/**
 * Load threads from .gitmem/threads.json.
 * Returns empty array if file doesn't exist or is invalid.
 */
export function loadThreadsFile(): ThreadObject[] {
  try {
    const filePath = getThreadsFilePath();
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(content);
    if (!Array.isArray(data)) return [];
    return data as ThreadObject[];
  } catch {
    return [];
  }
}

/**
 * Save threads to .gitmem/threads.json.
 */
export function saveThreadsFile(threads: ThreadObject[]): void {
  const gitmemDir = path.join(process.cwd(), ".gitmem");
  if (!fs.existsSync(gitmemDir)) {
    fs.mkdirSync(gitmemDir, { recursive: true });
  }
  const filePath = path.join(gitmemDir, THREADS_FILENAME);
  fs.writeFileSync(filePath, JSON.stringify(threads, null, 2));
}

// ---------- Merge ----------

/**
 * Merge two thread lists, preferring resolved state.
 * Used to merge session-close payload with mid-session resolutions.
 */
export function mergeThreadStates(
  incoming: ThreadObject[],
  current: ThreadObject[]
): ThreadObject[] {
  const byId = new Map<string, ThreadObject>();
  const textToId = new Map<string, string>(); // normalized text -> first ID

  // Start with current state (may have mid-session resolutions)
  for (const t of current) {
    byId.set(t.id, t);
    const key = normalizeText(t.text);
    if (key && !textToId.has(key)) {
      textToId.set(key, t.id);
    }
  }

  // Merge incoming — new threads get added, existing threads prefer resolved state
  for (const t of incoming) {
    const existing = byId.get(t.id);
    if (existing) {
      // Same ID: prefer resolved state
      if (t.status === "resolved" && existing.status === "open") {
        byId.set(t.id, t);
      }
      continue;
    }

    // Different ID — check for text-based duplicate (migration scenario)
    const key = normalizeText(t.text);
    if (key) {
      const existingId = textToId.get(key);
      if (existingId) {
        // Same text, different ID: propagate resolved status if incoming is resolved
        if (t.status === "resolved") {
          const existingThread = byId.get(existingId);
          if (existingThread && existingThread.status === "open") {
            existingThread.status = "resolved";
            existingThread.resolved_at = t.resolved_at;
            existingThread.resolved_by_session = t.resolved_by_session;
            existingThread.resolution_note = t.resolution_note;
          }
        }
        continue; // Skip the duplicate
      }
    }

    // Genuinely new thread
    byId.set(t.id, t);
    if (key) {
      textToId.set(key, t.id);
    }
  }

  return Array.from(byId.values());
}

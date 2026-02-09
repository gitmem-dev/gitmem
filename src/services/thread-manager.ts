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
          // Legacy format: {item, context}
          return migrateStringThread(parsed.item || item, sourceSession);
        } catch {
          // Not valid JSON, treat as plain text
        }
      }
      return migrateStringThread(item, sourceSession);
    }
    // Already a ThreadObject
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

  const seen = new Set<string>();
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

      const key = thread.text.toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);

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

  // Start with current state (may have mid-session resolutions)
  for (const t of current) {
    byId.set(t.id, t);
  }

  // Merge incoming — new threads get added, existing threads prefer resolved state
  for (const t of incoming) {
    const existing = byId.get(t.id);
    if (!existing) {
      byId.set(t.id, t);
    } else if (t.status === "resolved" && existing.status === "open") {
      // Incoming says resolved — update
      byId.set(t.id, t);
    }
    // If existing is resolved and incoming is open, keep resolved
  }

  // Also merge by text for threads that have different IDs (migration scenario)
  const textIndex = new Map<string, string>(); // text -> id
  for (const [id, t] of byId) {
    const key = t.text.toLowerCase().trim();
    if (!textIndex.has(key)) {
      textIndex.set(key, id);
    }
  }

  return Array.from(byId.values());
}

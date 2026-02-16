/**
 * Unit tests for thread-manager.ts
 *
 * Covers normalizeThreads() with all thread formats,
 * including the {id, status, note} wrapper bug fix.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeThreads,
  migrateStringThread,
  generateThreadId,
  aggregateThreads,
  mergeThreadStates,
  findThreadById,
  findThreadByText,
  resolveThread,
} from "../../../src/services/thread-manager.js";
import type { ThreadObject } from "../../../src/types/index.js";

describe("generateThreadId", () => {
  it("produces t- prefix with 8 hex chars", () => {
    const id = generateThreadId();
    expect(id).toMatch(/^t-[0-9a-f]{8}$/);
  });

  it("produces unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateThreadId()));
    expect(ids.size).toBe(100);
  });
});

describe("migrateStringThread", () => {
  it("creates a ThreadObject from plain text", () => {
    const thread = migrateStringThread("Something needs doing");
    expect(thread.id).toMatch(/^t-/);
    expect(thread.text).toBe("Something needs doing");
    expect(thread.status).toBe("open");
    expect(thread.created_at).toBeDefined();
    expect(thread.source_session).toBeUndefined();
  });

  it("attaches source_session when provided", () => {
    const thread = migrateStringThread("Thread text", "session-abc");
    expect(thread.source_session).toBe("session-abc");
  });
});

describe("normalizeThreads", () => {
  it("passes through existing ThreadObjects unchanged", () => {
    const existing: ThreadObject = {
      id: "t-aabbccdd",
      text: "Already a thread",
      status: "open",
      created_at: "2026-02-09T00:00:00.000Z",
    };
    const result = normalizeThreads([existing]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(existing); // same reference
  });

  it("migrates plain strings to ThreadObjects", () => {
    const result = normalizeThreads(["Fix the bug"]);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Fix the bug");
    expect(result[0].id).toMatch(/^t-/);
    expect(result[0].status).toBe("open");
  });

  it("parses JSON strings with full ThreadObject format", () => {
    const json = JSON.stringify({
      id: "t-11223344",
      text: "Thread from JSON",
      status: "open",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const result = normalizeThreads([json]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t-11223344");
    expect(result[0].text).toBe("Thread from JSON");
  });

  // THE BUG FIX: {id, status, note} format
  it("parses JSON strings with {id, status, note} format (wrapper bug fix)", () => {
    const json = JSON.stringify({
      id: "t-05a7ecb6",
      status: "open",
      note: "Phase 2 GitMem public npm release still pending",
    });
    const result = normalizeThreads([json], "session-xyz");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t-05a7ecb6");
    expect(result[0].text).toBe("Phase 2 GitMem public npm release still pending");
    expect(result[0].status).toBe("open");
    expect(result[0].source_session).toBe("session-xyz");
  });

  it("preserves resolved_at from {id, status, note} format", () => {
    const json = JSON.stringify({
      id: "t-aabb1122",
      status: "resolved",
      note: "Was resolved",
      resolved_at: "2026-02-08T12:00:00.000Z",
    });
    const result = normalizeThreads([json]);
    expect(result[0].status).toBe("resolved");
    expect(result[0].resolved_at).toBe("2026-02-08T12:00:00.000Z");
  });

  it("handles legacy {item, context} format", () => {
    const json = JSON.stringify({ item: "Legacy thread text" });
    const result = normalizeThreads([json]);
    expect(result[0].text).toBe("Legacy thread text");
  });

  it("falls back to raw JSON string when parsing fails", () => {
    const badJson = "{not valid json";
    const result = normalizeThreads([badJson]);
    expect(result[0].text).toBe("{not valid json");
  });

  it("handles mixed array of all formats", () => {
    const threadObj: ThreadObject = {
      id: "t-existing1",
      text: "Existing thread",
      status: "open",
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const jsonFull = JSON.stringify({
      id: "t-jsonfull1",
      text: "JSON full thread",
      status: "open",
    });
    const jsonNote = JSON.stringify({
      id: "t-jsonnote1",
      status: "open",
      note: "JSON note thread",
    });
    const plainText = "Plain text thread";

    const result = normalizeThreads([threadObj, jsonFull, jsonNote, plainText]);
    expect(result).toHaveLength(4);
    expect(result[0].text).toBe("Existing thread");
    expect(result[1].text).toBe("JSON full thread");
    expect(result[2].text).toBe("JSON note thread");
    expect(result[3].text).toBe("Plain text thread");
  });

  // Regression: the wrapper threads should NOT create duplicates
  it("does not create wrapper duplicates for {id, status, note} format", () => {
    // This is the exact format that caused the wrapper bug in active-session.json
    const wrapperJson = '{"id":"t-05a7ecb6","status":"open","note":"Phase 2 GitMem public npm release still pending"}';
    const result = normalizeThreads([wrapperJson]);

    // Should produce ONE thread with the note as text, not a wrapper
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t-05a7ecb6");
    expect(result[0].text).toBe("Phase 2 GitMem public npm release still pending");
    // The text should NOT be the JSON string itself
    expect(result[0].text).not.toContain("{");
    expect(result[0].text).not.toContain('"id"');
  });
});

describe("findThreadById", () => {
  const threads: ThreadObject[] = [
    { id: "t-aaa", text: "First", status: "open", created_at: "2026-01-01T00:00:00Z" },
    { id: "t-bbb", text: "Second", status: "open", created_at: "2026-01-02T00:00:00Z" },
  ];

  it("finds thread by ID", () => {
    expect(findThreadById(threads, "t-bbb")?.text).toBe("Second");
  });

  it("returns null for unknown ID", () => {
    expect(findThreadById(threads, "t-zzz")).toBeNull();
  });
});

describe("findThreadByText", () => {
  const threads: ThreadObject[] = [
    { id: "t-aaa", text: "Fix authentication bug", status: "open", created_at: "2026-01-01T00:00:00Z" },
    { id: "t-bbb", text: "Add logging to API", status: "open", created_at: "2026-01-02T00:00:00Z" },
  ];

  it("finds thread by substring match (case-insensitive)", () => {
    expect(findThreadByText(threads, "AUTH")?.id).toBe("t-aaa");
  });

  it("returns null for no match", () => {
    expect(findThreadByText(threads, "nonexistent")).toBeNull();
  });
});

describe("resolveThread", () => {
  it("resolves by ID", () => {
    const threads: ThreadObject[] = [
      { id: "t-aaa", text: "Open thread", status: "open", created_at: "2026-01-01T00:00:00Z" },
    ];
    const resolved = resolveThread(threads, { threadId: "t-aaa", resolutionNote: "Done" });
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolved_at).toBeDefined();
    expect(resolved?.resolution_note).toBe("Done");
  });

  it("resolves by text match", () => {
    const threads: ThreadObject[] = [
      { id: "t-aaa", text: "Package name decision", status: "open", created_at: "2026-01-01T00:00:00Z" },
    ];
    const resolved = resolveThread(threads, { textMatch: "package name" });
    expect(resolved?.status).toBe("resolved");
  });

  it("returns null if not found", () => {
    expect(resolveThread([], { threadId: "t-zzz" })).toBeNull();
  });

  it("returns already-resolved thread without modifying", () => {
    const threads: ThreadObject[] = [
      { id: "t-aaa", text: "Already done", status: "resolved", created_at: "2026-01-01T00:00:00Z", resolved_at: "2026-01-02T00:00:00Z" },
    ];
    const result = resolveThread(threads, { threadId: "t-aaa" });
    expect(result?.status).toBe("resolved");
  });
});

describe("resolveThread — duplicate cascade detection", () => {
  it("does not cascade when resolution note has no duplicate reference", () => {
    const threads: ThreadObject[] = [
      { id: "t-aaa", text: "Original thread", status: "open", created_at: "2026-01-01T00:00:00Z" },
      { id: "t-bbb", text: "Other thread", status: "open", created_at: "2026-01-01T00:00:00Z" },
    ];
    resolveThread(threads, { threadId: "t-bbb", resolutionNote: "Just done" });
    expect(threads.find(t => t.id === "t-aaa")?.status).toBe("open");
  });

  it("does not cascade when referenced thread does not exist", () => {
    const threads: ThreadObject[] = [
      { id: "t-bbb", text: "Duplicate thread", status: "open", created_at: "2026-01-01T00:00:00Z" },
    ];
    // Resolution mentions t-aaaa1234 which doesn't exist — should not throw
    const resolved = resolveThread(threads, { threadId: "t-bbb", resolutionNote: "Duplicate of t-aaaa1234" });
    expect(resolved?.status).toBe("resolved");
  });

  it("does not cascade when referenced thread is already resolved", () => {
    const threads: ThreadObject[] = [
      { id: "t-aaa11111", text: "Already resolved original", status: "resolved", created_at: "2026-01-01T00:00:00Z", resolved_at: "2026-01-02T00:00:00Z" },
      { id: "t-bbb", text: "Duplicate thread", status: "open", created_at: "2026-01-01T00:00:00Z" },
    ];
    resolveThread(threads, { threadId: "t-bbb", resolutionNote: "Duplicate of t-aaa11111" });
    // Original should still have its original resolved_at, not a new one
    const original = threads.find(t => t.id === "t-aaa11111");
    expect(original?.resolved_at).toBe("2026-01-02T00:00:00Z");
  });
});

describe("aggregateThreads", () => {
  it("deduplicates threads across sessions by text", () => {
    const sessions = [
      {
        id: "s1",
        session_date: "2026-02-09",
        close_compliance: { close_type: "standard" },
        open_threads: [
          { id: "t-aaa", text: "Shared thread", status: "open" as const, created_at: "2026-02-08T00:00:00Z" },
        ],
      },
      {
        id: "s2",
        session_date: "2026-02-08",
        close_compliance: { close_type: "standard" },
        open_threads: [
          { id: "t-bbb", text: "Shared thread", status: "open" as const, created_at: "2026-02-07T00:00:00Z" },
        ],
      },
    ];

    const result = aggregateThreads(sessions);
    expect(result.open).toHaveLength(1);
    expect(result.open[0].id).toBe("t-aaa"); // First seen wins
  });

  it("skips sessions without close_compliance", () => {
    const sessions = [
      {
        id: "s1",
        session_date: "2026-02-09",
        close_compliance: null,
        open_threads: [
          { id: "t-aaa", text: "Should be skipped", status: "open" as const, created_at: "2026-02-09T00:00:00Z" },
        ],
      },
    ];
    const result = aggregateThreads(sessions);
    expect(result.open).toHaveLength(0);
  });

  it("deduplicates threads across sessions by ID (same ID, different text)", () => {
    const sessions = [
      {
        id: "s1",
        session_date: "2026-02-09",
        close_compliance: { close_type: "standard" },
        open_threads: [
          { id: "t-aaa", text: "Phase 2 GitMem public npm release still pending", status: "open" as const, created_at: "2026-02-08T00:00:00Z" },
        ],
      },
      {
        id: "s2",
        session_date: "2026-02-08",
        close_compliance: { close_type: "standard" },
        open_threads: [
          { id: "t-aaa", text: "Phase 2 issues (GitMem public npm release) still ready to execute", status: "open" as const, created_at: "2026-02-07T00:00:00Z" },
        ],
      },
    ];

    const result = aggregateThreads(sessions);
    expect(result.open).toHaveLength(1);
    expect(result.open[0].id).toBe("t-aaa"); // First seen wins
  });

  it("separates resolved from open threads", () => {
    const sessions = [
      {
        id: "s1",
        session_date: "2026-02-09",
        close_compliance: { close_type: "standard" },
        open_threads: [
          { id: "t-aaa", text: "Still open", status: "open" as const, created_at: "2026-02-09T00:00:00Z" },
          { id: "t-bbb", text: "Was resolved", status: "resolved" as const, created_at: "2026-02-08T00:00:00Z" },
        ],
      },
    ];
    const result = aggregateThreads(sessions);
    expect(result.open).toHaveLength(1);
    expect(result.recently_resolved).toHaveLength(1);
  });
});

describe("mergeThreadStates", () => {
  it("adds new incoming threads", () => {
    const current: ThreadObject[] = [
      { id: "t-aaa", text: "Existing", status: "open", created_at: "2026-01-01T00:00:00Z" },
    ];
    const incoming: ThreadObject[] = [
      { id: "t-bbb", text: "New thread", status: "open", created_at: "2026-01-02T00:00:00Z" },
    ];
    const merged = mergeThreadStates(incoming, current);
    expect(merged).toHaveLength(2);
  });

  it("prefers resolved state over open", () => {
    const current: ThreadObject[] = [
      { id: "t-aaa", text: "Thread", status: "open", created_at: "2026-01-01T00:00:00Z" },
    ];
    const incoming: ThreadObject[] = [
      { id: "t-aaa", text: "Thread", status: "resolved", created_at: "2026-01-01T00:00:00Z", resolved_at: "2026-01-02T00:00:00Z" },
    ];
    const merged = mergeThreadStates(incoming, current);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe("resolved");
  });

  it("keeps resolved even if incoming says open", () => {
    const current: ThreadObject[] = [
      { id: "t-aaa", text: "Thread", status: "resolved", created_at: "2026-01-01T00:00:00Z", resolved_at: "2026-01-02T00:00:00Z" },
    ];
    const incoming: ThreadObject[] = [
      { id: "t-aaa", text: "Thread", status: "open", created_at: "2026-01-01T00:00:00Z" },
    ];
    const merged = mergeThreadStates(incoming, current);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe("resolved");
  });

  it("deduplicates by normalized text across different IDs", () => {
    const current: ThreadObject[] = [
      { id: "t-aaa", text: "Fix auth timeout", status: "open", created_at: "2026-01-01T00:00:00Z" },
    ];
    const incoming: ThreadObject[] = [
      { id: "t-bbb", text: "Fix auth timeout", status: "open", created_at: "2026-01-02T00:00:00Z" },
    ];
    const merged = mergeThreadStates(incoming, current);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("t-aaa"); // Current wins
  });

  it("propagates resolved status across text-matched threads with different IDs", () => {
    const current: ThreadObject[] = [
      { id: "t-aaa", text: "Fix auth timeout", status: "open", created_at: "2026-01-01T00:00:00Z" },
    ];
    const incoming: ThreadObject[] = [
      { id: "t-bbb", text: "Fix auth timeout", status: "resolved", created_at: "2026-01-01T00:00:00Z", resolved_at: "2026-01-02T00:00:00Z" },
    ];
    const merged = mergeThreadStates(incoming, current);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("t-aaa"); // Current ID preserved
    expect(merged[0].status).toBe("resolved"); // Resolved status propagated
    expect(merged[0].resolved_at).toBe("2026-01-02T00:00:00Z");
  });

  it("handles text normalization differences (trailing punctuation, whitespace)", () => {
    const current: ThreadObject[] = [
      { id: "t-aaa", text: "Fix the auth timeout.", status: "open", created_at: "2026-01-01T00:00:00Z" },
    ];
    const incoming: ThreadObject[] = [
      { id: "t-bbb", text: "fix the auth timeout", status: "open", created_at: "2026-01-02T00:00:00Z" },
    ];
    const merged = mergeThreadStates(incoming, current);
    expect(merged).toHaveLength(1);
  });
});

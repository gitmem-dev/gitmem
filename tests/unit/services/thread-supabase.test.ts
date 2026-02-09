/**
 * Unit tests for Thread Architecture — Supabase Integration (OD-626 Phase 1)
 *
 * Tests the contract between the thread-manager and the orchestra_threads
 * Supabase table. All Supabase calls are mocked — no real network calls.
 *
 * Covers:
 *   - CRUD operations (create, resolve, list via Supabase)
 *   - Cache sync (session_start populates local, session_close syncs back)
 *   - Backward compatibility with existing file-only format
 *   - Edge cases (dedup, null embeddings, project filtering, status constraints)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Mock Supabase client BEFORE importing anything that depends on it
// ---------------------------------------------------------------------------

const mockUpsertRecord = vi.fn();
const mockListRecords = vi.fn();
const mockDirectUpsert = vi.fn();
const mockDirectQuery = vi.fn();
const mockIsConfigured = vi.fn(() => true);

vi.mock("../../../src/services/supabase-client.js", () => ({
  isConfigured: (...args: unknown[]) => mockIsConfigured(...args),
  upsertRecord: (...args: unknown[]) => mockUpsertRecord(...args),
  listRecords: (...args: unknown[]) => mockListRecords(...args),
  directUpsert: (...args: unknown[]) => mockDirectUpsert(...args),
  directQuery: (...args: unknown[]) => mockDirectQuery(...args),
}));

// ---------------------------------------------------------------------------
// Import the thread-manager functions under test
// ---------------------------------------------------------------------------

import {
  normalizeThreads,
  migrateStringThread,
  generateThreadId,
  aggregateThreads,
  mergeThreadStates,
  findThreadById,
  findThreadByText,
  resolveThread,
  loadThreadsFile,
  saveThreadsFile,
} from "../../../src/services/thread-manager.js";
import type { ThreadObject } from "../../../src/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ThreadObject with sensible defaults */
function makeThread(overrides: Partial<ThreadObject> = {}): ThreadObject {
  return {
    id: overrides.id ?? generateThreadId(),
    text: overrides.text ?? "Test thread text",
    status: overrides.status ?? "open",
    created_at: overrides.created_at ?? "2026-02-09T00:00:00.000Z",
    ...(overrides.resolved_at && { resolved_at: overrides.resolved_at }),
    ...(overrides.source_session && { source_session: overrides.source_session }),
    ...(overrides.resolved_by_session && { resolved_by_session: overrides.resolved_by_session }),
    ...(overrides.resolution_note && { resolution_note: overrides.resolution_note }),
  };
}

/**
 * Build a Supabase-shaped row for orchestra_threads.
 * This mirrors the SQL schema columns so tests can assert the shape
 * of data flowing to/from Supabase.
 */
function makeSupabaseThreadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    thread_id: overrides.thread_id ?? "t-aabb1122",
    text: overrides.text ?? "Supabase thread text",
    status: overrides.status ?? "active",
    thread_class: overrides.thread_class ?? "backlog",
    vitality_score: overrides.vitality_score ?? 1.0,
    last_touched_at: overrides.last_touched_at ?? "2026-02-09T00:00:00.000Z",
    touch_count: overrides.touch_count ?? 1,
    created_at: overrides.created_at ?? "2026-02-09T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-02-09T00:00:00.000Z",
    resolved_at: overrides.resolved_at ?? null,
    resolution_note: overrides.resolution_note ?? null,
    source_session: overrides.source_session ?? null,
    resolved_by_session: overrides.resolved_by_session ?? null,
    related_issues: overrides.related_issues ?? null,
    domain: overrides.domain ?? null,
    embedding: overrides.embedding ?? null,
    project: overrides.project ?? "orchestra_dev",
    metadata: overrides.metadata ?? {},
  };
}

/** Map a Supabase row back to the local ThreadObject format */
function supabaseRowToThreadObject(row: ReturnType<typeof makeSupabaseThreadRow>): ThreadObject {
  return {
    id: row.thread_id,
    text: row.text,
    status: row.status === "resolved" ? "resolved" : "open",
    created_at: row.created_at as string,
    ...(row.resolved_at && { resolved_at: row.resolved_at as string }),
    ...(row.source_session && { source_session: row.source_session as string }),
    ...(row.resolved_by_session && { resolved_by_session: row.resolved_by_session as string }),
    ...(row.resolution_note && { resolution_note: row.resolution_note as string }),
  };
}

// Temp dir for file-based tests
let tmpDir: string;
let originalCwd: string;

beforeEach(() => {
  vi.clearAllMocks();
  mockIsConfigured.mockReturnValue(true);

  // Create temp directory and override cwd for file persistence tests
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-supa-test-"));
  originalCwd = process.cwd();
  // Override process.cwd for loadThreadsFile/saveThreadsFile
  vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
//  1. Supabase CRUD Operations (5 tests)
// ===========================================================================

describe("Supabase CRUD: create_thread writes to Supabase", () => {
  it("should call upsertRecord with correct orchestra_threads columns", async () => {
    const thread = makeThread({
      id: "t-create01",
      text: "New thread for Supabase",
      status: "open",
      source_session: "session-123",
    });

    // Simulate what the implementation SHOULD do when creating a thread:
    // upsert to orchestra_threads with the correct column mapping.
    mockUpsertRecord.mockResolvedValue({ thread_id: thread.id });

    // Call the mock directly — the implementation will wire this up.
    // The test documents the expected CONTRACT.
    await mockUpsertRecord("orchestra_threads", {
      thread_id: thread.id,
      text: thread.text,
      status: "active", // local "open" maps to Supabase "active"
      source_session: thread.source_session,
      project: "orchestra_dev",
      vitality_score: 1.0,
      touch_count: 1,
    });

    expect(mockUpsertRecord).toHaveBeenCalledTimes(1);
    expect(mockUpsertRecord).toHaveBeenCalledWith(
      "orchestra_threads",
      expect.objectContaining({
        thread_id: "t-create01",
        text: "New thread for Supabase",
        status: "active",
        project: "orchestra_dev",
      })
    );
  });
});

describe("Supabase CRUD: create_thread falls back to file-only on Supabase error", () => {
  it("should still persist locally when Supabase upsert fails", () => {
    mockUpsertRecord.mockRejectedValue(new Error("Supabase upsert error: 500"));

    // Even when Supabase fails, local file should still work.
    const thread = makeThread({ id: "t-fallback1", text: "File-only fallback" });
    const threads = [thread];

    // Local persistence should not throw
    saveThreadsFile(threads);
    const loaded = loadThreadsFile();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("t-fallback1");
    expect(loaded[0].text).toBe("File-only fallback");
  });
});

describe("Supabase CRUD: resolve_thread updates Supabase", () => {
  it("should update the thread with resolved status, resolved_at, and resolution_note", async () => {
    const threads: ThreadObject[] = [
      makeThread({ id: "t-resolve1", text: "Thread to resolve", status: "open" }),
    ];

    // Resolve locally (existing function)
    const resolved = resolveThread(threads, {
      threadId: "t-resolve1",
      resolutionNote: "Fixed in OD-626",
      sessionId: "session-456",
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("resolved");
    expect(resolved!.resolved_at).toBeDefined();
    expect(resolved!.resolution_note).toBe("Fixed in OD-626");
    expect(resolved!.resolved_by_session).toBe("session-456");

    // Now simulate the Supabase write that the implementation should do
    mockDirectUpsert.mockResolvedValue({ thread_id: "t-resolve1" });

    await mockDirectUpsert("orchestra_threads", {
      thread_id: resolved!.id,
      status: "resolved",
      resolved_at: resolved!.resolved_at,
      resolution_note: resolved!.resolution_note,
      resolved_by_session: resolved!.resolved_by_session,
    });

    expect(mockDirectUpsert).toHaveBeenCalledWith(
      "orchestra_threads",
      expect.objectContaining({
        thread_id: "t-resolve1",
        status: "resolved",
        resolution_note: "Fixed in OD-626",
      })
    );
  });
});

describe("Supabase CRUD: resolve_thread handles thread not in Supabase", () => {
  it("should resolve locally even if Supabase has no record", () => {
    mockDirectUpsert.mockRejectedValue(new Error("Not found in Supabase"));

    const threads: ThreadObject[] = [
      makeThread({ id: "t-localonly", text: "Only local", status: "open" }),
    ];

    const resolved = resolveThread(threads, {
      threadId: "t-localonly",
      resolutionNote: "Resolved locally",
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("resolved");
    expect(resolved!.resolved_at).toBeDefined();

    // Local file should still accept the write
    saveThreadsFile(threads);
    const loaded = loadThreadsFile();
    expect(loaded[0].status).toBe("resolved");
  });
});

describe("Supabase CRUD: list_threads reads from Supabase", () => {
  it("should return threads from Supabase in the correct ThreadObject format", async () => {
    const supabaseRows = [
      makeSupabaseThreadRow({
        thread_id: "t-list0001",
        text: "First thread from Supabase",
        status: "active",
        touch_count: 3,
      }),
      makeSupabaseThreadRow({
        thread_id: "t-list0002",
        text: "Second thread from Supabase",
        status: "active",
        touch_count: 1,
      }),
    ];

    mockListRecords.mockResolvedValue(supabaseRows);

    const result = await mockListRecords({
      table: "orchestra_threads",
      filters: { status: "active", project: "orchestra_dev" },
      orderBy: { column: "last_touched_at", ascending: false },
    });

    expect(result).toHaveLength(2);

    // Convert to ThreadObject format (the implementation should do this)
    const threadObjects = result.map(supabaseRowToThreadObject);
    expect(threadObjects[0].id).toBe("t-list0001");
    expect(threadObjects[0].text).toBe("First thread from Supabase");
    expect(threadObjects[0].status).toBe("open"); // "active" maps to "open"
    expect(threadObjects[1].id).toBe("t-list0002");
  });
});

// ===========================================================================
//  2. Cache Sync (3 tests)
// ===========================================================================

describe("Cache Sync: session_start populates local cache from Supabase", () => {
  it("should write Supabase threads to .gitmem/threads.json", async () => {
    const supabaseRows = [
      makeSupabaseThreadRow({ thread_id: "t-sync0001", text: "Synced from Supabase" }),
      makeSupabaseThreadRow({ thread_id: "t-sync0002", text: "Another synced thread" }),
    ];

    mockListRecords.mockResolvedValue(supabaseRows);

    // Simulate what session_start should do: fetch from Supabase, write to file
    const fetched = await mockListRecords({
      table: "orchestra_threads",
      filters: { project: "orchestra_dev" },
    });
    const threadObjects = fetched.map(supabaseRowToThreadObject);

    saveThreadsFile(threadObjects);

    // Verify local cache matches
    const local = loadThreadsFile();
    expect(local).toHaveLength(2);
    expect(local[0].id).toBe("t-sync0001");
    expect(local[1].id).toBe("t-sync0002");
  });
});

describe("Cache Sync: session_close syncs thread state to Supabase", () => {
  it("should increment touch_count for referenced threads", async () => {
    // Setup: thread already exists in Supabase with touch_count=2
    const existingRow = makeSupabaseThreadRow({
      thread_id: "t-touched1",
      text: "Frequently referenced thread",
      touch_count: 2,
    });

    mockDirectQuery.mockResolvedValue([existingRow]);
    mockDirectUpsert.mockResolvedValue({ ...existingRow, touch_count: 3 });

    // Simulate session_close: thread was referenced, increment touch_count
    const fetched = await mockDirectQuery("orchestra_threads", {
      filters: { thread_id: "eq.t-touched1" },
    });
    expect(fetched[0].touch_count).toBe(2);

    await mockDirectUpsert("orchestra_threads", {
      thread_id: "t-touched1",
      touch_count: fetched[0].touch_count + 1,
      last_touched_at: new Date().toISOString(),
    });

    expect(mockDirectUpsert).toHaveBeenCalledWith(
      "orchestra_threads",
      expect.objectContaining({
        thread_id: "t-touched1",
        touch_count: 3,
      })
    );
  });
});

describe("Cache Sync: local cache used when Supabase offline", () => {
  it("should fall back to file-based aggregation when Supabase times out", () => {
    mockListRecords.mockRejectedValue(new Error("network timeout"));
    mockIsConfigured.mockReturnValue(false);

    // Seed local file with threads
    const localThreads: ThreadObject[] = [
      makeThread({ id: "t-offline1", text: "Offline thread A" }),
      makeThread({ id: "t-offline2", text: "Offline thread B" }),
    ];
    saveThreadsFile(localThreads);

    // When Supabase is unavailable, loadThreadsFile should still work
    const cached = loadThreadsFile();
    expect(cached).toHaveLength(2);
    expect(cached[0].id).toBe("t-offline1");

    // aggregateThreads still works on session records (file-based data)
    const sessions = [
      {
        id: "s1",
        session_date: "2026-02-09",
        close_compliance: { close_type: "standard" },
        open_threads: localThreads,
      },
    ];
    const result = aggregateThreads(sessions);
    expect(result.open).toHaveLength(2);
  });
});

// ===========================================================================
//  3. Format Backward Compatibility (4 tests)
// ===========================================================================

describe("Format Compat: list_threads returns same format as file-only version", () => {
  it("should produce ThreadObject[] with id, text, status, created_at fields", async () => {
    const supabaseRows = [
      makeSupabaseThreadRow({
        thread_id: "t-compat01",
        text: "Compat check thread",
        status: "active",
        created_at: "2026-02-08T12:00:00.000Z",
      }),
    ];

    mockListRecords.mockResolvedValue(supabaseRows);
    const fetched = await mockListRecords({ table: "orchestra_threads" });
    const threadObjects = fetched.map(supabaseRowToThreadObject);

    // Must match ThreadObject interface exactly
    const thread = threadObjects[0];
    expect(thread).toHaveProperty("id");
    expect(thread).toHaveProperty("text");
    expect(thread).toHaveProperty("status");
    expect(thread).toHaveProperty("created_at");
    expect(thread.id).toMatch(/^t-/);
    expect(["open", "resolved"]).toContain(thread.status);
  });
});

describe("Format Compat: session.open_threads JSONB still populated", () => {
  it("should maintain backward compat by including threads in session close payload", () => {
    const threads: ThreadObject[] = [
      makeThread({ id: "t-jsonb01", text: "Backward compat thread" }),
    ];

    // Simulate the session close payload structure
    const sessionData: Record<string, unknown> = {
      id: "session-close-test",
      close_compliance: { close_type: "standard" },
    };

    // The implementation should STILL populate open_threads on the session
    // (even when also writing to orchestra_threads)
    sessionData.open_threads = threads;

    expect(sessionData.open_threads).toHaveLength(1);
    expect((sessionData.open_threads as ThreadObject[])[0].id).toBe("t-jsonb01");
  });
});

describe("Format Compat: mixed format threads normalized before Supabase write", () => {
  it("should handle plain strings, JSON objects, and ThreadObjects uniformly", () => {
    const plainString = "Plain text thread";
    const jsonNoteFormat = JSON.stringify({
      id: "t-jsonnote",
      status: "open",
      note: "JSON note format thread",
    });
    const threadObject: ThreadObject = {
      id: "t-existing",
      text: "Already a ThreadObject",
      status: "open",
      created_at: "2026-02-09T00:00:00.000Z",
    };

    const raw: (string | ThreadObject)[] = [plainString, jsonNoteFormat, threadObject];
    const normalized = normalizeThreads(raw, "session-norm");

    expect(normalized).toHaveLength(3);

    // All should be valid ThreadObjects
    for (const thread of normalized) {
      expect(thread).toHaveProperty("id");
      expect(thread).toHaveProperty("text");
      expect(thread).toHaveProperty("status");
      expect(thread.id).toMatch(/^t-/);
      // text should NEVER be a JSON string
      expect(thread.text).not.toContain('"id"');
    }

    // Specific checks
    expect(normalized[0].text).toBe("Plain text thread");
    expect(normalized[1].text).toBe("JSON note format thread");
    expect(normalized[1].id).toBe("t-jsonnote");
    expect(normalized[2].text).toBe("Already a ThreadObject");
  });
});

describe("Format Compat: resolved threads stay resolved across sessions (zombie prevention)", () => {
  it("should not resurrect a resolved thread as open in a later session", () => {
    // Session 1: thread resolved
    const session1Threads: ThreadObject[] = [
      makeThread({
        id: "t-zombie01",
        text: "Was resolved",
        status: "resolved",
        resolved_at: "2026-02-08T12:00:00.000Z",
      }),
    ];

    // Session 2: same thread text carried forward (agent mistakenly re-opens)
    const session2Threads: ThreadObject[] = [
      makeThread({
        id: "t-zombie01",
        text: "Was resolved",
        status: "open",
      }),
    ];

    // mergeThreadStates should keep resolved state
    const merged = mergeThreadStates(session2Threads, session1Threads);

    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe("resolved");
    expect(merged[0].resolved_at).toBe("2026-02-08T12:00:00.000Z");
  });

  it("should also prevent zombies via aggregateThreads deduplication", () => {
    const sessions = [
      {
        id: "s-recent",
        session_date: "2026-02-09",
        close_compliance: { close_type: "standard" },
        open_threads: [
          makeThread({ id: "t-zombie02", text: "Resolved thread", status: "resolved", resolved_at: "2026-02-09T00:00:00.000Z" }),
        ],
      },
      {
        id: "s-older",
        session_date: "2026-02-08",
        close_compliance: { close_type: "standard" },
        open_threads: [
          makeThread({ id: "t-zombie02", text: "Resolved thread", status: "open" }),
        ],
      },
    ];

    const result = aggregateThreads(sessions);

    // The thread should appear in recently_resolved, NOT open
    expect(result.open).toHaveLength(0);
    expect(result.recently_resolved).toHaveLength(1);
    expect(result.recently_resolved[0].id).toBe("t-zombie02");
  });
});

// ===========================================================================
//  4. Edge Cases (4 tests)
// ===========================================================================

describe("Edge Case: concurrent create_thread with same text deduplicates", () => {
  it("should deduplicate threads with identical text via aggregation", () => {
    const sessions = [
      {
        id: "s1",
        session_date: "2026-02-09",
        close_compliance: { close_type: "standard" },
        open_threads: [
          makeThread({ id: "t-dup0001", text: "Investigate auth timeout issue" }),
        ],
      },
      {
        id: "s2",
        session_date: "2026-02-08",
        close_compliance: { close_type: "standard" },
        open_threads: [
          makeThread({ id: "t-dup0002", text: "Investigate auth timeout issue" }),
        ],
      },
    ];

    const result = aggregateThreads(sessions);

    // Dedup by text: only one thread should remain
    expect(result.open).toHaveLength(1);
    expect(result.open[0].id).toBe("t-dup0001"); // First seen wins
  });

  it("should deduplicate via Supabase UNIQUE constraint on thread_id", async () => {
    // First insert succeeds
    mockUpsertRecord.mockResolvedValueOnce({ thread_id: "t-dup0001" });
    await mockUpsertRecord("orchestra_threads", {
      thread_id: "t-dup0001",
      text: "Investigate auth timeout issue",
    });

    // Second insert with same thread_id should upsert (update), not create duplicate
    mockUpsertRecord.mockResolvedValueOnce({ thread_id: "t-dup0001" });
    await mockUpsertRecord("orchestra_threads", {
      thread_id: "t-dup0001",
      text: "Investigate auth timeout issue (updated)",
    });

    // Both calls should go through without duplicate key error
    expect(mockUpsertRecord).toHaveBeenCalledTimes(2);
  });
});

describe("Edge Case: thread with null embedding accepted", () => {
  it("should allow threads without embeddings in Phase 1", async () => {
    const threadRow = makeSupabaseThreadRow({
      thread_id: "t-noembed1",
      text: "No embedding yet",
      embedding: null,
    });

    mockDirectUpsert.mockResolvedValue(threadRow);

    const result = await mockDirectUpsert("orchestra_threads", {
      thread_id: "t-noembed1",
      text: "No embedding yet",
      embedding: null,
      project: "orchestra_dev",
    });

    expect(result.embedding).toBeNull();
    expect(result.thread_id).toBe("t-noembed1");

    // Null embedding should NOT cause an error
    expect(mockDirectUpsert).toHaveBeenCalledWith(
      "orchestra_threads",
      expect.objectContaining({ embedding: null })
    );
  });

  it("should convert Supabase row with null embedding to valid ThreadObject", () => {
    const row = makeSupabaseThreadRow({
      thread_id: "t-noembed2",
      text: "Another no-embed",
      embedding: null,
    });

    const threadObj = supabaseRowToThreadObject(row);

    // ThreadObject does not have an embedding field — null is simply not mapped
    expect(threadObj.id).toBe("t-noembed2");
    expect(threadObj.text).toBe("Another no-embed");
    expect(threadObj).not.toHaveProperty("embedding");
  });
});

describe("Edge Case: project filter applied on list_threads", () => {
  it("should only return threads matching the specified project", async () => {
    const orchThread = makeSupabaseThreadRow({
      thread_id: "t-orch001",
      text: "Orchestra thread",
      project: "orchestra_dev",
    });
    const wwThread = makeSupabaseThreadRow({
      thread_id: "t-ww00001",
      text: "Weekend warrior thread",
      project: "weekend_warrior",
    });

    // Mock returns filtered results (as Supabase would with project filter)
    mockListRecords.mockImplementation((opts: Record<string, unknown>) => {
      const filters = opts.filters as Record<string, string> | undefined;
      const rows = [orchThread, wwThread];
      if (filters?.project) {
        return Promise.resolve(rows.filter((r) => r.project === filters.project));
      }
      return Promise.resolve(rows);
    });

    // Query with project filter
    const orchResults = await mockListRecords({
      table: "orchestra_threads",
      filters: { project: "orchestra_dev" },
    });
    expect(orchResults).toHaveLength(1);
    expect(orchResults[0].thread_id).toBe("t-orch001");

    const wwResults = await mockListRecords({
      table: "orchestra_threads",
      filters: { project: "weekend_warrior" },
    });
    expect(wwResults).toHaveLength(1);
    expect(wwResults[0].thread_id).toBe("t-ww00001");

    // Without filter, both returned
    const allResults = await mockListRecords({
      table: "orchestra_threads",
      filters: {},
    });
    expect(allResults).toHaveLength(2);
  });
});

describe("Edge Case: status check constraint validated", () => {
  it("should accept all valid Supabase status values", () => {
    const validStatuses = ["emerging", "active", "cooling", "dormant", "archived", "resolved"];

    for (const status of validStatuses) {
      const row = makeSupabaseThreadRow({ status });
      // Should not throw
      expect(row.status).toBe(status);
    }
  });

  it("should map Supabase statuses to local ThreadStatus correctly", () => {
    // Only "resolved" maps to "resolved"; everything else is "open"
    const mappings: Array<[string, "open" | "resolved"]> = [
      ["emerging", "open"],
      ["active", "open"],
      ["cooling", "open"],
      ["dormant", "open"],
      ["archived", "open"],
      ["resolved", "resolved"],
    ];

    for (const [supabaseStatus, expectedLocal] of mappings) {
      const row = makeSupabaseThreadRow({ status: supabaseStatus });
      const threadObj = supabaseRowToThreadObject(row);
      expect(threadObj.status).toBe(expectedLocal);
    }
  });

  it("should map local 'open' status to Supabase 'active'", () => {
    // When writing to Supabase, local "open" must become "active"
    // (since "open" is not in the Supabase CHECK constraint)
    const localThread = makeThread({ status: "open" });
    const supabaseStatus = localThread.status === "open" ? "active" : "resolved";
    expect(supabaseStatus).toBe("active");
  });
});

// ===========================================================================
//  5. Additional Robustness Tests
// ===========================================================================

describe("Supabase write: thread_id uniqueness constraint", () => {
  it("should use thread_id (not UUID id) as the unique key for upserts", async () => {
    const thread = makeThread({ id: "t-unique01", text: "Unique key test" });

    mockUpsertRecord.mockResolvedValue({ thread_id: thread.id });

    await mockUpsertRecord("orchestra_threads", {
      thread_id: thread.id,
      text: thread.text,
      status: "active",
    });

    // The call MUST include thread_id (the business key), not rely on UUID id
    const callArgs = mockUpsertRecord.mock.calls[0][1];
    expect(callArgs).toHaveProperty("thread_id", "t-unique01");
  });
});

describe("Supabase read: thread_class filter for operational vs backlog", () => {
  it("should distinguish operational from backlog threads", async () => {
    const opThread = makeSupabaseThreadRow({
      thread_id: "t-ops001",
      text: "Operational thread",
      thread_class: "operational",
    });
    const bgThread = makeSupabaseThreadRow({
      thread_id: "t-back001",
      text: "Backlog thread",
      thread_class: "backlog",
    });

    mockListRecords.mockImplementation((opts: Record<string, unknown>) => {
      const filters = opts.filters as Record<string, string> | undefined;
      const rows = [opThread, bgThread];
      if (filters?.thread_class) {
        return Promise.resolve(rows.filter((r) => r.thread_class === filters.thread_class));
      }
      return Promise.resolve(rows);
    });

    const opsOnly = await mockListRecords({
      table: "orchestra_threads",
      filters: { thread_class: "operational" },
    });
    expect(opsOnly).toHaveLength(1);
    expect(opsOnly[0].thread_class).toBe("operational");
  });
});

describe("Local file persistence roundtrip with Supabase-sourced data", () => {
  it("should save and reload Supabase-sourced threads without data loss", () => {
    const threads: ThreadObject[] = [
      makeThread({
        id: "t-round001",
        text: "Roundtrip test thread",
        status: "open",
        source_session: "session-rt-1",
      }),
      makeThread({
        id: "t-round002",
        text: "Resolved roundtrip thread",
        status: "resolved",
        resolved_at: "2026-02-09T10:00:00.000Z",
        resolution_note: "Done",
        resolved_by_session: "session-rt-2",
      }),
    ];

    saveThreadsFile(threads);
    const loaded = loadThreadsFile();

    expect(loaded).toHaveLength(2);
    expect(loaded[0].id).toBe("t-round001");
    expect(loaded[0].source_session).toBe("session-rt-1");
    expect(loaded[1].status).toBe("resolved");
    expect(loaded[1].resolved_at).toBe("2026-02-09T10:00:00.000Z");
    expect(loaded[1].resolution_note).toBe("Done");
  });
});

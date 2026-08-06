/**
 * Unit tests for resolve_thread tool — duplicate cascade behavior
 *
 * When a thread is resolved with a note like "Duplicate of t-XXXX",
 * the tool should also resolve the referenced original thread.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ThreadObject } from "../../../src/types/index.js";

// --- Mock external dependencies ---

vi.mock("../../../src/services/session-state.js", () => ({
  getThreads: vi.fn(() => []),
  getCurrentSession: vi.fn(() => ({ sessionId: "test-session" })),
  getProject: vi.fn(() => "default"),
}));

vi.mock("../../../src/services/thread-supabase.js", () => ({
  resolveThreadInSupabase: vi.fn(() => Promise.resolve(true)),
  // GIT-46: cross-session fallback lookups. Default to "not in Supabase" so
  // existing tests (local threads present) are unaffected; the cross-session
  // tests override these per-case.
  getThreadFromSupabaseById: vi.fn(() => Promise.resolve(null)),
  listThreadsFromSupabase: vi.fn(() => Promise.resolve(null)),
  // GIT-69 item 4: ownership lookup used to explain refusals. Defaults to
  // "no ownership record", which keeps the bare not-found path for existing
  // tests; the scoping tests override it per-case.
  getThreadOwnership: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../../../src/services/triple-writer.js", () => ({
  writeTriplesForThreadResolution: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../src/services/effect-tracker.js", () => ({
  getEffectTracker: vi.fn(() => ({
    track: vi.fn((_category: string, _label: string, fn: () => Promise<void>) => fn()),
  })),
}));

vi.mock("../../../src/services/agent-detection.js", () => ({
  getAgentIdentity: vi.fn(() => "CLI"),
}));

vi.mock("../../../src/services/metrics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/services/metrics.js")>();
  return {
    ...actual,
    recordMetrics: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("../../../src/services/timezone.js", () => ({
  formatThreadForDisplay: vi.fn((t: ThreadObject) => t),
}));

// Mock thread-manager to use real logic but intercept file operations
const mockThreads: ThreadObject[] = [];

vi.mock("../../../src/services/thread-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/services/thread-manager.js")>();
  return {
    ...actual,
    loadThreadsFile: vi.fn(() => [...mockThreads]),
    saveThreadsFile: vi.fn(),
  };
});

import { getThreads } from "../../../src/services/session-state.js";
import {
  resolveThreadInSupabase,
  getThreadOwnership,
  getThreadFromSupabaseById,
  listThreadsFromSupabase,
} from "../../../src/services/thread-supabase.js";
import { resolveThread } from "../../../src/tools/resolve-thread.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockThreads.length = 0;
});

describe("resolve_thread — duplicate cascade", () => {
  it("resolves both duplicate and original when note says 'Duplicate of t-XXXX'", async () => {
    mockThreads.push(
      { id: "t-aaa11111", text: "Original thread about auth", status: "open", created_at: "2026-01-01T00:00:00Z" },
      { id: "t-bbb22222", text: "Duplicate thread about auth", status: "open", created_at: "2026-01-02T00:00:00Z" },
    );
    // getThreads returns empty → falls back to loadThreadsFile
    vi.mocked(getThreads).mockReturnValue([]);

    const result = await resolveThread({
      thread_id: "t-bbb22222",
      resolution_note: "Duplicate of t-aaa11111",
    });

    expect(result.success).toBe(true);
    expect(result.resolved_thread?.id).toBe("t-bbb22222");
    expect(result.resolved_thread?.status).toBe("resolved");

    // Cascade: original should also be resolved
    expect(result.also_resolved).toBeDefined();
    expect(result.also_resolved).toHaveLength(1);
    expect(result.also_resolved![0].id).toBe("t-aaa11111");
    expect(result.also_resolved![0].status).toBe("resolved");
    expect(result.also_resolved![0].resolution_note).toContain("t-bbb22222");
  });

  it("syncs cascaded resolution to Supabase", async () => {
    mockThreads.push(
      { id: "t-orig1234", text: "Original", status: "open", created_at: "2026-01-01T00:00:00Z" },
      { id: "t-dupe5678", text: "Duplicate", status: "open", created_at: "2026-01-02T00:00:00Z" },
    );
    vi.mocked(getThreads).mockReturnValue([]);

    await resolveThread({
      thread_id: "t-dupe5678",
      resolution_note: "Duplicate of t-orig1234",
    });

    // Should be called twice: once for primary, once for cascaded
    expect(resolveThreadInSupabase).toHaveBeenCalledTimes(2);
    expect(vi.mocked(resolveThreadInSupabase).mock.calls[0][0]).toBe("t-dupe5678");
    expect(vi.mocked(resolveThreadInSupabase).mock.calls[1][0]).toBe("t-orig1234");
  });

  it("handles case-insensitive 'duplicate of' pattern", async () => {
    mockThreads.push(
      { id: "t-orig1234", text: "Original", status: "open", created_at: "2026-01-01T00:00:00Z" },
      { id: "t-dupe5678", text: "Duplicate", status: "open", created_at: "2026-01-02T00:00:00Z" },
    );
    vi.mocked(getThreads).mockReturnValue([]);

    const result = await resolveThread({
      thread_id: "t-dupe5678",
      resolution_note: "DUPLICATE OF t-orig1234",
    });

    expect(result.also_resolved).toHaveLength(1);
    expect(result.also_resolved![0].id).toBe("t-orig1234");
  });

  it("does not cascade when no duplicate reference in note", async () => {
    mockThreads.push(
      { id: "t-aaa11111", text: "Thread A", status: "open", created_at: "2026-01-01T00:00:00Z" },
      { id: "t-bbb22222", text: "Thread B", status: "open", created_at: "2026-01-02T00:00:00Z" },
    );
    vi.mocked(getThreads).mockReturnValue([]);

    const result = await resolveThread({
      thread_id: "t-bbb22222",
      resolution_note: "Just cleaning up",
    });

    expect(result.success).toBe(true);
    expect(result.also_resolved).toBeUndefined();
    // Only one Supabase call (primary thread)
    expect(resolveThreadInSupabase).toHaveBeenCalledTimes(1);
  });

  it("does not cascade when referenced thread is already resolved", async () => {
    mockThreads.push(
      { id: "t-orig1234", text: "Already done", status: "resolved", created_at: "2026-01-01T00:00:00Z", resolved_at: "2026-01-02T00:00:00Z" },
      { id: "t-dupe5678", text: "Duplicate", status: "open", created_at: "2026-01-02T00:00:00Z" },
    );
    vi.mocked(getThreads).mockReturnValue([]);

    const result = await resolveThread({
      thread_id: "t-dupe5678",
      resolution_note: "Duplicate of t-orig1234",
    });

    expect(result.success).toBe(true);
    expect(result.also_resolved).toBeUndefined();
  });

  it("does not cascade when referenced thread ID doesn't exist", async () => {
    mockThreads.push(
      { id: "t-dupe5678", text: "Duplicate", status: "open", created_at: "2026-01-02T00:00:00Z" },
    );
    vi.mocked(getThreads).mockReturnValue([]);

    const result = await resolveThread({
      thread_id: "t-dupe5678",
      resolution_note: "Duplicate of t-nonexist",
    });

    expect(result.success).toBe(true);
    expect(result.also_resolved).toBeUndefined();
  });

  it("does not cascade when resolution note is empty", async () => {
    mockThreads.push(
      { id: "t-aaa11111", text: "Thread", status: "open", created_at: "2026-01-01T00:00:00Z" },
    );
    vi.mocked(getThreads).mockReturnValue([]);

    const result = await resolveThread({ thread_id: "t-aaa11111" });

    expect(result.success).toBe(true);
    expect(result.also_resolved).toBeUndefined();
  });

  it("includes cascade count in performance result_count", async () => {
    mockThreads.push(
      { id: "t-orig1234", text: "Original", status: "open", created_at: "2026-01-01T00:00:00Z" },
      { id: "t-dupe5678", text: "Duplicate", status: "open", created_at: "2026-01-02T00:00:00Z" },
    );
    vi.mocked(getThreads).mockReturnValue([]);

    const result = await resolveThread({
      thread_id: "t-dupe5678",
      resolution_note: "Duplicate of t-orig1234",
    });

    expect(result.performance.result_count).toBe(2);
  });
});

/**
 * GIT-46: cross-session thread resolution.
 *
 * Bug: list_threads reads the Supabase SOT, but resolve_thread historically
 * matched only the local/session cache. A thread created by another session
 * was visible in list_threads yet returned "Thread not found" on resolve —
 * "visible-but-unresolvable" threads accumulate across sessions.
 *
 * Reproduces the bug at the unit level: local/session state is EMPTY (the
 * thread was created by a *different* session) while the thread exists in
 * Supabase. On unfixed `main` these are RED ("Thread not found"); after the
 * Supabase-fallback fix they pass. These run in `test:unit` (the suite CI
 * actually executes — see GIT-46 notes on integration tests not running in CI).
 */
describe("resolve_thread — cross-session resolution (GIT-46)", () => {
  // A thread that lives in the Supabase SOT but NOT in this session's cache.
  const remoteThread: ThreadObject = {
    id: "t-cafe0001",
    text: "Cross-session thread created by another session",
    status: "open",
    created_at: "2026-06-01T00:00:00Z",
  };

  beforeEach(() => {
    // Local/session state is empty — this session never saw the thread.
    vi.mocked(getThreads).mockReturnValue([]);
    mockThreads.length = 0;
  });

  it("case 1: resolves a thread created by another session via Supabase fallback", async () => {
    vi.mocked(getThreadFromSupabaseById).mockResolvedValue({ ...remoteThread });

    const result = await resolveThread({ thread_id: "t-cafe0001" });

    expect(result.success).toBe(true);
    expect(result.resolved_thread?.id).toBe("t-cafe0001");
    expect(result.resolved_thread?.status).toBe("resolved");
  });

  it("case 2: persists the resolution to the Supabase SOT (not just local cache)", async () => {
    vi.mocked(getThreadFromSupabaseById).mockResolvedValue({ ...remoteThread });

    await resolveThread({ thread_id: "t-cafe0001", resolution_note: "done in session B" });

    // Proves SOT update path was invoked for the cross-session thread id.
    expect(resolveThreadInSupabase).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolveThreadInSupabase).mock.calls[0][0]).toBe("t-cafe0001");
  });

  // ---- GIT-69 item 4 v1: project scope + audit trail (R9c) ----

  it("refuses a cross-project resolve and names the project", async () => {
    // Condition (1). getThreadFromSupabaseById filters on thread_id alone with
    // no project filter, so without this gate a caller in project A resolves
    // project B's thread outright.
    vi.mocked(getThreadOwnership).mockResolvedValue({
      thread_id: "t-cafe0001",
      project: "weekend_warrior",
      source_session: "other-session",
      status: "open",
    });
    vi.mocked(getThreadFromSupabaseById).mockResolvedValue({ ...remoteThread });

    const result = await resolveThread({ thread_id: "t-cafe0001" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("weekend_warrior");
    expect(result.error).toContain("Cross-project resolve is not permitted");
    // The refusal must be a refusal, not a silent no-op that still wrote.
    expect(resolveThreadInSupabase).not.toHaveBeenCalled();
  });

  it("returns ownership information on a miss rather than a bare not-found", async () => {
    // Condition (3). "Not found" for a thread that demonstrably exists reports
    // absence when the truth is that it wasn't reachable in this scope.
    vi.mocked(getThreadOwnership).mockResolvedValue({
      thread_id: "t-cafe0001",
      project: "default",
      source_session: "abcdef12-3456-7890-abcd-ef1234567890",
      status: "open",
    });
    vi.mocked(getThreadFromSupabaseById).mockResolvedValue(null);

    const result = await resolveThread({ thread_id: "t-cafe0001" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("abcdef12");
    expect(result.error).toContain("owned by session");
    expect(result.error).not.toBe('Thread not found: "t-cafe0001"');
  });

  it("names the owning session when resolving a thread this session does not own", async () => {
    // Condition (2). The audit trail is the price of the widened power — a
    // silent cross-session write is what project scope would otherwise buy.
    vi.mocked(getThreadFromSupabaseById).mockResolvedValue({
      ...remoteThread,
      source_session: "99887766-5544-3322-1100-aabbccddeeff",
    });

    const result = await resolveThread({ thread_id: "t-cafe0001" });

    expect(result.success).toBe(true);
    expect(result.display).toContain("Cross-session resolve");
    expect(result.display).toContain("99887766");
  });

  it("stays quiet when the caller owns the thread", async () => {
    // No audit line for the ordinary case — an always-on notice is noise, and
    // noise is how a real signal gets ignored.
    vi.mocked(getThreadFromSupabaseById).mockResolvedValue({
      ...remoteThread,
      source_session: "test-session",
    });

    const result = await resolveThread({ thread_id: "t-cafe0001" });

    expect(result.success).toBe(true);
    expect(result.display).not.toContain("Cross-session resolve");
  });

  it("case 3: resolves a cross-session thread by text_match too", async () => {
    vi.mocked(listThreadsFromSupabase).mockResolvedValue([{ ...remoteThread }]);

    const result = await resolveThread({ text_match: "another session" });

    expect(result.success).toBe(true);
    expect(result.resolved_thread?.id).toBe("t-cafe0001");
    expect(result.resolved_thread?.status).toBe("resolved");
    expect(vi.mocked(resolveThreadInSupabase).mock.calls[0][0]).toBe("t-cafe0001");
  });

  it("case 4 (regression guard): same-session resolve, #N, text_match, and cascade still work", async () => {
    // No Supabase fallback needed — everything is local.
    mockThreads.push(
      { id: "t-local001", text: "Local original thread", status: "open", created_at: "2026-01-01T00:00:00Z" },
      { id: "t-local002", text: "Local duplicate thread", status: "open", created_at: "2026-01-02T00:00:00Z" },
    );

    // same-session exact id
    const byId = await resolveThread({ thread_id: "t-local001" });
    expect(byId.success).toBe(true);

    // #N positional (only t-local002 remains open → "#1")
    const byPos = await resolveThread({ thread_id: "#1" });
    expect(byPos.success).toBe(true);
    expect(byPos.resolved_thread?.id).toBe("t-local002");

    // Supabase fallback must NOT be consulted when the thread is local
    expect(getThreadFromSupabaseById).not.toHaveBeenCalled();
  });

  it("still returns 'Thread not found' when the thread is in neither local nor Supabase", async () => {
    vi.mocked(getThreadFromSupabaseById).mockResolvedValue(null);
    vi.mocked(listThreadsFromSupabase).mockResolvedValue(null);

    const result = await resolveThread({ thread_id: "t-ghost999" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Thread not found");
  });
});

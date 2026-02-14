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
}));

vi.mock("../../../src/services/thread-supabase.js", () => ({
  resolveThreadInSupabase: vi.fn(() => Promise.resolve(true)),
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
import { resolveThreadInSupabase } from "../../../src/services/thread-supabase.js";
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

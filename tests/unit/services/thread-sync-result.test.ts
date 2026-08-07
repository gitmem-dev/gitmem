/**
 * Unit tests for syncThreadsToSupabase's outcome contract (GIT-69 item 3)
 *
 * syncThreadsToSupabase used to return void and swallow every per-thread error
 * to a console line marked "non-fatal". session_close then pruned the local
 * thread cache unconditionally — a destructive local operation gated on a
 * remote write whose result was never examined (scar cd345431, feedback
 * 11c313d0).
 *
 * These tests pin the outcome contract the prune gate depends on. If sync can
 * fail without saying so, the gate above it is decorative.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDirectQuery = vi.fn();
const mockDirectUpsert = vi.fn();
const mockIsConfigured = vi.fn(() => true);
const mockHasSupabase = vi.fn(() => true);

vi.mock("../../../src/services/supabase-client.js", () => ({
  isConfigured: (...a: unknown[]) => mockIsConfigured(...a),
  directQuery: (...a: unknown[]) => mockDirectQuery(...a),
  directUpsert: (...a: unknown[]) => mockDirectUpsert(...a),
  upsertRecord: vi.fn(),
  listRecords: vi.fn(),
}));

vi.mock("../../../src/services/tier.js", () => ({
  hasSupabase: (...a: unknown[]) => mockHasSupabase(...a),
  getTableName: (base: string) => `orchestra_${base}`,
  hasEmbeddings: () => false,
}));

const { syncThreadsToSupabase } = await import(
  "../../../src/services/thread-supabase.js"
);

const thread = (id: string, status = "open") => ({
  id,
  text: `thread ${id}`,
  status: status as "open" | "resolved",
  created_at: "2026-08-06T00:00:00.000Z",
});

beforeEach(() => {
  mockDirectQuery.mockReset();
  mockDirectUpsert.mockReset();
  mockIsConfigured.mockReturnValue(true);
  mockHasSupabase.mockReturnValue(true);
  mockDirectUpsert.mockResolvedValue([{ id: "row" }]);
});

describe("tier awareness (R3)", () => {
  it("reports skipped, not failed, when Supabase is not this tier's store", () => {
    // Free tier: the local file IS the SOT. There is nothing to sync, and
    // treating that as a failure would fail-close every free user's close.
    mockHasSupabase.mockReturnValue(false);

    return syncThreadsToSupabase([thread("t-a")], "gitmem", "s-1").then((r) => {
      expect(r.skipped).toBe(true);
      expect(r.all_synced).toBe(true);
      expect(r.failed).toEqual([]);
    });
  });

  it("reports skipped when the client is unconfigured", async () => {
    mockIsConfigured.mockReturnValue(false);
    const r = await syncThreadsToSupabase([thread("t-a")], "gitmem", "s-1");
    expect(r.skipped).toBe(true);
    expect(r.all_synced).toBe(true);
  });

  it("treats an empty thread list as success, not as skipped", async () => {
    const r = await syncThreadsToSupabase([], "gitmem", "s-1");
    expect(r.skipped).toBe(false);
    expect(r.all_synced).toBe(true);
    expect(r.attempted).toBe(0);
  });
});

describe("outcome reporting", () => {
  it("reports all_synced when every thread lands", async () => {
    // First call is the candidate load; the rest are per-thread lookups.
    mockDirectQuery.mockResolvedValue([]);

    const r = await syncThreadsToSupabase(
      [thread("t-a"), thread("t-b")],
      "gitmem",
      "s-1"
    );

    expect(r.all_synced).toBe(true);
    expect(r.attempted).toBe(2);
    expect(r.synced).toEqual(["t-a", "t-b"]);
    expect(r.failed).toEqual([]);
  });

  it("records a failed thread instead of swallowing it", async () => {
    mockDirectQuery
      .mockResolvedValueOnce([])                      // candidate load
      .mockRejectedValueOnce(new Error("boom"));      // t-a lookup

    const r = await syncThreadsToSupabase([thread("t-a")], "gitmem", "s-1");

    expect(r.all_synced).toBe(false);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].id).toBe("t-a");
    expect(r.failed[0].error).toContain("boom");
  });

  it("continues past a failure and reports the partial split", async () => {
    // A partial sync is still worth completing — but the miss must be named,
    // because the local file is the only remaining record of it.
    mockDirectQuery
      .mockResolvedValueOnce([])                          // candidate load
      .mockRejectedValueOnce(new Error("network"))        // t-a fails
      .mockResolvedValueOnce([]);                         // t-b succeeds

    const r = await syncThreadsToSupabase(
      [thread("t-a"), thread("t-b")],
      "gitmem",
      "s-1"
    );

    expect(r.attempted).toBe(2);
    expect(r.synced).toEqual(["t-b"]);
    expect(r.failed.map((f) => f.id)).toEqual(["t-a"]);
    expect(r.all_synced).toBe(false);
  });

  it("never reports all_synced while any thread failed", async () => {
    mockDirectQuery
      .mockResolvedValueOnce([])
      .mockRejectedValue(new Error("down"));

    const r = await syncThreadsToSupabase(
      [thread("t-a"), thread("t-b"), thread("t-c")],
      "gitmem",
      "s-1"
    );

    expect(r.failed).toHaveLength(3);
    expect(r.all_synced).toBe(false);
    // The prune gate reads exactly this field.
    expect(r.synced).toEqual([]);
  });

  it("names every missed id so the caller can report them", async () => {
    mockDirectQuery
      .mockResolvedValueOnce([])
      .mockRejectedValue(new Error("timeout"));

    const r = await syncThreadsToSupabase(
      [thread("t-aaa"), thread("t-bbb")],
      "gitmem",
      "s-1"
    );

    const ids = r.failed.map((f) => f.id);
    expect(ids).toContain("t-aaa");
    expect(ids).toContain("t-bbb");
    for (const f of r.failed) {
      expect(f.error).toBeTruthy();
    }
  });
});

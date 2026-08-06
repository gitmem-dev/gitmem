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
const mockDirectQueryAll = vi.fn();
const mockDirectUpsert = vi.fn();
const mockIsConfigured = vi.fn(() => true);
const mockHasSupabase = vi.fn(() => true);

vi.mock("../../../src/services/supabase-client.js", () => ({
  isConfigured: (...a: unknown[]) => mockIsConfigured(...a),
  directQuery: (...a: unknown[]) => mockDirectQuery(...a),
  directQueryAll: (...a: unknown[]) => mockDirectQueryAll(...a),
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
  mockDirectQueryAll.mockReset();
  // GIT-70: the dedup candidate set is loaded via paginated directQueryAll.
  // Empty by default so per-thread directQuery sequencing stays readable.
  mockDirectQueryAll.mockResolvedValue([]);
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
    mockDirectQuery.mockRejectedValueOnce(new Error("boom")); // t-a lookup

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
    mockDirectQuery.mockRejectedValue(new Error("down"));

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
    mockDirectQuery.mockRejectedValue(new Error("timeout"));

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

// ---------------------------------------------------------------------------
// GIT-70: dedup candidate completeness
// ---------------------------------------------------------------------------

describe("dedup candidate coverage (GIT-70)", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      thread_id: `t-${String(i).padStart(8, "0")}`,
      text: `existing ${i}`,
      status: "active",
    }));

  it("loads candidates with a deterministic total order", async () => {
    // Not cosmetic. PostgREST Range pagination over an unordered result set can
    // repeat and skip rows between pages, so without a total order the
    // pagination introduces the very gaps it was added to close. thread_id is
    // unique, so it orders totally on its own.
    mockDirectQuery.mockResolvedValue([]);
    await syncThreadsToSupabase([thread("t-a")], "gitmem", "s-1");

    const [, options] = mockDirectQueryAll.mock.calls[0] as [string, { order?: string }];
    expect(options.order).toBe("thread_id.asc");
  });

  it("reports complete coverage past the old 200-row window", async () => {
    // The defect: an unordered single page of 200 over a table already at 256.
    // A text match outside that window produced a silent duplicate.
    mockDirectQueryAll.mockResolvedValue(rows(256));
    mockDirectQuery.mockResolvedValue([]);

    const r = await syncThreadsToSupabase([thread("t-new")], "gitmem", "s-1");

    expect(r.dedup_coverage).toBe("complete");
    expect(r.dedup_candidates).toBe(256);
  });

  it("reports partial coverage rather than absorbing the cap", async () => {
    // directQueryAll stops at maxRows without saying so. Inheriting that
    // silence would rebuild the defect one layer up.
    mockDirectQueryAll.mockResolvedValue(rows(10000));
    mockDirectQuery.mockResolvedValue([]);

    const r = await syncThreadsToSupabase([thread("t-new")], "gitmem", "s-1");

    expect(r.dedup_coverage).toBe("partial");
    expect(r.dedup_candidates).toBe(10000);
  });

  it("reports unavailable when the candidate load fails", async () => {
    mockDirectQueryAll.mockRejectedValue(new Error("candidate load down"));
    mockDirectQuery.mockResolvedValue([]);

    const r = await syncThreadsToSupabase([thread("t-new")], "gitmem", "s-1");

    expect(r.dedup_coverage).toBe("unavailable");
  });

  it("still syncs successfully when coverage is incomplete", async () => {
    // Coverage and success are different axes. Every thread syncs by identity
    // regardless; incomplete coverage means a duplicate MAY exist, which
    // all_synced cannot detect because writing a duplicate IS a successful
    // write. This is the distinction the whole ticket rests on.
    mockDirectQueryAll.mockRejectedValue(new Error("down"));
    mockDirectQuery.mockResolvedValue([]);

    const r = await syncThreadsToSupabase([thread("t-new")], "gitmem", "s-1");

    expect(r.all_synced).toBe(true);
    expect(r.dedup_coverage).not.toBe("complete");
  });
});

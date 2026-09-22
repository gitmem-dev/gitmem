/**
 * GIT-105: thread triples reach knowledge_triples on a v1.8.0 store.
 *
 * source_id is a UUID column; thread ids are "t-xxxxxxxx". Every
 * create_thread / resolve_thread triple 400'd (22P02) and the failure was
 * swallowed. The writer now stores the thread's row id (gitmem_threads.id),
 * looking it up when the caller does not have it, and never sends a non-UUID.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({
  upserts: [] as Array<Record<string, unknown>>,
  queries: [] as Array<{ table: string; filters: Record<string, string> }>,
  threadRows: {} as Record<string, string>,
  queryFails: false,
}));

vi.mock("../../../src/services/supabase-client.js", () => ({
  directUpsert: vi.fn(async (_t: string, row: Record<string, unknown>) => { store.upserts.push(row); return row; }),
  directQuery: vi.fn(async (table: string, opts: { filters: Record<string, string> }) => {
    store.queries.push({ table, filters: opts.filters });
    if (store.queryFails) throw new Error("store down");
    const id = store.threadRows[opts.filters.thread_id];
    return id ? [{ id }] : [];
  }),
}));
vi.mock("../../../src/services/tier.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/services/tier.js")>()),
  hasSupabase: () => true,
}));

import { writeTriplesForThreadCreation, writeTriplesForThreadResolution, writeTriples } from "../../../src/services/triple-writer.js";

const ROW = "7d1c9a52-3f4e-4b8a-9c21-5e6f7a8b9c0d";
const SESSION = "550e8400-e29b-41d4-a716-446655440000";
const base = { thread_id: "t-abc12345", text: "Fix auth timeout", session_id: SESSION, project: "p", agent: "cli" };

beforeEach(() => {
  store.upserts = []; store.queries = []; store.threadRows = {}; store.queryFails = false;
});

describe("thread triples on a UUID source_id column (GIT-105)", () => {
  it("creation: uses the row id create_thread already has — no lookup", async () => {
    await writeTriplesForThreadCreation({ ...base, thread_row_id: ROW });
    expect(store.queries).toHaveLength(0);
    expect(store.upserts.map((r) => r.source_id)).toEqual([ROW]);
  });

  it("resolution: looks the row id up by thread_id", async () => {
    store.threadRows["t-abc12345"] = ROW;
    await writeTriplesForThreadResolution(base);
    expect(store.queries).toEqual([{ table: "gitmem_threads", filters: { thread_id: "t-abc12345" } }]);
    expect(store.upserts.map((r) => r.source_id)).toEqual([ROW]);
  });

  it("thread not in the store, or the lookup fails: source_id null, triple still written", async () => {
    await writeTriplesForThreadResolution(base);
    store.queryFails = true;
    await writeTriplesForThreadResolution(base);
    expect(store.upserts.map((r) => r.source_id)).toEqual([null, null]);
  });

  it("never sends a non-UUID source_id, whatever the caller passed", async () => {
    await writeTriples([{ subject: "s", predicate: "created_thread", object: "o", source_type: "thread",
      source_id: "t-abc12345", project: "p", half_life_days: 9999, created_by: "cli" }]);
    expect(store.upserts[0].source_id).toBeNull();
  });
});

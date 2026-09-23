/**
 * GIT-93: the retrieval RPCs must be called by the name that is actually
 * deployed, which is derived from the TABLE being searched.
 *
 * scarSearch and semanticSearch built their RPC name by taking the table prefix
 * and appending a verb: `${prefix}_scar_search` / `${prefix}_semantic_search`.
 * That produced "orchestra_scar_search" under GITMEM_TABLE_PREFIX=orchestra_ and
 * "gitmem_scar_search" by default. A survey of the functions PostgREST exposes
 * found neither, under any prefix — the deployed names are match_<table> and
 * match_<table>_weighted. Every call returned PGRST202.
 *
 * It went unnoticed because these are fallbacks: recall only reaches them while
 * the local vector index is still loading. In that window — which includes the
 * first recall of every session, the one the SessionStart hook triggers —
 * retrieval returned nothing at all.
 *
 * These tests assert the URL rather than the response, because the defect was
 * entirely in name construction. They are hermetic: fetch is stubbed, so they
 * fail on a wrong name rather than on network conditions, and they hold for a
 * deployment whose functions this developer cannot reach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ORIGINAL_ENV = { ...process.env };

/** Captures the URL and body of the single fetch each search performs. */
function stubFetch(): { calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });
    return {
      ok: true,
      status: 200,
      json: async () => [],
      text: async () => "[]",
    } as unknown as Response;
  }));
  return { calls };
}

async function loadClient(prefix: string) {
  process.env.GITMEM_TABLE_PREFIX = prefix;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  process.env.GITMEM_TIER = "pro";
  // Reset the module registry so SUPABASE_URL and the prefix are re-read.
  vi.resetModules();
  vi.doMock("../../../src/services/embedding.js", () => ({
    embed: async () => new Array(1536).fill(0.01),
  }));
  return import("../../../src/services/supabase-client.js");
}

describe("GIT-93: retrieval RPC names are derived from the table, not the prefix", () => {
  beforeEach(() => { vi.resetModules(); });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("../../../src/services/embedding.js");
    process.env = { ...ORIGINAL_ENV };
  });

  it("scarSearch calls match_<table>_weighted under a non-default prefix", async () => {
    const { calls } = stubFetch();
    const client = await loadClient("orchestra_");

    await client.scarSearch("any query", 3);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/rest/v1/rpc/match_orchestra_learnings_weighted");
    // The name that was being built before the fix. Asserted explicitly so this
    // test fails loudly if the prefix-plus-verb construction ever returns.
    expect(calls[0].url).not.toContain("orchestra_scar_search");
  });

  it("scarSearch sends match_threshold, which is what the weighted function takes", async () => {
    const { calls } = stubFetch();
    const client = await loadClient("orchestra_");

    await client.scarSearch("any query", 3);

    // The unweighted variant takes similarity_threshold; sending the wrong one
    // to the weighted function silently loses the threshold.
    expect(calls[0].body).toHaveProperty("match_threshold");
    expect(calls[0].body).not.toHaveProperty("similarity_threshold");
  });

  it("scarSearch does not narrow the fallback to one project", async () => {
    const { calls } = stubFetch();
    const client = await loadClient("orchestra_");

    await client.scarSearch("any query", 3);

    // It stands in for the unified CROSS-PROJECT vector cache. Filtering here
    // would make the cold path return a narrower set than the warm path.
    expect(calls[0].body).not.toHaveProperty("project_filter");
  });

  // GIT-114: this used to assert match_gitmem_learnings_weighted for the
  // default prefix — the name GIT-93 took from nTEG's store. No setup.sql
  // defines it, so every customer's cold-index recall got PGRST202. The
  // default prefix now calls setup.sql's function first.
  it("default prefix: calls setup.sql's gitmem_scar_search with similarity_threshold", async () => {
    const { calls } = stubFetch();
    const client = await loadClient("gitmem_");

    await client.scarSearch("any query", 3);

    expect(calls[0].url).toMatch(/\/rest\/v1\/rpc\/gitmem_scar_search$/);
    expect(calls[0].body).toHaveProperty("similarity_threshold", 0);
    expect(calls[0].body).not.toHaveProperty("match_threshold");
    expect(calls[0].body).not.toHaveProperty("project_filter");
  });
});

// ---------------------------------------------------------------------------
// GIT-114: fallback and missing columns
// ---------------------------------------------------------------------------

type Reply = { status: number; body: unknown };
function scriptedFetch(replies: Array<(url: string) => Reply | null>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });
    let r: Reply | null = null;
    for (const f of replies) { r = f(String(url)); if (r) break; }
    r = r ?? { status: 200, body: [] };
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return { ok: r.status < 300, status: r.status, json: async () => JSON.parse(text), text: async () => text } as unknown as Response;
  }));
  return { calls };
}
const PGRST202 = { status: 404, body: '{"code":"PGRST202","message":"Could not find the function"}' };
const SCAR = { id: "11111111-2222-4333-8444-555555555555", title: "t", description: "d", severity: "high", similarity: 0.8 };

describe("GIT-114: remote scar search on a setup.sql store", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("../../../src/services/embedding.js");
    process.env = { ...ORIGINAL_ENV };
  });

  it("a store without gitmem_scar_search (PGRST202) falls back to match_gitmem_learnings_weighted, and remembers it", async () => {
    const { calls } = scriptedFetch([
      (u) => (u.endsWith("/rpc/gitmem_scar_search") ? PGRST202 : null),
      (u) => (u.endsWith("/rpc/match_gitmem_learnings_weighted") ? { status: 200, body: [{ ...SCAR, learning_type: "scar" }] } : null),
    ]);
    const client = await loadClient("gitmem_");

    const rows = await client.scarSearch("q", 3);
    expect(rows).toHaveLength(1);
    expect(calls.map((c) => c.url.split("/rpc/")[1])).toEqual(["gitmem_scar_search", "match_gitmem_learnings_weighted"]);
    expect(calls[1].body).toHaveProperty("match_threshold");

    calls.length = 0;
    await client.scarSearch("q", 3);
    expect(calls.map((c) => c.url.split("/rpc/")[1])).toEqual(["match_gitmem_learnings_weighted"]);
  });

  it("a real error from an existing function is not retried under another name", async () => {
    const { calls } = scriptedFetch([(u) => (u.includes("/rpc/") ? { status: 500, body: "boom" } : null)]);
    const client = await loadClient("gitmem_");
    await expect(client.scarSearch("q", 3)).rejects.toThrow(/500/);
    expect(calls).toHaveLength(1);
  });

  it("fetches the columns gitmem_scar_search does not return, by id, in one request", async () => {
    const { calls } = scriptedFetch([
      (u) => (u.endsWith("/rpc/gitmem_scar_search") ? { status: 200, body: [SCAR] } : null),
      (u) => (u.includes("/rest/v1/gitmem_learnings?") ? { status: 200, body: [{ id: SCAR.id, learning_type: "scar", applies_when: ["deploy"], why_this_matters: "w" }] } : null),
    ]);
    const client = await loadClient("gitmem_");

    const [row] = await client.scarSearch<Record<string, unknown>>("q", 3);
    expect(row).toMatchObject({ ...SCAR, learning_type: "scar", applies_when: ["deploy"], why_this_matters: "w" });
    const follow = new URL(calls[1].url);
    expect(follow.searchParams.get("id")).toBe(`in.(${SCAR.id})`);
    expect(follow.searchParams.get("select")).toContain("learning_type");
  });

  it("if the follow-up select fails, the matched scars are still returned", async () => {
    scriptedFetch([
      (u) => (u.endsWith("/rpc/gitmem_scar_search") ? { status: 200, body: [SCAR] } : null),
      (u) => (u.includes("/rest/v1/gitmem_learnings?") ? { status: 503, body: "down" } : null),
    ]);
    const client = await loadClient("gitmem_");
    const rows = await client.scarSearch<Record<string, unknown>>("q", 3);
    expect(rows).toEqual([SCAR]);
  });
});

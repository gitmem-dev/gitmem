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

  it("semanticSearch calls match_<table>", async () => {
    const { calls } = stubFetch();
    const client = await loadClient("orchestra_");

    await client.semanticSearch({ query: "any query", match_count: 5 });

    expect(calls[0].url).toContain("/rest/v1/rpc/match_orchestra_learnings");
    expect(calls[0].url).not.toContain("orchestra_semantic_search");
  });

  it("tracks the prefix rather than hardcoding one deployment's table", async () => {
    const { calls } = stubFetch();
    const client = await loadClient("gitmem_");

    await client.scarSearch("any query", 3);

    expect(calls[0].url).toContain("/rest/v1/rpc/match_gitmem_learnings_weighted");
  });
});

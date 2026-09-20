/**
 * GIT-97: listRecords / getRecord must reach Supabase over PostgREST only.
 *
 * The package ships no data-access edge function, so a customer project
 * provisioned from schema/setup.sql has none. These tests pin the transport:
 * if a read ever goes back to /functions/v1/*, they fail.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const SUPABASE_URL = "https://customer-project.supabase.co";

async function loadClient() {
  vi.resetModules();
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  return import("../../../src/services/supabase-client.js");
}

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

describe("supabase-client transport (GIT-97)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => okJson([]));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("listRecords calls PostgREST and never an edge function", async () => {
    const client = await loadClient();
    await client.listRecords({
      table: "gitmem_sessions_lite",
      filters: { agent: "cli", project: "dev-suite" },
      limit: 10,
      orderBy: { column: "created_at", ascending: false },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [rawUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(rawUrl);

    expect(url.pathname).toBe("/rest/v1/gitmem_sessions_lite");
    expect(rawUrl).not.toContain("/functions/v1/");
    expect(init.method).toBe("GET");
    expect(url.searchParams.get("agent")).toBe("eq.cli");
    expect(url.searchParams.get("project")).toBe("eq.dev-suite");
    expect(url.searchParams.get("order")).toBe("created_at.desc");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("select")).toBe("*");
  });

  it("treats a filter value containing '.' as data, not as an operator", async () => {
    const client = await loadClient();
    await client.listRecords({
      table: "gitmem_learnings_lite",
      columns: "id,title",
      filters: { title: "Done != Deployed. Verify the row." },
    });

    const url = new URL((fetchMock.mock.calls[0] as [string])[0]);
    expect(url.searchParams.get("title")).toBe("eq.Done != Deployed. Verify the row.");
    expect(url.searchParams.get("select")).toBe("id,title");
  });

  it("maps null and boolean filters to PostgREST is.*", async () => {
    const client = await loadClient();
    await client.listRecords({ table: "gitmem_learnings_lite", filters: { archived_at: null, is_active: true } });

    const url = new URL((fetchMock.mock.calls[0] as [string])[0]);
    expect(url.searchParams.get("archived_at")).toBe("is.null");
    expect(url.searchParams.get("is_active")).toBe("is.true");
  });

  it("getRecord filters by id over PostgREST and returns null when absent", async () => {
    const client = await loadClient();
    const missing = await client.getRecord("gitmem_sessions", "07ac0fc5-13af-4f63-8ff9-6be604022aa4");
    expect(missing).toBeNull();

    const url = new URL((fetchMock.mock.calls[0] as [string])[0]);
    expect(url.pathname).toBe("/rest/v1/gitmem_sessions");
    expect(url.searchParams.get("id")).toBe("eq.07ac0fc5-13af-4f63-8ff9-6be604022aa4");
    expect(url.searchParams.get("limit")).toBe("1");

    fetchMock.mockResolvedValueOnce(okJson([{ id: "abc", project: "gitmem" }]));
    const found = await client.getRecord<{ id: string }>("gitmem_sessions", "abc");
    expect(found).toEqual({ id: "abc", project: "gitmem" });
  });

  it("surfaces a REST failure as an error naming the status", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "relation does not exist" } as unknown as Response);
    const client = await loadClient();
    await expect(client.listRecords({ table: "nope" })).rejects.toThrow(/Supabase REST error: 404/);
  });

  it("no source file references the ww-mcp edge function in code", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../../src/services/supabase-client.ts", import.meta.url), "utf-8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).not.toContain("functions/v1");
    expect(code).not.toContain("callMcp");
  });
});

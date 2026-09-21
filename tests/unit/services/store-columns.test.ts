/**
 * Store capability probe (overriding rule: never write a column or table the
 * store lacks).
 *
 * A store provisioned from setup.sql has none of nTEG's production-only
 * session columns. Sending one failed the whole session_close upsert
 * (PGRST204) — reproduced on a blank Supabase with 1.9.0: a close that carried
 * observations or a Claude Code session id was lost.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const directQuery = vi.fn();
vi.mock("../../../src/services/supabase-client.js", () => ({
  directQuery: (...a: unknown[]) => directQuery(...a),
}));

const { supportedColumns, storeHasTable, resetStoreColumnCache } = await import("../../../src/services/store-columns.js");
const { filterToStoreSessionColumns, PRODUCTION_ONLY_SESSION_COLUMNS, SESSION_COLUMNS } = await import(
  "../../../src/services/session-columns.js"
);

const missingColumn = (col: string) =>
  new Error(`Supabase REST error: 400 - {"code":"42703","message":"column gitmem_sessions.${col} does not exist"}`);

/** A store whose tables have exactly these columns (plus id). */
function storeWith(columns: Record<string, string[]>) {
  directQuery.mockImplementation(async (table: string, opts: { select: string }) => {
    if (!(table in columns)) throw new Error(`Supabase REST error: 404 - {"code":"PGRST205","message":"Could not find the table 'public.${table}'"}`);
    const have = new Set(["id", ...columns[table]]);
    const missing = opts.select.split(",").find((c) => !have.has(c));
    if (missing) throw missingColumn(missing);
    return [];
  });
}

beforeEach(() => {
  resetStoreColumnCache();
});

describe("supportedColumns", () => {
  it("answers in one read-only request when every column exists, then from cache", async () => {
    storeWith({ gitmem_sessions: ["children", "task_observations"] });
    expect(await supportedColumns("gitmem_sessions", ["children", "task_observations"])).toEqual(new Set(["children", "task_observations"]));
    expect(directQuery).toHaveBeenCalledTimes(1);
    expect(directQuery).toHaveBeenCalledWith("gitmem_sessions", { select: "children,task_observations", limit: 1 });

    await supportedColumns("gitmem_sessions", ["task_observations"]);
    expect(directQuery).toHaveBeenCalledTimes(1); // cached
  });

  it("finds which columns are missing, one at a time", async () => {
    storeWith({ gitmem_sessions: ["children"] });
    expect(await supportedColumns("gitmem_sessions", ["children", "task_observations"])).toEqual(new Set(["children"]));
  });

  it("treats a failed probe (not 'does not exist') as absent and does not cache it", async () => {
    directQuery.mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"));
    expect(await supportedColumns("gitmem_learnings", ["archived_at"])).toEqual(new Set());

    storeWith({ gitmem_learnings: ["archived_at"] });
    expect(await supportedColumns("gitmem_learnings", ["archived_at"])).toEqual(new Set(["archived_at"]));
  });

  it("storeHasTable is false for a table the store does not have", async () => {
    storeWith({ gitmem_sessions: [] });
    expect(await storeHasTable("gitmem_transcript_chunks")).toBe(false);
    expect(await storeHasTable("gitmem_sessions")).toBe(true);
  });
});

describe("filterToStoreSessionColumns", () => {
  const closeRow = {
    id: "s1",
    session_title: "t",
    closing_reflection: { what_worked: "x" },
    close_compliance: { close_type: "standard" },
    task_observations: [{ text: "obs" }],
    children: [{ id: "c1" }],
    claude_code_session_id: "cc-1",
    display: "local-only rendering field",
  };

  it("on a setup.sql store: drops production-only columns, keeps every canonical one", async () => {
    storeWith({ gitmem_sessions: [] });
    const row = await filterToStoreSessionColumns(closeRow, "gitmem_sessions");
    expect(row).toEqual({
      id: "s1",
      session_title: "t",
      closing_reflection: { what_worked: "x" },
      close_compliance: { close_type: "standard" },
    });
  });

  it("on nTEG's store: keeps the production-only columns it has", async () => {
    storeWith({ orchestra_sessions: [...PRODUCTION_ONLY_SESSION_COLUMNS] });
    const row = await filterToStoreSessionColumns(closeRow, "orchestra_sessions");
    expect(row).toMatchObject({ task_observations: [{ text: "obs" }], children: [{ id: "c1" }], claude_code_session_id: "cc-1" });
    expect(row).not.toHaveProperty("display");
  });

  it("does not probe when the row has no production-only keys", async () => {
    await filterToStoreSessionColumns({ id: "s1", session_title: "t" }, "gitmem_sessions");
    expect(directQuery).not.toHaveBeenCalled();
  });

  it("the production-only set is exactly SESSION_COLUMNS minus setup.sql's columns", () => {
    for (const c of PRODUCTION_ONLY_SESSION_COLUMNS) expect(SESSION_COLUMNS.has(c)).toBe(true);
  });
});

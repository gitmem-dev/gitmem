/**
 * GIT-73: a metrics row never references a session row that is not there yet.
 *
 * session_start created its session row fire-and-forget and wrote its metrics
 * row at the same moment; gitmem_query_metrics.session_id is an FK to
 * gitmem_sessions(id), so whichever arrived first decided whether the metrics
 * insert 409'd.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const writes = vi.hoisted(() => ({ log: [] as Array<{ table: string; row: Record<string, unknown>; at: number }> }));

vi.mock("../../../src/services/supabase-client.js", () => ({
  directUpsert: vi.fn(async (table: string, row: Record<string, unknown>) => {
    writes.log.push({ table, row, at: Date.now() });
    return row;
  }),
}));
vi.mock("../../../src/services/tier.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/services/tier.js")>()),
  hasSupabase: () => true,
}));

import { recordMetrics, registerPendingSessionRow, clearPendingSessionRows } from "../../../src/services/metrics.js";

const SID = "393adb34-a80c-4c3a-b71a-bc0053b7a7ea";
const metric = (extra: Record<string, unknown> = {}) => ({
  id: "m-" + Math.random().toString(16).slice(2), session_id: SID, tool_name: "session_start",
  latency_ms: 1, result_count: 0, metadata: { project: "p" }, ...extra,
}) as never;

beforeEach(() => { writes.log = []; clearPendingSessionRows(); });

describe("metrics wait for their session row (GIT-73)", () => {
  it("waits until the session row has landed, then keeps the FK", async () => {
    let land!: (v: boolean) => void;
    registerPendingSessionRow(SID, new Promise<boolean>((r) => (land = r)));

    const pending = recordMetrics(metric());
    await new Promise((r) => setTimeout(r, 30));
    expect(writes.log).toHaveLength(0); // held back while the session row is in flight

    land(true);
    await pending;
    expect(writes.log).toHaveLength(1);
    expect(writes.log[0].row.session_id).toBe(SID);
  });

  it("a session row that did not land: no FK, id kept in metadata.session_id", async () => {
    registerPendingSessionRow(SID, Promise.resolve(false));
    await recordMetrics(metric());
    expect(writes.log[0].row.session_id).toBeNull();
    expect(writes.log[0].row.metadata).toEqual({ project: "p", session_id: SID });
  });

  it("a session row whose creation threw is treated as not landed", async () => {
    registerPendingSessionRow(SID, Promise.reject(new Error("store down")));
    await recordMetrics(metric());
    expect(writes.log[0].row.session_id).toBeNull();
  });

  it("later writes for the same session reuse the settled answer", async () => {
    registerPendingSessionRow(SID, Promise.resolve(true));
    await recordMetrics(metric());
    await recordMetrics(metric({ tool_name: "recall" }));
    expect(writes.log.map((w) => w.row.session_id)).toEqual([SID, SID]);
  });

  it("a session this process did not create (resumed, or another process's) is written immediately", async () => {
    await recordMetrics(metric());
    expect(writes.log).toHaveLength(1);
    expect(writes.log[0].row.session_id).toBe(SID);
  });
});

/**
 * GIT-102: checkWritePath's verdicts, store mocked at the client.
 *
 * A probe that errors for any reason other than a missing table used to be
 * ignored, so a store refusing every connection was reported "Write-path OK".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const probe = vi.hoisted(() => ({ impl: async (): Promise<unknown[]> => [] }));

vi.mock("../../../src/services/supabase-client.js", () => ({
  isConfigured: () => true,
  directQuery: vi.fn(() => probe.impl()),
}));
vi.mock("../../../src/services/tier.js", () => ({
  getTier: () => "pro",
  hasSupabase: () => true,
  getTablePrefix: () => "gitmem_",
  getTableName: (b: string) => `gitmem_${b}`,
}));

import { checkWritePath } from "../../../src/services/write-health.js";

beforeEach(() => { probe.impl = async () => []; });

describe("checkWritePath verdicts (GIT-102)", () => {
  it("tables answer: supabase, ok", async () => {
    expect(await checkWritePath()).toEqual({ ok: true, mode: "supabase" });
  });

  it("a missing table: missing_tables", async () => {
    probe.impl = async () => { throw new Error("PGRST205 Could not find the table"); };
    expect(await checkWritePath()).toMatchObject({ ok: false, mode: "missing_tables", missing: ["gitmem_learnings", "gitmem_decisions"] });
  });

  it("the store refuses the connection: unreachable, NOT ok (was: Write-path OK)", async () => {
    probe.impl = async () => { throw new TypeError("fetch failed: ECONNREFUSED"); };
    const r = await checkWritePath();
    expect(r.ok).toBe(false);
    expect(r.mode).toBe("unreachable");
    expect(r.error).toContain("ECONNREFUSED");
  });

  it("an auth failure is unreachable too, not OK", async () => {
    probe.impl = async () => { throw new Error("Supabase query error: 401 - Invalid API key"); };
    expect(await checkWritePath()).toMatchObject({ ok: false, mode: "unreachable" });
  });
});

/**
 * GIT-108: analytics must only select columns the usage table actually has.
 *
 * queryScarUsageByDateRange selected scar_title and scar_severity, which
 * gitmem_scar_usage has never had, so the analytics and blindspot reads
 * returned a 400 (column does not exist) on every store. Title and severity now
 * come from the learnings table via enrichScarUsageTitles().
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const directQueryAll = vi.fn();
const directQuery = vi.fn();

vi.mock("../../../src/services/supabase-client.js", () => ({
  directQueryAll: (...a: unknown[]) => directQueryAll(...a),
  directQuery: (...a: unknown[]) => directQuery(...a),
  safeInFilter: (ids: string[]) => `in.(${ids.join(",")})`,
}));
vi.mock("../../../src/services/cache.js", () => ({
  getCache: () => ({
    getOrFetchScarUsage: async (_p: unknown, _d: unknown, _a: unknown, fetch: () => Promise<unknown>) => ({ data: await fetch() }),
  }),
}));

const { queryScarUsageByDateRange, enrichScarUsageTitles } = await import("../../../src/services/analytics.js");

/** Columns of gitmem_scar_usage as setup.sql creates them (CREATE TABLE + ADD COLUMN migrations). */
function scarUsageColumns(): Set<string> {
  const sql = readFileSync(join(__dirname, "../../../schema/setup.sql"), "utf-8");
  const create = sql.match(/CREATE TABLE IF NOT EXISTS gitmem_scar_usage \(([\s\S]*?)\n\);/)![1];
  const cols = create.split("\n").map((l) => l.trim().match(/^([a-z_]+)\s+[A-Z]/)?.[1]).filter(Boolean) as string[];
  for (const m of sql.matchAll(/ALTER TABLE gitmem_scar_usage ADD COLUMN IF NOT EXISTS ([a-z_]+)/g)) cols.push(m[1]);
  return new Set(cols);
}

describe("analytics scar-usage query (GIT-108)", () => {
  it("selects only columns that gitmem_scar_usage has", async () => {
    directQueryAll.mockResolvedValue([]);
    await queryScarUsageByDateRange("2026-01-01T00:00:00Z", "2026-12-31T00:00:00Z", "default");

    const [table, opts] = directQueryAll.mock.calls[0] as [string, { select: string }];
    expect(table).toBe("gitmem_scar_usage");
    const selected = opts.select.split(",");
    const known = scarUsageColumns();
    expect(known.has("scar_id")).toBe(true); // sanity: the parser found the table
    expect(selected.filter((c) => !known.has(c))).toEqual([]);
    expect(selected).not.toContain("scar_title");
    expect(selected).not.toContain("scar_severity");
  });

  it("returns null title/severity for enrichment to fill from learnings", async () => {
    directQueryAll.mockResolvedValue([
      { scar_id: "s1", agent: "cli", reference_type: "acknowledged", execution_successful: null, surfaced_at: "2026-09-01T00:00:00Z" },
    ]);
    directQuery.mockResolvedValue([{ id: "s1", title: "Dry-run migrations first", severity: "high" }]);

    const raw = await queryScarUsageByDateRange("2026-01-01T00:00:00Z", "2026-12-31T00:00:00Z", "default");
    expect(raw[0]).toMatchObject({ scar_id: "s1", scar_title: null, scar_severity: null });

    const enriched = await enrichScarUsageTitles(raw);
    expect(directQuery).toHaveBeenCalledWith("gitmem_learnings", expect.objectContaining({ select: "id,title,severity" }));
    expect(enriched[0]).toMatchObject({ scar_title: "Dry-run migrations first", scar_severity: "high" });
  });
});

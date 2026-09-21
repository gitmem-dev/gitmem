/**
 * schema/setup.sql must be safe to apply twice (GIT-84).
 *
 * Customers re-run setup.sql to pick up schema changes. CREATE POLICY and
 * CREATE TRIGGER have no IF NOT EXISTS, so each needs a DROP ... IF EXISTS
 * first; one missing pair (gitmem_licenses) made the second run fail at
 * statement 72 on a real Supabase.
 *
 * Also pins the GIT-84 guard on refresh_scar_behavioral_scores(): rows whose
 * decay_multiplier would not change must not be rewritten, because the rewrite
 * bumps updated_at and invalidates every client's GIT-98 disk cache.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SQL = readFileSync(join(__dirname, "../../schema/setup.sql"), "utf-8")
  // strip -- comments so commented-out statements don't count
  .replace(/--[^\n]*/g, "");

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

describe("schema/setup.sql re-apply safety (GIT-84)", () => {
  it("drops every policy before creating it", () => {
    const created = [...SQL.matchAll(/CREATE POLICY\s+("[^"]+")\s+ON\s+([\w.]+)/gi)].map((m) => `${m[1]} ON ${m[2]}`);
    expect(created.length).toBeGreaterThan(0);
    const missing = created.filter((p) => {
      const [name, table] = p.split(" ON ");
      const drop = new RegExp(`DROP POLICY IF EXISTS\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+ON\\s+${table}\\s*;`, "i");
      const dropAt = SQL.search(drop);
      const createAt = SQL.search(new RegExp(`CREATE POLICY\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+ON\\s+${table}\\b`, "i"));
      return dropAt < 0 || dropAt > createAt;
    });
    expect(missing).toEqual([]);
  });

  it("drops every trigger before creating it", () => {
    const created = [...SQL.matchAll(/CREATE TRIGGER\s+(\w+)[\s\S]*?\bON\s+([\w.]+)/gi)].map((m) => [m[1], m[2]]);
    expect(created.length).toBeGreaterThan(0);
    const missing = created.filter(([name, table]) => !new RegExp(`DROP TRIGGER IF EXISTS\\s+${name}\\s+ON\\s+${table}\\s*;`, "i").test(SQL));
    expect(missing).toEqual([]);
  });

  it("creates tables and indexes with IF NOT EXISTS", () => {
    const bare = [...SQL.matchAll(/CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+(?!IF NOT EXISTS)(\w+)/gi)].map((m) => `${m[1]} ${m[2]}`);
    expect(bare).toEqual([]);
  });

  it("refresh_scar_behavioral_scores() only rewrites rows whose multiplier changes", () => {
    const fn = SQL.slice(SQL.search(/CREATE OR REPLACE FUNCTION refresh_scar_behavioral_scores/i));
    const update = norm(fn.slice(0, fn.indexOf("GET DIAGNOSTICS")));
    const expr = "greatest(0.1, 1.0 - (us.times_dismissed::float / us.times_surfaced::float) * 0.8)";
    expect(update).toContain(`set decay_multiplier = ${expr}`);
    expect(update).toContain(`and l.decay_multiplier is distinct from ${expr}`);
  });
});

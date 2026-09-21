/**
 * Guard: Supabase table names must go through getTableName() (GIT-84).
 *
 * The user schema is prefixed (gitmem_ by default, GITMEM_TABLE_PREFIX to
 * override). A bare literal like "scar_usage" passed straight to PostgREST
 * silently 404s on every customer project — that is how scar usage was lost.
 *
 * Checked:
 *   - directUpsert / directQuery / directQueryAll / directPatch whose table
 *     argument is a string literal
 *   - `table: "..."` option objects (listRecords and friends)
 *   - REST URLs built as `${SUPABASE_REST_URL}/name` or `/rest/v1/name`
 * The storage layer (getStorage().upsert/query/get) takes a COLLECTION name
 * and applies the prefix itself, so there the rule is reversed: passing a
 * prefixed name or getTableName() would double-prefix.
 *
 * Known literals awaiting a ruling are allowlisted below, each with a reason.
 * Removing an entry is the point — the list should only shrink.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const SRC = join(__dirname, "../../src");

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * Literal table names that setup.sql creates under exactly that name (or that
 * live outside the user schema). Changing the code alone would break them, so
 * they stay literal until ruled on. Keyed by table name.
 */
const ALLOWED_LITERALS: Record<string, string> = {
  gitmem_query_metrics: "setup.sql creates it with a hard-coded gitmem_ prefix — ruling needed (GIT-84 sweep)",
  knowledge_triples: "setup.sql creates it unprefixed — ruling needed (GIT-84 sweep)",
  scar_enforcement_variants: "setup.sql creates it unprefixed; column drift tracked in GIT-106",
  variant_assignments: "not created by setup.sql at all — ruling needed (GIT-84 sweep)",
  variant_performance_metrics: "not created by setup.sql at all — ruling needed (GIT-84 sweep)",
  community_feedback: "gitmem's own feedback endpoint (feedback-remote.ts), not the user schema",
};

/** Files that build REST URLs for diagnostics with a literal prefix — ruling needed (GIT-84 sweep). */
const ALLOWED_URL_FILES = new Set(["src/commands/check.ts"]);

const DIRECT_CALL = /\b(directUpsert|directQuery|directQueryAll|directPatch)\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\s*\(\s*(["'`])([A-Za-z_][\w]*)\2/g;
const TABLE_OPTION = /\btable:\s*(["'`])([A-Za-z_][\w]*)\1/g;
const REST_URL = /(?:SUPABASE_REST_URL\}|\/rest\/v1)\/([A-Za-z_][\w]*)/g;
const STORAGE_CALL = /\b(?:storage|getStorage\(\))\s*\.\s*(upsert|query|get)\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\s*\(\s*([^,)]+)/g;

interface Finding { file: string; line: number; text: string }

function scan(): { bare: Finding[]; doublePrefixed: Finding[]; allowlistedSeen: Set<string> } {
  const bare: Finding[] = [];
  const doublePrefixed: Finding[] = [];
  const allowlistedSeen = new Set<string>();

  for (const full of collectTsFiles(SRC)) {
    const file = relative(join(SRC, ".."), full);
    const src = readFileSync(full, "utf-8");
    const lineOf = (i: number) => src.slice(0, i).split("\n").length;
    const flag = (name: string, i: number, text: string) => {
      if (name in ALLOWED_LITERALS) { allowlistedSeen.add(name); return; }
      bare.push({ file, line: lineOf(i), text });
    };

    for (const m of src.matchAll(DIRECT_CALL)) flag(m[3], m.index!, `${m[1]}("${m[3]}")`);
    for (const m of src.matchAll(TABLE_OPTION)) flag(m[2], m.index!, `table: "${m[2]}"`);
    for (const m of src.matchAll(REST_URL)) {
      if (m[1] === "rpc") continue; // RPC function names are not tables
      if (ALLOWED_URL_FILES.has(file)) continue;
      flag(m[1], m.index!, `REST /${m[1]}`);
    }
    for (const m of src.matchAll(STORAGE_CALL)) {
      const arg = m[2].trim();
      if (/getTableName\s*\(/.test(arg) || /^["'`]gitmem_/.test(arg)) {
        doublePrefixed.push({ file, line: lineOf(m.index!), text: `storage.${m[1]}(${arg})` });
      }
    }
  }
  return { bare, doublePrefixed, allowlistedSeen };
}

describe("Supabase table names go through getTableName() (GIT-84)", () => {
  const { bare, doublePrefixed, allowlistedSeen } = scan();
  const fmt = (fs: Finding[]) => fs.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");

  it("passes no bare table-name literal to directUpsert/directQuery/directQueryAll/directPatch, table: options or REST URLs", () => {
    expect(fmt(bare), "wrap these in getTableName(<base name>)").toBe("");
  });

  it("never hands the storage layer an already-prefixed name (it prefixes collections itself)", () => {
    expect(fmt(doublePrefixed), "pass the bare collection name to storage").toBe("");
  });

  it("keeps the allowlist honest: every entry is still in use", () => {
    const stale = Object.keys(ALLOWED_LITERALS).filter((name) => !allowlistedSeen.has(name));
    expect(stale, "remove allowlist entries that no longer occur").toEqual([]);
  });

  it("would catch the GIT-84 bug (self-test on a synthetic source)", () => {
    const sample = `await supabase.directUpsert<{ id: string }>(\n  "scar_usage",\n  record\n);`;
    const hits = [...sample.matchAll(DIRECT_CALL)].map((m) => m[3]);
    expect(hits).toEqual(["scar_usage"]);
    expect([...`new URL(\`\${SUPABASE_REST_URL}/scar_usage\`)`.matchAll(REST_URL)].map((m) => m[1])).toEqual(["scar_usage"]);
  });
});

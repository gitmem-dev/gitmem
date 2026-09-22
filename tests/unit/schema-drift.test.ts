/**
 * GIT-109 step 2: nothing gitmem reads or writes may be missing from the
 * v1.8.0 setup.sql, unless it is allowlisted against the ticket that owns it.
 *
 * Standing rule (Chris, 2026-09-21): customers never run SQL after initial
 * setup, so every store in the field may still be on the v1.8.0 schema. The
 * pinned copy is tests/fixtures/schema/setup-v1.8.0.sql (byte-identical to
 * `git show v1.8.0:schema/setup.sql`).
 *
 * What fails:
 *   - a table or column reached from src/ that v1.8.0 does not have and that
 *     is not on ALLOWED below;
 *   - an ALLOWED entry that no longer matches anything (the list only shrinks);
 *   - an ALLOWED entry without a GIT-### ticket;
 *   - a call site the analyzer cannot resolve that is not on KNOWN_UNRESOLVED
 *     (so coverage cannot silently decay);
 *   - a SESSION_COLUMNS entry missing from v1.8.0 that is not production-only.
 * See tests/helpers/schema-drift.ts for what is collected and how.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseSchema, scanSources, compare, selectColumns } from "../helpers/schema-drift.js";
import type { Finding, ScanResult, Schema } from "../helpers/schema-drift.js";
import { SESSION_COLUMNS, PRODUCTION_ONLY_SESSION_COLUMNS } from "../../src/services/session-columns.js";

const REPO = path.resolve(__dirname, "../..");
const FLOOR_SQL = path.join(REPO, "tests/fixtures/schema/setup-v1.8.0.sql");
const CURRENT_SQL = path.join(REPO, "schema/setup.sql");

interface Allowed {
  table: string;
  column: string | null;
  kind: Finding["kind"];
  ticket: string;
  reason: string;
}

/**
 * Known gaps, each owned by a ticket. Remove an entry when its ticket lands —
 * the test fails on an entry that matches nothing.
 */
const ALLOWED: Allowed[] = [
  // Written only where the store has the column (store-columns.ts probe).
  { table: "gitmem_learnings", column: "archived_at", kind: "write", ticket: "GIT-109", reason: "probe-guarded: archive-learning.ts writes it only if supportedColumns() finds it" },
  { table: "gitmem_sessions", column: "claude_code_session_id", kind: "write", ticket: "GIT-109", reason: "probe-guarded: production-only, dropped by filterToStoreSessionColumns() on setup.sql stores" },
  { table: "gitmem_sessions", column: "task_observations", kind: "write", ticket: "GIT-109", reason: "probe-guarded: absorb-observations.ts writes it only if supportedColumns() finds it" },
  // Scar variant A/B testing is dev-tier only (hasVariants()); customer schemas do not provision it.
  { table: "variant_assignments", column: null, kind: "table", ticket: "GIT-106", reason: "dev tier only; table not in setup.sql" },
  { table: "variant_performance_metrics", column: null, kind: "table", ticket: "GIT-106", reason: "dev tier only; table not in setup.sql" },
  { table: "scar_enforcement_variants", column: "active", kind: "filter", ticket: "GIT-106", reason: "dev tier only; setup.sql's table has a different shape" },
  { table: "scar_enforcement_variants", column: "active", kind: "write", ticket: "GIT-106", reason: "dev tier only; setup.sql's table has a different shape" },
  { table: "scar_enforcement_variants", column: "description", kind: "write", ticket: "GIT-106", reason: "dev tier only; setup.sql's table has a different shape" },
  { table: "scar_enforcement_variants", column: "enforcement_config", kind: "write", ticket: "GIT-106", reason: "dev tier only; setup.sql's table has a different shape" },
  { table: "scar_enforcement_variants", column: "variant_name", kind: "write", ticket: "GIT-106", reason: "dev tier only; setup.sql's table has a different shape" },
  { table: "scar_enforcement_variants", column: "variant_version", kind: "write", ticket: "GIT-106", reason: "dev tier only; setup.sql's table has a different shape" },
];

/**
 * Call sites the analyzer cannot resolve statically, by file and what is
 * missing. Each is checked another way or is out of reach; a NEW one fails.
 */
const KNOWN_UNRESOLVED: Array<{ file: string; what: RegExp; why: string }> = [
  { file: "src/services/thread-supabase.ts", what: /^filters: /, why: "filters come from buildScopedThreadQuery() in thread-scope.ts (another file); thread-scope tests pin them" },
  { file: "src/services/write-health.ts", what: /^table /, why: "loops over getTableName(\"learnings\" | \"decisions\"), select id only" },
  { file: "src/tools/session-close.ts", what: /sessionData not resolvable; filtered by filterToStoreSessionColumns/, why: "narrowed to SESSION_COLUMNS, checked against v1.8.0 below" },
];

let floor: Schema;
let current: Schema;
let scan: ScanResult;
let findings: Finding[];

beforeAll(() => {
  floor = parseSchema(fs.readFileSync(FLOOR_SQL, "utf-8"));
  current = parseSchema(fs.readFileSync(CURRENT_SQL, "utf-8"));
  scan = scanSources(path.join(REPO, "src"));
  findings = compare(scan, floor, current);
});

const matches = (a: Allowed, f: Finding) => a.table === f.table && a.column === f.column && a.kind === f.kind;
const label = (f: Finding) => `${f.table}.${f.column ?? "(table)"} [${f.kind}]${f.addedAfterFloor ? " (added after 1.8.0)" : " (in no setup.sql)"} at ${f.sites.join(", ")}`;

describe("schema parser", () => {
  it("reads the v1.8.0 tables, ALTER-added columns and views", () => {
    expect([...floor.keys()]).toEqual(expect.arrayContaining([
      "gitmem_learnings", "gitmem_sessions", "gitmem_decisions", "gitmem_scar_usage", "gitmem_threads",
      "knowledge_triples", "gitmem_query_metrics", "scar_enforcement_variants", "gitmem_threads_lite", "gitmem_sessions_lite",
    ]));
    expect(floor.get("gitmem_learnings")).toContain("decay_multiplier"); // ALTER TABLE ... ADD COLUMN
    expect(floor.get("gitmem_threads")).toContain("resolved_by_session");
    expect(floor.get("gitmem_threads")).not.toContain("CHECK");
    expect(floor.get("gitmem_sessions_lite")).toContain("close_compliance"); // view
    expect(floor.get("gitmem_sessions_lite")).not.toContain("embedding");
  });

  it("the pinned floor is the v1.8.0 schema, not a later one", () => {
    expect(fs.readFileSync(FLOOR_SQL, "utf-8")).toMatch(/refresh_scar_behavioral_scores/);
    // The release-B setup.sql re-creates the usage table idempotently (GIT-84); v1.8.0 did not.
    expect(fs.readFileSync(FLOOR_SQL, "utf-8")).not.toBe(fs.readFileSync(CURRENT_SQL, "utf-8"));
  });

  it("parses PostgREST select lists", () => {
    expect(selectColumns("id,title:t,embedding::text,metadata->>session_id,rel(a,b),*")).toEqual({
      columns: ["id", "t", "embedding", "metadata"], star: true,
    });
  });
});

describe("analyzer catches drift (planted in a synthetic source tree)", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-drift-"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "planted.ts"), `
      declare const supabase: any; declare function getTableName(b: string): string; declare function hasSupabase(): boolean;
      declare const getStorage: () => any;
      export async function a() {
        const row = { id: "x", bogus_column: 1, ...(true && { also_bogus: 2 }) };
        row.assigned_later = 3;
        await supabase.directUpsert(getTableName("sessions"), row);
        await supabase.directQuery("knowledge_triples", { select: "id,no_such_col", filters: { nope: "eq.1" }, order: "gone.desc" });
        await supabase.directPatch(getTableName("threads"), { thread_id: "t" }, { status: "resolved", not_a_col: 1 });
        await supabase.directQuery("missing_table", { select: "id" });
        if (!hasSupabase()) await getStorage().upsert("sessions", { local_only_field: 1 });
      }`);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reports every planted column and table, and ignores free-tier-only writes", () => {
    const s = scanSources(path.join(dir, "src"));
    const got = compare(s, floor, current).map((f) => `${f.table}.${f.column ?? "(table)"}:${f.kind}`).sort();
    expect(got).toEqual([
      "gitmem_sessions.also_bogus:write",
      "gitmem_sessions.assigned_later:write",
      "gitmem_sessions.bogus_column:write",
      "gitmem_threads.not_a_col:write",
      "knowledge_triples.gone:order",
      "knowledge_triples.no_such_col:select",
      "knowledge_triples.nope:filter",
      "missing_table.(table):table",
    ]);
    expect(s.freeTierOnly).toBe(1);
  });
});

describe("src/ against the v1.8.0 schema", () => {
  it("scans a meaningful surface", () => {
    expect(scan.callSites).toBeGreaterThan(50);
    expect(scan.accesses.length).toBeGreaterThan(300);
  });

  it("every table and column is in v1.8.0 or allowlisted by ticket", () => {
    const unexpected = findings.filter((f) => !ALLOWED.some((a) => matches(a, f)));
    expect(unexpected.map(label), "not in v1.8.0 setup.sql and not allowlisted").toEqual([]);
  });

  it("every allowlist entry still matches a finding, and names a ticket", () => {
    for (const a of ALLOWED) {
      expect(a.ticket, `${a.table}.${a.column}`).toMatch(/^GIT-\d+$/);
      expect(findings.some((f) => matches(a, f)), `stale ALLOWED entry ${a.table}.${a.column} [${a.kind}] (${a.ticket}) — remove it`).toBe(true);
    }
  });

  it("no call site is unresolved except the known ones", () => {
    const unknown = scan.unresolved.filter((u) => !KNOWN_UNRESOLVED.some((k) => k.file === u.file && k.what.test(u.what)));
    expect(unknown.map((u) => `${u.file}:${u.line} ${u.call} — ${u.what}`)).toEqual([]);
    for (const k of KNOWN_UNRESOLVED) {
      expect(scan.unresolved.some((u) => u.file === k.file && k.what.test(u.what)), `stale KNOWN_UNRESOLVED ${k.file}`).toBe(true);
    }
  });

  it("session writes: SESSION_COLUMNS is v1.8.0 plus the probe-guarded production-only set", () => {
    const sessions = floor.get("gitmem_sessions")!;
    const missing = [...SESSION_COLUMNS].filter((c) => !sessions.has(c) && !PRODUCTION_ONLY_SESSION_COLUMNS.has(c));
    expect(missing, "SESSION_COLUMNS entries a v1.8.0 store rejects").toEqual([]);
  });
});

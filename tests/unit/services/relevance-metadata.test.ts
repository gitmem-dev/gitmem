/**
 * GIT-109: relevance data is stored inside gitmem_query_metrics.metadata.
 *
 * updateRelevanceData used to upsert a `memories_applied` column the table has
 * never had, and compared free-text Q6 titles against UUIDs, so nothing was
 * ever recorded. It now PATCHes the existing row's `metadata` JSONB — a column
 * every schema since 1.8.0 has — and session_close feeds it the structured
 * confirm_scars decisions and relevance ratings.
 *
 * Also: hook-scars.json holds learning text and must be owner-only (0600).
 */

import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const directQuery = vi.fn();
const directPatch = vi.fn(async () => []);
const directUpsert = vi.fn(async () => ({}));

vi.mock("../../../src/services/supabase-client.js", () => ({
  isConfigured: () => true,
  directQuery: (...a: unknown[]) => directQuery(...a),
  directPatch: (...a: unknown[]) => directPatch(...a),
  directUpsert: (...a: unknown[]) => directUpsert(...a),
}));
vi.mock("../../../src/services/tier.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/services/tier.js")>()),
  hasSupabase: () => true,
}));

const { updateRelevanceData } = await import("../../../src/services/metrics.js");
const { buildRelevanceInput } = await import("../../../src/tools/session-close.js");
const { persistScarsForHooks } = await import("../../../src/services/startup.js");
const { setGitmemDir, clearGitmemDirCache } = await import("../../../src/services/gitmem-dir.js");

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";

describe("updateRelevanceData (GIT-109)", () => {
  it("PATCHes metadata on the existing row and never writes a memories_applied column", async () => {
    directQuery.mockResolvedValue([
      { id: "m1", memories_surfaced: [A, B], metadata: { project: "p", match_count: 3 } },
      { id: "m2", memories_surfaced: [C], metadata: {} },
      { id: "m3", memories_surfaced: null, metadata: null },
    ]);

    await updateRelevanceData("session-1", [A], { A_unrelated: "high", [A]: "high", [B]: "noise" });

    // recall rows carry the session in metadata.session_id (no FK race), others in the column.
    expect(directQuery).toHaveBeenCalledWith("gitmem_query_metrics", expect.objectContaining({
      select: "id,memories_surfaced,metadata",
      filters: { or: "(session_id.eq.session-1,metadata->>session_id.eq.session-1)" },
    }));
    expect(directUpsert).not.toHaveBeenCalled();
    // Only m1 surfaced anything applied or rated; m2/m3 are left alone.
    expect(directPatch).toHaveBeenCalledTimes(1);
    const [table, match, body] = directPatch.mock.calls[0] as [string, Record<string, string>, Record<string, unknown>];
    expect(table).toBe("gitmem_query_metrics");
    expect(match).toEqual({ id: "eq.m1" });
    expect(Object.keys(body)).toEqual(["metadata"]);
    expect(body.metadata).toEqual({
      project: "p",
      match_count: 3, // existing metadata preserved
      memories_applied: [A],
      memory_relevance: { [A]: "high", [B]: "noise" },
    });
  });
});

describe("buildRelevanceInput (GIT-109)", () => {
  const surfaced = [
    { scar_id: A, scar_title: "Dry-run migrations first", scar_severity: "high", surfaced_at: "t", source: "recall" as const },
    { scar_id: B, scar_title: "Verify after deploy", scar_severity: "medium", surfaced_at: "t", source: "recall" as const },
    { scar_id: C, scar_title: "Keys never in logs", scar_severity: "low", surfaced_at: "t", source: "recall" as const },
  ];
  const conf = (scar_id: string, decision: "APPLYING" | "N_A" | "REFUTED", relevance?: "high" | "low" | "noise") =>
    ({ scar_id, scar_title: "", decision, evidence: "x".repeat(60), confirmed_at: "t", relevance });

  it("counts APPLYING confirmations as applied and keeps every rating", () => {
    const out = buildRelevanceInput([conf(A, "APPLYING", "high"), conf(B, "N_A", "noise")], surfaced, []);
    expect(out.appliedIds).toEqual([A]);
    expect(out.relevanceById).toEqual({ [A]: "high", [B]: "noise" });
  });

  it("resolves Q6 scars_applied entries by exact title or UUID, ignoring unmatched text", () => {
    const out = buildRelevanceInput([], surfaced, ["verify after deploy", C, "something vague"]);
    expect(out.appliedIds.sort()).toEqual([B, C].sort());
    expect(out.relevanceById).toEqual({});
  });
});

describe("hook-scars.json is owner-only (GIT-109)", () => {
  it("is written 0600, and an existing 0644 file is tightened", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-hookscars-"));
    try {
      setGitmemDir(dir);
      const file = path.join(dir, "cache", "hook-scars.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "[]", { mode: 0o644 });
      fs.chmodSync(file, 0o644);

      persistScarsForHooks([{ id: A, title: "t", description: "d", severity: "high" }]);

      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(file, "utf8"))[0].id).toBe(A);
    } finally {
      clearGitmemDirCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

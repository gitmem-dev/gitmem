/**
 * Session column filtering (GIT-74/R17)
 *
 * The defect: session_close builds its upsert by spreading the existing session
 * record, and on the Supabase-miss path that record is the LOCAL file record —
 * a different shape carrying rendering fields like `display`. Postgres rejects
 * the entire upsert on the first unknown key (PGRST204), so one local-only
 * field failed the whole close. A fresh Pro install could not close its first
 * session.
 *
 * These tests guard the CLASS, not the `display` instance: any unknown key is
 * dropped, and every known column survives. The second half matters as much as
 * the first — a filter that drops real columns is the same bug pointed the
 * other way, and filtering to schema/setup.sql alone would have done exactly
 * that to eleven live production columns.
 */

import { describe, it, expect } from "vitest";
import {
  SESSION_COLUMNS,
  filterToSessionColumns,
} from "../../../src/services/session-columns.js";

describe("filterToSessionColumns: drops what the table does not have", () => {
  it("drops `display` — the field that failed the close", () => {
    const out = filterToSessionColumns({
      id: "s-1",
      display: "((●)) gitmem ── close · FAILED",
    });

    expect(out).not.toHaveProperty("display");
    expect(out.id).toBe("s-1");
  });

  it("drops any unknown key, not just the one that was reported", () => {
    const out = filterToSessionColumns({
      id: "s-1",
      display: "chrome",
      performance: { latency_ms: 12 },
      some_future_local_field: true,
      _internal: "x",
    });

    expect(Object.keys(out)).toEqual(["id"]);
  });

  it("returns a new object and does not mutate the input", () => {
    const input = { id: "s-1", display: "chrome" };
    const out = filterToSessionColumns(input);

    expect(input).toHaveProperty("display");
    expect(out).not.toBe(input);
  });

  it("survives an empty payload", () => {
    expect(filterToSessionColumns({})).toEqual({});
  });
});

describe("filterToSessionColumns: keeps every column the table does have", () => {
  // The inverse guard. A filter that silently drops real columns would be the
  // same defect class as the one it fixes — data loss instead of a hard error,
  // which is strictly worse because nothing reports it.
  it("passes through every column in SESSION_COLUMNS", () => {
    const payload: Record<string, unknown> = {};
    for (const col of SESSION_COLUMNS) payload[col] = `value-of-${col}`;

    const out = filterToSessionColumns(payload);

    expect(Object.keys(out).sort()).toEqual([...SESSION_COLUMNS].sort());
  });

  it("keeps the production-only columns that schema/setup.sql omits", () => {
    // These eleven exist in the live table but not in setup.sql. Filtering to
    // setup.sql alone would have dropped real data on every production close.
    const productionOnly = [
      "blocked_by",
      "children",
      "claude_code_session_id",
      "compacted",
      "compacted_at",
      "compacted_summary",
      "handover_linear_slug",
      "insights",
      "metrics",
      "pre_compaction_summary",
      "task_observations",
    ];

    const payload = Object.fromEntries(productionOnly.map((c) => [c, "kept"]));
    const out = filterToSessionColumns(payload);

    for (const col of productionOnly) {
      expect(out, `${col} is a live production column and must survive`).toHaveProperty(col);
    }
  });

  it("keeps a realistic close payload intact", () => {
    const closePayload = {
      id: "3f2a1b4c-0000-4000-8000-000000000000",
      agent: "CLI",
      project: "gitmem",
      session_title: "Release session",
      close_compliance: { valid: true },
      closing_reflection: { what_broke: "nothing" },
      decisions: ["ship it"],
      open_threads: [{ id: "t-1" }],
      rapport_summary: "good",
      claude_code_session_id: "abc",
      // the intruder
      display: "((●)) gitmem ── close",
    };

    const out = filterToSessionColumns(closePayload);

    expect(out).not.toHaveProperty("display");
    expect(Object.keys(out).length).toBe(Object.keys(closePayload).length - 1);
    expect(out.close_compliance).toEqual({ valid: true });
    expect(out.decisions).toEqual(["ship it"]);
  });

  it("preserves an explicitly-undefined known column", () => {
    // Only unknown KEYS are the hazard. An explicit undefined on a real column
    // is the caller's business and must not be quietly reinterpreted.
    const out = filterToSessionColumns({ id: "s-1", linear_issue: undefined });

    expect("linear_issue" in out).toBe(true);
  });
});

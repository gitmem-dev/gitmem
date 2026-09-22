/**
 * GIT-102: diagnostics that say what they know and what they don't.
 *
 * 1. The startup write-path probe is raced against a deadline. A store that
 *    never answers yields "timed out, durability UNVERIFIED" — not silence.
 *    The last verdict is kept for `health`, and a late answer replaces it.
 * 2. session_close's WARN names the subsystem, the cause, and always whether
 *    the session content itself was stored.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  checkWritePathWithTimeout,
  getLastWritePathVerdict,
  resetWritePathVerdict,
  formatWritePathLine,
  WRITE_PATH_TIMEOUT_MS,
} from "../../../src/services/write-health.js";
import type { WritePathResult } from "../../../src/services/write-health.js";
import { formatWriteWarnings } from "../../../src/tools/session-close.js";

const never = () => new Promise<WritePathResult>(() => {});
const after = (ms: number, r: WritePathResult) => () => new Promise<WritePathResult>((res) => setTimeout(() => res(r), ms));

beforeEach(() => resetWritePathVerdict());

describe("write-path check timeout (GIT-102)", () => {
  it("defaults to a 10 s budget", () => {
    expect(WRITE_PATH_TIMEOUT_MS).toBe(10_000);
  });

  it("a probe that never answers resolves at the deadline as timed_out, durability UNVERIFIED", async () => {
    const t0 = Date.now();
    const v = await checkWritePathWithTimeout(60, never);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(v.ok).toBe(false);
    expect(v.mode).toBe("timed_out");
    expect(v.summary).toMatch(/timed out after .* durability UNVERIFIED/);
    expect(getLastWritePathVerdict()?.mode).toBe("timed_out");
  });

  it("names the configured budget in seconds", async () => {
    const v = await checkWritePathWithTimeout(10_000, () => Promise.resolve({ ok: false, mode: "timed_out" }));
    expect(v.summary).toBe("timed out after 10 s, durability UNVERIFIED");
  });

  it("a fast probe's verdict is recorded as-is", async () => {
    const v = await checkWritePathWithTimeout(1000, () => Promise.resolve({ ok: true, mode: "supabase" }));
    expect(v.mode).toBe("supabase");
    expect(v.late).toBeUndefined();
    expect(getLastWritePathVerdict()).toEqual(v);
  });

  it("a probe that answers after the deadline replaces timed_out, marked late", async () => {
    const v = await checkWritePathWithTimeout(30, after(90, { ok: false, mode: "missing_tables", missing: ["gitmem_learnings"] }));
    expect(v.mode).toBe("timed_out");
    await new Promise((r) => setTimeout(r, 120));
    const latest = getLastWritePathVerdict()!;
    expect(latest.mode).toBe("missing_tables");
    expect(latest.late).toBe(true);
    expect(latest.summary).toContain("gitmem_learnings");
  });

  it("health's line says not-checked, UNVERIFIED, or ok — never nothing", async () => {
    expect(formatWritePathLine(null)).toMatch(/not checked yet/);
    const timedOut = await checkWritePathWithTimeout(20, never);
    expect(formatWritePathLine(timedOut)).toMatch(/^Write path: timed out after .* durability UNVERIFIED \(NOT OK, checked /);
    const ok = await checkWritePathWithTimeout(1000, () => Promise.resolve({ ok: true, mode: "supabase" }));
    expect(formatWritePathLine(ok)).toMatch(/^Write path: Supabase — .* \(ok, checked /);
  });
});

describe("session_close WARN lines (GIT-102)", () => {
  const report = (byPath: Record<string, { attempted: number; failed: number; error?: string }>) => ({
    byPath: Object.fromEntries(Object.entries(byPath).map(([k, v]) => [k, {
      attempted: v.attempted, succeeded: v.attempted - v.failed, failed: v.failed, successRate: "", avgDurationMs: 0,
      ...(v.error && { lastFailure: { error: v.error, timestamp: "" } }),
    }])),
    overall: { attempted: 0, succeeded: 0, failed: 0, successRate: "", paths_with_failures: [] },
    recentFailures: [],
    uptimeMs: 0,
  });

  it("names subsystem and cause, and says the session content was stored", () => {
    const lines = formatWriteWarnings(report({
      triple_write: { attempted: 3, failed: 3, error: 'POST knowledge_triples 400: invalid input syntax for type uuid: "t-abc"' },
      embedding: { attempted: 1, failed: 0 },
    }), true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^knowledge graph \(triples\): 3 of 3 writes failed — POST knowledge_triples 400: invalid input syntax/);
    expect(lines[0]).toMatch(/· session content stored OK( \(local\))?$/);
  });

  it("says NOT stored when the session row did not land — on every line", () => {
    const lines = formatWriteWarnings(report({
      triple_write: { attempted: 1, failed: 1, error: "boom" },
      transcript: { attempted: 1, failed: 1, error: "bucket missing" },
    }), false);
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toMatch(/· session content NOT stored$/);
    expect(lines[1]).toMatch(/^transcript upload: 1 of 1 write failed — bucket missing/);
  });

  it("an unknown subsystem is named by its path, a missing cause is said to be missing", () => {
    const [line] = formatWriteWarnings(report({ new_path: { attempted: 2, failed: 1 } }), true);
    expect(line).toMatch(/^new_path: 1 of 2 writes failed — no error message recorded · session content stored OK/);
  });

  it("no failures, no WARN", () => {
    expect(formatWriteWarnings(report({ triple_write: { attempted: 2, failed: 0 } }), true)).toEqual([]);
  });
});

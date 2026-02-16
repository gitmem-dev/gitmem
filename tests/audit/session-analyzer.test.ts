import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { analyzeSession } from "../../scripts/audit/session-analyzer.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

describe("analyzeSession", () => {
  it("analyzes minimal session with just session_start", async () => {
    const report = await analyzeSession(join(FIXTURES, "minimal.cast"));

    expect(report.file).toBe("minimal.cast");
    expect(report.start_epoch).toBe(1771200000);
    expect(report.gitmem_events.session_starts).toBeGreaterThanOrEqual(1);
    expect(report.ux_metrics.has_gitmem_activity).toBe(true);
  });

  it("analyzes session with recall → confirm cycle", async () => {
    const report = await analyzeSession(join(FIXTURES, "with-recall.cast"));

    expect(report.gitmem_events.recalls).toBe(1);
    expect(report.gitmem_events.scars_surfaced).toBe(3);
    expect(report.gitmem_events.confirms_attempted).toBe(1);
    expect(report.gitmem_events.confirms_first_try).toBe(1);
    expect(report.gitmem_events.confirms_rejected).toBe(0);
    expect(report.gitmem_events.scar_applying).toBe(2);
    expect(report.gitmem_events.scar_na).toBe(1);
    expect(report.gitmem_events.threads_resolved).toBe(1);
    expect(report.ux_metrics.zero_friction_rate).toBe(1);
    expect(report.ux_metrics.scar_relevance_rate).toBeCloseTo(0.67, 1);
    expect(report.ux_metrics.has_gitmem_activity).toBe(true);
  });

  it("analyzes session with rejection then retry", async () => {
    const report = await analyzeSession(join(FIXTURES, "with-rejection.cast"));

    expect(report.gitmem_events.recalls).toBe(2);
    expect(report.gitmem_events.confirms_rejected).toBe(1);
    // First recall: rejected once + accepted = 2 attempts
    // Second recall: accepted first try = 1 attempt
    expect(report.gitmem_events.confirms_attempted).toBe(3);
    // Second recall was first-try, first recall had a rejection
    expect(report.gitmem_events.confirms_first_try).toBe(1);
    // zero_friction_rate: 1 first-try / 2 sequences = 0.5
    expect(report.ux_metrics.zero_friction_rate).toBe(0.5);
  });

  it("analyzes session with no gitmem events", async () => {
    const report = await analyzeSession(join(FIXTURES, "no-gitmem.cast"));

    expect(report.gitmem_events.session_starts).toBe(0);
    expect(report.gitmem_events.recalls).toBe(0);
    expect(report.ux_metrics.has_gitmem_activity).toBe(false);
    expect(report.ux_metrics.zero_friction_rate).toBe(0);
    expect(report.ux_metrics.ceremony_overhead_sec).toBe(0);
  });

  it("extracts date from filename", async () => {
    const report = await analyzeSession(join(FIXTURES, "minimal.cast"));
    // Filename doesn't match YYYY-MM-DD pattern, so falls back to epoch
    expect(report.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("computes duration in minutes from cumulative v3 timestamps", async () => {
    const report = await analyzeSession(join(FIXTURES, "with-recall.cast"));
    // v3 timestamps are deltas; sum of all deltas = cumulative time
    // 0.1+0.5+0.6+1.0+2.0+5.0+5.5+5.6+5.7+6.0+6.1+6.2+6.3+7.0+7.5+10.0+10.5+10.6+10.7+15.0+20.0+50.0+55.0+60.0 = 306.9
    expect(report.duration_min).toBeGreaterThan(4);
    expect(report.duration_min).toBeLessThan(6);
  });
});

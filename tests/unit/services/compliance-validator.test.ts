/**
 * Tests for compliance-validator.ts
 * Covers buildCloseCompliance scars_applied counting (string vs string[])
 */

import { describe, it, expect } from "vitest";
import { buildCloseCompliance, validateSessionClose } from "../../../src/services/compliance-validator.js";
import type { SessionCloseParams } from "../../../src/types/index.js";

describe("buildCloseCompliance: scars_applied counting", () => {
  const agent = "CLI" as const;
  const learnings = 0;

  function buildParams(scarsApplied: string | string[] | undefined): SessionCloseParams {
    return {
      session_id: "test-session",
      close_type: "standard",
      closing_reflection: {
        what_broke: "Nothing",
        what_took_longer: "Tests",
        do_differently: "Plan better",
        what_worked: "Communication",
        wrong_assumption: "None",
        scars_applied: scarsApplied as any,
      },
      human_corrections: "None",
    };
  }

  it("counts array scars_applied by element count", () => {
    const result = buildCloseCompliance(buildParams(["scar-1", "scar-2", "scar-3"]), agent, learnings);
    expect(result.scars_applied).toBe(3);
  });

  it("counts empty array as 0", () => {
    const result = buildCloseCompliance(buildParams([]), agent, learnings);
    expect(result.scars_applied).toBe(0);
  });

  it("counts single-element array as 1", () => {
    const result = buildCloseCompliance(buildParams(["Done != Deployed"]), agent, learnings);
    expect(result.scars_applied).toBe(1);
  });

  it("counts undefined scars_applied as 0", () => {
    const result = buildCloseCompliance(buildParams(undefined), agent, learnings);
    expect(result.scars_applied).toBe(0);
  });

  it("does NOT count string characters — counts logical items", () => {
    // Bug: "Applied scar A" has 14 chars. Old code returned 14, not 1.
    const result = buildCloseCompliance(buildParams("Applied scar A"), agent, learnings);
    expect(result.scars_applied).toBe(1);
    expect(result.scars_applied).not.toBe(14); // character count
  });

  it("splits prose on period+space delimiter", () => {
    const result = buildCloseCompliance(
      buildParams("Applied Done != Deployed. Applied trace execution path. Refuted over-engineering"),
      agent,
      learnings,
    );
    expect(result.scars_applied).toBe(3);
  });

  it("splits prose on semicolon delimiter", () => {
    const result = buildCloseCompliance(
      buildParams("scar A; scar B; scar C"),
      agent,
      learnings,
    );
    expect(result.scars_applied).toBe(3);
  });

  it("splits prose on em-dash delimiter", () => {
    const result = buildCloseCompliance(
      buildParams("scar A — scar B — scar C"),
      agent,
      learnings,
    );
    expect(result.scars_applied).toBe(3);
  });

  it("returns at least 1 for non-empty string with no delimiters", () => {
    const result = buildCloseCompliance(
      buildParams("Applied Done != Deployed scar"),
      agent,
      learnings,
    );
    expect(result.scars_applied).toBeGreaterThanOrEqual(1);
  });

  it("handles no closing_reflection gracefully", () => {
    const params: SessionCloseParams = {
      session_id: "test-session",
      close_type: "quick",
    };
    const result = buildCloseCompliance(params, agent, learnings);
    expect(result.scars_applied).toBe(0);
  });
});

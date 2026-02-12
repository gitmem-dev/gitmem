/**
 * Unit tests for format-utils.ts
 *
 * Tests formatCompact, formatGate, and estimateTokens.
 */

import { describe, it, expect } from "vitest";
import {
  formatCompact,
  formatGate,
  estimateTokens,
  SEVERITY_EMOJI,
  SEVERITY_ORDER,
  type FormattableScar,
} from "../../../src/hooks/format-utils.js";

// --- Test fixtures ---

function makeScar(overrides: Partial<FormattableScar> = {}): FormattableScar {
  return {
    id: "test-id-1",
    title: "Test Scar Title",
    description: "This is a test scar description. It has multiple sentences.",
    severity: "medium",
    counter_arguments: ["arg1", "arg2"],
    similarity: 0.85,
    ...overrides,
  };
}

// --- estimateTokens ---

describe("estimateTokens", () => {
  it("returns roughly 1 token per 4 characters", () => {
    expect(estimateTokens("1234")).toBe(1);
    expect(estimateTokens("12345678")).toBe(2);
    expect(estimateTokens("123")).toBe(1); // ceil
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

// --- formatCompact ---

describe("formatCompact", () => {
  it("formats a single scar with header", () => {
    const scars = [makeScar()];
    const { payload, included } = formatCompact(scars, "test plan", 2000);

    expect(included).toBe(1);
    expect(payload).toContain("[INSTITUTIONAL MEMORY");
    expect(payload).toContain("test plan");
    expect(payload).toContain("Test Scar Title");
    expect(payload).toContain("MEDIUM");
  });

  it("sorts scars by severity (critical first)", () => {
    const scars = [
      makeScar({ id: "low", severity: "low", title: "Low Scar" }),
      makeScar({ id: "crit", severity: "critical", title: "Critical Scar" }),
      makeScar({ id: "high", severity: "high", title: "High Scar" }),
    ];
    const { payload, included } = formatCompact(scars, "plan", 5000);

    expect(included).toBe(3);
    const lines = payload.split("\n");
    // Line 0 is header, lines 1-3 are scars
    expect(lines[1]).toContain("Critical Scar");
    expect(lines[2]).toContain("High Scar");
    expect(lines[3]).toContain("Low Scar");
  });

  it("truncates to token budget", () => {
    const scars = Array.from({ length: 20 }, (_, i) =>
      makeScar({
        id: `scar-${i}`,
        title: `Scar number ${i} with a reasonably long title for testing`,
        description: "A description that adds to the token count for this particular scar entry.",
      })
    );
    const { payload, included } = formatCompact(scars, "plan", 200);

    // Should include at least 1 but fewer than 20
    expect(included).toBeGreaterThanOrEqual(1);
    expect(included).toBeLessThan(20);
    expect(estimateTokens(payload)).toBeLessThanOrEqual(250); // some slack for last-added
  });

  it("always includes at least one scar even if over budget", () => {
    const scars = [
      makeScar({ title: "A".repeat(500), description: "B".repeat(500) }),
    ];
    const { included } = formatCompact(scars, "plan", 10); // tiny budget

    expect(included).toBe(1);
  });

  it("uses first sentence of description only", () => {
    const scars = [
      makeScar({ description: "First sentence here. Second sentence ignored. Third too." }),
    ];
    const { payload } = formatCompact(scars, "plan", 2000);

    expect(payload).toContain("First sentence here");
    expect(payload).not.toContain("Second sentence ignored");
  });

  it("truncates plan text in header to 60 chars", () => {
    const longPlan = "A".repeat(100);
    const { payload } = formatCompact([makeScar()], longPlan, 2000);

    const header = payload.split("\n")[0];
    expect(header).toContain("A".repeat(60));
    expect(header).not.toContain("A".repeat(61));
  });
});

// --- formatGate ---

describe("formatGate", () => {
  it("returns PASS when no blocking scars", () => {
    const scars = [makeScar()]; // no required_verification
    const { payload, blocking } = formatGate(scars);

    expect(blocking).toBe(0);
    expect(payload).toContain("PASS");
  });

  it("returns blocking info for blocking scars", () => {
    const scars = [
      makeScar({
        required_verification: {
          when: "Before deploying to production",
          queries: ["SELECT count(*) FROM migrations"],
          must_show: "All migrations applied",
          blocking: true,
        },
      }),
    ];
    const { payload, blocking } = formatGate(scars);

    expect(blocking).toBe(1);
    expect(payload).toContain("BLOCK");
    expect(payload).toContain("Before deploying to production");
    expect(payload).toContain("SELECT count(*)");
    expect(payload).toContain("All migrations applied");
  });

  it("ignores non-blocking scars with required_verification", () => {
    const scars = [
      makeScar({
        required_verification: {
          when: "Before deploy",
          queries: [],
          must_show: "Tests pass",
          blocking: false,
        },
      }),
    ];
    const { payload, blocking } = formatGate(scars);

    expect(blocking).toBe(0);
    expect(payload).toContain("PASS");
  });
});

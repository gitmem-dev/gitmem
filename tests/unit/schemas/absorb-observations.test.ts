/**
 * Unit tests for absorb_observations schema (OD-595)
 */

import { describe, it, expect } from "vitest";
import {
  ObservationSeveritySchema,
  ObservationSchema,
  AbsorbObservationsParamsSchema,
  validateAbsorbObservationsParams,
} from "../../../src/schemas/absorb-observations.js";

describe("ObservationSeveritySchema", () => {
  it("accepts info", () => {
    expect(ObservationSeveritySchema.safeParse("info").success).toBe(true);
  });

  it("accepts warning", () => {
    expect(ObservationSeveritySchema.safeParse("warning").success).toBe(true);
  });

  it("accepts scar_candidate", () => {
    expect(ObservationSeveritySchema.safeParse("scar_candidate").success).toBe(true);
  });

  it("rejects invalid severity", () => {
    expect(ObservationSeveritySchema.safeParse("critical").success).toBe(false);
  });

  it("rejects empty string", () => {
    expect(ObservationSeveritySchema.safeParse("").success).toBe(false);
  });
});

describe("ObservationSchema", () => {
  it("accepts valid observation", () => {
    const result = ObservationSchema.safeParse({
      source: "Sub-Agent: code review",
      text: "API endpoint has no auth middleware",
      severity: "scar_candidate",
    });
    expect(result.success).toBe(true);
  });

  it("accepts observation with context", () => {
    const result = ObservationSchema.safeParse({
      source: "Teammate: Marcus",
      text: "Missing error handling",
      severity: "warning",
      context: "src/routes/api/foo.ts",
    });
    expect(result.success).toBe(true);
    expect(result.data?.context).toBe("src/routes/api/foo.ts");
  });

  it("rejects missing source", () => {
    const result = ObservationSchema.safeParse({
      text: "something",
      severity: "info",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty source", () => {
    const result = ObservationSchema.safeParse({
      source: "",
      text: "something",
      severity: "info",
    });
    expect(result.success).toBe(false);
    expect(result.error?.errors[0].message).toContain("source is required");
  });

  it("rejects missing text", () => {
    const result = ObservationSchema.safeParse({
      source: "agent",
      severity: "info",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty text", () => {
    const result = ObservationSchema.safeParse({
      source: "agent",
      text: "",
      severity: "info",
    });
    expect(result.success).toBe(false);
    expect(result.error?.errors[0].message).toContain("text is required");
  });

  it("rejects missing severity", () => {
    const result = ObservationSchema.safeParse({
      source: "agent",
      text: "something",
    });
    expect(result.success).toBe(false);
  });
});

describe("AbsorbObservationsParamsSchema", () => {
  const validObs = {
    source: "Sub-Agent: test",
    text: "Found issue",
    severity: "warning" as const,
  };

  it("accepts valid params with one observation", () => {
    const result = AbsorbObservationsParamsSchema.safeParse({
      observations: [validObs],
    });
    expect(result.success).toBe(true);
    expect(result.data?.observations).toHaveLength(1);
  });

  it("accepts params with task_id", () => {
    const result = AbsorbObservationsParamsSchema.safeParse({
      task_id: "OD-595",
      observations: [validObs],
    });
    expect(result.success).toBe(true);
    expect(result.data?.task_id).toBe("OD-595");
  });

  it("accepts multiple observations", () => {
    const result = AbsorbObservationsParamsSchema.safeParse({
      observations: [
        validObs,
        { source: "agent2", text: "another", severity: "info" },
        { source: "agent3", text: "third", severity: "scar_candidate" },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.data?.observations).toHaveLength(3);
  });

  it("rejects empty observations array", () => {
    const result = AbsorbObservationsParamsSchema.safeParse({
      observations: [],
    });
    expect(result.success).toBe(false);
    expect(result.error?.errors[0].message).toContain("at least one observation");
  });

  it("rejects missing observations", () => {
    const result = AbsorbObservationsParamsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects invalid observation in array", () => {
    const result = AbsorbObservationsParamsSchema.safeParse({
      observations: [{ source: "agent" }], // missing text + severity
    });
    expect(result.success).toBe(false);
  });
});

describe("validateAbsorbObservationsParams", () => {
  it("returns success for valid params", () => {
    const result = validateAbsorbObservationsParams({
      observations: [{ source: "agent", text: "found bug", severity: "warning" }],
    });
    expect(result.success).toBe(true);
    expect(result.data?.observations).toHaveLength(1);
  });

  it("returns error for empty observations", () => {
    const result = validateAbsorbObservationsParams({ observations: [] });
    expect(result.success).toBe(false);
    expect(result.error).toContain("at least one observation");
  });

  it("returns error for missing observations field", () => {
    const result = validateAbsorbObservationsParams({});
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

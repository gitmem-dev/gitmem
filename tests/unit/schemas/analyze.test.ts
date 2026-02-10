/**
 * Unit tests for analyze schema
 */

import { describe, it, expect } from "vitest";
import { AnalyzeParamsSchema, AnalyzeLensSchema, validateAnalyzeParams } from "../../../src/schemas/analyze.js";

describe("AnalyzeLensSchema", () => {
  it("accepts summary", () => {
    expect(AnalyzeLensSchema.safeParse("summary").success).toBe(true);
  });

  it("accepts reflections", () => {
    expect(AnalyzeLensSchema.safeParse("reflections").success).toBe(true);
  });

  it("accepts blindspots", () => {
    expect(AnalyzeLensSchema.safeParse("blindspots").success).toBe(true);
  });

  it("rejects invalid lens", () => {
    expect(AnalyzeLensSchema.safeParse("unknown").success).toBe(false);
  });
});

describe("AnalyzeParamsSchema", () => {
  describe("valid inputs", () => {
    it("accepts empty object (all params optional)", () => {
      const result = AnalyzeParamsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("accepts full valid params", () => {
      const result = AnalyzeParamsSchema.safeParse({
        lens: "summary",
        days: 30,
        project: "my-project",
        agent: "CLI",
      });
      expect(result.success).toBe(true);
    });

    it("accepts reflections lens", () => {
      const result = AnalyzeParamsSchema.safeParse({ lens: "reflections" });
      expect(result.success).toBe(true);
    });
  });

  describe("type mismatches", () => {
    it("rejects invalid lens", () => {
      const result = AnalyzeParamsSchema.safeParse({ lens: "invalid" });
      expect(result.success).toBe(false);
    });

    it("rejects zero days", () => {
      const result = AnalyzeParamsSchema.safeParse({ days: 0 });
      expect(result.success).toBe(false);
    });

    it("rejects negative days", () => {
      const result = AnalyzeParamsSchema.safeParse({ days: -7 });
      expect(result.success).toBe(false);
    });

    it("rejects non-string project", () => {
      const result = AnalyzeParamsSchema.safeParse({ project: 123 });
      expect(result.success).toBe(false);
    });
  });

  describe("validateAnalyzeParams helper", () => {
    it("returns success for empty params", () => {
      const result = validateAnalyzeParams({});
      expect(result.success).toBe(true);
    });

    it("returns error for invalid params", () => {
      const result = validateAnalyzeParams({ lens: "invalid" });
      expect(result.success).toBe(false);
    });
  });
});

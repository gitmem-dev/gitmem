/**
 * Unit tests for log schema
 */

import { describe, it, expect } from "vitest";
import { LogParamsSchema, validateLogParams } from "../../../src/schemas/log.js";

describe("LogParamsSchema", () => {
  describe("valid inputs", () => {
    it("accepts empty object (all params optional)", () => {
      const result = LogParamsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("accepts full valid params", () => {
      const result = LogParamsSchema.safeParse({
        limit: 20,
        project: "orchestra_dev",
        learning_type: "scar",
        severity: "high",
        since: 7,
      });
      expect(result.success).toBe(true);
    });

    it("accepts all severity values", () => {
      const severities = ["critical", "high", "medium", "low"];
      for (const severity of severities) {
        const result = LogParamsSchema.safeParse({ severity });
        expect(result.success).toBe(true);
      }
    });
  });

  describe("type mismatches", () => {
    it("rejects zero limit", () => {
      const result = LogParamsSchema.safeParse({ limit: 0 });
      expect(result.success).toBe(false);
    });

    it("rejects negative limit", () => {
      const result = LogParamsSchema.safeParse({ limit: -5 });
      expect(result.success).toBe(false);
    });

    it("rejects zero since", () => {
      const result = LogParamsSchema.safeParse({ since: 0 });
      expect(result.success).toBe(false);
    });

    it("rejects non-string project", () => {
      const result = LogParamsSchema.safeParse({ project: 123 });
      expect(result.success).toBe(false);
    });
  });

  describe("validateLogParams helper", () => {
    it("returns success for empty params", () => {
      const result = validateLogParams({});
      expect(result.success).toBe(true);
    });

    it("returns error for invalid params", () => {
      const result = validateLogParams({ limit: -1 });
      expect(result.success).toBe(false);
    });
  });
});

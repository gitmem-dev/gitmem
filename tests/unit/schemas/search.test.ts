/**
 * Unit tests for search schema
 */

import { describe, it, expect } from "vitest";
import { SearchParamsSchema, validateSearchParams } from "../../../src/schemas/search.js";

describe("SearchParamsSchema", () => {
  describe("valid inputs", () => {
    it("accepts minimal valid params", () => {
      const result = SearchParamsSchema.safeParse({
        query: "deployment verification",
      });
      expect(result.success).toBe(true);
    });

    it("accepts full valid params", () => {
      const result = SearchParamsSchema.safeParse({
        query: "deployment verification",
        match_count: 10,
        project: "my-project",
        severity: "high",
        learning_type: "scar",
      });
      expect(result.success).toBe(true);
    });

    it("accepts all severity values", () => {
      const severities = ["critical", "high", "medium", "low"];
      for (const severity of severities) {
        const result = SearchParamsSchema.safeParse({ query: "test", severity });
        expect(result.success).toBe(true);
      }
    });

    it("accepts all learning_type values", () => {
      const types = ["scar", "win", "pattern"];
      for (const learning_type of types) {
        const result = SearchParamsSchema.safeParse({ query: "test", learning_type });
        expect(result.success).toBe(true);
      }
    });
  });

  describe("required params missing", () => {
    it("rejects missing query", () => {
      const result = SearchParamsSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects empty query", () => {
      const result = SearchParamsSchema.safeParse({ query: "" });
      expect(result.success).toBe(false);
    });
  });

  describe("type mismatches", () => {
    it("rejects invalid severity", () => {
      const result = SearchParamsSchema.safeParse({
        query: "test",
        severity: "urgent",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid learning_type", () => {
      const result = SearchParamsSchema.safeParse({
        query: "test",
        learning_type: "lesson",
      });
      expect(result.success).toBe(false);
    });

    it("rejects zero match_count", () => {
      const result = SearchParamsSchema.safeParse({
        query: "test",
        match_count: 0,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("validateSearchParams helper", () => {
    it("returns success for valid params", () => {
      const result = validateSearchParams({ query: "test" });
      expect(result.success).toBe(true);
    });

    it("returns error for invalid params", () => {
      const result = validateSearchParams({});
      expect(result.success).toBe(false);
      expect(result.error).toContain("query");
    });
  });
});

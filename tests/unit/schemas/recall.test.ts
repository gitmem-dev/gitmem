/**
 * Unit tests for recall schema
 *
 * Critical: Tests the `action` vs `plan` bug that caused the 2026-02-03 crash.
 */

import { describe, it, expect } from "vitest";
import { RecallParamsSchema, validateRecallParams } from "../../../src/schemas/recall.js";

describe("RecallParamsSchema", () => {
  describe("valid inputs", () => {
    it("accepts minimal valid params (plan only)", () => {
      const result = RecallParamsSchema.safeParse({ plan: "deploy to production" });
      expect(result.success).toBe(true);
      expect(result.data?.plan).toBe("deploy to production");
    });

    it("accepts full valid params", () => {
      const result = RecallParamsSchema.safeParse({
        plan: "deploy to production",
        project: "orchestra_dev",
        match_count: 5,
        issue_id: "OD-123",
      });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        plan: "deploy to production",
        project: "orchestra_dev",
        match_count: 5,
        issue_id: "OD-123",
      });
    });

    it("accepts weekend_warrior project", () => {
      const result = RecallParamsSchema.safeParse({
        plan: "test",
        project: "weekend_warrior",
      });
      expect(result.success).toBe(true);
      expect(result.data?.project).toBe("weekend_warrior");
    });
  });

  describe("required params missing", () => {
    it("rejects empty object", () => {
      const result = RecallParamsSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects missing plan", () => {
      const result = RecallParamsSchema.safeParse({ project: "orchestra_dev" });
      expect(result.success).toBe(false);
    });

    it("rejects empty plan", () => {
      const result = RecallParamsSchema.safeParse({ plan: "" });
      expect(result.success).toBe(false);
      expect(result.error?.errors[0].message).toContain("plan is required");
    });
  });

  describe("wrong param names - GOLDEN REGRESSION", () => {
    it("rejects 'action' param (should be 'plan')", () => {
      // This is the exact bug that caused the 2026-02-03 recall crash
      const result = RecallParamsSchema.safeParse({ action: "deploy" });
      expect(result.success).toBe(false);
    });

    it("validateRecallParams gives helpful error for action vs plan", () => {
      // Validate the helper function provides good UX
      const result = validateRecallParams({ action: "deploy" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("action");
      expect(result.error).toContain("plan");
    });
  });

  describe("type mismatches", () => {
    it("rejects numeric plan", () => {
      const result = RecallParamsSchema.safeParse({ plan: 123 });
      expect(result.success).toBe(false);
    });

    it("rejects null plan", () => {
      const result = RecallParamsSchema.safeParse({ plan: null });
      expect(result.success).toBe(false);
    });

    it("rejects array plan", () => {
      const result = RecallParamsSchema.safeParse({ plan: ["deploy"] });
      expect(result.success).toBe(false);
    });

    it("rejects non-string project", () => {
      const result = RecallParamsSchema.safeParse({
        plan: "test",
        project: 123,
      });
      expect(result.success).toBe(false);
    });

    it("rejects negative match_count", () => {
      const result = RecallParamsSchema.safeParse({
        plan: "test",
        match_count: -1,
      });
      expect(result.success).toBe(false);
    });

    it("rejects zero match_count", () => {
      const result = RecallParamsSchema.safeParse({
        plan: "test",
        match_count: 0,
      });
      expect(result.success).toBe(false);
    });

    it("rejects float match_count", () => {
      const result = RecallParamsSchema.safeParse({
        plan: "test",
        match_count: 3.5,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("boundary values", () => {
    it("accepts single character plan", () => {
      const result = RecallParamsSchema.safeParse({ plan: "x" });
      expect(result.success).toBe(true);
    });

    it("accepts very long plan", () => {
      const longPlan = "x".repeat(10000);
      const result = RecallParamsSchema.safeParse({ plan: longPlan });
      expect(result.success).toBe(true);
    });

    it("accepts match_count of 1", () => {
      const result = RecallParamsSchema.safeParse({ plan: "test", match_count: 1 });
      expect(result.success).toBe(true);
    });

    it("accepts large match_count", () => {
      const result = RecallParamsSchema.safeParse({ plan: "test", match_count: 100 });
      expect(result.success).toBe(true);
    });
  });
});

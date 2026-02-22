import { describe, it, expect } from "vitest";
import {
  ContributeFeedbackParamsSchema,
  validateContributeFeedbackParams,
} from "../../../src/schemas/contribute-feedback.js";

describe("ContributeFeedbackParamsSchema", () => {
  const validParams = {
    type: "bug_report",
    tool: "recall",
    description: "Recall returns stale results after cache flush completes",
    severity: "high",
  };

  it("accepts valid minimal params", () => {
    const result = ContributeFeedbackParamsSchema.safeParse(validParams);
    expect(result.success).toBe(true);
  });

  it("accepts valid params with all optional fields", () => {
    const result = ContributeFeedbackParamsSchema.safeParse({
      ...validParams,
      suggested_fix: "Invalidate the in-memory cache after flush returns",
      context: "Noticed during a session where I flushed and immediately recalled",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing type", () => {
    const { type, ...rest } = validParams;
    const result = ContributeFeedbackParamsSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing tool", () => {
    const { tool, ...rest } = validParams;
    const result = ContributeFeedbackParamsSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing description", () => {
    const { description, ...rest } = validParams;
    const result = ContributeFeedbackParamsSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing severity", () => {
    const { severity, ...rest } = validParams;
    const result = ContributeFeedbackParamsSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects invalid type enum value", () => {
    const result = ContributeFeedbackParamsSchema.safeParse({
      ...validParams,
      type: "complaint",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid severity enum value", () => {
    const result = ContributeFeedbackParamsSchema.safeParse({
      ...validParams,
      severity: "critical",
    });
    expect(result.success).toBe(false);
  });

  it("rejects description shorter than 20 chars", () => {
    const result = ContributeFeedbackParamsSchema.safeParse({
      ...validParams,
      description: "Too short",
    });
    expect(result.success).toBe(false);
  });

  it("rejects description longer than 2000 chars", () => {
    const result = ContributeFeedbackParamsSchema.safeParse({
      ...validParams,
      description: "x".repeat(2001),
    });
    expect(result.success).toBe(false);
  });

  it("rejects tool longer than 100 chars", () => {
    const result = ContributeFeedbackParamsSchema.safeParse({
      ...validParams,
      tool: "x".repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty tool string", () => {
    const result = ContributeFeedbackParamsSchema.safeParse({
      ...validParams,
      tool: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects suggested_fix longer than 1000 chars", () => {
    const result = ContributeFeedbackParamsSchema.safeParse({
      ...validParams,
      suggested_fix: "x".repeat(1001),
    });
    expect(result.success).toBe(false);
  });

  it("rejects context longer than 500 chars", () => {
    const result = ContributeFeedbackParamsSchema.safeParse({
      ...validParams,
      context: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("accepts all four feedback types", () => {
    for (const type of ["feature_request", "bug_report", "friction", "suggestion"]) {
      const result = ContributeFeedbackParamsSchema.safeParse({ ...validParams, type });
      expect(result.success).toBe(true);
    }
  });

  it("accepts all three severity levels", () => {
    for (const severity of ["low", "medium", "high"]) {
      const result = ContributeFeedbackParamsSchema.safeParse({ ...validParams, severity });
      expect(result.success).toBe(true);
    }
  });
});

describe("validateContributeFeedbackParams", () => {
  it("returns success with valid data", () => {
    const result = validateContributeFeedbackParams({
      type: "feature_request",
      tool: "session_close",
      description: "Would be nice to have auto-detected close type",
      severity: "low",
    });
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.type).toBe("feature_request");
  });

  it("returns error string with invalid data", () => {
    const result = validateContributeFeedbackParams({
      type: "invalid",
      tool: "",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe("string");
  });
});

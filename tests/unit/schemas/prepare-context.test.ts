/**
 * Unit tests for prepare_context schema
 */

import { describe, it, expect } from "vitest";
import {
  PrepareContextFormatSchema,
  PrepareContextParamsSchema,
  validatePrepareContextParams,
} from "../../../src/schemas/prepare-context.js";

describe("PrepareContextFormatSchema", () => {
  it("accepts full", () => {
    expect(PrepareContextFormatSchema.safeParse("full").success).toBe(true);
  });

  it("accepts compact", () => {
    expect(PrepareContextFormatSchema.safeParse("compact").success).toBe(true);
  });

  it("accepts gate", () => {
    expect(PrepareContextFormatSchema.safeParse("gate").success).toBe(true);
  });

  it("rejects invalid format", () => {
    expect(PrepareContextFormatSchema.safeParse("brief").success).toBe(false);
  });

  it("rejects empty string", () => {
    expect(PrepareContextFormatSchema.safeParse("").success).toBe(false);
  });
});

describe("PrepareContextParamsSchema", () => {
  describe("valid inputs", () => {
    it("accepts minimal valid params (plan + format)", () => {
      const result = PrepareContextParamsSchema.safeParse({
        plan: "review auth middleware",
        format: "compact",
      });
      expect(result.success).toBe(true);
      expect(result.data?.plan).toBe("review auth middleware");
      expect(result.data?.format).toBe("compact");
    });

    it("accepts full valid params", () => {
      const result = PrepareContextParamsSchema.safeParse({
        plan: "deploy edge function",
        format: "full",
        max_tokens: 300,
        agent_role: "reviewer",
        project: "my-project",
      });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        plan: "deploy edge function",
        format: "full",
        max_tokens: 300,
        agent_role: "reviewer",
        project: "my-project",
      });
    });

    it("accepts gate format with other-project project", () => {
      const result = PrepareContextParamsSchema.safeParse({
        plan: "test trading logic",
        format: "gate",
        project: "other-project",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("required params missing", () => {
    it("rejects empty object", () => {
      const result = PrepareContextParamsSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects missing plan", () => {
      const result = PrepareContextParamsSchema.safeParse({ format: "compact" });
      expect(result.success).toBe(false);
    });

    it("rejects missing format", () => {
      const result = PrepareContextParamsSchema.safeParse({ plan: "do something" });
      expect(result.success).toBe(false);
    });

    it("rejects empty plan", () => {
      const result = PrepareContextParamsSchema.safeParse({
        plan: "",
        format: "compact",
      });
      expect(result.success).toBe(false);
      expect(result.error?.errors[0].message).toContain("plan is required");
    });
  });

  describe("max length enforcement", () => {
    it("rejects plan exceeding 500 chars", () => {
      const result = PrepareContextParamsSchema.safeParse({
        plan: "x".repeat(501),
        format: "compact",
      });
      expect(result.success).toBe(false);
    });

    it("rejects agent_role exceeding 100 chars", () => {
      const result = PrepareContextParamsSchema.safeParse({
        plan: "test",
        format: "compact",
        agent_role: "x".repeat(101),
      });
      expect(result.success).toBe(false);
    });
  });

  describe("type mismatches", () => {
    it("rejects numeric plan", () => {
      const result = PrepareContextParamsSchema.safeParse({ plan: 123, format: "full" });
      expect(result.success).toBe(false);
    });

    it("rejects invalid format enum", () => {
      const result = PrepareContextParamsSchema.safeParse({
        plan: "test",
        format: "brief",
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-string project", () => {
      const result = PrepareContextParamsSchema.safeParse({
        plan: "test",
        format: "compact",
        project: 123,
      });
      expect(result.success).toBe(false);
    });

    it("rejects negative max_tokens", () => {
      const result = PrepareContextParamsSchema.safeParse({
        plan: "test",
        format: "compact",
        max_tokens: -1,
      });
      expect(result.success).toBe(false);
    });

    it("rejects zero max_tokens", () => {
      const result = PrepareContextParamsSchema.safeParse({
        plan: "test",
        format: "compact",
        max_tokens: 0,
      });
      expect(result.success).toBe(false);
    });

    it("rejects float max_tokens", () => {
      const result = PrepareContextParamsSchema.safeParse({
        plan: "test",
        format: "compact",
        max_tokens: 3.5,
      });
      expect(result.success).toBe(false);
    });
  });
});

describe("validatePrepareContextParams", () => {
  it("returns success for valid params", () => {
    const result = validatePrepareContextParams({
      plan: "deploy",
      format: "gate",
    });
    expect(result.success).toBe(true);
    expect(result.data?.plan).toBe("deploy");
    expect(result.data?.format).toBe("gate");
  });

  it("returns error for missing plan", () => {
    const result = validatePrepareContextParams({ format: "compact" });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns error for missing format", () => {
    const result = validatePrepareContextParams({ plan: "test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("format");
  });
});

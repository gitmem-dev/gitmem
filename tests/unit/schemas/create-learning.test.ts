/**
 * Unit tests for create_learning schema
 *
 * Critical: Tests scar-specific requirements (severity, counter_arguments)
 */

import { describe, it, expect } from "vitest";
import { CreateLearningParamsSchema, validateCreateLearningParams } from "../../../src/schemas/create-learning.js";

describe("CreateLearningParamsSchema", () => {
  describe("valid inputs", () => {
    it("accepts valid scar with all requirements", () => {
      const result = CreateLearningParamsSchema.safeParse({
        learning_type: "scar",
        title: "Test Scar",
        description: "A test scar description",
        severity: "high",
        counter_arguments: ["Argument 1", "Argument 2"],
      });
      expect(result.success).toBe(true);
    });

    it("accepts valid win without severity/counter_arguments", () => {
      const result = CreateLearningParamsSchema.safeParse({
        learning_type: "win",
        title: "Test Win",
        description: "A test win description",
      });
      expect(result.success).toBe(true);
    });

    it("accepts valid pattern", () => {
      const result = CreateLearningParamsSchema.safeParse({
        learning_type: "pattern",
        title: "Test Pattern",
        description: "A test pattern description",
      });
      expect(result.success).toBe(true);
    });

    it("accepts all severity levels for scars", () => {
      const severities = ["critical", "high", "medium", "low"];
      for (const severity of severities) {
        const result = CreateLearningParamsSchema.safeParse({
          learning_type: "scar",
          title: "Test",
          description: "Test",
          severity,
          counter_arguments: ["arg1", "arg2"],
        });
        expect(result.success).toBe(true);
      }
    });

    it("accepts scar with LLM-cooperative fields", () => {
      const result = CreateLearningParamsSchema.safeParse({
        learning_type: "scar",
        title: "Test Scar",
        description: "Description",
        severity: "high",
        counter_arguments: ["arg1", "arg2"],
        why_this_matters: "Because it prevents bugs",
        action_protocol: ["Step 1", "Step 2"],
        self_check_criteria: ["Check 1", "Check 2"],
      });
      expect(result.success).toBe(true);
    });
  });

  describe("scar-specific validation", () => {
    it("rejects scar without severity", () => {
      const result = CreateLearningParamsSchema.safeParse({
        learning_type: "scar",
        title: "Test Scar",
        description: "Description",
        counter_arguments: ["arg1", "arg2"],
        // Missing severity
      });
      expect(result.success).toBe(false);
      expect(result.error?.errors.some((e) => e.path.includes("severity"))).toBe(true);
    });

    it("rejects scar without counter_arguments", () => {
      const result = CreateLearningParamsSchema.safeParse({
        learning_type: "scar",
        title: "Test Scar",
        description: "Description",
        severity: "high",
        // Missing counter_arguments
      });
      expect(result.success).toBe(false);
      expect(result.error?.errors.some((e) => e.path.includes("counter_arguments"))).toBe(true);
    });

    it("rejects scar with only 1 counter_argument", () => {
      const result = CreateLearningParamsSchema.safeParse({
        learning_type: "scar",
        title: "Test Scar",
        description: "Description",
        severity: "high",
        counter_arguments: ["Only one argument"],
      });
      expect(result.success).toBe(false);
      expect(result.error?.errors.some((e) =>
        e.message.includes("at least 2 counter_arguments")
      )).toBe(true);
    });

    it("rejects scar with empty counter_arguments array", () => {
      const result = CreateLearningParamsSchema.safeParse({
        learning_type: "scar",
        title: "Test Scar",
        description: "Description",
        severity: "high",
        counter_arguments: [],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("required params missing", () => {
    it("rejects missing learning_type", () => {
      const result = CreateLearningParamsSchema.safeParse({
        title: "Test",
        description: "Description",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing title", () => {
      const result = CreateLearningParamsSchema.safeParse({
        learning_type: "win",
        description: "Description",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing description", () => {
      const result = CreateLearningParamsSchema.safeParse({
        learning_type: "win",
        title: "Title",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty title", () => {
      const result = CreateLearningParamsSchema.safeParse({
        learning_type: "win",
        title: "",
        description: "Description",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty description", () => {
      const result = CreateLearningParamsSchema.safeParse({
        learning_type: "win",
        title: "Title",
        description: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("type mismatches", () => {
    it("rejects invalid learning_type", () => {
      const result = CreateLearningParamsSchema.safeParse({
        learning_type: "invalid",
        title: "Title",
        description: "Description",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid severity", () => {
      const result = CreateLearningParamsSchema.safeParse({
        learning_type: "scar",
        title: "Title",
        description: "Description",
        severity: "invalid",
        counter_arguments: ["arg1", "arg2"],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("validateCreateLearningParams helper", () => {
    it("returns success for valid params", () => {
      const result = validateCreateLearningParams({
        learning_type: "win",
        title: "Test",
        description: "Description",
      });
      expect(result.success).toBe(true);
    });

    it("returns concatenated errors", () => {
      const result = validateCreateLearningParams({
        learning_type: "scar",
        title: "",
        description: "",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("title");
    });
  });
});

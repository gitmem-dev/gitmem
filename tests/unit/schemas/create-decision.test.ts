/**
 * Unit tests for create_decision schema
 */

import { describe, it, expect } from "vitest";
import { CreateDecisionParamsSchema, validateCreateDecisionParams } from "../../../src/schemas/create-decision.js";

describe("CreateDecisionParamsSchema", () => {
  describe("valid inputs", () => {
    it("accepts minimal valid params", () => {
      const result = CreateDecisionParamsSchema.safeParse({
        title: "Use Zod for validation",
        decision: "We will use Zod schemas for parameter validation",
        rationale: "Provides type safety and clear error messages",
      });
      expect(result.success).toBe(true);
    });

    it("accepts full valid params", () => {
      const result = CreateDecisionParamsSchema.safeParse({
        title: "Use Zod for validation",
        decision: "We will use Zod schemas for parameter validation",
        rationale: "Provides type safety and clear error messages",
        alternatives_considered: ["Manual validation", "Yup", "io-ts"],
        personas_involved: ["Alice", "Bob"],
        docs_affected: ["docs/systems/enforcement/roadmap.md", "CLAUDE.md"],
        linear_issue: "PROJ-580",
        session_id: "test-session-123",
        project: "my-project",
      });
      expect(result.success).toBe(true);
      expect(result.data?.alternatives_considered).toHaveLength(3);
      expect(result.data?.docs_affected).toHaveLength(2);
    });

    it("accepts params with docs_affected", () => {
      const result = CreateDecisionParamsSchema.safeParse({
        title: "Expand session close to 7 questions",
        decision: "Session close now uses 7 questions instead of 5",
        rationale: "More thorough reflection captures better learnings",
        docs_affected: ["docs/systems/enforcement/roadmap.md"],
      });
      expect(result.success).toBe(true);
      expect(result.data?.docs_affected).toEqual(["docs/systems/enforcement/roadmap.md"]);
    });

    it("accepts empty docs_affected array", () => {
      const result = CreateDecisionParamsSchema.safeParse({
        title: "Minor tweak",
        decision: "Adjust timeout",
        rationale: "Was too short",
        docs_affected: [],
      });
      expect(result.success).toBe(true);
      expect(result.data?.docs_affected).toEqual([]);
    });

    it("accepts params without docs_affected (optional)", () => {
      const result = CreateDecisionParamsSchema.safeParse({
        title: "Title",
        decision: "Decision",
        rationale: "Rationale",
      });
      expect(result.success).toBe(true);
      expect(result.data?.docs_affected).toBeUndefined();
    });
  });

  describe("max length enforcement", () => {
    it("rejects title exceeding 500 chars", () => {
      const result = CreateDecisionParamsSchema.safeParse({
        title: "x".repeat(501),
        decision: "Valid",
        rationale: "Valid",
      });
      expect(result.success).toBe(false);
    });

    it("rejects decision exceeding 2000 chars", () => {
      const result = CreateDecisionParamsSchema.safeParse({
        title: "Valid",
        decision: "x".repeat(2001),
        rationale: "Valid",
      });
      expect(result.success).toBe(false);
    });

    it("rejects rationale exceeding 2000 chars", () => {
      const result = CreateDecisionParamsSchema.safeParse({
        title: "Valid",
        decision: "Valid",
        rationale: "x".repeat(2001),
      });
      expect(result.success).toBe(false);
    });

    it("rejects alternative item exceeding 1000 chars", () => {
      const result = CreateDecisionParamsSchema.safeParse({
        title: "Valid",
        decision: "Valid",
        rationale: "Valid",
        alternatives_considered: ["x".repeat(1001)],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("required params missing", () => {
    it("rejects missing title", () => {
      const result = CreateDecisionParamsSchema.safeParse({
        decision: "Decision text",
        rationale: "Rationale",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing decision", () => {
      const result = CreateDecisionParamsSchema.safeParse({
        title: "Title",
        rationale: "Rationale",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing rationale", () => {
      const result = CreateDecisionParamsSchema.safeParse({
        title: "Title",
        decision: "Decision text",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty strings", () => {
      const result = CreateDecisionParamsSchema.safeParse({
        title: "",
        decision: "",
        rationale: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("type mismatches", () => {
    it("rejects non-array alternatives_considered", () => {
      const result = CreateDecisionParamsSchema.safeParse({
        title: "Title",
        decision: "Decision",
        rationale: "Rationale",
        alternatives_considered: "single alternative",
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-array docs_affected", () => {
      const result = CreateDecisionParamsSchema.safeParse({
        title: "Title",
        decision: "Decision",
        rationale: "Rationale",
        docs_affected: "single-doc.md",
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-string project", () => {
      const result = CreateDecisionParamsSchema.safeParse({
        title: "Title",
        decision: "Decision",
        rationale: "Rationale",
        project: 123,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("validateCreateDecisionParams helper", () => {
    it("returns success for valid params", () => {
      const result = validateCreateDecisionParams({
        title: "Title",
        decision: "Decision",
        rationale: "Rationale",
      });
      expect(result.success).toBe(true);
    });

    it("returns error for invalid params", () => {
      const result = validateCreateDecisionParams({
        title: "",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});

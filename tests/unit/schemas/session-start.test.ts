/**
 * Unit tests for session_start schema
 */

import { describe, it, expect } from "vitest";
import { SessionStartParamsSchema, validateSessionStartParams } from "../../../src/schemas/session-start.js";

describe("SessionStartParamsSchema", () => {
  describe("valid inputs", () => {
    it("accepts empty object (all params optional)", () => {
      const result = SessionStartParamsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("accepts full valid params", () => {
      const result = SessionStartParamsSchema.safeParse({
        agent_identity: "CLI",
        linear_issue: "OD-123",
        issue_title: "Test issue",
        issue_description: "Description here",
        issue_labels: ["bug", "urgent"],
        project: "orchestra_dev",
        force: true,
      });
      expect(result.success).toBe(true);
      expect(result.data?.force).toBe(true);
    });

    it("accepts all agent identities", () => {
      const agents = ["CLI", "DAC", "CODA-1", "Brain_Local", "Brain_Cloud", "Unknown"];
      for (const agent of agents) {
        const result = SessionStartParamsSchema.safeParse({ agent_identity: agent });
        expect(result.success).toBe(true);
        expect(result.data?.agent_identity).toBe(agent);
      }
    });

    it("accepts both project values", () => {
      const projects = ["orchestra_dev", "weekend_warrior"];
      for (const project of projects) {
        const result = SessionStartParamsSchema.safeParse({ project });
        expect(result.success).toBe(true);
      }
    });
  });

  describe("type mismatches", () => {
    it("rejects invalid agent identity", () => {
      const result = SessionStartParamsSchema.safeParse({ agent_identity: "InvalidAgent" });
      expect(result.success).toBe(false);
    });

    it("rejects invalid project", () => {
      const result = SessionStartParamsSchema.safeParse({ project: "invalid_project" });
      expect(result.success).toBe(false);
    });

    it("rejects non-boolean force", () => {
      const result = SessionStartParamsSchema.safeParse({ force: "true" });
      expect(result.success).toBe(false);
    });

    it("rejects non-array issue_labels", () => {
      const result = SessionStartParamsSchema.safeParse({ issue_labels: "bug" });
      expect(result.success).toBe(false);
    });
  });

  describe("validateSessionStartParams helper", () => {
    it("returns success for valid params", () => {
      const result = validateSessionStartParams({ project: "orchestra_dev" });
      expect(result.success).toBe(true);
      expect(result.data?.project).toBe("orchestra_dev");
    });

    it("returns error for invalid params", () => {
      const result = validateSessionStartParams({ project: "invalid" });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});

/**
 * Unit tests for session_close schema
 */

import { describe, it, expect } from "vitest";
import {
  SessionCloseParamsSchema,
  validateSessionCloseParams,
  TaskCompletionSchema,
  ClosingReflectionSchema,
} from "../../../src/schemas/session-close.js";

describe("SessionCloseParamsSchema", () => {
  describe("valid inputs", () => {
    it("accepts minimal valid params", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "test-session-123",
        close_type: "quick",
      });
      expect(result.success).toBe(true);
    });

    it("accepts all close types", () => {
      const closeTypes = ["standard", "quick", "autonomous", "retroactive"];
      for (const closeType of closeTypes) {
        const result = SessionCloseParamsSchema.safeParse({
          session_id: "test-session",
          close_type: closeType,
        });
        expect(result.success).toBe(true);
      }
    });

    it("accepts full valid params with standard close", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "test-session",
        close_type: "standard",
        task_completion: {
          questions_displayed_at: "2026-02-03T10:00:00Z",
          reflection_completed_at: "2026-02-03T10:05:00Z",
          human_asked_at: "2026-02-03T10:06:00Z",
          human_response: "no corrections",
          human_response_at: "2026-02-03T10:07:00Z",
        },
        closing_reflection: {
          what_broke: "Nothing major",
          what_took_longer: "Setting up tests",
          do_differently: "Start earlier",
          what_worked: "Pair programming",
          wrong_assumption: "None",
          scars_applied: ["scar-1", "scar-2"],
        },
        decisions: [
          {
            title: "Decision 1",
            decision: "We chose X",
            rationale: "Because Y",
          },
        ],
        open_threads: ["Thread 1", "Thread 2"],
        project_state: "On track",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("required params missing", () => {
    it("rejects missing session_id", () => {
      const result = SessionCloseParamsSchema.safeParse({
        close_type: "quick",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing close_type", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "test-session",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty session_id", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "",
        close_type: "quick",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("type mismatches", () => {
    it("rejects invalid close_type", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "test",
        close_type: "invalid",
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-array open_threads", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "test",
        close_type: "quick",
        open_threads: "single thread",
      });
      expect(result.success).toBe(false);
    });

    it("rejects negative ceremony_duration_ms", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "test",
        close_type: "quick",
        ceremony_duration_ms: -100,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("validateSessionCloseParams warnings", () => {
    it("warns when standard close lacks task_completion", () => {
      const result = validateSessionCloseParams({
        session_id: "test",
        close_type: "standard",
      });
      expect(result.success).toBe(true);
      expect(result.warnings).toContain("standard close should include task_completion proof");
    });

    it("warns when standard close lacks closing_reflection", () => {
      const result = validateSessionCloseParams({
        session_id: "test",
        close_type: "standard",
      });
      expect(result.success).toBe(true);
      expect(result.warnings).toContain("standard close should include closing_reflection");
    });

    it("no warnings for quick close without task_completion", () => {
      const result = validateSessionCloseParams({
        session_id: "test",
        close_type: "quick",
      });
      expect(result.success).toBe(true);
      expect(result.warnings).toBeUndefined();
    });
  });
});

describe("TaskCompletionSchema", () => {
  it("accepts valid task completion", () => {
    const result = TaskCompletionSchema.safeParse({
      questions_displayed_at: "2026-02-03T10:00:00Z",
      reflection_completed_at: "2026-02-03T10:05:00Z",
      human_asked_at: "2026-02-03T10:06:00Z",
      human_response: "no corrections",
      human_response_at: "2026-02-03T10:07:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid timestamp", () => {
    const result = TaskCompletionSchema.safeParse({
      questions_displayed_at: "not-a-date",
      reflection_completed_at: "2026-02-03T10:05:00Z",
      human_asked_at: "2026-02-03T10:06:00Z",
      human_response: "no corrections",
      human_response_at: "2026-02-03T10:07:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty human_response", () => {
    const result = TaskCompletionSchema.safeParse({
      questions_displayed_at: "2026-02-03T10:00:00Z",
      reflection_completed_at: "2026-02-03T10:05:00Z",
      human_asked_at: "2026-02-03T10:06:00Z",
      human_response: "",
      human_response_at: "2026-02-03T10:07:00Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("ClosingReflectionSchema", () => {
  it("accepts valid closing reflection", () => {
    const result = ClosingReflectionSchema.safeParse({
      what_broke: "Nothing",
      what_took_longer: "Tests",
      do_differently: "Plan better",
      what_worked: "Communication",
      wrong_assumption: "None",
      scars_applied: ["scar-1"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty scars_applied array", () => {
    const result = ClosingReflectionSchema.safeParse({
      what_broke: "Nothing",
      what_took_longer: "Tests",
      do_differently: "Plan better",
      what_worked: "Communication",
      wrong_assumption: "None",
      scars_applied: [],
    });
    expect(result.success).toBe(true);
  });
});

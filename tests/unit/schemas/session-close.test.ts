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
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        close_type: "quick",
      });
      expect(result.success).toBe(true);
    });

    it("accepts all close types", () => {
      const closeTypes = ["standard", "quick", "autonomous", "retroactive"];
      for (const closeType of closeTypes) {
        const result = SessionCloseParamsSchema.safeParse({
          session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          close_type: closeType,
        });
        expect(result.success).toBe(true);
      }
    });

    it("accepts full valid params with standard close", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
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

    it("accepts standard close with rapport fields (OD-666)", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        close_type: "standard",
        closing_reflection: {
          what_broke: "Nothing",
          what_took_longer: "Tests",
          do_differently: "Plan better",
          what_worked: "Communication",
          wrong_assumption: "None",
          scars_applied: [],
          collaborative_dynamic: "Direct and terse. No hedging.",
          rapport_notes: "Push-back welcomed. High-energy iteration.",
        },
      });
      expect(result.success).toBe(true);
      expect(result.data?.closing_reflection?.collaborative_dynamic).toBe(
        "Direct and terse. No hedging."
      );
      expect(result.data?.closing_reflection?.rapport_notes).toBe(
        "Push-back welcomed. High-energy iteration."
      );
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
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
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

  describe("path traversal prevention", () => {
    it("rejects session_id with path traversal", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "../../etc/passwd",
        close_type: "quick",
      });
      expect(result.success).toBe(false);
    });

    it("rejects session_id with arbitrary string", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "not-a-valid-id",
        close_type: "quick",
      });
      expect(result.success).toBe(false);
    });

    it("accepts valid UUID session_id", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        close_type: "quick",
      });
      expect(result.success).toBe(true);
    });

    it("accepts valid short hex session_id", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "a1b2c3d4",
        close_type: "quick",
      });
      expect(result.success).toBe(true);
    });

    it("rejects transcript_path with path traversal", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "a1b2c3d4",
        close_type: "quick",
        transcript_path: "/home/user/../../../etc/shadow",
      });
      expect(result.success).toBe(false);
    });

    it("rejects transcript_path with null bytes", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "a1b2c3d4",
        close_type: "quick",
        transcript_path: "/home/user/file.txt\0.json",
      });
      expect(result.success).toBe(false);
    });

    it("accepts valid transcript_path", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "a1b2c3d4",
        close_type: "quick",
        transcript_path: "/home/user/.claude/projects/session.jsonl",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("type mismatches", () => {
    it("rejects invalid close_type", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "a1b2c3d4",
        close_type: "invalid",
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-array open_threads", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "a1b2c3d4",
        close_type: "quick",
        open_threads: "single thread",
      });
      expect(result.success).toBe(false);
    });

    it("rejects negative ceremony_duration_ms", () => {
      const result = SessionCloseParamsSchema.safeParse({
        session_id: "a1b2c3d4",
        close_type: "quick",
        ceremony_duration_ms: -100,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("validateSessionCloseParams warnings", () => {
    it("warns when standard close lacks task_completion", () => {
      const result = validateSessionCloseParams({
        session_id: "a1b2c3d4",
        close_type: "standard",
      });
      expect(result.success).toBe(true);
      expect(result.warnings).toContain("standard close should include task_completion proof");
    });

    it("warns when standard close lacks closing_reflection", () => {
      const result = validateSessionCloseParams({
        session_id: "a1b2c3d4",
        close_type: "standard",
      });
      expect(result.success).toBe(true);
      expect(result.warnings).toContain("standard close should include closing_reflection");
    });

    it("no warnings for quick close without task_completion", () => {
      const result = validateSessionCloseParams({
        session_id: "a1b2c3d4",
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

  it("accepts scars_applied as string (prose format)", () => {
    const result = ClosingReflectionSchema.safeParse({
      what_broke: "Nothing",
      what_took_longer: "Tests",
      do_differently: "Plan better",
      what_worked: "Communication",
      wrong_assumption: "None",
      scars_applied: "Applied Done != Deployed. Applied trace execution path; Refuted over-engineering",
    });
    expect(result.success).toBe(true);
  });

  it("accepts scars_applied as single string without delimiters", () => {
    const result = ClosingReflectionSchema.safeParse({
      what_broke: "Nothing",
      what_took_longer: "Tests",
      do_differently: "Plan better",
      what_worked: "Communication",
      wrong_assumption: "None",
      scars_applied: "Applied Done != Deployed scar",
    });
    expect(result.success).toBe(true);
  });

  it("accepts learnings_created as array of objects (agent reality)", () => {
    const result = SessionCloseParamsSchema.safeParse({
      session_id: "a1b2c3d4",
      close_type: "quick",
      learnings_created: [
        { id: "abc", title: "test scar", type: "scar" },
        { id: "def", title: "test win", type: "win" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts learnings_created as array of strings (schema original)", () => {
    const result = SessionCloseParamsSchema.safeParse({
      session_id: "a1b2c3d4",
      close_type: "quick",
      learnings_created: ["learning-1", "learning-2"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts learnings_created as mixed array", () => {
    const result = SessionCloseParamsSchema.safeParse({
      session_id: "a1b2c3d4",
      close_type: "quick",
      learnings_created: ["learning-1", { id: "abc", title: "scar", type: "scar" }],
    });
    expect(result.success).toBe(true);
  });

  // OD-666: Rapport fields (Q8/Q9)
  describe("rapport fields (OD-666)", () => {
    it("accepts Q8 collaborative_dynamic", () => {
      const result = ClosingReflectionSchema.safeParse({
        what_broke: "Nothing",
        what_took_longer: "Tests",
        do_differently: "Plan better",
        what_worked: "Communication",
        wrong_assumption: "None",
        scars_applied: [],
        collaborative_dynamic: "Direct and fast-paced. Short commands, immediate action.",
      });
      expect(result.success).toBe(true);
      expect(result.data?.collaborative_dynamic).toBe(
        "Direct and fast-paced. Short commands, immediate action."
      );
    });

    it("accepts Q9 rapport_notes", () => {
      const result = ClosingReflectionSchema.safeParse({
        what_broke: "Nothing",
        what_took_longer: "Tests",
        do_differently: "Plan better",
        what_worked: "Communication",
        wrong_assumption: "None",
        scars_applied: [],
        rapport_notes: "Push-back welcomed. High-energy iteration worked well.",
      });
      expect(result.success).toBe(true);
      expect(result.data?.rapport_notes).toBe(
        "Push-back welcomed. High-energy iteration worked well."
      );
    });

    it("accepts both Q8 and Q9 together", () => {
      const result = ClosingReflectionSchema.safeParse({
        what_broke: "Nothing",
        what_took_longer: "Tests",
        do_differently: "Plan better",
        what_worked: "Communication",
        wrong_assumption: "None",
        scars_applied: ["scar-1"],
        collaborative_dynamic: "Directive, fast-paced",
        rapport_notes: "Candid push-back worked well",
      });
      expect(result.success).toBe(true);
      expect(result.data?.collaborative_dynamic).toBe("Directive, fast-paced");
      expect(result.data?.rapport_notes).toBe("Candid push-back worked well");
    });

    it("Q8 and Q9 are optional (backwards compatible)", () => {
      const result = ClosingReflectionSchema.safeParse({
        what_broke: "Nothing",
        what_took_longer: "Tests",
        do_differently: "Plan better",
        what_worked: "Communication",
        wrong_assumption: "None",
        scars_applied: [],
      });
      expect(result.success).toBe(true);
      expect(result.data?.collaborative_dynamic).toBeUndefined();
      expect(result.data?.rapport_notes).toBeUndefined();
    });

    it("accepts Q7 institutional_memory_items alongside Q8/Q9", () => {
      const result = ClosingReflectionSchema.safeParse({
        what_broke: "Nothing",
        what_took_longer: "Tests",
        do_differently: "Plan better",
        what_worked: "Communication",
        wrong_assumption: "None",
        scars_applied: [],
        institutional_memory_items: "Test infra needs Docker-in-Docker",
        collaborative_dynamic: "Directive style",
        rapport_notes: "High-energy iteration",
      });
      expect(result.success).toBe(true);
      expect(result.data?.institutional_memory_items).toBe("Test infra needs Docker-in-Docker");
      expect(result.data?.collaborative_dynamic).toBe("Directive style");
      expect(result.data?.rapport_notes).toBe("High-energy iteration");
    });
  });
});

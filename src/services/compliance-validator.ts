/**
 * Compliance Validator Service
 *
 * Validates session close compliance based on close type.
 *
 * Standard close requires (OD-491):
 * - task_completion object with timestamps proving each step was done
 * - All 6 closing questions answered
 * - human_corrections field present (even if empty string)
 * - Timestamps in logical order
 * - Minimum 3-second gap between human_asked_at and human_response_at
 *
 * Quick close has minimal requirements.
 * Autonomous close has agent-specific requirements.
 */

import type { SessionCloseParams, CloseType, CloseCompliance, AgentIdentity, TaskCompletion } from "../types/index.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Minimum time (ms) between asking human and receiving response */
const MIN_HUMAN_RESPONSE_GAP_MS = 3000;

/**
 * Validate task_completion timestamps (OD-491)
 *
 * Ensures:
 * 1. All timestamps are valid ISO strings
 * 2. Timestamps are in logical order
 * 3. Minimum gap between human_asked_at and human_response_at
 */
function validateTaskCompletion(tc: TaskCompletion): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Parse timestamps
  const timestamps: Record<string, Date | null> = {};
  const fields = [
    "questions_displayed_at",
    "reflection_completed_at",
    "human_asked_at",
    "human_response_at",
  ] as const;

  for (const field of fields) {
    const value = tc[field];
    if (!value || value.trim() === "") {
      errors.push(`task_completion.${field} is required`);
      timestamps[field] = null;
    } else {
      const date = new Date(value);
      if (isNaN(date.getTime())) {
        errors.push(`task_completion.${field} is not a valid ISO timestamp: ${value}`);
        timestamps[field] = null;
      } else {
        timestamps[field] = date;
      }
    }
  }

  // Validate human_response content
  if (!tc.human_response || tc.human_response.trim() === "") {
    errors.push("task_completion.human_response is required (e.g., 'none', 'no corrections', or actual corrections)");
  }

  // If we have valid timestamps, check logical order
  const q = timestamps.questions_displayed_at;
  const r = timestamps.reflection_completed_at;
  const a = timestamps.human_asked_at;
  const h = timestamps.human_response_at;

  if (q && r && q > r) {
    errors.push("task_completion: questions_displayed_at must be before reflection_completed_at");
  }
  if (r && a && r > a) {
    errors.push("task_completion: reflection_completed_at must be before human_asked_at");
  }
  if (a && h && a > h) {
    errors.push("task_completion: human_asked_at must be before human_response_at");
  }

  // Check minimum gap between asking and response
  if (a && h) {
    const gapMs = h.getTime() - a.getTime();
    if (gapMs < MIN_HUMAN_RESPONSE_GAP_MS) {
      errors.push(
        `task_completion: human_response_at must be at least ${MIN_HUMAN_RESPONSE_GAP_MS}ms after human_asked_at ` +
        `(actual gap: ${gapMs}ms). Human cannot respond instantly.`
      );
    }
  }

  return { errors, warnings };
}

/**
 * Validate standard close parameters
 *
 * OD-491: Now requires task_completion with timestamps proving each step was done.
 */
function validateStandardClose(params: SessionCloseParams): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // OD-491: task_completion is REQUIRED for standard close
  if (!params.task_completion) {
    errors.push(
      "Standard close requires task_completion object (OD-491). " +
      "You must complete each step: display questions → answer → ask human → wait for response"
    );
  } else {
    // Validate task_completion timestamps and content
    const tcValidation = validateTaskCompletion(params.task_completion);
    errors.push(...tcValidation.errors);
    warnings.push(...tcValidation.warnings);
  }

  // Closing reflection is required for standard close
  if (!params.closing_reflection) {
    errors.push("Standard close requires closing_reflection with 6 answers");
  } else {
    const reflection = params.closing_reflection;

    // Check each of the 6 questions
    if (!reflection.what_broke || reflection.what_broke.trim() === "") {
      errors.push("Missing: what_broke (Q1: What broke that you didn't expect?)");
    }
    if (!reflection.what_took_longer || reflection.what_took_longer.trim() === "") {
      errors.push("Missing: what_took_longer (Q2: What took longer than it should have?)");
    }
    if (!reflection.do_differently || reflection.do_differently.trim() === "") {
      errors.push("Missing: do_differently (Q3: What would you do differently next time?)");
    }
    if (!reflection.what_worked || reflection.what_worked.trim() === "") {
      errors.push("Missing: what_worked (Q4: What pattern or approach worked well?)");
    }
    if (!reflection.wrong_assumption || reflection.wrong_assumption.trim() === "") {
      errors.push("Missing: wrong_assumption (Q5: What assumption was wrong?)");
    }
    if (!reflection.scars_applied) {
      // Not an error if empty array, but warn if not provided
      warnings.push("scars_applied not provided (Q6: Which scars did you apply?)");
    }
  }

  // Human corrections must be explicitly acknowledged
  if (params.human_corrections === undefined) {
    errors.push("Standard close requires human_corrections field (even if empty string)");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate quick close parameters
 */
function validateQuickClose(params: SessionCloseParams): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Quick close has minimal requirements
  if (!params.session_id) {
    errors.push("session_id is required");
  }

  // Warn if closing reflection provided for quick close
  if (params.closing_reflection) {
    warnings.push("closing_reflection provided for quick close - consider using standard close");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate autonomous close parameters (CODA-1)
 */
function validateAutonomousClose(params: SessionCloseParams): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Autonomous close generates its own reflection
  if (!params.session_id) {
    errors.push("session_id is required");
  }

  // closing_reflection is optional for autonomous - agent generates it
  // human_corrections should not be present for autonomous
  if (params.human_corrections) {
    warnings.push("human_corrections provided for autonomous close - this will be ignored");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate retroactive close parameters
 */
function validateRetroactiveClose(params: SessionCloseParams): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Retroactive close SHOULD have closing_reflection or decisions
  // but we allow minimal retroactive closes (better than nothing)
  if (!params.closing_reflection && (!params.decisions || params.decisions.length === 0)) {
    warnings.push("Retroactive close has no closing_reflection or decisions - session will have minimal content");
  }

  // session_id is optional for retroactive - will be generated if not provided
  // but if provided, it will be used
  if (params.session_id) {
    warnings.push("session_id provided for retroactive close - this will be ignored, a new ID will be generated");
  }

  return {
    valid: true, // Retroactive closes are always valid (recovery path)
    errors,
    warnings,
  };
}

/**
 * Validate session close parameters based on close type
 */
export function validateSessionClose(params: SessionCloseParams): ValidationResult {
  const closeType: CloseType = params.close_type || "standard";

  switch (closeType) {
    case "standard":
      return validateStandardClose(params);
    case "quick":
      return validateQuickClose(params);
    case "autonomous":
      return validateAutonomousClose(params);
    case "retroactive":
      return validateRetroactiveClose(params);
    default:
      return {
        valid: false,
        errors: [`Unknown close_type: ${closeType}`],
        warnings: [],
      };
  }
}

/**
 * Build close_compliance object from validated params
 */
export function buildCloseCompliance(
  params: SessionCloseParams,
  agentIdentity: AgentIdentity,
  learningsCount: number
): CloseCompliance {
  const closeType = params.close_type || "standard";
  const scarsApplied = params.closing_reflection?.scars_applied?.length || 0;

  const compliance: CloseCompliance = {
    close_type: closeType,
    agent: agentIdentity,
    checklist_displayed: true,
    questions_answered_by_agent: closeType !== "quick",
    human_asked_for_corrections: closeType === "standard" && params.human_corrections !== undefined,
    learnings_stored: learningsCount,
    scars_applied: scarsApplied,
  };

  // Mark retroactive closes for tracking
  if (closeType === "retroactive") {
    compliance.retroactive = true;
  }

  return compliance;
}

/**
 * Zod schema for session_close tool parameters
 */

import { z } from "zod";
import { CloseTypeSchema, ProjectSchema, ReferenceTypeSchema, ISOTimestampSchema } from "./common.js";
import { ThreadObjectSchema } from "./thread.js";

/**
 * Closing reflection schema
 */
export const ClosingReflectionSchema = z.object({
  what_broke: z.string(),
  what_took_longer: z.string(),
  do_differently: z.string(),
  what_worked: z.string(),
  wrong_assumption: z.string(),
  scars_applied: z.union([z.string(), z.array(z.string())]),
  /** Q7: What from this session should be captured as institutional memory? */
  institutional_memory_items: z.string().optional(),
  /** Q8: How did the human prefer to work this session? */
  collaborative_dynamic: z.string().optional(),
  /** Q9: What collaborative dynamic worked or didn't work? */
  rapport_notes: z.string().optional(),
});

export type ClosingReflection = z.infer<typeof ClosingReflectionSchema>;

/**
 * Task completion proof schema (OD-491)
 */
export const TaskCompletionSchema = z.object({
  questions_displayed_at: ISOTimestampSchema,
  reflection_completed_at: ISOTimestampSchema,
  human_asked_at: ISOTimestampSchema,
  human_response: z.string().min(1, "human_response cannot be empty"),
  human_response_at: ISOTimestampSchema,
});

export type TaskCompletion = z.infer<typeof TaskCompletionSchema>;

/**
 * Session decision schema
 */
export const SessionDecisionSchema = z.object({
  title: z.string().min(1, "decision title is required"),
  decision: z.string().min(1, "decision text is required"),
  rationale: z.string().min(1, "rationale is required"),
  alternatives_considered: z.array(z.string()).optional(),
});

export type SessionDecision = z.infer<typeof SessionDecisionSchema>;

/**
 * Scar usage entry schema
 */
export const ScarUsageEntrySchema = z.object({
  scar_identifier: z.string().min(1, "scar_identifier is required"),
  issue_id: z.string().optional(),
  issue_identifier: z.string().optional(),
  session_id: z.string().optional(),
  agent: z.string().optional(),
  surfaced_at: ISOTimestampSchema,
  acknowledged_at: ISOTimestampSchema.optional(),
  reference_type: ReferenceTypeSchema,
  reference_context: z.string(),
  execution_successful: z.boolean().optional(),
});

export type ScarUsageEntry = z.infer<typeof ScarUsageEntrySchema>;

/**
 * Session close parameters schema
 */
export const SessionCloseParamsSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
  close_type: CloseTypeSchema,
  task_completion: TaskCompletionSchema.optional(),
  closing_reflection: ClosingReflectionSchema.optional(),
  human_corrections: z.string().optional(),
  decisions: z.array(SessionDecisionSchema).optional(),
  open_threads: z.array(z.union([z.string(), ThreadObjectSchema])).optional(),
  project_state: z.string().optional(),
  learnings_created: z.array(z.string()).optional(),
  linear_issue: z.string().optional(),
  ceremony_duration_ms: z.number().nonnegative().optional(),
  scars_to_record: z.array(ScarUsageEntrySchema).optional(),
  capture_transcript: z.boolean().optional(),
  transcript_path: z.string().optional(),
});

export type SessionCloseParams = z.infer<typeof SessionCloseParamsSchema>;

/**
 * Validate session_close params with close type specific rules
 */
export function validateSessionCloseParams(params: unknown): {
  success: boolean;
  data?: SessionCloseParams;
  error?: string;
  warnings?: string[];
} {
  const result = SessionCloseParamsSchema.safeParse(params);

  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
    return { success: false, error: errors.join("; ") };
  }

  const warnings: string[] = [];
  const data = result.data;

  // Standard close requires task_completion and closing_reflection
  if (data.close_type === "standard") {
    if (!data.task_completion) {
      warnings.push("standard close should include task_completion proof");
    }
    if (!data.closing_reflection) {
      warnings.push("standard close should include closing_reflection");
    }
  }

  return { success: true, data, warnings: warnings.length > 0 ? warnings : undefined };
}

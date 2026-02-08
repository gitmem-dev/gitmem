/**
 * Zod schema for recall tool parameters
 *
 * Golden regression: This schema catches the `action` vs `plan` bug
 * that caused the 2026-02-03 recall crash.
 */

import { z } from "zod";
import { ProjectSchema, PositiveIntSchema } from "./common.js";

/**
 * Recall tool parameters schema
 *
 * @param plan - Required. What you're about to do (for scar matching).
 * @param project - Optional. Project namespace for filtering.
 * @param match_count - Optional. Number of scars to return (default 3).
 * @param issue_id - Optional. Linear issue ID for variant assignment.
 */
export const RecallParamsSchema = z.object({
  plan: z
    .string()
    .min(1, "plan is required - describe what you're about to do"),
  project: ProjectSchema.optional(),
  match_count: PositiveIntSchema.optional(),
  issue_id: z.string().optional(),
});

export type RecallParams = z.infer<typeof RecallParamsSchema>;

/**
 * Validate recall params with helpful error messages
 */
export function validateRecallParams(params: unknown): {
  success: boolean;
  data?: RecallParams;
  error?: string;
} {
  const result = RecallParamsSchema.safeParse(params);

  if (result.success) {
    return { success: true, data: result.data };
  }

  // Check for common mistake: using "action" instead of "plan"
  if (
    typeof params === "object" &&
    params !== null &&
    "action" in params &&
    !("plan" in params)
  ) {
    return {
      success: false,
      error:
        'Parameter name mismatch: received "action" but expected "plan". ' +
        "The recall tool uses 'plan' to describe what you're about to do.",
    };
  }

  const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
  return { success: false, error: errors.join("; ") };
}

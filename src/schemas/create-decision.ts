/**
 * Zod schema for create_decision tool parameters
 */

import { z } from "zod";
import { ProjectSchema } from "./common.js";

/**
 * Create decision parameters schema
 */
export const CreateDecisionParamsSchema = z.object({
  title: z.string().min(1, "title is required"),
  decision: z.string().min(1, "decision text is required"),
  rationale: z.string().min(1, "rationale is required"),
  alternatives_considered: z.array(z.string()).optional(),
  personas_involved: z.array(z.string()).optional(),
  linear_issue: z.string().optional(),
  session_id: z.string().optional(),
  project: ProjectSchema.optional(),
});

export type CreateDecisionParams = z.infer<typeof CreateDecisionParamsSchema>;

/**
 * Validate create_decision params
 */
export function validateCreateDecisionParams(params: unknown): {
  success: boolean;
  data?: CreateDecisionParams;
  error?: string;
} {
  const result = CreateDecisionParamsSchema.safeParse(params);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
  return { success: false, error: errors.join("; ") };
}

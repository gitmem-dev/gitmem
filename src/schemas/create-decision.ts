/**
 * Zod schema for create_decision tool parameters
 */

import { z } from "zod";
import { ProjectSchema } from "./common.js";

/**
 * Create decision parameters schema
 */
export const CreateDecisionParamsSchema = z.object({
  title: z.string().min(1, "title is required").max(500),
  decision: z.string().min(1, "decision text is required").max(2000),
  rationale: z.string().min(1, "rationale is required").max(2000),
  alternatives_considered: z.array(z.string().max(1000)).optional(),
  personas_involved: z.array(z.string().max(200)).optional(),
  docs_affected: z.array(z.string().max(500)).optional(),
  linear_issue: z.string().max(100).optional(),
  session_id: z.string().max(100).optional(),
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

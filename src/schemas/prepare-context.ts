/**
 * Zod schema for prepare_context tool parameters (GitMem v2 Phase 1)
 */

import { z } from "zod";
import { ProjectSchema, PositiveIntSchema } from "./common.js";

/**
 * Format mode for memory payload output
 */
export const PrepareContextFormatSchema = z.enum(["full", "compact", "gate"]);
export type PrepareContextFormat = z.infer<typeof PrepareContextFormatSchema>;

/**
 * PrepareContext parameters schema
 */
export const PrepareContextParamsSchema = z.object({
  plan: z.string().min(1, "plan is required - describe what the team is about to do"),
  format: PrepareContextFormatSchema,
  max_tokens: PositiveIntSchema.optional(),
  agent_role: z.string().optional(),
  project: ProjectSchema.optional(),
});

export type PrepareContextParams = z.infer<typeof PrepareContextParamsSchema>;

/**
 * Validate prepare_context params with helpful error messages
 */
export function validatePrepareContextParams(params: unknown): {
  success: boolean;
  data?: PrepareContextParams;
  error?: string;
} {
  const result = PrepareContextParamsSchema.safeParse(params);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
  return { success: false, error: errors.join("; ") };
}

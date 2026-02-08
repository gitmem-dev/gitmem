/**
 * Zod schema for log tool parameters
 */

import { z } from "zod";
import { ProjectSchema, ScarSeveritySchema, LearningTypeSchema, PositiveIntSchema } from "./common.js";

/**
 * Log parameters schema
 */
export const LogParamsSchema = z.object({
  limit: PositiveIntSchema.optional(),
  project: ProjectSchema.optional(),
  learning_type: LearningTypeSchema.optional(),
  severity: ScarSeveritySchema.optional(),
  since: PositiveIntSchema.optional(), // days to look back
});

export type LogParams = z.infer<typeof LogParamsSchema>;

/**
 * Validate log params
 */
export function validateLogParams(params: unknown): {
  success: boolean;
  data?: LogParams;
  error?: string;
} {
  const result = LogParamsSchema.safeParse(params);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
  return { success: false, error: errors.join("; ") };
}

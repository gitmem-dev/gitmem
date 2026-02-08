/**
 * Zod schema for analyze tool parameters
 */

import { z } from "zod";
import { ProjectSchema, PositiveIntSchema } from "./common.js";

/**
 * Analyze lens enum
 */
export const AnalyzeLensSchema = z.enum(["summary", "reflections", "blindspots"]);
export type AnalyzeLens = z.infer<typeof AnalyzeLensSchema>;

/**
 * Analyze parameters schema
 */
export const AnalyzeParamsSchema = z.object({
  lens: AnalyzeLensSchema.optional(),
  days: PositiveIntSchema.optional(),
  project: ProjectSchema.optional(),
  agent: z.string().optional(),
});

export type AnalyzeParams = z.infer<typeof AnalyzeParamsSchema>;

/**
 * Validate analyze params
 */
export function validateAnalyzeParams(params: unknown): {
  success: boolean;
  data?: AnalyzeParams;
  error?: string;
} {
  const result = AnalyzeParamsSchema.safeParse(params);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
  return { success: false, error: errors.join("; ") };
}

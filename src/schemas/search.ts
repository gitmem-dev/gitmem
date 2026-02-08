/**
 * Zod schema for search tool parameters
 */

import { z } from "zod";
import { ProjectSchema, ScarSeveritySchema, LearningTypeSchema, PositiveIntSchema } from "./common.js";

/**
 * Search parameters schema
 */
export const SearchParamsSchema = z.object({
  query: z.string().min(1, "query is required"),
  match_count: PositiveIntSchema.optional(),
  project: ProjectSchema.optional(),
  severity: ScarSeveritySchema.optional(),
  learning_type: LearningTypeSchema.optional(),
});

export type SearchParams = z.infer<typeof SearchParamsSchema>;

/**
 * Validate search params
 */
export function validateSearchParams(params: unknown): {
  success: boolean;
  data?: SearchParams;
  error?: string;
} {
  const result = SearchParamsSchema.safeParse(params);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
  return { success: false, error: errors.join("; ") };
}

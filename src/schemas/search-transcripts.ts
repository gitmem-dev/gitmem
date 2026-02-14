/**
 * Zod schema for search_transcripts tool parameters
 */

import { z } from "zod";
import { ProjectSchema } from "./common.js";

/**
 * Search transcripts parameters schema
 */
export const SearchTranscriptsParamsSchema = z.object({
  query: z.string().min(1, "query is required"),
  match_count: z.number().int().min(1).max(50).optional(),
  similarity_threshold: z.number().min(0).max(1).optional(),
  project: ProjectSchema.optional(),
});

export type SearchTranscriptsParams = z.infer<typeof SearchTranscriptsParamsSchema>;

/**
 * Validate search_transcripts params
 */
export function validateSearchTranscriptsParams(params: unknown): {
  success: boolean;
  data?: SearchTranscriptsParams;
  error?: string;
} {
  const result = SearchTranscriptsParamsSchema.safeParse(params);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
  return { success: false, error: errors.join("; ") };
}

/**
 * Zod schema for get_transcript tool parameters
 */

import { z } from "zod";

/**
 * Get transcript parameters schema
 */
export const GetTranscriptParamsSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
});

export type GetTranscriptParams = z.infer<typeof GetTranscriptParamsSchema>;

/**
 * Validate get_transcript params
 */
export function validateGetTranscriptParams(params: unknown): {
  success: boolean;
  data?: GetTranscriptParams;
  error?: string;
} {
  const result = GetTranscriptParamsSchema.safeParse(params);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
  return { success: false, error: errors.join("; ") };
}

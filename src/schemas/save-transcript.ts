/**
 * Zod schema for save_transcript tool parameters
 */

import { z } from "zod";
import { ProjectSchema } from "./common.js";

/**
 * Transcript format enum
 */
export const TranscriptFormatSchema = z.enum(["json", "markdown"]);
export type TranscriptFormat = z.infer<typeof TranscriptFormatSchema>;

/**
 * Save transcript parameters schema
 */
export const SaveTranscriptParamsSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
  transcript: z.string().min(1, "transcript content is required"),
  format: TranscriptFormatSchema.optional(),
  project: ProjectSchema.optional(),
});

export type SaveTranscriptParams = z.infer<typeof SaveTranscriptParamsSchema>;

/**
 * Validate save_transcript params
 */
export function validateSaveTranscriptParams(params: unknown): {
  success: boolean;
  data?: SaveTranscriptParams;
  error?: string;
} {
  const result = SaveTranscriptParamsSchema.safeParse(params);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
  return { success: false, error: errors.join("; ") };
}

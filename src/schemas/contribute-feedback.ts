/**
 * Zod schema for contribute_feedback tool parameters
 */

import { z } from "zod";

export const FeedbackTypeSchema = z.enum(["feature_request", "bug_report", "friction", "suggestion"]);
export const FeedbackSeveritySchema = z.enum(["low", "medium", "high"]);

export const ContributeFeedbackParamsSchema = z.object({
  type: FeedbackTypeSchema,
  tool: z.string().min(1).max(100),
  description: z.string().min(20).max(2000),
  severity: FeedbackSeveritySchema,
  suggested_fix: z.string().max(1000).optional(),
  context: z.string().max(500).optional(),
});

export type ContributeFeedbackParams = z.infer<typeof ContributeFeedbackParamsSchema>;

/**
 * Validate contribute_feedback params
 */
export function validateContributeFeedbackParams(params: unknown): {
  success: boolean;
  data?: ContributeFeedbackParams;
  error?: string;
} {
  const result = ContributeFeedbackParamsSchema.safeParse(params);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
  return { success: false, error: errors.join("; ") };
}

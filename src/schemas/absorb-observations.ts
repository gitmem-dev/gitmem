/**
 * Zod schema for absorb_observations tool parameters (GitMem v2 Phase 2)
 */

import { z } from "zod";

export const ObservationSeveritySchema = z.enum(["info", "warning", "scar_candidate"]);

export const ObservationSchema = z.object({
  source: z.string().min(1, "source is required — who made this observation?").max(500),
  text: z.string().min(1, "text is required — what was observed?").max(5000),
  severity: ObservationSeveritySchema,
  context: z.string().max(1000).optional(),
});

export const AbsorbObservationsParamsSchema = z.object({
  task_id: z.string().optional(),
  observations: z.array(ObservationSchema)
    .min(1, "at least one observation is required"),
});

export type AbsorbObservationsParams = z.infer<typeof AbsorbObservationsParamsSchema>;

export function validateAbsorbObservationsParams(params: unknown): {
  success: boolean;
  data?: AbsorbObservationsParams;
  error?: string;
} {
  const result = AbsorbObservationsParamsSchema.safeParse(params);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
  return { success: false, error: errors.join("; ") };
}

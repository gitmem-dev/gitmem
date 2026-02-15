/**
 * Zod schema for record_scar_usage tool parameters
 */

import { z } from "zod";
import { ReferenceTypeSchema, ISOTimestampSchema } from "./common.js";

/**
 * Record scar usage parameters schema
 */
export const RecordScarUsageParamsSchema = z.object({
  scar_id: z.string().uuid("scar_id must be a valid UUID"),
  issue_id: z.string().optional(),
  issue_identifier: z.string().optional(),
  session_id: z.string().optional(),
  agent: z.string().optional(),
  surfaced_at: ISOTimestampSchema,
  acknowledged_at: ISOTimestampSchema.optional(),
  reference_type: ReferenceTypeSchema,
  reference_context: z.string(),
  execution_successful: z.boolean().optional(),
  variant_id: z.string().uuid().optional(),
});

export type RecordScarUsageParams = z.infer<typeof RecordScarUsageParamsSchema>;

/**
 * Validate record_scar_usage params
 */
export function validateRecordScarUsageParams(params: unknown): {
  success: boolean;
  data?: RecordScarUsageParams;
  error?: string;
} {
  const result = RecordScarUsageParamsSchema.safeParse(params);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
  return { success: false, error: errors.join("; ") };
}

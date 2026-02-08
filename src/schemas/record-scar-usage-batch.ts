/**
 * Zod schema for record_scar_usage_batch tool parameters
 */

import { z } from "zod";
import { ProjectSchema } from "./common.js";
import { ScarUsageEntrySchema } from "./session-close.js";

/**
 * Record scar usage batch parameters schema
 */
export const RecordScarUsageBatchParamsSchema = z.object({
  scars: z.array(ScarUsageEntrySchema).min(1, "scars array cannot be empty"),
  project: ProjectSchema.optional(),
});

export type RecordScarUsageBatchParams = z.infer<typeof RecordScarUsageBatchParamsSchema>;

/**
 * Validate record_scar_usage_batch params
 */
export function validateRecordScarUsageBatchParams(params: unknown): {
  success: boolean;
  data?: RecordScarUsageBatchParams;
  error?: string;
} {
  const result = RecordScarUsageBatchParamsSchema.safeParse(params);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
  return { success: false, error: errors.join("; ") };
}

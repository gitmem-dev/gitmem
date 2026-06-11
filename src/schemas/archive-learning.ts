/**
 * Zod schema for archive_learning tool parameters
 */

import { z } from "zod";

/**
 * Archive learning parameters schema
 *
 * Accepts full UUIDs or short hex prefixes (4-32 chars).
 * Short prefixes are resolved to full UUIDs at runtime.
 */
export const ArchiveLearningParamsSchema = z.object({
  id: z.string().min(4, "ID must be at least 4 characters (short hex prefix or full UUID)").max(36),
  reason: z.string().max(500).optional(),
});

export type ArchiveLearningParams = z.infer<typeof ArchiveLearningParamsSchema>;

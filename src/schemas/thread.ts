/**
 * Zod schemas for thread lifecycle tools
 */

import { z } from "zod";
import { ProjectSchema } from "./common.js";

/**
 * Thread status enum
 */
export const ThreadStatusSchema = z.enum(["open", "resolved"]);

/**
 * Thread object schema (structured thread with lifecycle)
 */
export const ThreadObjectSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: ThreadStatusSchema,
  created_at: z.string(),
  resolved_at: z.string().optional(),
  source_session: z.string().optional(),
  resolved_by_session: z.string().optional(),
  resolution_note: z.string().optional(),
});

/**
 * list_threads parameters
 */
export const ListThreadsParamsSchema = z.object({
  status: ThreadStatusSchema.optional(),
  include_resolved: z.boolean().optional(),
  project: ProjectSchema.optional(),
});

/**
 * resolve_thread parameters
 */
export const ResolveThreadParamsSchema = z.object({
  thread_id: z.string().optional(),
  text_match: z.string().optional(),
  resolution_note: z.string().optional(),
});

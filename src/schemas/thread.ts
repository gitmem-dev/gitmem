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
  id: z.string().max(100),
  text: z.string().max(3000),
  status: ThreadStatusSchema,
  created_at: z.string().max(100),
  resolved_at: z.string().max(100).optional(),
  source_session: z.string().max(100).optional(),
  resolved_by_session: z.string().max(100).optional(),
  resolution_note: z.string().max(1000).optional(),
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
  thread_id: z.string().max(100).optional(),
  text_match: z.string().max(500).optional(),
  resolution_note: z.string().max(1000).optional(),
});

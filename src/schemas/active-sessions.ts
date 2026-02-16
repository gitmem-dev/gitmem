/**
 * Zod schemas for active-sessions.json registry
 *
 * Validates data read from disk — defensive parsing of potentially corrupted JSON.
 */

import { z } from "zod";
import { AgentIdentitySchema, ProjectSchema } from "./common.js";

export const ActiveSessionEntrySchema = z.object({
  session_id: z.string().uuid(),
  agent: AgentIdentitySchema,
  started_at: z.string(),
  hostname: z.string(),
  pid: z.number().int().nonnegative(),
  project: ProjectSchema,
});

export const ActiveSessionsRegistrySchema = z.object({
  sessions: z.array(ActiveSessionEntrySchema),
});

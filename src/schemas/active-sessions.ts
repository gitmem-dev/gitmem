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
  // GIT-128: optional so registries written by older servers still parse.
  client_pid: z.number().int().positive().optional(),
});

export const ActiveSessionsRegistrySchema = z.object({
  sessions: z.array(ActiveSessionEntrySchema),
});

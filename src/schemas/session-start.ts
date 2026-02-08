/**
 * Zod schema for session_start tool parameters
 */

import { z } from "zod";
import { ProjectSchema, AgentIdentitySchema } from "./common.js";

/**
 * Session start parameters schema
 *
 * All parameters are optional - the tool can auto-detect agent
 * and use defaults for project.
 */
export const SessionStartParamsSchema = z.object({
  agent_identity: AgentIdentitySchema.optional(),
  linear_issue: z.string().optional(),
  issue_title: z.string().optional(),
  issue_description: z.string().optional(),
  issue_labels: z.array(z.string()).optional(),
  project: ProjectSchema.optional(),
  /** OD-558: Force overwrite of existing active session */
  force: z.boolean().optional(),
});

export type SessionStartParams = z.infer<typeof SessionStartParamsSchema>;

/**
 * Validate session_start params
 */
export function validateSessionStartParams(params: unknown): {
  success: boolean;
  data?: SessionStartParams;
  error?: string;
} {
  const result = SessionStartParamsSchema.safeParse(params);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
  return { success: false, error: errors.join("; ") };
}

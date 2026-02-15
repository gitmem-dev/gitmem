/**
 * Agent Detection Service
 *
 * Detects which Claude agent is running based on environment variables,
 * Docker presence, and hostname.
 *
 * Detection matrix (from CLAUDE.md):
 * | ENTRYPOINT | Docker | Hostname | Identity |
 * |------------|--------|----------|----------|
 * | cli        | YES    | (any)    | CLI      |
 * | cli        | NO     | (server hostname)  | CODA-1 |
 * | claude-desktop | NO | (any)    | DAC      |
 * | (empty)    | NO     | (local)  | Brain_Local |
 * | (empty)    | NO     | (no fs)  | Brain_Cloud |
 */

import * as fs from "node:fs";
import * as os from "node:os";
import type { AgentIdentity, DetectedEnvironment } from "../types/index.js";

/**
 * Check if running in Docker container
 */
function isDocker(): boolean {
  try {
    return fs.existsSync("/.dockerenv");
  } catch {
    return false;
  }
}

/**
 * Check if filesystem is accessible (Brain Local vs Brain Cloud)
 */
function hasFilesystemAccess(): boolean {
  try {
    fs.accessSync("/tmp", fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the current agent identity based on environment
 */
export function detectAgent(): DetectedEnvironment {
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || null;
  const docker = isDocker();
  const hostname = os.hostname();

  let agent: AgentIdentity;

  if (entrypoint === "cli") {
    if (docker) {
      // CLI in Docker container
      agent = "CLI";
    } else if (process.env.GITMEM_AGENT_HOSTNAME && (hostname === process.env.GITMEM_AGENT_HOSTNAME)) {
      // CLI on configured server = CODA-1
      agent = "CODA-1";
    } else {
      // CLI elsewhere (fallback)
      agent = "CLI";
    }
  } else if (entrypoint === "claude-desktop") {
    // Desktop app code tab
    agent = "DAC";
  } else if (!entrypoint) {
    // No entrypoint - could be Brain Local or Brain Cloud
    if (hasFilesystemAccess()) {
      agent = "Brain_Local";
    } else {
      agent = "Brain_Cloud";
    }
  } else {
    // Unknown entrypoint
    agent = "Unknown";
  }

  return {
    entrypoint,
    docker,
    hostname,
    agent,
  };
}

/**
 * Get just the agent identity (convenience function)
 */
export function getAgentIdentity(): AgentIdentity {
  return detectAgent().agent;
}

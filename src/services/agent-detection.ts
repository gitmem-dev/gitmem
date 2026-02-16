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
      agent = "cli";
    } else if (process.env.GITMEM_AGENT_HOSTNAME && (hostname === process.env.GITMEM_AGENT_HOSTNAME)) {
      agent = "autonomous";
    } else {
      agent = "cli";
    }
  } else if (entrypoint === "claude-desktop") {
    agent = "desktop";
  } else if (!entrypoint) {
    if (hasFilesystemAccess()) {
      agent = "local";
    } else {
      agent = "cloud";
    }
  } else {
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
 * Normalize legacy agent names to new generic names.
 * Accepts both old (CLI, DAC, CODA-1, Brain_Local, Brain_Cloud)
 * and new (cli, desktop, autonomous, local, cloud) formats.
 */
const LEGACY_MAP: Record<string, AgentIdentity> = {
  "CLI": "cli",
  "DAC": "desktop",
  "CODA-1": "autonomous",
  "Brain_Local": "local",
  "Brain_Cloud": "cloud",
};

export function normalizeAgent(input: string): AgentIdentity {
  return LEGACY_MAP[input] || input as AgentIdentity;
}

/**
 * Get just the agent identity (convenience function)
 */
export function getAgentIdentity(): AgentIdentity {
  return detectAgent().agent;
}

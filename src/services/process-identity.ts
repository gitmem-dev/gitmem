/**
 * Process identity (GIT-128)
 *
 * Two clients on one machine (Claude Code CLI, the desktop app's server that
 * Brain reaches through the bridge, Cursor) each run their own gitmem server
 * against the same store. Session state used to carry no notion of who wrote
 * it, so one client's server could adopt another client's session, overwrite
 * its confirmations, and disarm its push gate.
 *
 * A session is owned by the client that started it. The server pid alone is
 * not enough, because a client restarting its server is the normal way a
 * session outlives a process (GIT-51/GIT-89) — the client pid survives that,
 * a different client's does not.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import type { AgentIdentity, WriterIdentity } from "../types/index.js";

/**
 * Command lines of the wrappers between a client and this server: `npx -y
 * gitmem-mcp`, `npm exec gitmem-mcp@x`, the desktop app's
 * `disclaimer ... npx -y gitmem-mcp`, `node .../bin/gitmem.js`. The client
 * itself never names the package; its wrappers always do.
 */
const LAUNCHER_PATTERN = /gitmem-mcp|(?:^|[\/\s])gitmem(?:\.js)?(?:\s|$)/i;
const MAX_DEPTH = 12;

export function isLauncherCommand(command: string): boolean {
  return LAUNCHER_PATTERN.test(command);
}

interface ProcessInfo {
  ppid: number;
  command: string;
}

function readProcess(pid: number): ProcessInfo | null {
  try {
    if (process.platform === "linux" && fs.existsSync(`/proc/${pid}/stat`)) {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 4 follows the parenthesised comm, which may itself contain spaces.
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
      return Number.isFinite(ppid) ? { ppid, command } : null;
    }
    const out = execFileSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    const match = out.match(/^(\d+)\s+(.*)$/s);
    return match ? { ppid: Number(match[1]), command: match[2] } : null;
  } catch {
    return null;
  }
}

/**
 * The ancestors of `pid`, nearest first, stopping before pid 1.
 */
export function getAncestors(pid: number = process.pid): Array<{ pid: number; command: string }> {
  const chain: Array<{ pid: number; command: string }> = [];
  let current = readProcess(pid)?.ppid ?? 0;
  while (current > 1 && chain.length < MAX_DEPTH) {
    const info = readProcess(current);
    if (!info) break;
    chain.push({ pid: current, command: info.command });
    current = info.ppid;
  }
  return chain;
}

/**
 * The client that launched `serverPid`: its nearest ancestor that is not a
 * gitmem launcher wrapper. GITMEM_CLIENT_PID overrides detection for clients
 * that launch the server in some other way.
 */
export function findClientPid(serverPid: number = process.pid, override?: string): number | null {
  const fromEnv = Number(override);
  if (override && Number.isInteger(fromEnv) && fromEnv > 1) return fromEnv;

  for (const ancestor of getAncestors(serverPid)) {
    if (!isLauncherCommand(ancestor.command)) return ancestor.pid;
  }
  return null;
}

let cachedClientPid: number | null | undefined;
let clientLabel: string | undefined;

/** This server's client pid, resolved once per process. */
export function getClientPid(): number | null {
  if (cachedClientPid === undefined) {
    cachedClientPid = findClientPid(process.pid, process.env.GITMEM_CLIENT_PID);
  }
  return cachedClientPid;
}

/** Record the MCP clientInfo the client sent on initialize. */
export function setClientInfo(info: { name?: string; version?: string } | undefined): void {
  if (!info?.name) return;
  clientLabel = info.version ? `${info.name}/${info.version}` : info.name;
}

/** The identity stamped on every entry this process writes into a session. */
export function getWriterIdentity(agent: AgentIdentity): WriterIdentity {
  return {
    agent,
    server_pid: process.pid,
    client_pid: getClientPid(),
    ...(clientLabel && { client: clientLabel }),
  };
}

/**
 * Whether this process may take over a session whose server died.
 *
 * Only the client that owns the session may: that is a restart. A session with
 * no recorded owner was written by a server older than GIT-128 and stays
 * adoptable, as before, so sessions open across the upgrade survive it.
 */
export function canAdoptSession(owner: unknown): boolean {
  if (!owner || typeof owner !== "object") return true;
  const ownerClient = (owner as { client_pid?: unknown }).client_pid;
  if (typeof ownerClient !== "number") return true;
  return ownerClient === getClientPid();
}

/** Test hook: forget the cached client pid and label. */
export function resetProcessIdentityForTests(): void {
  cachedClientPid = undefined;
  clientLabel = undefined;
}

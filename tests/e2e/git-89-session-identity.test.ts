/**
 * GIT-89 E2E: a session must survive a real MCP server restart.
 *
 * The reported defect is not reproducible in-process. Session identity lives in
 * a long-lived server process; what breaks it is that process dying and a new
 * one taking over while the on-disk state stays put. Every assertion here
 * therefore runs against a genuinely restarted server over the real MCP stdio
 * protocol — the same surface an agent uses — rather than by calling the
 * resolver directly. An in-process test of this bug proves nothing, because the
 * thing that fails is the process boundary.
 *
 * Covers the acceptance criteria that can be checked without a scar corpus:
 *   AC#2  session survives restart with zero false "No active session" warnings
 *   AC#4  session_close resolves the session without being told its id
 *   AC#5  a genuinely absent session still warns (no invented sessions)
 *
 * AC#3 (surfacing continuity) is deliberately NOT asserted here. recall()
 * surfaces nothing against an empty free-tier store, so an assertion would read
 * `before=0, after=0` and pass without testing anything — a green result that
 * means the instrument had no material to work with. It is covered at unit
 * level in tests/unit/services/session-state-surfacing.test.ts, where the
 * surfacing can be seeded. Restoring it here needs a store with real scars.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createMcpClient,
  callTool,
  restartServer,
  getToolResultText,
  createTierEnv,
  type McpTestClient,
} from "./mcp-client.js";

const NO_ACTIVE_SESSION = /No active session/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Tools that must never report a missing session while one is live on disk. */
const SESSION_REQUIRED_TOOLS = [
  { name: "recall", args: { plan: "continue the work after a restart", project: "gitmem" } },
  {
    name: "create_learning",
    args: {
      title: "GIT-89 post-restart probe",
      learning_type: "pattern",
      description: "Written after a real MCP server restart.",
      project: "gitmem",
    },
  },
  {
    name: "create_thread",
    args: { title: "GIT-89 post-restart thread", description: "Written after a restart.", project: "gitmem" },
  },
  {
    name: "create_decision",
    args: {
      title: "GIT-89 post-restart decision",
      decision: "Resolve identity from disk.",
      rationale: "The registry is the store that gets lost.",
      project: "gitmem",
    },
  },
] as const;

describe("GIT-89: session identity survives an MCP server restart", () => {
  let root: string;
  let env: Record<string, string>;
  let mcp: McpTestClient;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "gitmem-git89-e2e-"));
    // Isolate the store: this suite must never touch the developer's real
    // .gitmem, and must not depend on what happens to be in it (GIT-92).
    env = { ...createTierEnv("free"), GITMEM_DIR: root, HOME: root };
    mcp = await createMcpClient(env, { cwd: root });
  });

  afterEach(async () => {
    await mcp.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  const readSessionFile = (id: string): Record<string, unknown> | null => {
    const p = join(root, "sessions", id, "session.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null;
  };

  const startSession = async (): Promise<string> => {
    const res = await callTool(mcp.client, "session_start", { project: "gitmem", agent_identity: "cli" });
    const id = getToolResultText(res).match(UUID)?.[0];
    expect(id, "session_start must return a session id").toBeTruthy();
    return id!;
  };

  // NOTE: assertions here read the PID out of the registry rather than off
  // McpTestClient.process. That field is typed ChildProcess but createMcpClient
  // never assigns it (`process: serverProcess!` — serverProcess stays null), so
  // touching it throws. The registry PID is also the better witness: it is what
  // the product actually wrote, not what the test harness happens to know.
  const registryPidFor = (sessionId: string): number | undefined => {
    const registry = JSON.parse(readFileSync(join(root, "active-sessions.json"), "utf-8"));
    return registry.sessions?.find((s: { session_id: string }) => s.session_id === sessionId)?.pid;
  };

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("keeps the same session id across a restart", async () => {
    const sessionId = await startSession();
    const pidBefore = registryPidFor(sessionId);

    mcp = await restartServer(mcp, env, { cwd: root });

    // Identity is re-derived by the new process, not carried in memory.
    const after = await callTool(mcp.client, "recall", { plan: "resume", project: "gitmem" });
    expect(getToolResultText(after)).not.toMatch(NO_ACTIVE_SESSION);
    expect(readSessionFile(sessionId)).not.toBeNull();
    expect(registryPidFor(sessionId)).not.toBe(pidBefore);
  });

  it.each(SESSION_REQUIRED_TOOLS.map((t) => [t.name, t.args] as const))(
    "AC#2: %s does not warn about a missing session after a restart",
    async (name, args) => {
      await startSession();
      mcp = await restartServer(mcp, env, { cwd: root });

      const text = getToolResultText(await callTool(mcp.client, name, args as Record<string, unknown>));

      expect(text).not.toMatch(NO_ACTIVE_SESSION);
    }
  );

  it("AC#2: repairs the on-disk registry to the new, live process", async () => {
    const sessionId = await startSession();
    const pidBefore = registryPidFor(sessionId);
    expect(pidBefore, "session_start must register the session").toBeTruthy();

    mcp = await restartServer(mcp, env, { cwd: root });
    await callTool(mcp.client, "recall", { plan: "resume", project: "gitmem" });

    const pidAfter = registryPidFor(sessionId);

    // The entry must be reclaimed, not merely left behind: a stale PID here is
    // the original defect — the registry pointing at a process that is gone.
    expect(pidAfter, "the restarted process must reclaim the registry entry").toBeTruthy();
    expect(pidAfter).not.toBe(pidBefore);
    expect(isAlive(pidAfter!), "the reclaimed PID must be a live process").toBe(true);
  });

  it("AC#2: restores recall_called, so writes are not told recall never ran", async () => {
    const sessionId = await startSession();
    await callTool(mcp.client, "recall", { plan: "before the restart", project: "gitmem" });

    mcp = await restartServer(mcp, env, { cwd: root });
    await callTool(mcp.client, "create_learning", {
      title: "GIT-89 recall_called probe",
      learning_type: "pattern",
      description: "probe",
      project: "gitmem",
    });

    expect(readSessionFile(sessionId)?.recall_called).toBe(true);
  });

  it("AC#4: session_close resolves the session without being passed its id", async () => {
    await startSession();
    mcp = await restartServer(mcp, env, { cwd: root });

    // No session_id — the agent has lost it to the restart, which is the point.
    const res = await callTool(mcp.client, "session_close", { close_type: "quick" });
    const text = getToolResultText(res);

    // Assert on the failure shapes this specifically regressed through: a schema
    // rejection ("session_id: Required") never reaches the resolution logic, and
    // an {"error": ...} body is not a close. Checking only for absence of the
    // words "No active session" passed this test while it was broken.
    expect(res.isError ?? false).toBe(false);
    expect(text).not.toMatch(/session_id.*Required/i);
    expect(text).not.toMatch(/Invalid parameters/i);
    expect(text).not.toMatch(NO_ACTIVE_SESSION);
  });

  it("AC#5: still warns when there is genuinely no session", async () => {
    // Fresh store, no session_start — a real absence, not a lost identity.
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(join(root, "active-sessions.json"), JSON.stringify({ sessions: [] }));

    const text = getToolResultText(
      await callTool(mcp.client, "create_learning", {
        title: "GIT-89 absent-session probe",
        learning_type: "pattern",
        description: "probe",
        project: "gitmem",
      })
    );

    expect(text).toMatch(NO_ACTIVE_SESSION);
  });
});

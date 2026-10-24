/**
 * GIT-128: a session belongs to the client that started it.
 *
 * Two clients on one machine (CLI and the desktop server Brain reaches through
 * the bridge) shared one session file: the second client's server adopted the
 * first's session, its confirm_scars replaced the first's confirmations, and
 * nothing in the file said who wrote what.
 *
 * Real registry and session files in a temp dir, as in the GIT-51 recovery
 * suite. The cross-process cases with real servers and real hooks are in
 * tests/e2e/git-128-concurrent-clients.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { setGitmemDir, clearGitmemDirCache } from "../../../src/services/gitmem-dir.js";
import { registerSession, findResumableSessionOnDisk, listActiveSessions } from "../../../src/services/active-sessions.js";
import {
  setCurrentSession,
  clearCurrentSession,
  addConfirmations,
  addSurfacedScars,
  getConfirmations,
  getConfirmationLog,
} from "../../../src/services/session-state.js";
import {
  isLauncherCommand,
  findClientPid,
  getClientPid,
  canAdoptSession,
  getAncestors,
  resetProcessIdentityForTests,
} from "../../../src/services/process-identity.js";
import { confirmScars } from "../../../src/tools/confirm-scars.js";
import type { ScarConfirmation, SurfacedScar } from "../../../src/types/index.js";

const HOSTNAME = os.hostname();
const DEAD_PID = 99999999;
const SID = "12345678-1234-4234-8234-123456789abc";

const scar = (id: string, title: string): SurfacedScar => ({
  scar_id: id,
  scar_title: title,
  scar_severity: "high",
  surfaced_at: new Date().toISOString(),
  source: "recall",
});
const SCAR_X = scar("aaaaaaaa-1111-4111-8111-111111111111", "Scar X");
const SCAR_Y = scar("bbbbbbbb-2222-4222-8222-222222222222", "Scar Y");

const conf = (s: SurfacedScar, at: string): ScarConfirmation => ({
  scar_id: s.scar_id,
  scar_title: s.scar_title,
  decision: "N_A",
  evidence: "The scenario in this scar was compared with the task and it does not apply here.",
  confirmed_at: at,
});

let tmpDir: string;

function writeSession(data: Record<string, unknown>, id = SID): string {
  const dir = path.join(tmpDir, "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "session.json");
  fs.writeFileSync(file, JSON.stringify({
    session_id: id,
    agent: "cli",
    started_at: new Date().toISOString(),
    project: "gitmem",
    hostname: HOSTNAME,
    pid: process.pid,
    surfaced_scars: [],
    threads: [],
    ...data,
  }));
  return file;
}
const readSession = (id = SID) => JSON.parse(fs.readFileSync(path.join(tmpDir, "sessions", id, "session.json"), "utf8"));

function startOwnSession(extra: Record<string, unknown> = {}): string {
  const file = writeSession(extra);
  setCurrentSession({ sessionId: SID, agent: "cli", project: "gitmem", startedAt: new Date() });
  return file;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-git128-"));
  setGitmemDir(tmpDir);
  clearCurrentSession();
  resetProcessIdentityForTests();
});

afterEach(() => {
  clearCurrentSession();
  clearGitmemDirCache();
  resetProcessIdentityForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("client identity", () => {
  it("treats the wrappers between a client and the server as launchers", () => {
    expect(isLauncherCommand("npm exec gitmem-mcp@1.11.2")).toBe(true);
    expect(isLauncherCommand("/usr/local/bin/npx -y gitmem-mcp@1.11.2")).toBe(true);
    expect(isLauncherCommand("/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- /usr/local/bin/npx -y gitmem-mcp@1.11.2")).toBe(true);
    expect(isLauncherCommand("node /opt/pkg/bin/gitmem.js")).toBe(true);
  });

  it("does not treat the client itself as a launcher", () => {
    expect(isLauncherCommand("/Users/x/Library/Application Support/Claude/claude-code/2.1/claude --output-format stream-json")).toBe(false);
    expect(isLauncherCommand("/Applications/Cursor.app/Contents/MacOS/Cursor")).toBe(false);
    expect(isLauncherCommand("node /home/x/gitmem-repro/clienthost.mjs")).toBe(false);
  });

  it("finds the client among the real ancestors of this process", () => {
    const client = findClientPid(process.pid);
    expect(client).not.toBeNull();
    expect(getAncestors(process.pid).map((a) => a.pid)).toContain(client);
  });

  it("honours GITMEM_CLIENT_PID", () => {
    expect(findClientPid(process.pid, "4242")).toBe(4242);
    expect(findClientPid(process.pid, "not-a-pid")).not.toBe(4242);
  });

  it("lets only the owning client adopt a session; ownerless (pre-GIT-128) sessions stay adoptable", () => {
    expect(canAdoptSession(undefined)).toBe(true);
    expect(canAdoptSession({ agent: "cli", server_pid: 1 })).toBe(true);
    expect(canAdoptSession({ client_pid: getClientPid() })).toBe(true);
    expect(canAdoptSession({ client_pid: 424242 })).toBe(false);
  });
});

describe("findResumableSessionOnDisk — adoption after a server dies", () => {
  const seedDead = (owner?: Record<string, unknown>) => {
    registerSession({ session_id: SID, agent: "cli", started_at: new Date().toISOString(), hostname: HOSTNAME, pid: DEAD_PID, project: "gitmem" });
    writeSession({ pid: DEAD_PID, ...(owner && { owner }) });
  };

  it("refuses a session another client owns, however dead its server is", () => {
    seedDead({ agent: "local", server_pid: DEAD_PID, client_pid: 424242 });
    expect(findResumableSessionOnDisk("gitmem")).toBeNull();
    expect(readSession().pid).toBe(DEAD_PID);
  });

  it("adopts this client's own session after a restart and records the new serving pid", () => {
    seedDead({ agent: "cli", server_pid: DEAD_PID, client_pid: getClientPid() });
    const entry = findResumableSessionOnDisk("gitmem");
    expect(entry?.session_id).toBe(SID);
    expect(entry?.pid).toBe(process.pid);
    expect(entry?.client_pid).toBe(getClientPid());
    expect(readSession().pid).toBe(process.pid);
    expect(readSession().owner.server_pid).toBe(process.pid);
    const reg = listActiveSessions().find((s) => s.session_id === SID);
    expect(reg?.pid).toBe(process.pid);
    expect(reg?.client_pid).toBe(getClientPid());
  });

  it("still adopts a session written before GIT-128 (no owner)", () => {
    seedDead();
    expect(findResumableSessionOnDisk("gitmem")?.session_id).toBe(SID);
  });
});

describe("confirmations are append-only, with their writer", () => {
  it("a second confirm keeps the first (was: file replaced with the latest batch)", () => {
    startOwnSession({ surfaced_scars: [SCAR_X, SCAR_Y] });
    expect(addConfirmations([conf(SCAR_X, "2026-10-24T10:00:00.000Z")])).toBeNull();
    expect(addConfirmations([conf(SCAR_Y, "2026-10-24T10:01:00.000Z")])).toBeNull();

    const file = readSession();
    expect(file.confirmations.map((c: ScarConfirmation) => c.scar_id)).toEqual([SCAR_X.scar_id, SCAR_Y.scar_id]);
  });

  it("a re-confirmation is a new entry; the current view is the latest per scar", () => {
    startOwnSession({ surfaced_scars: [SCAR_X] });
    addConfirmations([conf(SCAR_X, "2026-10-24T10:00:00.000Z")]);
    addConfirmations([{ ...conf(SCAR_X, "2026-10-24T10:05:00.000Z"), decision: "REFUTED" }]);

    expect(readSession().confirmations).toHaveLength(2);
    expect(getConfirmationLog()).toHaveLength(2);
    expect(getConfirmations()).toHaveLength(1);
    expect(getConfirmations()[0].decision).toBe("REFUTED");
  });

  it("stamps each confirmation with agent, server pid and client pid", () => {
    startOwnSession({ surfaced_scars: [SCAR_X] });
    addConfirmations([conf(SCAR_X, "2026-10-24T10:00:00.000Z")]);
    expect(readSession().confirmations[0].writer).toEqual({
      agent: "cli",
      server_pid: process.pid,
      client_pid: getClientPid(),
    });
  });

  it("refuses to write into a session another live server serves", () => {
    // process.ppid is alive and is not this process: another server owns the file.
    startOwnSession({ surfaced_scars: [SCAR_X], pid: process.ppid });
    const reason = addConfirmations([conf(SCAR_X, "2026-10-24T10:00:00.000Z")]);
    expect(reason).toMatch(/served by another gitmem process/);
    expect(readSession().confirmations ?? []).toEqual([]);
    expect(getConfirmationLog()).toEqual([]);
  });

  it("confirm_scars does not say ACCEPTED when the write was refused", async () => {
    startOwnSession({ surfaced_scars: [SCAR_X] });
    // Another server takes the session over after this one loaded it.
    const file = readSession();
    fs.writeFileSync(path.join(tmpDir, "sessions", SID, "session.json"), JSON.stringify({ ...file, pid: process.ppid }));

    const result = await confirmScars({ confirmations: [{ scar_id: SCAR_X.scar_id, decision: "N_A", evidence: conf(SCAR_X, "").evidence }] });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/not recorded/);
    expect(result.formatted_response).not.toMatch(/ACCEPTED/);
  });

  it("resuming a session keeps the confirmations already in its file", () => {
    writeSession({ surfaced_scars: [SCAR_X], confirmations: [conf(SCAR_X, "2026-10-24T10:00:00.000Z")] });
    setCurrentSession({ sessionId: SID, agent: "cli", project: "gitmem", startedAt: new Date() });
    expect(getConfirmations().map((c) => c.scar_id)).toEqual([SCAR_X.scar_id]);
  });
});

describe("surfaced scars are append-only, with their writer", () => {
  it("keeps entries already in the file that this process's memory lacks", () => {
    startOwnSession();
    // Written to the file after this process loaded the session (e.g. a restart in between).
    const file = readSession();
    fs.writeFileSync(path.join(tmpDir, "sessions", SID, "session.json"), JSON.stringify({ ...file, surfaced_scars: [SCAR_X] }));

    expect(addSurfacedScars([SCAR_Y])).toBe(true);
    const ids = readSession().surfaced_scars.map((s: SurfacedScar) => s.scar_id);
    expect(ids).toEqual([SCAR_X.scar_id, SCAR_Y.scar_id]);
    expect(readSession().surfaced_scars[1].writer.server_pid).toBe(process.pid);
  });

  it("refuses to track scars in a session another live server serves", () => {
    startOwnSession({ pid: process.ppid });
    expect(addSurfacedScars([SCAR_X])).toBe(false);
    expect(readSession().surfaced_scars).toEqual([]);
  });
});

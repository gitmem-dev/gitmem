/**
 * GIT-86: session_start must never resume a session of another project.
 *
 * One desktop process serves every chat, so this process's registry entries
 * and session directories belong to several conversations at once. Before the
 * fix, session_start(Y) found X by hostname+pid, overwrote the caller's
 * project with X's (stderr only) and continued the X session in the Y chat.
 *
 * Runs the real session_start on the free tier against a temp .gitmem root.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("../../../src/services/agent-detection.js", () => ({
  detectAgent: () => ({ agent: "desktop", entrypoint: "claude-desktop", docker: false, hostname: os.hostname() }),
}));

import { sessionStart } from "../../../src/tools/session-start.js";
import { setGitmemDir, clearGitmemDirCache } from "../../../src/services/gitmem-dir.js";
import { resetTier } from "../../../src/services/tier.js";
import { listActiveSessions, findResumableSessionOnDisk, pruneStale } from "../../../src/services/active-sessions.js";
import { clearCurrentSession, getCurrentSession, addSurfacedScars, addConfirmations } from "../../../src/services/session-state.js";

let tmpDir: string;

const sessionDirExists = (id: string) => fs.existsSync(path.join(tmpDir, "sessions", id, "session.json"));

beforeEach(() => {
  vi.stubEnv("GITMEM_TIER", "free");
  resetTier();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-git86-"));
  setGitmemDir(tmpDir);
  clearCurrentSession();
});

afterEach(() => {
  clearCurrentSession();
  clearGitmemDirCache();
  resetTier();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("session_start across projects (GIT-86)", () => {
  it("X open; session_start(Y) starts a new Y session and X stays resumable", async () => {
    const x = await sessionStart({ project: "proj-x" });
    expect(x.project).toBe("proj-x");

    const y = await sessionStart({ project: "proj-y" });
    expect(y.session_id).not.toBe(x.session_id);
    expect(y.project).toBe("proj-y");
    expect(y.resumed).toBeUndefined();

    // X left open: registry entry, session directory, and a prune pass keep it.
    pruneStale();
    expect(sessionDirExists(x.session_id)).toBe(true);
    expect(listActiveSessions().map((s) => [s.session_id, s.project]).sort()).toEqual(
      [[x.session_id, "proj-x"], [y.session_id, "proj-y"]].sort()
    );

    // ...and resumable by asking for X again.
    const xAgain = await sessionStart({ project: "proj-x" });
    expect(xAgain.session_id).toBe(x.session_id);
    expect(xAgain.resumed).toBe(true);
    expect(xAgain.project).toBe("proj-x");

    // Y, likewise, was not displaced by resuming X.
    const yAgain = await sessionStart({ project: "proj-y" });
    expect(yAgain.session_id).toBe(y.session_id);
    expect(yAgain.resumed).toBe(true);
  });

  it("resumes the same project's session as before", async () => {
    const first = await sessionStart({ project: "proj-x" });
    const second = await sessionStart({ project: "proj-x" });
    expect(second.session_id).toBe(first.session_id);
    expect(second.resumed).toBe(true);
    expect(second.project_from_resumed_session).toBeUndefined();
  });

  it("no project passed: resumes the most recent session and names its project in the display", async () => {
    await sessionStart({ project: "proj-x" });
    await new Promise((r) => setTimeout(r, 5)); // distinct started_at
    const y = await sessionStart({ project: "proj-y" });

    const bare = await sessionStart({});
    expect(bare.session_id).toBe(y.session_id);
    expect(bare.resumed).toBe(true);
    expect(bare.project).toBe("proj-y");
    expect(bare.project_from_resumed_session).toBe(true);
    expect(bare.display).toContain("Resumed project: proj-y");
  });

  it("the disk scan honours the requested project when the registry is lost", async () => {
    const x = await sessionStart({ project: "proj-x" });
    fs.writeFileSync(path.join(tmpDir, "active-sessions.json"), JSON.stringify({ sessions: [] }));

    expect(findResumableSessionOnDisk("proj-y")).toBeNull();
    expect(findResumableSessionOnDisk("proj-x")?.session_id).toBe(x.session_id);

    const y = await sessionStart({ project: "proj-y" });
    expect(y.session_id).not.toBe(x.session_id);
    expect(y.resumed).toBeUndefined();
  });

  it("force:true carries activity forward from a same-project session only", async () => {
    const scar = { scar_id: "s-1", scar_title: "t", scar_severity: "medium", surfaced_at: new Date().toISOString(), source: "recall" as const };

    // Different project in memory: nothing carried, the X session stays open.
    const conf = (id: string) => ({ scar_id: id, scar_title: "t", decision: "APPLYING" as const, evidence: "e", confirmed_at: new Date().toISOString() });
    const x = await sessionStart({ project: "proj-x" });
    addSurfacedScars([scar]);
    addConfirmations([conf("s-1")]);
    const xStartedAt = getCurrentSession()!.startedAt;
    await new Promise((r) => setTimeout(r, 5));
    const y = await sessionStart({ project: "proj-y", force: true });
    expect(y.session_id).not.toBe(x.session_id);
    expect(getCurrentSession()!.surfacedScars).toHaveLength(0);
    expect(getCurrentSession()!.confirmations).toHaveLength(0);
    expect(getCurrentSession()!.startedAt.getTime()).toBeGreaterThan(xStartedAt.getTime());
    expect(sessionDirExists(x.session_id)).toBe(true);
    expect(listActiveSessions().some((s) => s.session_id === x.session_id)).toBe(true);

    // Same project in memory: carried as before (t-f7c2fa01).
    addSurfacedScars([{ ...scar, scar_id: "s-2" }]);
    addConfirmations([conf("s-2")]);
    const yStartedAt = getCurrentSession()!.startedAt;
    const y2 = await sessionStart({ project: "proj-y", force: true });
    expect(y2.session_id).not.toBe(y.session_id);
    expect(getCurrentSession()!.surfacedScars.map((s) => s.scar_id)).toEqual(["s-2"]);
    expect(getCurrentSession()!.confirmations.map((c) => c.scar_id)).toEqual(["s-2"]);
    expect(getCurrentSession()!.startedAt.getTime()).toBe(yStartedAt.getTime());
    // The same-project predecessor is displaced; X is still untouched.
    const ids = listActiveSessions().map((s) => s.session_id);
    expect(ids).toContain(x.session_id);
    expect(ids).not.toContain(y.session_id);
  });
});

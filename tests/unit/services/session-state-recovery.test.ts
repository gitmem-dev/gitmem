/**
 * Tests for getSurfacedScars() registry-based recovery (Fallback 2).
 *
 * When MCP restarts completely (currentSession is null), getSurfacedScars()
 * should recover scars from the active-sessions registry by finding the
 * most recent session for the current hostname and reading its session.json.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "os";

// Mock fs at module level — vi.spyOn(fs, "existsSync") fails because ESM re-exports are read-only.
// session-state.ts uses `import fs from "fs"` (default import), so we must set `default` explicitly.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const mocked = {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
  };
  return { ...mocked, default: mocked };
});

vi.mock("../../../src/services/active-sessions.js", () => ({
  listActiveSessions: vi.fn().mockReturnValue([]),
}));

vi.mock("../../../src/services/gitmem-dir.js", () => ({
  getSessionPath: vi.fn().mockReturnValue("/tmp/nonexistent/session.json"),
}));

import * as fs from "fs";
import {
  setCurrentSession,
  clearCurrentSession,
  getSurfacedScars,
  addSurfacedScars,
} from "../../../src/services/session-state.js";
import { listActiveSessions } from "../../../src/services/active-sessions.js";
import { getSessionPath } from "../../../src/services/gitmem-dir.js";

const HOSTNAME = os.hostname();

const MOCK_SCARS = [
  {
    scar_id: "aaaa1111-1111-1111-1111-111111111111",
    scar_title: "Trace execution path first",
    title: "Trace execution path first",
    severity: "high",
    surfaced_at: "2026-02-22T10:00:00.000Z",
    source: "recall" as const,
  },
  {
    scar_id: "bbbb2222-2222-2222-2222-222222222222",
    scar_title: "Done != Deployed",
    title: "Done != Deployed",
    severity: "high",
    surfaced_at: "2026-02-22T10:00:00.000Z",
    source: "recall" as const,
  },
];

describe("getSurfacedScars() registry recovery", () => {
  beforeEach(() => {
    clearCurrentSession();
    vi.mocked(listActiveSessions).mockReturnValue([]);
    vi.mocked(getSessionPath).mockReturnValue("/tmp/nonexistent/session.json");
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue("{}");
  });

  it("returns in-memory scars when session is active", () => {
    setCurrentSession({
      sessionId: "test-session-id",
      agent: "CLI",
      startedAt: new Date(),
    });
    addSurfacedScars(MOCK_SCARS);

    const result = getSurfacedScars();
    expect(result.length).toBe(2);
    expect(result[0].scar_id).toBe(MOCK_SCARS[0].scar_id);
  });

  it("returns empty array when no session and no registry entries", () => {
    vi.mocked(listActiveSessions).mockReturnValue([]);

    const result = getSurfacedScars();
    expect(result).toEqual([]);
  });

  it("recovers scars from registry when currentSession is null", () => {
    const sessionId = "recovered-session-id-1234-567890abcdef";
    const sessionFilePath = `/tmp/.gitmem/sessions/${sessionId}/session.json`;

    vi.mocked(listActiveSessions).mockReturnValue([
      {
        session_id: sessionId,
        hostname: HOSTNAME,
        pid: 99999,
        agent: "CLI",
        started_at: new Date().toISOString(),
      },
    ]);

    vi.mocked(getSessionPath).mockReturnValue(sessionFilePath);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ surfaced_scars: MOCK_SCARS })
    );

    const result = getSurfacedScars();

    expect(result.length).toBe(2);
    expect(result[0].scar_title).toBe("Trace execution path first");
    expect(result[1].scar_title).toBe("Done != Deployed");
  });

  it("picks most recent session from registry when multiple exist", () => {
    const oldSessionId = "old-session-aaaa-bbbb-ccccddddeeee";
    const newSessionId = "new-session-1111-2222-333344445555";

    vi.mocked(listActiveSessions).mockReturnValue([
      {
        session_id: oldSessionId,
        hostname: HOSTNAME,
        pid: 11111,
        agent: "CLI",
        started_at: "2026-02-22T08:00:00.000Z",
      },
      {
        session_id: newSessionId,
        hostname: HOSTNAME,
        pid: 22222,
        agent: "CLI",
        started_at: "2026-02-22T10:00:00.000Z",
      },
    ]);

    vi.mocked(getSessionPath).mockImplementation((sid: string) =>
      `/tmp/.gitmem/sessions/${sid}/session.json`
    );

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      const p = filePath as string;
      if (p.includes(newSessionId)) {
        return JSON.stringify({ surfaced_scars: MOCK_SCARS });
      }
      return JSON.stringify({ surfaced_scars: [] });
    });

    const result = getSurfacedScars();
    expect(result.length).toBe(2);
  });

  it("ignores registry sessions from different hostnames", () => {
    vi.mocked(listActiveSessions).mockReturnValue([
      {
        session_id: "other-host-session",
        hostname: "different-host",
        pid: 33333,
        agent: "CLI",
        started_at: new Date().toISOString(),
      },
    ]);

    const result = getSurfacedScars();
    expect(result).toEqual([]);
  });

  it("handles corrupted session.json gracefully", () => {
    const sessionId = "corrupt-session-1234";

    vi.mocked(listActiveSessions).mockReturnValue([
      {
        session_id: sessionId,
        hostname: HOSTNAME,
        pid: 44444,
        agent: "CLI",
        started_at: new Date().toISOString(),
      },
    ]);

    vi.mocked(getSessionPath).mockReturnValue(`/tmp/.gitmem/sessions/${sessionId}/session.json`);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not valid json{{{");

    const result = getSurfacedScars();
    expect(result).toEqual([]);
  });

  it("returns empty when session.json has no surfaced_scars field", () => {
    const sessionId = "no-scars-session-1234";

    vi.mocked(listActiveSessions).mockReturnValue([
      {
        session_id: sessionId,
        hostname: HOSTNAME,
        pid: 55555,
        agent: "CLI",
        started_at: new Date().toISOString(),
      },
    ]);

    vi.mocked(getSessionPath).mockReturnValue(`/tmp/.gitmem/sessions/${sessionId}/session.json`);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ agent: "CLI", started_at: new Date().toISOString() })
    );

    const result = getSurfacedScars();
    expect(result).toEqual([]);
  });
});

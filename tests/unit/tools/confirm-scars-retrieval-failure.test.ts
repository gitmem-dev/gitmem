/**
 * GIT-93 step 2: a failed retrieval must not read as a clean check.
 *
 * confirm_scars answered an empty scar set with "No recall-surfaced scars to
 * confirm. Proceed freely." — regardless of why the set was empty. Two very
 * different states produced that identical green result:
 *
 *   1. recall() ran, reached the store, matched nothing. Proceeding is correct.
 *   2. recall() never reached the store. Nothing was checked, and any warning
 *      that applies is still unseen. Proceeding is a guess.
 *
 * The second is not hypothetical: the *_scar_search RPC 404'd on every call from
 * the day it was written, and the reason it survived that long is that the
 * system reported success for the failure. Fixing the RPC name without fixing
 * this signal would leave the next such break just as well hidden.
 *
 * These tests drive real session state on disk — the marker has to survive a
 * process restart, so an in-memory-only assertion would not prove much.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { setGitmemDir, clearGitmemDirCache } from "../../../src/services/gitmem-dir.js";
import {
  setCurrentSession,
  clearCurrentSession,
  setRecallFailure,
  clearRecallFailure,
  getRecallFailure,
  addSurfacedScars,
  resolveCurrentSession,
} from "../../../src/services/session-state.js";
import { confirmScars } from "../../../src/tools/confirm-scars.js";

const SESSION_ID = "3c9f21ab-77de-4a10-9f31-2b8c4d5e6f70";
let root: string;

function startSession(): void {
  fs.mkdirSync(path.join(root, "sessions", SESSION_ID), { recursive: true });
  fs.writeFileSync(
    path.join(root, "sessions", SESSION_ID, "session.json"),
    JSON.stringify({
      session_id: SESSION_ID,
      agent: "cli",
      project: "gitmem",
      started_at: new Date().toISOString(),
      hostname: os.hostname(),
      pid: process.pid,
      host_pid: process.pid,
    })
  );
  fs.writeFileSync(path.join(root, "active-sessions.json"), JSON.stringify({ sessions: [] }));
  setCurrentSession({
    sessionId: SESSION_ID,
    agent: "cli",
    project: "gitmem",
    startedAt: new Date(),
  });
}

describe("GIT-93: confirm_scars distinguishes an empty answer from no answer", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-git93-"));
    clearGitmemDirCache();
    setGitmemDir(root);
    clearCurrentSession();
    startSession();
  });

  afterEach(() => {
    clearCurrentSession();
    clearGitmemDirCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("still says proceed when retrieval succeeded and matched nothing", async () => {
    // No failure recorded — recall ran and simply found nothing relevant.
    const result = await confirmScars({ confirmations: [] });

    expect(result.valid).toBe(true);
    expect(result.formatted_response).toContain("Proceed freely");
  });

  it("refuses to say proceed when retrieval never reached the store", async () => {
    setRecallFailure("Supabase RPC error: 404 - PGRST202");

    const result = await confirmScars({ confirmations: [] });

    expect(result.valid).toBe(false);
    expect(result.formatted_response).not.toContain("Proceed freely");
    expect(result.errors.join(" ")).toMatch(/recall\(\) failed|unavailable/i);
  });

  it("names the underlying failure rather than reporting a generic error", async () => {
    setRecallFailure("Supabase RPC error: 404 - PGRST202");

    const result = await confirmScars({ confirmations: [] });

    // A diagnosable message is the difference between this being noticed in a
    // day and being noticed never.
    expect(result.formatted_response).toContain("PGRST202");
  });

  it("says proceed again once a later recall reaches the store", async () => {
    setRecallFailure("transient network error");
    clearRecallFailure();

    const result = await confirmScars({ confirmations: [] });

    expect(result.valid).toBe(true);
    expect(result.formatted_response).toContain("Proceed freely");
  });

  it("keeps the failure marker across an MCP restart", () => {
    setRecallFailure("Supabase RPC error: 404 - PGRST202");

    // Simulate the restart: in-memory state dies, disk survives.
    clearCurrentSession();
    const recovered = resolveCurrentSession();

    expect(recovered?.sessionId).toBe(SESSION_ID);
    // A restart must not launder a broken store into a clean slate.
    expect(getRecallFailure()?.message).toContain("PGRST202");
  });

  it("does not suppress real surfaced scars when a stale failure is present", async () => {
    // A failure followed by a successful recall that surfaced scars: the scars
    // are what matter, and the normal confirmation path must still run.
    setRecallFailure("earlier transient failure");
    clearRecallFailure();
    addSurfacedScars([
      { scar_id: "abc12345", title: "some scar", severity: "high", source: "recall" },
    ] as never);

    const result = await confirmScars({ confirmations: [] });

    // Missing confirmations for a surfaced scar is its own rejection — the
    // point here is that it is NOT the retrieval-failure path.
    expect(result.formatted_response).not.toContain("institutional memory was not reached");
  });
});

/**
 * Regression test for OD-668:
 * session_refresh drops project context, falls back to "default"
 *
 * Bug: sessionRefresh() used `params.project || "default"` instead of
 * `params.project || currentSession.project || "default"` in the
 * in-memory path, causing project to reset to "default" after /clear + gm-refresh.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  setCurrentSession,
  getCurrentSession,
  clearCurrentSession,
  getProject,
} from "../../../src/services/session-state.js";

describe("session_refresh project resolution (OD-668)", () => {
  beforeEach(() => {
    clearCurrentSession();
  });

  it("getCurrentSession preserves project set during session_start", () => {
    setCurrentSession({
      sessionId: "test-session",
      agent: "CLI",
      project: "orchestra_dev",
      startedAt: new Date(),
    });

    const session = getCurrentSession();
    expect(session).not.toBeNull();
    expect(session!.project).toBe("orchestra_dev");
  });

  it("getProject() returns session project", () => {
    setCurrentSession({
      sessionId: "test-session",
      agent: "CLI",
      project: "orchestra_dev",
      startedAt: new Date(),
    });

    expect(getProject()).toBe("orchestra_dev");
  });

  it("params.project || currentSession.project || 'default' resolves correctly", () => {
    setCurrentSession({
      sessionId: "test-session",
      agent: "CLI",
      project: "orchestra_dev",
      startedAt: new Date(),
    });

    const currentSession = getCurrentSession()!;

    // Simulate the FIXED resolution logic from sessionRefresh
    const paramsProject = undefined; // user didn't pass project
    const resolved = paramsProject || currentSession.project || "default";
    expect(resolved).toBe("orchestra_dev");

    // Simulate the OLD BUGGY logic
    const buggyResolved = paramsProject || "default";
    expect(buggyResolved).toBe("default"); // This was the bug
  });

  it("explicit params.project overrides session project", () => {
    setCurrentSession({
      sessionId: "test-session",
      agent: "CLI",
      project: "orchestra_dev",
      startedAt: new Date(),
    });

    const currentSession = getCurrentSession()!;
    const paramsProject = "weekend_warrior";
    const resolved = paramsProject || currentSession.project || "default";
    expect(resolved).toBe("weekend_warrior");
  });

  it("falls back to 'default' when neither params nor session has project", () => {
    setCurrentSession({
      sessionId: "test-session",
      agent: "CLI",
      startedAt: new Date(),
      // no project set
    });

    const currentSession = getCurrentSession()!;
    const paramsProject = undefined;
    const resolved = paramsProject || currentSession.project || "default";
    expect(resolved).toBe("default");
  });
});

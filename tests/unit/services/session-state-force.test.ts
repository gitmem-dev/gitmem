/**
 * Regression test for t-f7c2fa01:
 * session_close rejects standard close after force:true session creation
 * because duration check uses new session's clock instead of actual conversation duration.
 *
 * Verifies that setCurrentSession preserves startedAt, observations, and children
 * when force:true carries forward prior session state.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  setCurrentSession,
  getCurrentSession,
  clearCurrentSession,
  getSessionActivity,
  addObservations,
  addSurfacedScars,
} from "../../../src/services/session-state.js";

describe("session-state force:true carry-forward (t-f7c2fa01)", () => {
  beforeEach(() => {
    clearCurrentSession();
  });

  it("preserves startedAt when force:true creates new session", () => {
    // Simulate original session started 45 minutes ago
    const originalStart = new Date(Date.now() - 45 * 60 * 1000);
    setCurrentSession({
      sessionId: "original-session",
      agent: "CLI",
      startedAt: originalStart,
    });

    // Simulate force:true — capture prior state, then create new session with carried-forward startedAt
    const prior = getCurrentSession();
    const carryStartedAt = prior?.startedAt;

    setCurrentSession({
      sessionId: "new-forced-session",
      agent: "CLI",
      startedAt: carryStartedAt || new Date(),
    });

    const activity = getSessionActivity();
    expect(activity).not.toBeNull();
    // Duration should reflect the original 45 minutes, not 0
    expect(activity!.duration_min).toBeGreaterThanOrEqual(44);
  });

  it("preserves surfaced scars when force:true creates new session", () => {
    setCurrentSession({
      sessionId: "original-session",
      agent: "CLI",
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // Add scars to original session
    addSurfacedScars([{
      scar_id: "scar-1",
      title: "Test scar",
      severity: "high",
      surfaced_at: new Date().toISOString(),
      source: "recall",
    }]);

    const prior = getCurrentSession();
    const carryScars = prior?.surfacedScars || [];

    // Force new session with carried scars
    setCurrentSession({
      sessionId: "new-forced-session",
      agent: "CLI",
      startedAt: prior?.startedAt || new Date(),
      surfacedScars: carryScars,
    });

    const activity = getSessionActivity();
    expect(activity!.recall_count).toBe(1);
  });

  it("preserves observations when force:true creates new session", () => {
    setCurrentSession({
      sessionId: "original-session",
      agent: "CLI",
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // Add observations to original session
    addObservations([
      { source: "sub-agent", text: "Found a bug", severity: "warning" },
      { source: "sub-agent", text: "Code review done", severity: "info" },
    ]);

    const prior = getCurrentSession();
    const carryObservations = prior?.observations || [];

    // Force new session with carried observations
    setCurrentSession({
      sessionId: "new-forced-session",
      agent: "CLI",
      startedAt: prior?.startedAt || new Date(),
      observations: carryObservations,
    });

    const activity = getSessionActivity();
    expect(activity!.observation_count).toBe(2);
  });

  it("without carry-forward, force:true resets duration to 0", () => {
    // This demonstrates the bug behavior WITHOUT the fix
    setCurrentSession({
      sessionId: "original-session",
      agent: "CLI",
      startedAt: new Date(Date.now() - 45 * 60 * 1000),
    });

    // Create new session WITHOUT carrying forward startedAt (the bug)
    setCurrentSession({
      sessionId: "new-forced-session",
      agent: "CLI",
      startedAt: new Date(), // Fresh clock — this is the bug
    });

    const activity = getSessionActivity();
    // Duration should be near 0 since startedAt is now
    expect(activity!.duration_min).toBeLessThan(1);
  });

  it("standard close gate passes with carried-forward duration and activity", () => {
    // Simulate a 45-minute session with recalls
    const originalStart = new Date(Date.now() - 45 * 60 * 1000);
    setCurrentSession({
      sessionId: "original-session",
      agent: "CLI",
      startedAt: originalStart,
    });

    addSurfacedScars([{
      scar_id: "scar-1",
      title: "Test scar",
      severity: "high",
      surfaced_at: new Date().toISOString(),
      source: "recall",
    }]);

    // Capture and carry forward
    const prior = getCurrentSession();

    setCurrentSession({
      sessionId: "new-forced-session",
      agent: "CLI",
      startedAt: prior?.startedAt || new Date(),
      surfacedScars: prior?.surfacedScars || [],
      observations: prior?.observations || [],
      children: prior?.children || [],
    });

    const activity = getSessionActivity();
    // Should pass the standard close gate: >= 30 min AND not minimal activity
    expect(activity!.duration_min).toBeGreaterThanOrEqual(30);
    expect(activity!.recall_count).toBeGreaterThan(0);
    const isMinimal = activity!.recall_count === 0 &&
                      activity!.observation_count === 0 &&
                      activity!.children_count === 0;
    expect(isMinimal).toBe(false);
  });
});

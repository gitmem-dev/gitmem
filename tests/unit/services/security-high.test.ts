/**
 * Security tests for HIGH severity fixes
 *
 * H1: PostgREST in.() filter injection (safeInFilter)
 * H2: PostgREST ilike pattern injection (graph-traverse normalizeNode)
 * H3: Session-state unbounded array caps
 * H4: File-lock PID reentrance
 */

import { describe, it, expect, beforeEach } from "vitest";
import { safeInFilter, escapePostgRESTValue } from "../../../src/services/supabase-client.js";
import {
  setCurrentSession,
  clearCurrentSession,
  addObservations,
  addChild,
  getObservations,
  getChildren,
} from "../../../src/services/session-state.js";

// --- H1: safeInFilter ---

describe("safeInFilter", () => {
  it("passes valid UUIDs through", () => {
    const ids = [
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "11111111-2222-3333-4444-555555555555",
    ];
    const result = safeInFilter(ids);
    expect(result).toBe(`in.(${ids.join(",")})`);
  });

  it("rejects non-UUID values", () => {
    const ids = [
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "DROP TABLE orchestra_learnings",
      "11111111-2222-3333-4444-555555555555",
    ];
    const result = safeInFilter(ids);
    // Should only include the 2 valid UUIDs
    expect(result).toBe(
      "in.(a1b2c3d4-e5f6-7890-abcd-ef1234567890,11111111-2222-3333-4444-555555555555)"
    );
  });

  it("returns empty in.() for all-invalid input", () => {
    const result = safeInFilter(["not-a-uuid", "also-not-valid"]);
    expect(result).toBe("in.()");
  });

  it("returns empty in.() for empty array", () => {
    expect(safeInFilter([])).toBe("in.()");
  });

  it("rejects comma-injection attempts", () => {
    // Attacker tries to inject extra values via commas in a single ID
    const result = safeInFilter([
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890,extra-injected-id",
    ]);
    expect(result).toBe("in.()"); // fails UUID validation
  });
});

// --- H2: escapePostgRESTValue ---

describe("escapePostgRESTValue", () => {
  it("strips parentheses and commas", () => {
    expect(escapePostgRESTValue("test(inject),value")).toBe("testinjectvalue");
  });

  it("throws on null bytes", () => {
    expect(() => escapePostgRESTValue("test\0value")).toThrow("null bytes");
  });

  it("passes clean values through", () => {
    expect(escapePostgRESTValue("OD-466")).toBe("OD-466");
    expect(escapePostgRESTValue("Scar: Title Here")).toBe("Scar: Title Here");
  });

  it("strips PostgREST OR group escape attempts", () => {
    // Attacker tries to close the ilike and inject new filter condition
    const malicious = "test),subject.eq.admin,(anything.ilike.";
    const escaped = escapePostgRESTValue(malicious);
    expect(escaped).not.toContain("(");
    expect(escaped).not.toContain(")");
    expect(escaped).not.toContain(",");
  });
});

// --- H3: Session-state array caps ---

describe("session-state array caps", () => {
  beforeEach(() => {
    clearCurrentSession();
    setCurrentSession({
      sessionId: "test-session",
      agent: "CLI",
      startedAt: new Date(),
    });
  });

  it("caps observations at 500", () => {
    // Add 600 observations in batches
    for (let i = 0; i < 60; i++) {
      const batch = Array.from({ length: 10 }, (_, j) => ({
        source: `agent-${i}`,
        text: `observation ${i * 10 + j}`,
        severity: "info" as const,
      }));
      addObservations(batch);
    }

    const obs = getObservations();
    expect(obs.length).toBe(500);
    // Should keep the most recent (last batch)
    expect(obs[obs.length - 1].text).toBe("observation 599");
  });

  it("caps children at 100", () => {
    for (let i = 0; i < 110; i++) {
      addChild({
        type: "general-purpose",
        role: `agent-${i}`,
        spawned_at: new Date().toISOString(),
      });
    }

    const children = getChildren();
    expect(children.length).toBe(100);
  });

  it("observations cap keeps most recent entries", () => {
    // Add exactly 501 observations
    const batch = Array.from({ length: 501 }, (_, i) => ({
      source: "test",
      text: `obs-${i}`,
      severity: "info" as const,
    }));
    addObservations(batch);

    const obs = getObservations();
    expect(obs.length).toBe(500);
    // First entry should be obs-1 (obs-0 was trimmed)
    expect(obs[0].text).toBe("obs-1");
  });
});

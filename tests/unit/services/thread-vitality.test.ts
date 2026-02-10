/**
 * Unit tests for Thread Vitality Scoring (Phase 2)
 *
 * Pure function tests — no mocks, no filesystem, no network.
 * All tests inject deterministic `now` timestamps.
 */

import { describe, it, expect } from "vitest";
import {
  computeVitality,
  vitalityToStatus,
  detectThreadClass,
} from "../../../src/services/thread-vitality.js";
import type { VitalityInput } from "../../../src/services/thread-vitality.js";

// ---------- Helpers ----------

const NOW = new Date("2026-02-10T12:00:00Z");

function daysAgo(days: number): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function makeInput(overrides: Partial<VitalityInput> = {}): VitalityInput {
  return {
    last_touched_at: overrides.last_touched_at ?? NOW.toISOString(),
    touch_count: overrides.touch_count ?? 1,
    created_at: overrides.created_at ?? NOW.toISOString(),
    thread_class: overrides.thread_class ?? "backlog",
  };
}

// ===========================================================================
// 1. computeVitality — Core Formula
// ===========================================================================

describe("computeVitality", () => {
  it("freshly created thread has vitality near 1.0 and status active", () => {
    const result = computeVitality(makeInput(), NOW);
    expect(result.vitality_score).toBeGreaterThan(0.9);
    expect(result.status).toBe("active");
  });

  it("backlog thread has ~0.5 recency after 21 days (half-life)", () => {
    const result = computeVitality(
      makeInput({
        last_touched_at: daysAgo(21),
        created_at: daysAgo(21),
        touch_count: 1,
        thread_class: "backlog",
      }),
      NOW
    );
    expect(result.recency_component).toBeCloseTo(0.5, 1);
  });

  it("operational thread has ~0.5 recency after 3 days (half-life)", () => {
    const result = computeVitality(
      makeInput({
        last_touched_at: daysAgo(3),
        created_at: daysAgo(3),
        touch_count: 1,
        thread_class: "operational",
      }),
      NOW
    );
    expect(result.recency_component).toBeCloseTo(0.5, 1);
  });

  it("operational decays faster than backlog at same age", () => {
    const op = computeVitality(
      makeInput({ last_touched_at: daysAgo(7), created_at: daysAgo(7), thread_class: "operational" }),
      NOW
    );
    const bg = computeVitality(
      makeInput({ last_touched_at: daysAgo(7), created_at: daysAgo(7), thread_class: "backlog" }),
      NOW
    );
    expect(op.vitality_score).toBeLessThan(bg.vitality_score);
  });

  it("high touch_count boosts frequency component", () => {
    const low = computeVitality(
      makeInput({ last_touched_at: daysAgo(5), created_at: daysAgo(10), touch_count: 1 }),
      NOW
    );
    const high = computeVitality(
      makeInput({ last_touched_at: daysAgo(5), created_at: daysAgo(10), touch_count: 20 }),
      NOW
    );
    expect(high.vitality_score).toBeGreaterThan(low.vitality_score);
    expect(high.frequency_component).toBeGreaterThan(low.frequency_component);
  });

  it("backlog thread becomes dormant after 60+ days of inactivity", () => {
    const result = computeVitality(
      makeInput({
        last_touched_at: daysAgo(60),
        created_at: daysAgo(90),
        touch_count: 2,
        thread_class: "backlog",
      }),
      NOW
    );
    expect(result.vitality_score).toBeLessThan(0.2);
    expect(result.status).toBe("dormant");
  });

  it("operational thread becomes dormant after 10+ days", () => {
    const result = computeVitality(
      makeInput({
        last_touched_at: daysAgo(10),
        created_at: daysAgo(10),
        touch_count: 1,
        thread_class: "operational",
      }),
      NOW
    );
    expect(result.vitality_score).toBeLessThan(0.2);
    expect(result.status).toBe("dormant");
  });

  it("score never exceeds 1.0 even with extreme frequency", () => {
    const result = computeVitality(makeInput({ touch_count: 10000 }), NOW);
    expect(result.vitality_score).toBeLessThanOrEqual(1.0);
  });

  it("score never goes below 0.0", () => {
    const result = computeVitality(
      makeInput({ last_touched_at: daysAgo(365), created_at: daysAgo(365), touch_count: 1 }),
      NOW
    );
    expect(result.vitality_score).toBeGreaterThanOrEqual(0.0);
  });

  it("touch refreshing recency increases vitality", () => {
    const before = computeVitality(
      makeInput({ last_touched_at: daysAgo(7), created_at: daysAgo(14), touch_count: 3 }),
      NOW
    );
    const after = computeVitality(
      makeInput({ last_touched_at: NOW.toISOString(), created_at: daysAgo(14), touch_count: 4 }),
      NOW
    );
    expect(after.vitality_score).toBeGreaterThan(before.vitality_score);
  });
});

// ===========================================================================
// 2. vitalityToStatus — Threshold Mapping
// ===========================================================================

describe("vitalityToStatus", () => {
  it("returns active for scores above 0.5", () => {
    expect(vitalityToStatus(0.51)).toBe("active");
    expect(vitalityToStatus(0.8)).toBe("active");
    expect(vitalityToStatus(1.0)).toBe("active");
  });

  it("returns cooling for scores between 0.2 and 0.5 inclusive", () => {
    expect(vitalityToStatus(0.5)).toBe("cooling");
    expect(vitalityToStatus(0.35)).toBe("cooling");
    expect(vitalityToStatus(0.2)).toBe("cooling");
  });

  it("returns dormant for scores below 0.2", () => {
    expect(vitalityToStatus(0.19)).toBe("dormant");
    expect(vitalityToStatus(0.1)).toBe("dormant");
    expect(vitalityToStatus(0.0)).toBe("dormant");
  });
});

// ===========================================================================
// 3. detectThreadClass — Keyword Classification
// ===========================================================================

describe("detectThreadClass", () => {
  it("returns operational for threads with operational keywords", () => {
    expect(detectThreadClass("Deploy new version to production")).toBe("operational");
    expect(detectThreadClass("Fix broken auth flow")).toBe("operational");
    expect(detectThreadClass("DEBUG: session_close timeout")).toBe("operational");
    expect(detectThreadClass("Urgent: database connection failing")).toBe("operational");
  });

  it("returns backlog for threads without operational keywords", () => {
    expect(detectThreadClass("Implement vitality scoring for threads")).toBe("backlog");
    expect(detectThreadClass("Consider adding a caching layer")).toBe("backlog");
    expect(detectThreadClass("Research alternative embedding models")).toBe("backlog");
  });

  it("is case-insensitive", () => {
    expect(detectThreadClass("DEPLOY to staging")).toBe("operational");
    expect(detectThreadClass("Hotfix for login page")).toBe("operational");
  });

  it("returns backlog for empty or generic text", () => {
    expect(detectThreadClass("")).toBe("backlog");
    expect(detectThreadClass("Thread about something")).toBe("backlog");
  });
});

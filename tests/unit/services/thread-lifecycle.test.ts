/**
 * Unit tests for Thread Lifecycle State Machine (Phase 6)
 *
 * Tests the computeLifecycleStatus() function which wraps
 * vitality scoring with age-based emerging window and archival logic.
 *
 * State machine:
 *   EMERGING (< 24h) → ACTIVE → COOLING → DORMANT → ARCHIVED (30+ days dormant)
 *   Any state → RESOLVED (handled externally)
 */

import { describe, it, expect } from "vitest";
import {
  computeLifecycleStatus,
  EMERGING_WINDOW_HOURS,
  ARCHIVAL_DORMANT_DAYS,
} from "../../../src/services/thread-vitality.js";
import type { LifecycleInput } from "../../../src/services/thread-vitality.js";

// ---------- Helpers ----------

const NOW = new Date("2026-02-10T12:00:00Z");

function daysAgo(days: number): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function hoursAgo(hours: number): string {
  const d = new Date(NOW);
  d.setTime(d.getTime() - hours * 60 * 60 * 1000);
  return d.toISOString();
}

function makeLifecycleInput(overrides: Partial<LifecycleInput> = {}): LifecycleInput {
  return {
    last_touched_at: overrides.last_touched_at ?? NOW.toISOString(),
    touch_count: overrides.touch_count ?? 1,
    created_at: overrides.created_at ?? NOW.toISOString(),
    thread_class: overrides.thread_class ?? "backlog",
    current_status: overrides.current_status ?? "active",
    dormant_since: overrides.dormant_since,
  };
}

// ===========================================================================
// 1. Emerging Window
// ===========================================================================

describe("computeLifecycleStatus — emerging window", () => {
  it("new thread (< 24h old) is emerging regardless of vitality score", () => {
    const result = computeLifecycleStatus(
      makeLifecycleInput({
        created_at: hoursAgo(12),
        last_touched_at: hoursAgo(12),
        touch_count: 1,
        current_status: "active",
      }),
      NOW
    );
    expect(result.lifecycle_status).toBe("emerging");
  });

  it("thread exactly at 23h is still emerging", () => {
    const result = computeLifecycleStatus(
      makeLifecycleInput({
        created_at: hoursAgo(23),
        last_touched_at: hoursAgo(23),
        current_status: "active",
      }),
      NOW
    );
    expect(result.lifecycle_status).toBe("emerging");
  });

  it("thread at 25h is no longer emerging — uses vitality-derived status", () => {
    const result = computeLifecycleStatus(
      makeLifecycleInput({
        created_at: hoursAgo(25),
        last_touched_at: hoursAgo(1), // recently touched
        touch_count: 5,
        current_status: "active",
      }),
      NOW
    );
    expect(result.lifecycle_status).not.toBe("emerging");
    expect(result.lifecycle_status).toBe("active");
  });

  it("emerging thread still computes vitality score", () => {
    const result = computeLifecycleStatus(
      makeLifecycleInput({
        created_at: hoursAgo(6),
        last_touched_at: hoursAgo(6),
        touch_count: 3,
        current_status: "emerging",
      }),
      NOW
    );
    expect(result.lifecycle_status).toBe("emerging");
    expect(result.vitality.vitality_score).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 2. Normal Vitality-Derived Statuses
// ===========================================================================

describe("computeLifecycleStatus — vitality-derived", () => {
  it("active thread with high vitality stays active", () => {
    const result = computeLifecycleStatus(
      makeLifecycleInput({
        created_at: daysAgo(3),
        last_touched_at: NOW.toISOString(),
        touch_count: 10,
        current_status: "active",
      }),
      NOW
    );
    expect(result.lifecycle_status).toBe("active");
    expect(result.vitality.vitality_score).toBeGreaterThan(0.5);
  });

  it("thread with decayed vitality transitions to cooling", () => {
    // backlog half-life is 21 days; ~21 days untouched → recency ~0.5, frequency low → cooling range
    const result = computeLifecycleStatus(
      makeLifecycleInput({
        created_at: daysAgo(30),
        last_touched_at: daysAgo(21),
        touch_count: 3,
        thread_class: "backlog",
        current_status: "active",
      }),
      NOW
    );
    expect(result.lifecycle_status).toBe("cooling");
    expect(result.vitality.vitality_score).toBeLessThanOrEqual(0.5);
    expect(result.vitality.vitality_score).toBeGreaterThanOrEqual(0.2);
  });

  it("thread with very decayed vitality becomes dormant", () => {
    const result = computeLifecycleStatus(
      makeLifecycleInput({
        created_at: daysAgo(90),
        last_touched_at: daysAgo(60),
        touch_count: 2,
        thread_class: "backlog",
        current_status: "cooling",
      }),
      NOW
    );
    expect(result.lifecycle_status).toBe("dormant");
    expect(result.vitality.vitality_score).toBeLessThan(0.2);
  });

  it("touch on dormant thread revives to active", () => {
    const result = computeLifecycleStatus(
      makeLifecycleInput({
        created_at: daysAgo(60),
        last_touched_at: NOW.toISOString(), // just touched!
        touch_count: 10,
        current_status: "dormant",
        dormant_since: daysAgo(20),
      }),
      NOW
    );
    expect(result.lifecycle_status).toBe("active");
    expect(result.vitality.vitality_score).toBeGreaterThan(0.5);
  });
});

// ===========================================================================
// 3. Archival (30+ days dormant)
// ===========================================================================

describe("computeLifecycleStatus — archival", () => {
  it("dormant thread for 30+ days becomes archived", () => {
    const result = computeLifecycleStatus(
      makeLifecycleInput({
        created_at: daysAgo(120),
        last_touched_at: daysAgo(90),
        touch_count: 2,
        thread_class: "backlog",
        current_status: "dormant",
        dormant_since: daysAgo(31),
      }),
      NOW
    );
    expect(result.lifecycle_status).toBe("archived");
  });

  it("dormant thread for 29 days stays dormant (not yet archived)", () => {
    const result = computeLifecycleStatus(
      makeLifecycleInput({
        created_at: daysAgo(120),
        last_touched_at: daysAgo(90),
        touch_count: 2,
        thread_class: "backlog",
        current_status: "dormant",
        dormant_since: daysAgo(29),
      }),
      NOW
    );
    expect(result.lifecycle_status).toBe("dormant");
  });

  it("dormant thread without dormant_since stays dormant (no archival)", () => {
    const result = computeLifecycleStatus(
      makeLifecycleInput({
        created_at: daysAgo(120),
        last_touched_at: daysAgo(90),
        touch_count: 2,
        thread_class: "backlog",
        current_status: "dormant",
        // no dormant_since
      }),
      NOW
    );
    expect(result.lifecycle_status).toBe("dormant");
  });
});

// ===========================================================================
// 4. Terminal States
// ===========================================================================

describe("computeLifecycleStatus — terminal states", () => {
  it("archived thread stays archived regardless of vitality", () => {
    const result = computeLifecycleStatus(
      makeLifecycleInput({
        created_at: daysAgo(5),
        last_touched_at: NOW.toISOString(),
        touch_count: 50,
        current_status: "archived",
      }),
      NOW
    );
    expect(result.lifecycle_status).toBe("archived");
  });

  it("resolved thread stays resolved regardless of vitality", () => {
    const result = computeLifecycleStatus(
      makeLifecycleInput({
        created_at: daysAgo(2),
        last_touched_at: NOW.toISOString(),
        touch_count: 10,
        current_status: "resolved",
      }),
      NOW
    );
    // resolved is not a LifecycleStatus, but the function returns current_status as-is
    expect(result.lifecycle_status).toBe("resolved");
  });
});

// ===========================================================================
// 5. Constants
// ===========================================================================

describe("lifecycle constants", () => {
  it("emerging window is 24 hours", () => {
    expect(EMERGING_WINDOW_HOURS).toBe(24);
  });

  it("archival threshold is 30 days", () => {
    expect(ARCHIVAL_DORMANT_DAYS).toBe(30);
  });
});

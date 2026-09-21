/**
 * Unit tests for EffectTracker.track() outcome accounting (GIT-104).
 *
 * Many tracked operations catch their own errors and resolve with
 * { success: false }. Those must count as failures, not successes.
 */

import { describe, it, expect } from "vitest";
import { EffectTracker } from "../../../src/services/effect-tracker.js";

function statsFor(tracker: EffectTracker, path: string) {
  return tracker.getHealthReport().byPath[path];
}

describe("EffectTracker.track outcome accounting", () => {
  it("counts a resolved { success: false } as a failure and still returns the value", async () => {
    const tracker = new EffectTracker();
    const value = { success: false, error: "Supabase upsert error: 404 - table not found" };

    const returned = await tracker.track("scar_usage", "batch", async () => value);

    expect(returned).toBe(value);
    expect(statsFor(tracker, "scar_usage")).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    const report = tracker.getHealthReport();
    expect(report.overall.paths_with_failures).toEqual(["scar_usage"]);
    expect(report.recentFailures[0]).toMatchObject({
      path: "scar_usage",
      target: "batch",
      error: "Supabase upsert error: 404 - table not found",
    });
  });

  it("uses message, then display, when a { success: false } result has no error", async () => {
    const tracker = new EffectTracker();
    await tracker.track("p", "message", async () => ({ success: false, message: "from message" }));
    await tracker.track("p", "display", async () => ({ success: false, display: "from display" }));
    await tracker.track("p", "error-object", async () => ({ success: false, error: new Error("from Error") }));
    await tracker.track("p", "bare", async () => ({ success: false }));

    const errors = tracker.getHealthReport().recentFailures.map((f) => [f.target, f.error]);
    expect(errors).toEqual([
      ["bare", "resolved with success: false"],
      ["error-object", "from Error"],
      ["display", "from display"],
      ["message", "from message"],
    ]);
    expect(statsFor(tracker, "p")).toMatchObject({ attempted: 4, succeeded: 0, failed: 4 });
  });

  it("counts a resolved { success: true } as a success", async () => {
    const tracker = new EffectTracker();
    const value = { success: true, usage_ids: ["a"] };

    const returned = await tracker.track("scar_usage", "batch", async () => value);

    expect(returned).toBe(value);
    expect(statsFor(tracker, "scar_usage")).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
  });

  it("counts plain values (including undefined, null and numbers) as successes", async () => {
    const tracker = new EffectTracker();
    await tracker.track("p", "undefined", async () => undefined);
    await tracker.track("p", "null", async () => null);
    await tracker.track("p", "number", async () => 0);
    await tracker.track("p", "object-without-success", async () => ({ id: "x" }));
    await tracker.track("p", "success-not-boolean-false", async () => ({ success: 0 }));

    expect(statsFor(tracker, "p")).toMatchObject({ attempted: 5, succeeded: 5, failed: 0 });
    expect(tracker.getHealthReport().recentFailures).toEqual([]);
  });

  it("counts a rejection as a failure and resolves undefined without rethrowing", async () => {
    const tracker = new EffectTracker();

    const returned = await tracker.track("triple_write", "thread_creation", async () => {
      throw new Error("Supabase upsert error: 400 - invalid input syntax for type uuid");
    });

    expect(returned).toBeUndefined();
    expect(statsFor(tracker, "triple_write")).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    expect(tracker.getHealthReport().recentFailures[0].error).toBe(
      "Supabase upsert error: 400 - invalid input syntax for type uuid"
    );
  });

  it("formatSummary reports a { success: false } result as failed", async () => {
    const tracker = new EffectTracker();
    await tracker.track("scar_usage", "session_close_batch", async () => ({ success: false, error: "404" }));

    const summary = tracker.formatSummary();
    expect(summary).toContain("scar_usage");
    expect(summary).toContain("0/1 succeeded (1 failed)");
    expect(summary).toContain("[scar_usage/session_close_batch] 404");
  });
});

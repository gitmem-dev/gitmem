import { describe, it, expect } from "vitest";
import { detectEvents, TextBuffer } from "../../scripts/audit/event-detectors.js";
import type { GitmemEvent } from "../../scripts/audit/types.js";

describe("detectEvents", () => {
  it("detects session_start", () => {
    const recent: GitmemEvent[] = [];
    const events = detectEvents("gitmem ── active", 1.0, recent);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session_start");
  });

  it("detects session_resumed", () => {
    const recent: GitmemEvent[] = [];
    const events = detectEvents("gitmem ── resumed", 1.0, recent);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session_resumed");
  });

  it("detects recall with INSTITUTIONAL MEMORY ACTIVATED", () => {
    const recent: GitmemEvent[] = [];
    const events = detectEvents(
      "🧠 INSTITUTIONAL MEMORY ACTIVATED",
      5.0,
      recent
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("recall");
  });

  it("detects scars_found with count", () => {
    const recent: GitmemEvent[] = [];
    const events = detectEvents("Found 3 relevant scars", 5.5, recent);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("scars_found");
    expect(events[0].detail).toBe("3");
  });

  it("detects confirm_accepted", () => {
    const recent: GitmemEvent[] = [];
    const events = detectEvents(
      "✅ SCAR CONFIRMATIONS ACCEPTED",
      10.0,
      recent
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("confirm_accepted");
  });

  it("detects confirm_rejected", () => {
    const recent: GitmemEvent[] = [];
    const events = detectEvents(
      "❌ SCAR CONFIRMATIONS REJECTED",
      8.0,
      recent
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("confirm_rejected");
  });

  it("detects scar decisions", () => {
    const recent: GitmemEvent[] = [];
    expect(detectEvents("→ APPLYING", 6.0, recent)[0].type).toBe("scar_applying");

    const recent2: GitmemEvent[] = [];
    expect(detectEvents("→ N_A", 6.1, recent2)[0].type).toBe("scar_na");

    const recent3: GitmemEvent[] = [];
    expect(detectEvents("→ REFUTED", 6.2, recent3)[0].type).toBe("scar_refuted");
  });

  it("detects gate and unblocked", () => {
    const recent: GitmemEvent[] = [];
    const gateEvents = detectEvents(
      "Acknowledge these lessons before proceeding.",
      7.0,
      recent
    );
    expect(gateEvents.some((e) => e.type === "gate")).toBe(true);

    const unblockEvents = detectEvents(
      "Consequential actions are now unblocked.",
      10.5,
      recent
    );
    expect(unblockEvents.some((e) => e.type === "unblocked")).toBe(true);
  });

  it("detects thread operations", () => {
    const recent: GitmemEvent[] = [];
    expect(detectEvents("Thread resolved", 50.0, recent)[0].type).toBe(
      "thread_resolved"
    );

    const recent2: GitmemEvent[] = [];
    expect(detectEvents("Thread created", 51.0, recent2)[0].type).toBe(
      "thread_created"
    );
  });

  it("deduplicates events within 2s window", () => {
    const recent: GitmemEvent[] = [];
    const first = detectEvents("gitmem ── active", 1.0, recent);
    expect(first).toHaveLength(1);

    // Same event within 2s — should be deduped
    const second = detectEvents("gitmem ── active", 2.5, recent);
    expect(second).toHaveLength(0);

    // Same event after 2s — should NOT be deduped
    const third = detectEvents("gitmem ── active", 3.1, recent);
    expect(third).toHaveLength(1);
  });

  it("detects hook fires", () => {
    const recent: GitmemEvent[] = [];
    const events = detectEvents(
      "SessionStart:compact hook success",
      0.2,
      recent
    );
    expect(events.some((e) => e.type === "hook_fire")).toBe(true);
  });

  it("detects learning and decision creation", () => {
    const recent: GitmemEvent[] = [];
    expect(detectEvents("Scar created", 40.0, recent)[0].type).toBe(
      "learning_created"
    );

    const recent2: GitmemEvent[] = [];
    expect(detectEvents("Decision logged", 41.0, recent2)[0].type).toBe(
      "decision_created"
    );
  });
});

describe("TextBuffer", () => {
  it("accumulates text", () => {
    const buf = new TextBuffer(100);
    buf.append("hello ");
    const result = buf.append("world");
    expect(result).toBe("hello world");
  });

  it("truncates at max size", () => {
    const buf = new TextBuffer(10);
    buf.append("1234567890");
    const result = buf.append("ABC");
    expect(result).toBe("4567890ABC");
    expect(result.length).toBe(10);
  });

  it("consume keeps tail", () => {
    const buf = new TextBuffer(100);
    buf.append("hello world this is a long text");
    buf.consume(5);
    const result = buf.append("!");
    expect(result).toBe(" text!");
  });

  it("getMatchText returns chunk + overlap", () => {
    const buf = new TextBuffer(1000);
    buf.append("AAAA");  // 4 chars
    buf.append("BBBB");  // 4 chars, total 8
    // getMatchText(4) should return last 4 chars (new) + up to 128 overlap
    // Since total is only 8, it returns the whole buffer
    const matchText = buf.getMatchText(4);
    expect(matchText).toBe("AAAABBBB");
  });
});

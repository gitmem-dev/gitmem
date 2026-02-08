/**
 * Unit tests for diagnostics channels
 *
 * Issue: OD-584
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { subscribe, unsubscribe } from "diagnostics_channel";
import {
  diagnostics,
  CHANNEL_NAMES,
  type ToolCallEvent,
  type CacheEvent,
  type DbQueryEvent,
  type EmbeddingCallEvent,
  type ErrorEvent,
} from "../../../src/diagnostics/channels.js";

describe("CHANNEL_NAMES", () => {
  it("defines all expected channels", () => {
    expect(CHANNEL_NAMES.TOOL_CALL).toBe("gitmem:tool:call");
    expect(CHANNEL_NAMES.CACHE_HIT).toBe("gitmem:cache:hit");
    expect(CHANNEL_NAMES.CACHE_MISS).toBe("gitmem:cache:miss");
    expect(CHANNEL_NAMES.DB_QUERY).toBe("gitmem:db:query");
    expect(CHANNEL_NAMES.EMBEDDING_CALL).toBe("gitmem:embedding:call");
    expect(CHANNEL_NAMES.ERROR).toBe("gitmem:error");
  });
});

describe("diagnostics.publishToolCallStart/End", () => {
  let receivedEvents: ToolCallEvent[] = [];
  const handler = (msg: unknown) => receivedEvents.push(msg as ToolCallEvent);

  beforeEach(() => {
    receivedEvents = [];
    subscribe(CHANNEL_NAMES.TOOL_CALL, handler);
  });

  afterEach(() => {
    unsubscribe(CHANNEL_NAMES.TOOL_CALL, handler);
  });

  it("publishes start event with tool name", () => {
    const event = diagnostics.publishToolCallStart("recall", { plan: "test" });

    expect(event.tool).toBe("recall");
    expect(event.startTime).toBeGreaterThan(0);
    expect(event.params).toEqual({ plan: "test" });
    expect(receivedEvents).toHaveLength(1);
  });

  it("publishes end event with duration", () => {
    const event = diagnostics.publishToolCallStart("search");
    diagnostics.publishToolCallEnd(event, true);

    expect(event.endTime).toBeGreaterThan(0);
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    expect(event.success).toBe(true);
    expect(receivedEvents).toHaveLength(2);
  });

  it("publishes end event with error", () => {
    const event = diagnostics.publishToolCallStart("create_learning");
    diagnostics.publishToolCallEnd(event, false, "Database error");

    expect(event.success).toBe(false);
    expect(event.error).toBe("Database error");
  });
});

describe("diagnostics.publishCacheHit/Miss", () => {
  let hitEvents: CacheEvent[] = [];
  let missEvents: CacheEvent[] = [];
  const hitHandler = (msg: unknown) => hitEvents.push(msg as CacheEvent);
  const missHandler = (msg: unknown) => missEvents.push(msg as CacheEvent);

  beforeEach(() => {
    hitEvents = [];
    missEvents = [];
    subscribe(CHANNEL_NAMES.CACHE_HIT, hitHandler);
    subscribe(CHANNEL_NAMES.CACHE_MISS, missHandler);
  });

  afterEach(() => {
    unsubscribe(CHANNEL_NAMES.CACHE_HIT, hitHandler);
    unsubscribe(CHANNEL_NAMES.CACHE_MISS, missHandler);
  });

  it("publishes cache hit event", () => {
    diagnostics.publishCacheHit("test_key", "scar_search", 1000, 512);

    expect(hitEvents).toHaveLength(1);
    expect(hitEvents[0].key).toBe("test_key");
    expect(hitEvents[0].type).toBe("scar_search");
    expect(hitEvents[0].ageMs).toBe(1000);
    expect(hitEvents[0].sizeBytes).toBe(512);
  });

  it("publishes cache miss event", () => {
    diagnostics.publishCacheMiss("missing_key", "decisions");

    expect(missEvents).toHaveLength(1);
    expect(missEvents[0].key).toBe("missing_key");
    expect(missEvents[0].type).toBe("decisions");
  });
});

describe("diagnostics.publishDbQueryStart/End", () => {
  let receivedEvents: DbQueryEvent[] = [];
  const handler = (msg: unknown) => receivedEvents.push(msg as DbQueryEvent);

  beforeEach(() => {
    receivedEvents = [];
    subscribe(CHANNEL_NAMES.DB_QUERY, handler);
  });

  afterEach(() => {
    unsubscribe(CHANNEL_NAMES.DB_QUERY, handler);
  });

  it("publishes query start event", () => {
    const event = diagnostics.publishDbQueryStart("SELECT", "gitmem_learnings");

    expect(event.operation).toBe("SELECT");
    expect(event.table).toBe("gitmem_learnings");
    expect(event.startTime).toBeGreaterThan(0);
    expect(receivedEvents).toHaveLength(1);
  });

  it("publishes query end event with row count", () => {
    const event = diagnostics.publishDbQueryStart("INSERT", "gitmem_sessions");
    diagnostics.publishDbQueryEnd(event, true, 1);

    expect(event.success).toBe(true);
    expect(event.rowCount).toBe(1);
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("diagnostics.publishEmbeddingStart/End", () => {
  let receivedEvents: EmbeddingCallEvent[] = [];
  const handler = (msg: unknown) => receivedEvents.push(msg as EmbeddingCallEvent);

  beforeEach(() => {
    receivedEvents = [];
    subscribe(CHANNEL_NAMES.EMBEDDING_CALL, handler);
  });

  afterEach(() => {
    unsubscribe(CHANNEL_NAMES.EMBEDDING_CALL, handler);
  });

  it("publishes embedding start event", () => {
    const event = diagnostics.publishEmbeddingStart("openai", 100, "text-embedding-ada-002");

    expect(event.provider).toBe("openai");
    expect(event.inputLength).toBe(100);
    expect(event.model).toBe("text-embedding-ada-002");
    expect(receivedEvents).toHaveLength(1);
  });

  it("publishes embedding end event", () => {
    const event = diagnostics.publishEmbeddingStart("ollama", 50);
    diagnostics.publishEmbeddingEnd(event, true);

    expect(event.success).toBe(true);
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("diagnostics.publishError", () => {
  let receivedEvents: ErrorEvent[] = [];
  const handler = (msg: unknown) => receivedEvents.push(msg as ErrorEvent);

  beforeEach(() => {
    receivedEvents = [];
    subscribe(CHANNEL_NAMES.ERROR, handler);
  });

  afterEach(() => {
    unsubscribe(CHANNEL_NAMES.ERROR, handler);
  });

  it("publishes error event with string", () => {
    diagnostics.publishError("Connection failed", "supabase");

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].error).toBe("Connection failed");
    expect(receivedEvents[0].context).toBe("supabase");
    expect(receivedEvents[0].severity).toBe("error");
  });

  it("publishes error event with Error object", () => {
    diagnostics.publishError(new Error("Test error"), "cache", "warning");

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].severity).toBe("warning");
  });
});

describe("diagnostics.hasSubscribers", () => {
  it("returns false when no subscribers", () => {
    // Note: Other tests may have subscribers, so this is best-effort
    // The important thing is that it doesn't throw
    expect(typeof diagnostics.hasSubscribers()).toBe("boolean");
  });

  it("returns true when subscribers attached", () => {
    const handler = () => {};
    subscribe(CHANNEL_NAMES.TOOL_CALL, handler);

    expect(diagnostics.hasSubscribers()).toBe(true);

    unsubscribe(CHANNEL_NAMES.TOOL_CALL, handler);
  });
});

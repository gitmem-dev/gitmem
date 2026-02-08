/**
 * Unit tests for diagnostics collector
 *
 * Issue: OD-584
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DiagnosticsCollector,
  getCollector,
  resetCollector,
  runBenchmark,
  percentile,
} from "../../../src/diagnostics/collector.js";
import { diagnostics } from "../../../src/diagnostics/channels.js";

describe("DiagnosticsCollector", () => {
  let collector: DiagnosticsCollector;

  beforeEach(() => {
    collector = new DiagnosticsCollector();
  });

  afterEach(() => {
    collector.stop();
  });

  describe("start/stop", () => {
    it("tracks collection time", async () => {
      collector.start();
      await new Promise((r) => setTimeout(r, 15));
      const metrics = collector.stop();

      expect(metrics.startTime).toBeGreaterThan(0);
      expect(metrics.endTime).toBeGreaterThan(metrics.startTime);
      // Allow for timer variance - just verify duration is tracked
      expect(metrics.durationMs).toBeGreaterThanOrEqual(5);
    });

    it("can be stopped multiple times safely", () => {
      collector.start();
      const metrics1 = collector.stop();
      const metrics2 = collector.stop();

      expect(metrics1).toEqual(metrics2);
    });
  });

  describe("tool call collection", () => {
    it("collects completed tool calls", () => {
      collector.start();

      const event = diagnostics.publishToolCallStart("recall");
      diagnostics.publishToolCallEnd(event, true);

      const metrics = collector.stop();

      expect(metrics.toolCalls).toHaveLength(1);
      expect(metrics.toolCalls[0].tool).toBe("recall");
      expect(metrics.toolCalls[0].success).toBe(true);
      expect(metrics.totals.toolCallCount).toBe(1);
    });

    it("collects failed tool calls with anonymized errors", () => {
      collector.start();

      const event = diagnostics.publishToolCallStart("search");
      diagnostics.publishToolCallEnd(event, false, "API key sk_test_1234567890abcdefghij invalid");

      const metrics = collector.stop();

      expect(metrics.toolCalls[0].success).toBe(false);
      expect(metrics.toolCalls[0].error).toContain("[API_KEY]");
      expect(metrics.toolCalls[0].error).not.toContain("sk_test");
    });

    it("calculates total tool duration", () => {
      collector.start();

      const event1 = diagnostics.publishToolCallStart("recall");
      diagnostics.publishToolCallEnd(event1, true);

      const event2 = diagnostics.publishToolCallStart("search");
      diagnostics.publishToolCallEnd(event2, true);

      const metrics = collector.stop();

      expect(metrics.totals.totalToolDurationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("cache event collection", () => {
    it("collects cache hits", () => {
      collector.start();

      diagnostics.publishCacheHit("key1", "scar_search");
      diagnostics.publishCacheHit("key2", "scar_search");
      diagnostics.publishCacheHit("key3", "decisions");

      const metrics = collector.stop();

      expect(metrics.cache.hits).toBe(3);
      expect(metrics.cache.hitsByType["scar_search"]).toBe(2);
      expect(metrics.cache.hitsByType["decisions"]).toBe(1);
    });

    it("collects cache misses", () => {
      collector.start();

      diagnostics.publishCacheMiss("key1", "wins");
      diagnostics.publishCacheMiss("key2", "wins");

      const metrics = collector.stop();

      expect(metrics.cache.misses).toBe(2);
      expect(metrics.cache.missesByType["wins"]).toBe(2);
    });

    it("calculates hit rate", () => {
      collector.start();

      diagnostics.publishCacheHit("key1", "scar_search");
      diagnostics.publishCacheHit("key2", "scar_search");
      diagnostics.publishCacheMiss("key3", "scar_search");
      diagnostics.publishCacheMiss("key4", "scar_search");

      const metrics = collector.stop();

      expect(metrics.cache.hitRate).toBe(0.5);
    });

    it("handles zero cache operations", () => {
      collector.start();
      const metrics = collector.stop();

      expect(metrics.cache.hitRate).toBe(0);
    });
  });

  describe("database query collection", () => {
    it("collects completed queries", () => {
      collector.start();

      const event = diagnostics.publishDbQueryStart("SELECT", "gitmem_learnings");
      diagnostics.publishDbQueryEnd(event, true, 5);

      const metrics = collector.stop();

      expect(metrics.dbQueries).toHaveLength(1);
      expect(metrics.dbQueries[0].operation).toBe("SELECT");
      expect(metrics.dbQueries[0].table).toBe("gitmem_learnings");
      expect(metrics.dbQueries[0].rowCount).toBe(5);
      expect(metrics.totals.dbQueryCount).toBe(1);
    });
  });

  describe("embedding call collection", () => {
    it("collects completed embedding calls", () => {
      collector.start();

      const event = diagnostics.publishEmbeddingStart("openai", 100);
      diagnostics.publishEmbeddingEnd(event, true);

      const metrics = collector.stop();

      expect(metrics.embeddings).toHaveLength(1);
      expect(metrics.embeddings[0].provider).toBe("openai");
      expect(metrics.embeddings[0].inputLength).toBe(100);
      expect(metrics.totals.embeddingCallCount).toBe(1);
    });
  });

  describe("error collection", () => {
    it("collects errors with anonymization", () => {
      collector.start();

      diagnostics.publishError("Failed at https://abc.supabase.co/api", "supabase", "error");

      const metrics = collector.stop();

      expect(metrics.errors).toHaveLength(1);
      expect(metrics.errors[0].message).toContain("https://*.supabase.co");
      expect(metrics.errors[0].context).toBe("supabase");
      expect(metrics.errors[0].severity).toBe("error");
      expect(metrics.totals.errorCount).toBe(1);
    });
  });

  describe("getMetrics", () => {
    it("returns current metrics without stopping", () => {
      collector.start();

      diagnostics.publishCacheHit("key", "scar_search");
      const metrics = collector.getMetrics();

      expect(metrics.cache.hits).toBe(1);

      // Can still add more events
      diagnostics.publishCacheHit("key2", "scar_search");
      const finalMetrics = collector.stop();

      expect(finalMetrics.cache.hits).toBe(2);
    });
  });
});

describe("getCollector/resetCollector", () => {
  afterEach(() => {
    resetCollector();
  });

  it("returns singleton collector", () => {
    const collector1 = getCollector();
    const collector2 = getCollector();

    expect(collector1).toBe(collector2);
  });

  it("reset creates new collector", () => {
    const collector1 = getCollector();
    resetCollector();
    const collector2 = getCollector();

    expect(collector1).not.toBe(collector2);
  });
});

describe("percentile", () => {
  it("calculates percentiles correctly", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 90)).toBe(9);
    expect(percentile(values, 100)).toBe(10);
  });

  it("handles empty array", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("handles single element", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });
});

describe("runBenchmark", () => {
  it("runs benchmark with multiple iterations", async () => {
    let count = 0;
    const result = await runBenchmark("test", async () => {
      count++;
      await new Promise((r) => setTimeout(r, 1));
    }, 3);

    expect(count).toBe(3);
    expect(result.iterations).toBe(3);
    expect(result.meanMs).toBeGreaterThan(0);
    expect(result.minMs).toBeGreaterThan(0);
    expect(result.maxMs).toBeGreaterThanOrEqual(result.minMs);
    expect(result.p50Ms).toBeGreaterThan(0);
    expect(result.p95Ms).toBeGreaterThanOrEqual(result.p50Ms);
    expect(result.p99Ms).toBeGreaterThanOrEqual(result.p95Ms);
  });

  it("uses default 5 iterations", async () => {
    let count = 0;
    await runBenchmark("test", async () => {
      count++;
    });

    expect(count).toBe(5);
  });
});

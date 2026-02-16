/**
 * GitMem Diagnostics Collector
 *
 * Subscribes to diagnostics_channel events and collects metrics
 * during diagnostic pass. Anonymizes data as it's collected.
 *
 *
 */

import { subscribe, unsubscribe, Channel } from "diagnostics_channel";
import {
  CHANNEL_NAMES,
  ToolCallEvent,
  CacheEvent,
  DbQueryEvent,
  EmbeddingCallEvent,
  ErrorEvent,
} from "./channels.js";
import {
  anonymizeError,
  anonymizeCacheKey,
  anonymizeToolParams,
  anonymizeSupabaseUrl,
  anonymizePath,
  isApiKeyConfigured,
  getSafeEnvironmentInfo,
} from "./anonymizer.js";

/**
 * Collected metrics for a diagnostic run
 */
export interface DiagnosticMetrics {
  // Timing
  startTime: number;
  endTime?: number;
  durationMs?: number;

  // Tool calls
  toolCalls: {
    tool: string;
    durationMs: number;
    success: boolean;
    error?: string;
  }[];

  // Cache performance
  cache: {
    hits: number;
    misses: number;
    hitRate: number;
    hitsByType: Record<string, number>;
    missesByType: Record<string, number>;
  };

  // Database queries
  dbQueries: {
    operation: string;
    table?: string;
    durationMs: number;
    success: boolean;
    rowCount?: number;
  }[];

  // Embedding calls
  embeddings: {
    provider: string;
    durationMs: number;
    success: boolean;
    inputLength: number;
  }[];

  // Errors
  errors: {
    message: string;
    context: string;
    severity: string;
  }[];

  // Aggregates
  totals: {
    toolCallCount: number;
    dbQueryCount: number;
    embeddingCallCount: number;
    errorCount: number;
    totalToolDurationMs: number;
    totalDbDurationMs: number;
    totalEmbeddingDurationMs: number;
  };
}

/**
 * Full diagnostic report
 */
export interface DiagnosticReport {
  version: string;
  generatedAt: string;
  mode: "quick" | "full";

  // Environment (safe info only)
  environment: {
    platform: string;
    nodeVersion: string;
    arch: string;
    tier: string;
  };

  // Configuration (boolean flags only)
  configuration: {
    supabaseConfigured: boolean;
    supabaseUrl: string; // anonymized
    embeddingProvider: string;
    embeddingConfigured: boolean;
    cacheEnabled: boolean;
    cachePath: string; // anonymized
  };

  // Health checks
  health: {
    supabase: HealthCheckResult;
    embedding: HealthCheckResult;
    cache: HealthCheckResult;
    recall: HealthCheckResult;
    write: HealthCheckResult;
  };

  // Metrics from diagnostic run
  metrics: DiagnosticMetrics;

  // Benchmarks (full mode only)
  benchmarks?: {
    coldStart?: BenchmarkResult;
    recall?: BenchmarkResult;
    cachePopulate?: BenchmarkResult;
    cacheHit?: BenchmarkResult;
  };

  // Data volume (counts only)
  dataVolume?: {
    learningsCount: number;
    sessionsCount: number;
    decisionsCount: number;
    localCacheFiles: number;
    localCacheBytes: number;
  };
}

/**
 * Health check result
 */
export interface HealthCheckResult {
  status: "pass" | "fail" | "skip";
  message: string;
  durationMs?: number;
}

/**
 * Benchmark result
 */
export interface BenchmarkResult {
  iterations: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

/**
 * Diagnostics collector
 */
export class DiagnosticsCollector {
  private metrics: DiagnosticMetrics;
  private subscriptions: Array<{ channel: string; handler: (message: unknown) => void }> = [];
  private isCollecting: boolean = false;

  constructor() {
    this.metrics = this.createEmptyMetrics();
  }

  /**
   * Create empty metrics object
   */
  private createEmptyMetrics(): DiagnosticMetrics {
    return {
      startTime: 0,
      toolCalls: [],
      cache: {
        hits: 0,
        misses: 0,
        hitRate: 0,
        hitsByType: {},
        missesByType: {},
      },
      dbQueries: [],
      embeddings: [],
      errors: [],
      totals: {
        toolCallCount: 0,
        dbQueryCount: 0,
        embeddingCallCount: 0,
        errorCount: 0,
        totalToolDurationMs: 0,
        totalDbDurationMs: 0,
        totalEmbeddingDurationMs: 0,
      },
    };
  }

  /**
   * Start collecting metrics
   */
  start(): void {
    if (this.isCollecting) return;

    this.metrics = this.createEmptyMetrics();
    this.metrics.startTime = Date.now();
    this.isCollecting = true;

    // Subscribe to all channels
    this.subscribeToChannel(CHANNEL_NAMES.TOOL_CALL, this.handleToolCall.bind(this));
    this.subscribeToChannel(CHANNEL_NAMES.CACHE_HIT, this.handleCacheHit.bind(this));
    this.subscribeToChannel(CHANNEL_NAMES.CACHE_MISS, this.handleCacheMiss.bind(this));
    this.subscribeToChannel(CHANNEL_NAMES.DB_QUERY, this.handleDbQuery.bind(this));
    this.subscribeToChannel(CHANNEL_NAMES.EMBEDDING_CALL, this.handleEmbeddingCall.bind(this));
    this.subscribeToChannel(CHANNEL_NAMES.ERROR, this.handleError.bind(this));
  }

  /**
   * Stop collecting and return metrics
   */
  stop(): DiagnosticMetrics {
    if (!this.isCollecting) return this.metrics;

    this.metrics.endTime = Date.now();
    this.metrics.durationMs = this.metrics.endTime - this.metrics.startTime;
    this.isCollecting = false;

    // Unsubscribe from all channels
    for (const sub of this.subscriptions) {
      unsubscribe(sub.channel, sub.handler);
    }
    this.subscriptions = [];

    // Calculate cache hit rate
    const totalCacheOps = this.metrics.cache.hits + this.metrics.cache.misses;
    if (totalCacheOps > 0) {
      this.metrics.cache.hitRate = this.metrics.cache.hits / totalCacheOps;
    }

    return this.metrics;
  }

  /**
   * Get current metrics (without stopping)
   */
  getMetrics(): DiagnosticMetrics {
    return { ...this.metrics };
  }

  /**
   * Subscribe to a channel
   */
  private subscribeToChannel(channelName: string, handler: (message: unknown) => void): void {
    subscribe(channelName, handler);
    this.subscriptions.push({ channel: channelName, handler });
  }

  /**
   * Handle tool call event
   */
  private handleToolCall(message: unknown): void {
    const event = message as ToolCallEvent;

    // Only record completed calls (with duration)
    if (event.durationMs !== undefined) {
      this.metrics.toolCalls.push({
        tool: event.tool,
        durationMs: event.durationMs,
        success: event.success ?? true,
        error: event.error ? anonymizeError(event.error) : undefined,
      });

      this.metrics.totals.toolCallCount++;
      this.metrics.totals.totalToolDurationMs += event.durationMs;
    }
  }

  /**
   * Handle cache hit event
   */
  private handleCacheHit(message: unknown): void {
    const event = message as CacheEvent;
    this.metrics.cache.hits++;
    this.metrics.cache.hitsByType[event.type] = (this.metrics.cache.hitsByType[event.type] || 0) + 1;
  }

  /**
   * Handle cache miss event
   */
  private handleCacheMiss(message: unknown): void {
    const event = message as CacheEvent;
    this.metrics.cache.misses++;
    this.metrics.cache.missesByType[event.type] = (this.metrics.cache.missesByType[event.type] || 0) + 1;
  }

  /**
   * Handle database query event
   */
  private handleDbQuery(message: unknown): void {
    const event = message as DbQueryEvent;

    // Only record completed queries (with duration)
    if (event.durationMs !== undefined) {
      this.metrics.dbQueries.push({
        operation: event.operation,
        table: event.table,
        durationMs: event.durationMs,
        success: event.success ?? true,
        rowCount: event.rowCount,
      });

      this.metrics.totals.dbQueryCount++;
      this.metrics.totals.totalDbDurationMs += event.durationMs;
    }
  }

  /**
   * Handle embedding call event
   */
  private handleEmbeddingCall(message: unknown): void {
    const event = message as EmbeddingCallEvent;

    // Only record completed calls (with duration)
    if (event.durationMs !== undefined) {
      this.metrics.embeddings.push({
        provider: event.provider,
        durationMs: event.durationMs,
        success: event.success ?? true,
        inputLength: event.inputLength,
      });

      this.metrics.totals.embeddingCallCount++;
      this.metrics.totals.totalEmbeddingDurationMs += event.durationMs;
    }
  }

  /**
   * Handle error event
   */
  private handleError(message: unknown): void {
    const event = message as ErrorEvent;
    this.metrics.errors.push({
      message: anonymizeError(event.error),
      context: event.context,
      severity: event.severity,
    });
    this.metrics.totals.errorCount++;
  }
}

/**
 * Calculate percentile from sorted array
 */
export function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

/**
 * Run benchmark with multiple iterations
 */
export async function runBenchmark(
  name: string,
  fn: () => Promise<void>,
  iterations: number = 5
): Promise<BenchmarkResult> {
  const times: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    const end = performance.now();
    times.push(end - start);
  }

  times.sort((a, b) => a - b);

  return {
    iterations,
    meanMs: times.reduce((a, b) => a + b, 0) / times.length,
    minMs: times[0],
    maxMs: times[times.length - 1],
    p50Ms: percentile(times, 50),
    p95Ms: percentile(times, 95),
    p99Ms: percentile(times, 99),
  };
}

// Singleton collector for global use
let globalCollector: DiagnosticsCollector | null = null;

export function getCollector(): DiagnosticsCollector {
  if (!globalCollector) {
    globalCollector = new DiagnosticsCollector();
  }
  return globalCollector;
}

export function resetCollector(): void {
  if (globalCollector) {
    globalCollector.stop();
  }
  globalCollector = null;
}

/**
 * GitMem Diagnostics Module
 *
 * Zero-overhead instrumentation using Node.js diagnostics_channel.
 * When no subscriber is attached, publish() calls are essentially no-ops.
 *
 * Usage:
 *   import { diagnostics } from './diagnostics';
 *
 *   // In tool handler:
 *   const event = diagnostics.publishToolCallStart('recall');
 *   // ... do work ...
 *   diagnostics.publishToolCallEnd(event, true);
 *
 * For diagnostic collection:
 *   import { getCollector } from './diagnostics';
 *
 *   const collector = getCollector();
 *   collector.start();
 *   // ... run operations ...
 *   const metrics = collector.stop();
 *
 * Issue: OD-584
 */

// Channel definitions and publisher
export {
  diagnostics,
  CHANNEL_NAMES,
  channel,
  type ToolCallEvent,
  type CacheEvent,
  type DbQueryEvent,
  type EmbeddingCallEvent,
  type ErrorEvent,
} from "./channels.js";

// Collector for diagnostic runs
export {
  DiagnosticsCollector,
  getCollector,
  resetCollector,
  runBenchmark,
  percentile,
  type DiagnosticMetrics,
  type DiagnosticReport,
  type HealthCheckResult,
  type BenchmarkResult,
} from "./collector.js";

// Anonymization utilities
export {
  anonymizeSupabaseUrl,
  anonymizePath,
  anonymizeError,
  anonymizeString,
  anonymizeCacheKey,
  anonymizeToolParams,
  isApiKeyConfigured,
  getSafeEnvironmentInfo,
} from "./anonymizer.js";

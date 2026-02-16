/**
 * GitMem Diagnostics Channels
 *
 * Defines diagnostics_channel channels for zero-overhead instrumentation.
 * When no subscriber is attached, publish() is essentially a no-op.
 *
 * Pattern reference: @ibm/telemetry-js
 *
 */

import { channel, Channel } from "diagnostics_channel";

/**
 * Channel names for GitMem diagnostics
 */
export const CHANNEL_NAMES = {
  TOOL_CALL: "gitmem:tool:call",
  CACHE_HIT: "gitmem:cache:hit",
  CACHE_MISS: "gitmem:cache:miss",
  DB_QUERY: "gitmem:db:query",
  EMBEDDING_CALL: "gitmem:embedding:call",
  ERROR: "gitmem:error",
} as const;

/**
 * Tool call event payload
 */
export interface ToolCallEvent {
  tool: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  success?: boolean;
  error?: string;
  params?: Record<string, unknown>;
}

/**
 * Cache event payload
 */
export interface CacheEvent {
  key: string;
  type: "scar_search" | "decisions" | "wins" | "embeddings";
  ageMs?: number;
  sizeBytes?: number;
}

/**
 * Database query event payload
 */
export interface DbQueryEvent {
  operation: string;
  table?: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  rowCount?: number;
  success?: boolean;
  error?: string;
}

/**
 * Embedding call event payload
 */
export interface EmbeddingCallEvent {
  provider: string;
  model?: string;
  inputLength: number;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  success?: boolean;
  error?: string;
}

/**
 * Error event payload
 */
export interface ErrorEvent {
  error: Error | string;
  context: string;
  timestamp: number;
  severity: "warning" | "error" | "fatal";
}

/**
 * Diagnostics channels singleton
 */
class DiagnosticsChannels {
  readonly toolCall: Channel;
  readonly cacheHit: Channel;
  readonly cacheMiss: Channel;
  readonly dbQuery: Channel;
  readonly embeddingCall: Channel;
  readonly error: Channel;

  constructor() {
    this.toolCall = channel(CHANNEL_NAMES.TOOL_CALL);
    this.cacheHit = channel(CHANNEL_NAMES.CACHE_HIT);
    this.cacheMiss = channel(CHANNEL_NAMES.CACHE_MISS);
    this.dbQuery = channel(CHANNEL_NAMES.DB_QUERY);
    this.embeddingCall = channel(CHANNEL_NAMES.EMBEDDING_CALL);
    this.error = channel(CHANNEL_NAMES.ERROR);
  }

  /**
   * Publish tool call start event
   */
  publishToolCallStart(tool: string, params?: Record<string, unknown>): ToolCallEvent {
    const event: ToolCallEvent = {
      tool,
      startTime: Date.now(),
      params,
    };
    this.toolCall.publish(event);
    return event;
  }

  /**
   * Publish tool call end event
   */
  publishToolCallEnd(event: ToolCallEvent, success: boolean, error?: string): void {
    event.endTime = Date.now();
    event.durationMs = event.endTime - event.startTime;
    event.success = success;
    event.error = error;
    this.toolCall.publish(event);
  }

  /**
   * Publish cache hit event
   */
  publishCacheHit(key: string, type: CacheEvent["type"], ageMs?: number, sizeBytes?: number): void {
    const event: CacheEvent = { key, type, ageMs, sizeBytes };
    this.cacheHit.publish(event);
  }

  /**
   * Publish cache miss event
   */
  publishCacheMiss(key: string, type: CacheEvent["type"]): void {
    const event: CacheEvent = { key, type };
    this.cacheMiss.publish(event);
  }

  /**
   * Publish database query start event
   */
  publishDbQueryStart(operation: string, table?: string): DbQueryEvent {
    const event: DbQueryEvent = {
      operation,
      table,
      startTime: Date.now(),
    };
    this.dbQuery.publish(event);
    return event;
  }

  /**
   * Publish database query end event
   */
  publishDbQueryEnd(event: DbQueryEvent, success: boolean, rowCount?: number, error?: string): void {
    event.endTime = Date.now();
    event.durationMs = event.endTime - event.startTime;
    event.success = success;
    event.rowCount = rowCount;
    event.error = error;
    this.dbQuery.publish(event);
  }

  /**
   * Publish embedding call start event
   */
  publishEmbeddingStart(provider: string, inputLength: number, model?: string): EmbeddingCallEvent {
    const event: EmbeddingCallEvent = {
      provider,
      model,
      inputLength,
      startTime: Date.now(),
    };
    this.embeddingCall.publish(event);
    return event;
  }

  /**
   * Publish embedding call end event
   */
  publishEmbeddingEnd(event: EmbeddingCallEvent, success: boolean, error?: string): void {
    event.endTime = Date.now();
    event.durationMs = event.endTime - event.startTime;
    event.success = success;
    event.error = error;
    this.embeddingCall.publish(event);
  }

  /**
   * Publish error event
   */
  publishError(error: Error | string, context: string, severity: ErrorEvent["severity"] = "error"): void {
    const event: ErrorEvent = {
      error,
      context,
      timestamp: Date.now(),
      severity,
    };
    this.error.publish(event);
  }

  /**
   * Check if any channel has subscribers
   */
  hasSubscribers(): boolean {
    return (
      this.toolCall.hasSubscribers ||
      this.cacheHit.hasSubscribers ||
      this.cacheMiss.hasSubscribers ||
      this.dbQuery.hasSubscribers ||
      this.embeddingCall.hasSubscribers ||
      this.error.hasSubscribers
    );
  }
}

// Singleton instance
export const diagnostics = new DiagnosticsChannels();

// Export channel for external subscription
export { channel };

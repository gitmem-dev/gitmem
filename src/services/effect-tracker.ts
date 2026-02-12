/**
 * Effect Tracker — Lightweight in-process accounting for async side effects.
 *
 * Wraps fire-and-forget operations so failures are recorded instead of
 * swallowed.  Provides aggregate stats queryable via the `gitmem-health`
 * MCP tool.
 *
 * Design principles (from docs/silent-failures.md):
 *  - Non-blocking: registration and completion are synchronous Map ops.
 *  - Fire-and-forget stays fire-and-forget for latency; failures become visible.
 *  - In-memory ring buffer — no persistence across restarts (acceptable for
 *    metrics, cache warming, knowledge graph triples).
 *  - Aggregate stats per write path, not per individual write.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PathStats {
  attempted: number;
  succeeded: number;
  failed: number;
  lastFailure?: { error: string; timestamp: string };
  totalDurationMs: number;
}

export interface EffectFailure {
  path: string;
  target: string;
  error: string;
  timestamp: string;
  durationMs: number;
}

export interface EffectHealthReport {
  /** Per-path aggregate stats */
  byPath: Record<string, {
    attempted: number;
    succeeded: number;
    failed: number;
    successRate: string;
    avgDurationMs: number;
    lastFailure?: { error: string; timestamp: string };
  }>;
  /** Overall aggregate */
  overall: {
    attempted: number;
    succeeded: number;
    failed: number;
    successRate: string;
    paths_with_failures: string[];
  };
  /** Recent failures (newest first) */
  recentFailures: EffectFailure[];
  /** Session uptime */
  uptimeMs: number;
}

// ---------------------------------------------------------------------------
// Ring Buffer for recent failures
// ---------------------------------------------------------------------------

class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Return items newest-first */
  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      result.push(this.buffer[idx] as T);
    }
    return result;
  }

  get size(): number {
    return this.count;
  }
}

// ---------------------------------------------------------------------------
// EffectTracker
// ---------------------------------------------------------------------------

const FAILURE_BUFFER_SIZE = 50;

export class EffectTracker {
  private stats = new Map<string, PathStats>();
  private failures = new RingBuffer<EffectFailure>(FAILURE_BUFFER_SIZE);
  private startedAt = Date.now();

  /**
   * Wrap an async fire-and-forget operation for tracking.
   *
   * - On success: records success + duration, returns the result.
   * - On failure: records failure + error message, returns undefined.
   *   The error is **not** rethrown — this is intentionally fire-and-forget.
   */
  track<T>(
    path: string,
    target: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    const start = Date.now();
    const stats = this.getOrCreatePath(path);
    stats.attempted++;

    return fn().then(
      (result) => {
        const duration = Date.now() - start;
        stats.succeeded++;
        stats.totalDurationMs += duration;
        return result;
      },
      (error) => {
        const duration = Date.now() - start;
        const errorMsg = error instanceof Error ? error.message : String(error);
        stats.failed++;
        stats.totalDurationMs += duration;
        stats.lastFailure = {
          error: errorMsg,
          timestamp: new Date().toISOString(),
        };
        this.failures.push({
          path,
          target,
          error: errorMsg,
          timestamp: new Date().toISOString(),
          durationMs: duration,
        });
        return undefined;
      },
    );
  }

  /**
   * Generate a health report for the `gitmem-health` tool.
   */
  getHealthReport(failureLimit = 10): EffectHealthReport {
    const byPath: EffectHealthReport["byPath"] = {};
    let totalAttempted = 0;
    let totalSucceeded = 0;
    let totalFailed = 0;
    const pathsWithFailures: string[] = [];

    for (const [path, s] of this.stats) {
      totalAttempted += s.attempted;
      totalSucceeded += s.succeeded;
      totalFailed += s.failed;
      if (s.failed > 0) pathsWithFailures.push(path);

      byPath[path] = {
        attempted: s.attempted,
        succeeded: s.succeeded,
        failed: s.failed,
        successRate: s.attempted > 0
          ? `${((s.succeeded / s.attempted) * 100).toFixed(1)}%`
          : "N/A",
        avgDurationMs: s.attempted > 0
          ? Math.round(s.totalDurationMs / s.attempted)
          : 0,
        lastFailure: s.lastFailure,
      };
    }

    const recentFailures = this.failures.toArray().slice(0, failureLimit);

    return {
      byPath,
      overall: {
        attempted: totalAttempted,
        succeeded: totalSucceeded,
        failed: totalFailed,
        successRate: totalAttempted > 0
          ? `${((totalSucceeded / totalAttempted) * 100).toFixed(1)}%`
          : "N/A",
        paths_with_failures: pathsWithFailures,
      },
      recentFailures,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  /**
   * Format a human-readable health summary for session close.
   */
  formatSummary(): string {
    const report = this.getHealthReport();
    if (report.overall.attempted === 0) return "No tracked effects this session.";

    const lines: string[] = [];
    for (const [path, s] of Object.entries(report.byPath)) {
      const status = s.failed > 0 ? `(${s.failed} failed)` : "";
      lines.push(`  ${path.padEnd(20)} ${s.succeeded}/${s.attempted} succeeded ${status}`);
    }

    if (report.overall.failed > 0) {
      lines.push("");
      lines.push(`  ⚠ ${report.overall.failed} total failures across: ${report.overall.paths_with_failures.join(", ")}`);
    }

    return lines.join("\n");
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private getOrCreatePath(path: string): PathStats {
    let s = this.stats.get(path);
    if (!s) {
      s = { attempted: 0, succeeded: 0, failed: 0, totalDurationMs: 0 };
      this.stats.set(path, s);
    }
    return s;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: EffectTracker | undefined;

export function getEffectTracker(): EffectTracker {
  if (!instance) {
    instance = new EffectTracker();
  }
  return instance;
}

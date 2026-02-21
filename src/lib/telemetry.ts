/**
 * Privacy-respecting telemetry for GitMem
 *
 * - Opt-in only (disabled by default)
 * - No PII (queries, scars, project names, IPs)
 * - Transparent (local logs visible before sending)
 * - Anonymous (random session IDs, not persistent)
 * - Controllable (enable/disable/show/clear)
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { platform } from "os";

interface TelemetryConfig {
  enabled: boolean;
  session_id: string; // Random per-session, not stored
  consent_version: string;
  consented_at?: string;
}

interface TelemetryEvent {
  event: string;
  tool?: string;
  success?: boolean;
  duration_ms?: number;
  result_count?: number;
  error_type?: string;
  version: string;
  platform: string;
  mcp_host?: string;
  tier: "free" | "pro";
  timestamp: string;
  session_id: string;
}

const CONSENT_VERSION = "2026-02";
const TELEMETRY_ENDPOINT = "https://telemetry.gitmem.ai/v1/events";
const BATCH_INTERVAL_HOURS = 24;

export class Telemetry {
  private configPath: string;
  private logPath: string;
  private config: TelemetryConfig | null = null;
  private version: string;

  constructor(gitmemDir: string, version: string) {
    this.configPath = join(gitmemDir, "telemetry.json");
    this.logPath = join(gitmemDir, "telemetry.log");
    this.version = version;
    this.loadConfig();
  }

  /**
   * Load telemetry config from disk
   */
  private loadConfig(): void {
    if (!existsSync(this.configPath)) {
      // Default: disabled
      this.config = {
        enabled: false,
        session_id: this.generateSessionId(),
        consent_version: CONSENT_VERSION,
      };
      return;
    }

    try {
      const raw = readFileSync(this.configPath, "utf-8");
      const stored = JSON.parse(raw);

      // Check consent version — re-prompt if changed
      if (stored.consent_version !== CONSENT_VERSION) {
        console.warn("[telemetry] Privacy policy updated — re-consent required");
        this.config = {
          enabled: false,
          session_id: this.generateSessionId(),
          consent_version: CONSENT_VERSION,
        };
        this.saveConfig();
        return;
      }

      this.config = {
        ...stored,
        session_id: this.generateSessionId(), // Always fresh per-session
      };
    } catch (err) {
      console.warn("[telemetry] Could not parse config, resetting");
      this.config = {
        enabled: false,
        session_id: this.generateSessionId(),
        consent_version: CONSENT_VERSION,
      };
    }
  }

  /**
   * Save config to disk
   */
  private saveConfig(): void {
    if (!this.config) return;

    // Don't persist session_id — it's per-session only
    const toSave = {
      enabled: this.config.enabled,
      consent_version: this.config.consent_version,
      consented_at: this.config.consented_at,
    };

    writeFileSync(this.configPath, JSON.stringify(toSave, null, 2));
  }

  /**
   * Generate random session ID (8 hex chars, not persistent)
   */
  private generateSessionId(): string {
    return randomBytes(4).toString("hex");
  }

  /**
   * Check if telemetry is enabled
   */
  isEnabled(): boolean {
    return this.config?.enabled ?? false;
  }

  /**
   * Enable telemetry (user consent)
   */
  enable(): void {
    if (!this.config) {
      this.loadConfig();
    }

    this.config!.enabled = true;
    this.config!.consented_at = new Date().toISOString();
    this.saveConfig();
  }

  /**
   * Disable telemetry
   */
  disable(): void {
    if (!this.config) {
      this.loadConfig();
    }

    this.config!.enabled = false;
    delete this.config!.consented_at;
    this.saveConfig();
  }

  /**
   * Log an event (always writes to local log, sends if enabled)
   */
  async track(eventData: {
    event: string;
    tool?: string;
    success?: boolean;
    duration_ms?: number;
    result_count?: number;
    error_type?: string;
    mcp_host?: string;
  }): Promise<void> {
    if (!this.config) return;

    const tier = this.detectTier();

    const event: TelemetryEvent = {
      ...eventData,
      version: this.version,
      platform: platform(),
      tier,
      timestamp: new Date().toISOString(),
      session_id: this.config.session_id,
    };

    // Always log locally (transparent)
    this.logToFile(event);

    // Send immediately if enabled (in background, don't block)
    if (this.isEnabled()) {
      this.sendEvent(event).catch((err) => {
        // Silent failure — don't interrupt user workflows
        if (process.env.DEBUG) {
          console.warn("[telemetry] Send failed:", err.message);
        }
      });
    }
  }

  /**
   * Write event to local log file
   */
  private logToFile(event: TelemetryEvent): void {
    try {
      const line = JSON.stringify(event) + "\n";
      appendFileSync(this.logPath, line);
    } catch (err) {
      // Silent failure on write errors
    }
  }

  /**
   * Send event to telemetry endpoint (background, non-blocking)
   */
  private async sendEvent(event: TelemetryEvent): Promise<void> {
    try {
      const response = await fetch(TELEMETRY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5000), // 5s timeout
      });

      if (!response.ok && process.env.DEBUG) {
        console.warn("[telemetry] HTTP", response.status);
      }
    } catch (err) {
      // Silent failure — telemetry should never break workflows
      if (process.env.DEBUG) {
        console.warn("[telemetry]", err);
      }
    }
  }

  /**
   * Detect tier (free vs pro)
   */
  private detectTier(): "free" | "pro" {
    return process.env.SUPABASE_URL ? "pro" : "free";
  }

  /**
   * Get telemetry status for CLI display
   */
  getStatus(): {
    enabled: boolean;
    session_id: string;
    event_count: number;
    consent_version: string;
    consented_at?: string;
  } {
    if (!this.config) {
      this.loadConfig();
    }

    let eventCount = 0;
    if (existsSync(this.logPath)) {
      try {
        const log = readFileSync(this.logPath, "utf-8");
        eventCount = log.split("\n").filter((line) => line.trim()).length;
      } catch {
        eventCount = 0;
      }
    }

    return {
      enabled: this.config!.enabled,
      session_id: this.config!.session_id,
      event_count: eventCount,
      consent_version: this.config!.consent_version,
      consented_at: this.config!.consented_at,
    };
  }

  /**
   * Get recent events for CLI display
   */
  getRecentEvents(limit: number = 100): string[] {
    if (!existsSync(this.logPath)) {
      return [];
    }

    try {
      const log = readFileSync(this.logPath, "utf-8");
      const lines = log.split("\n").filter((line) => line.trim());
      return lines.slice(-limit);
    } catch {
      return [];
    }
  }

  /**
   * Clear local telemetry log
   */
  clearLog(): void {
    if (existsSync(this.logPath)) {
      writeFileSync(this.logPath, "");
    }
  }

  /**
   * Format event for human-readable display
   */
  static formatEvent(eventJson: string): string {
    try {
      const e = JSON.parse(eventJson) as TelemetryEvent;
      const time = new Date(e.timestamp).toLocaleString();
      const tool = e.tool ? `: ${e.tool}` : "";
      const status = e.success === false ? " (failed)" : "";
      const duration = e.duration_ms ? ` ${e.duration_ms}ms` : "";
      const results = e.result_count !== undefined ? `, ${e.result_count} results` : "";
      return `[${time}] ${e.event}${tool}${status}${duration}${results}`;
    } catch {
      return eventJson;
    }
  }
}

/**
 * Global telemetry instance (lazy init)
 */
let telemetryInstance: Telemetry | null = null;

export function getTelemetry(gitmemDir: string, version: string): Telemetry {
  if (!telemetryInstance) {
    telemetryInstance = new Telemetry(gitmemDir, version);
  }
  return telemetryInstance;
}

/**
 * Track a tool call
 */
export async function trackToolCall(args: {
  gitmemDir: string;
  version: string;
  tool: string;
  success: boolean;
  duration_ms: number;
  result_count?: number;
  error_type?: string;
  mcp_host?: string;
}): Promise<void> {
  const { gitmemDir, version, ...eventData } = args;
  const telemetry = getTelemetry(gitmemDir, version);
  await telemetry.track({
    event: "tool_called",
    ...eventData,
  });
}

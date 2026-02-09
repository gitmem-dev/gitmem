/**
 * Timezone Display Formatting Service
 *
 * Converts UTC timestamps to user's local timezone for display.
 * Storage timestamps remain UTC — this is display-layer only.
 *
 * Config chain: .gitmem/config.json → TZ env var → UTC (default)
 */

import * as fs from "fs";
import { getGitmemPath } from "./gitmem-dir.js";
import type { ThreadObject } from "../types/index.js";

let _timezone: string | null = null;
let _loaded = false;

/**
 * Load timezone from config chain:
 * 1. .gitmem/config.json "timezone" field
 * 2. TZ environment variable
 * 3. "UTC" (default, preserves current behavior)
 */
function loadTimezone(): string {
  if (_loaded) return _timezone || "UTC";

  // 1. Try .gitmem/config.json
  try {
    const configPath = getGitmemPath("config.json");
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (raw.timezone && typeof raw.timezone === "string") {
        const tz: string = raw.timezone;
        try {
          Intl.DateTimeFormat(undefined, { timeZone: tz });
          _timezone = tz;
          _loaded = true;
          console.error(`[timezone] Loaded from config.json: ${tz}`);
          return tz;
        } catch {
          console.warn(`[timezone] Invalid timezone in config.json: ${tz}, falling back`);
        }
      }
    }
  } catch {
    // File doesn't exist or is invalid — fall through
  }

  // 2. Try TZ env var
  const tzEnv = process.env.TZ;
  if (tzEnv) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tzEnv });
      _timezone = tzEnv;
      _loaded = true;
      console.error(`[timezone] Loaded from TZ env: ${tzEnv}`);
      return tzEnv;
    } catch {
      console.warn(`[timezone] Invalid TZ env var: ${tzEnv}, falling back to UTC`);
    }
  }

  // 3. Default to UTC
  _timezone = "UTC";
  _loaded = true;
  return _timezone;
}

/** Get the configured timezone. Loads once from config chain. */
export function getTimezone(): string {
  return loadTimezone();
}

function isTimezoneConfigured(): boolean {
  return getTimezone() !== "UTC";
}

/**
 * Format a date-only string (YYYY-MM-DD) for display.
 *
 * When timezone is UTC (default): returns original string unchanged.
 * When timezone configured: returns "Feb 9, 2026" format.
 *
 * Does NOT shift the date to another timezone — the input is
 * treated as a calendar date, not a UTC midnight timestamp.
 */
export function formatDate(dateStr: string): string {
  if (!isTimezoneConfigured()) return dateStr;
  if (!dateStr || dateStr.length < 10) return dateStr;

  try {
    const [year, month, day] = dateStr.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC", // Calendar date — don't shift across timezones
    }).format(date);
  } catch {
    return dateStr;
  }
}

/**
 * Format a full ISO timestamp for display.
 *
 * When timezone is UTC (default): returns original string unchanged.
 * When timezone configured: returns "Feb 9, 2026, 1:45 PM EST" format.
 */
export function formatTimestamp(isoStr: string): string {
  if (!isTimezoneConfigured()) return isoStr;
  if (!isoStr) return isoStr;

  try {
    const date = new Date(isoStr);
    if (isNaN(date.getTime())) return isoStr;

    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone: getTimezone(),
    }).format(date);
  } catch {
    return isoStr;
  }
}

/**
 * Format a ThreadObject's timestamps for display.
 * Returns original reference when UTC (no allocation).
 * Returns a shallow copy with formatted dates when timezone configured.
 */
export function formatThreadForDisplay(thread: ThreadObject): ThreadObject {
  if (!isTimezoneConfigured()) return thread;
  return {
    ...thread,
    created_at: formatTimestamp(thread.created_at),
    ...(thread.resolved_at && { resolved_at: formatTimestamp(thread.resolved_at) }),
  };
}

/** Reset cached timezone (for testing). */
export function resetTimezone(): void {
  _timezone = null;
  _loaded = false;
}

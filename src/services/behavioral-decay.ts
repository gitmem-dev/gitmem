/**
 * Behavioral Decay Service
 *
 * Organic scar lifecycle management: scars that keep getting dismissed
 * naturally fade in recall ranking. No manual hygiene commands needed.
 *
 * Two functions:
 * 1. refreshBehavioralScores() — calls Supabase RPC to update decay_multiplier
 *    based on scar_usage patterns (fire-and-forget from session_start)
 * 2. fetchDismissalCounts() — queries scar_usage for inline archival hints
 *    (called from recall to annotate frequently-dismissed scars)
 */

import { isConfigured, safeInFilter } from "./supabase-client.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "";
const SUPABASE_REST_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1` : "";

export interface BehavioralRefreshResult {
  scars_updated: number;
  scars_scanned: number;
}

export interface DismissalCounts {
  surfaced: number;
  dismissed: number;
}

/**
 * Refresh behavioral decay scores from scar_usage patterns.
 *
 * Calls the `refresh_scar_behavioral_scores()` Supabase RPC function.
 * Idempotent, safe for concurrent calls. Returns null if Supabase isn't configured.
 *
 * Intended to be called fire-and-forget from session_start.
 */
export async function refreshBehavioralScores(): Promise<BehavioralRefreshResult | null> {
  if (!isConfigured()) {
    return null;
  }

  try {
    const url = `${SUPABASE_REST_URL}/rpc/refresh_scar_behavioral_scores`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Content-Profile": "public",
      },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[behavioral-decay] RPC failed: ${response.status} - ${text.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200)}`);
      return null;
    }

    const result = await response.json();

    // RPC returns TABLE, so result is an array of rows
    if (Array.isArray(result) && result.length > 0) {
      const { scars_updated, scars_scanned } = result[0];
      console.error(`[behavioral-decay] Refreshed: ${scars_updated} updated / ${scars_scanned} scanned`);
      return { scars_updated, scars_scanned };
    }

    return { scars_updated: 0, scars_scanned: 0 };
  } catch (error) {
    console.error("[behavioral-decay] Refresh failed:", error);
    return null;
  }
}

/**
 * Fetch dismissal counts for specific scars from scar_usage.
 *
 * Returns a map of scar_id → { surfaced, dismissed } for scars
 * that have been surfaced at least once. Used by recall to add
 * inline archival hints for frequently-dismissed scars.
 *
 * Gracefully returns empty map on any error.
 */
export async function fetchDismissalCounts(
  scarIds: string[]
): Promise<Map<string, DismissalCounts>> {
  const result = new Map<string, DismissalCounts>();

  if (!isConfigured() || scarIds.length === 0) {
    return result;
  }

  try {
    // Query scar_usage for the given scar IDs (last 90 days)
    const url = new URL(`${SUPABASE_REST_URL}/scar_usage`);
    url.searchParams.set("select", "scar_id,reference_type");
    url.searchParams.set("scar_id", safeInFilter(scarIds));
    url.searchParams.set("surfaced_at", `gte.${new Date(Date.now() - 90 * 86400000).toISOString()}`);
    url.searchParams.set("limit", "1000");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        "Accept-Profile": "public",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return result;
    }

    const rows = (await response.json()) as Array<{
      scar_id: string;
      reference_type: string;
    }>;

    // Aggregate counts per scar
    for (const row of rows) {
      const existing = result.get(row.scar_id) || { surfaced: 0, dismissed: 0 };
      existing.surfaced++;
      if (row.reference_type === "refuted" || row.reference_type === "none") {
        existing.dismissed++;
      }
      result.set(row.scar_id, existing);
    }

    return result;
  } catch {
    return result;
  }
}

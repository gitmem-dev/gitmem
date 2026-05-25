/**
 * License Key Validation for GitMem Pro Tier
 *
 * Detection chain:
 *   1. GITMEM_TIER env var (explicit override — testing/dev)
 *   2. api_key in config.json or GITMEM_API_KEY env var:
 *      a. Check license-cache.json → if valid + not expired (72h) → return cached tier
 *      b. No cache → optimistic "pro" (validated async in runServer)
 *   3. No key + no SUPABASE_URL + no config.supabase_url → free
 *   4. No key + SUPABASE_URL set (env var) → pro (backward compat for us)
 *
 * Async validation (validateLicense()):
 *   - Called in runServer() startup (non-blocking)
 *   - POST to hardcoded validation endpoint with api_key + install_id
 *   - Success: cache to ~/.gitmem/license-cache.json (72h TTL)
 *   - Failure: downgrade _tier to free, log warning
 *   - Network error: honor existing cache if valid, else downgrade
 */

import * as fs from "fs";
import * as path from "path";
import { getGitmemDir, getInstallId } from "./gitmem-dir.js";

// Hardcoded validation endpoint — calls RPC directly on our Supabase via PostgREST.
// Users never see or configure this URL.
const VALIDATION_URL = "https://cjptxyezuxdiinufgrrm.supabase.co/rest/v1/rpc/gitmem_validate_license";
// Anon key for our project (safe to embed — RPC is SECURITY DEFINER, RLS blocks direct table access)
const VALIDATION_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqcHR4eWV6dXhkaWludWZncnJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYxODY3MDMsImV4cCI6MjA4MTc2MjcwM30.L0oZy3LYCMikmZ15IUU5DnfJmucM37DJ14nUkM3AreY";

// Cache TTL: 72 hours
const CACHE_TTL_MS = 72 * 60 * 60 * 1000;

export interface LicenseValidationResult {
  valid: boolean;
  tier: string | null;
  message: string;
}

interface LicenseCache {
  valid: boolean;
  tier: string;
  validated_at: string;
  api_key_prefix: string;
}

/**
 * Get license key from env var or config.json
 */
export function getLicenseKey(): string | null {
  // Env var takes priority
  const envKey = process.env.GITMEM_API_KEY;
  if (envKey) return envKey;

  // Read from config.json
  try {
    const configPath = path.join(getGitmemDir(), "config.json");
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (raw.api_key && typeof raw.api_key === "string") {
        return raw.api_key;
      }
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return null;
}

/**
 * Get Pro config (Supabase + OpenRouter credentials) from config.json
 * Env vars override config.json values.
 */
export function getProConfig(): {
  supabaseUrl: string;
  supabaseKey: string;
  openrouterKey: string;
} {
  let supabaseUrl = process.env.SUPABASE_URL || "";
  let supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "";
  let openrouterKey = process.env.OPENROUTER_API_KEY || "";

  // Fall back to config.json
  try {
    const configPath = path.join(getGitmemDir(), "config.json");
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (!supabaseUrl && raw.supabase_url) supabaseUrl = raw.supabase_url;
      if (!supabaseKey && raw.supabase_key) supabaseKey = raw.supabase_key;
      if (!openrouterKey && raw.openrouter_key) openrouterKey = raw.openrouter_key;
    }
  } catch {
    // File doesn't exist or is invalid
  }

  return { supabaseUrl, supabaseKey, openrouterKey };
}

/**
 * Read cached license validation result
 */
function readLicenseCache(): LicenseCache | null {
  try {
    const cachePath = path.join(getGitmemDir(), "license-cache.json");
    if (!fs.existsSync(cachePath)) return null;

    const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as LicenseCache;
    const validatedAt = new Date(raw.validated_at).getTime();
    const now = Date.now();

    // Check TTL
    if (now - validatedAt > CACHE_TTL_MS) {
      console.error("[gitmem:license] Cache expired");
      return null;
    }

    return raw;
  } catch {
    return null;
  }
}

/**
 * Write license validation result to cache
 */
function writeLicenseCache(result: LicenseCache): void {
  try {
    const gitmemDir = getGitmemDir();
    if (!fs.existsSync(gitmemDir)) {
      fs.mkdirSync(gitmemDir, { recursive: true });
    }
    const cachePath = path.join(gitmemDir, "license-cache.json");
    fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("[gitmem:license] Failed to write cache:", err);
  }
}

/**
 * Delete license cache (used by deactivate)
 */
export function clearLicenseCache(): void {
  try {
    const cachePath = path.join(getGitmemDir(), "license-cache.json");
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
    }
  } catch {
    // Ignore
  }
}

/**
 * Check if license key has a valid cached result (non-async, for tier detection)
 */
export function getCachedLicenseTier(): string | null {
  const cache = readLicenseCache();
  if (cache && cache.valid) {
    return cache.tier;
  }
  return null;
}

/**
 * Validate license key against GitMem's Supabase RPC endpoint.
 * Calls gitmem_validate_license() via PostgREST using the anon key.
 * Returns the validation result.
 *
 * This is async and should be called non-blocking during startup.
 */
export async function validateLicense(apiKey: string, installId: string): Promise<LicenseValidationResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(VALIDATION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: VALIDATION_ANON_KEY,
        Authorization: `Bearer ${VALIDATION_ANON_KEY}`,
      },
      body: JSON.stringify({ p_api_key: apiKey, p_install_id: installId }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { valid: false, tier: null, message: `HTTP ${response.status}: ${text}` };
    }

    // PostgREST RPC returns an array of rows
    const rows = await response.json() as LicenseValidationResult[];
    const data = Array.isArray(rows) ? rows[0] : rows as unknown as LicenseValidationResult;

    if (!data) {
      return { valid: false, tier: null, message: "Empty validation response" };
    }

    // Cache successful validation
    if (data.valid && data.tier) {
      writeLicenseCache({
        valid: true,
        tier: data.tier,
        validated_at: new Date().toISOString(),
        api_key_prefix: apiKey.substring(0, 16) + "...",
      });
    }

    return data;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";

    // Network error: honor existing cache
    const cache = readLicenseCache();
    if (cache && cache.valid) {
      console.error(`[gitmem:license] Network error, using cached validation: ${message}`);
      return { valid: true, tier: cache.tier, message: "Using cached validation (offline)" };
    }

    return { valid: false, tier: null, message: `Network error: ${message}` };
  }
}

/**
 * Get the validation URL (for diagnostics/testing)
 */
export function getValidationUrl(): string {
  return VALIDATION_URL;
}

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
 *   - POST to hardcoded validation endpoint with api_key + install_id, or to
 *     GITMEM_LICENSE_URL's base when it is set (getLicenseCheckUrl)
 *   - Success: cache to ~/.gitmem/license-cache.json (72h TTL)
 *   - Failure: downgrade _tier to free, log warning
 *   - Network error: honor existing cache if valid, else downgrade
 *   - GITMEM_LICENSE_URL set but unusable: no request, no cache, invalid
 */

import * as fs from "fs";
import * as path from "path";
import { getGitmemDir, getInstallId } from "./gitmem-dir.js";
import { writePrivateFileSync } from "./private-file.js";

// The path the license check posts to, under the built-in URL or GITMEM_LICENSE_URL.
const VALIDATION_PATH = "/rest/v1/rpc/gitmem_validate_license";
// Hardcoded validation endpoint — calls RPC directly on our Supabase via PostgREST.
// Users only replace it to route the check through a gateway (GITMEM_LICENSE_URL).
const VALIDATION_URL = `https://cjptxyezuxdiinufgrrm.supabase.co${VALIDATION_PATH}`;
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
  /** The URL that gave this answer. Absent in a cache written before GITMEM_LICENSE_URL. */
  validation_url?: string;
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

/** OpenRouter's own base URL; `/embeddings`, `/chat/completions` and `/models` are added to it. */
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// One warning per process and per condition.
const warnedBaseUrl = new Set<string>();

function warnBaseUrlOnce(condition: string, message: string): void {
  if (warnedBaseUrl.has(condition)) return;
  warnedBaseUrl.add(condition);
  console.error(`[gitmem:license] ${message}`);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Read a base URL from the environment variable `name`.
 *
 * Environment only — never read from config.json or saved by `activate`, like
 * GITMEM_TABLE_PREFIX. Unset, empty or whitespace-only → undefined, so the
 * caller uses its default.
 *
 * Returns null (after one warning that never prints the value; `effect` says
 * what happens then) when the value is not an absolute http(s) URL or contains
 * a username, password, query or fragment. Callers must then make no request
 * with it: never fall back to their default. A plain-http base on a host that is
 * not loopback is returned, with one warning that `keyName` is sent unencrypted.
 */
function readBaseUrlFromEnv(name: string, effect: string, keyName: string): string | null | undefined {
  const trimmed = (process.env[name] ?? "").trim();
  if (!trimmed) return undefined;

  const unusable = (reason: string): null => {
    warnBaseUrlOnce(`${name}:unusable:${reason}`, `${name} is not usable (${reason}); ${effect}.`);
    return null;
  };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return unusable("not a URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return unusable("scheme must be http or https");
  }
  if (parsed.username || parsed.password) {
    return unusable("must not contain a username or password");
  }
  // The parser reports a lone trailing "?" or "#" as an empty query or fragment,
  // so the raw string is checked as well.
  if (parsed.search || parsed.hash || trimmed.includes("?") || trimmed.includes("#")) {
    return unusable("must not contain a query or fragment");
  }

  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    warnBaseUrlOnce(`${name}:cleartext`, `${name} uses http to a non-local host; ${keyName} is sent unencrypted.`);
  }

  return trimmed.replace(/\/+$/, "");
}

/**
 * Resolve the OpenRouter base URL from the OPENROUTER_BASE_URL environment variable
 * (readBaseUrlFromEnv). Unset or blank → the default.
 *
 * Returns null when the value is unusable. Callers must then make no OpenRouter
 * request: never fall back to openrouter.ai.
 */
export function getOpenRouterBaseUrl(): string | null {
  const base = readBaseUrlFromEnv(
    "OPENROUTER_BASE_URL",
    "OpenRouter calls are off until it is fixed",
    "the OpenRouter key",
  );
  return base === undefined ? DEFAULT_OPENROUTER_BASE_URL : base;
}

/**
 * Full URL for an OpenRouter endpoint, or null when the base URL is unusable.
 */
export function getOpenRouterUrl(endpoint: "embeddings" | "chat/completions" | "models"): string | null {
  const base = getOpenRouterBaseUrl();
  return base === null ? null : `${base}/${endpoint}`;
}

/**
 * URL the license check posts to.
 *
 * GITMEM_LICENSE_URL is a base URL, read like OPENROUTER_BASE_URL
 * (readBaseUrlFromEnv): when it is set, the check posts to
 * `<base>/rest/v1/rpc/gitmem_validate_license` with the same headers and body,
 * so a gateway that holds the license key can forward the check. Unset or
 * blank → the built-in URL.
 *
 * Returns null when the value is unusable: the check must then not be made, and
 * never falls back to the built-in URL. `deactivate` does not use this; it keeps
 * the built-in URL (getValidationUrl).
 */
export function getLicenseCheckUrl(): string | null {
  const base = readBaseUrlFromEnv(
    "GITMEM_LICENSE_URL",
    "no license check is made and the license counts as invalid until it is fixed",
    "the license key",
  );
  if (base === undefined) return VALIDATION_URL;
  return base === null ? null : `${base}${VALIDATION_PATH}`;
}

/**
 * Read cached license validation result
 */
function readLicenseCache(): LicenseCache | null {
  try {
    const cachePath = path.join(getGitmemDir(), "license-cache.json");
    if (!fs.existsSync(cachePath)) return null;

    const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as LicenseCache;

    // An answer counts only for the URL that gave it, so setting, changing or
    // unsetting GITMEM_LICENSE_URL never reuses another server's answer. A cache
    // with no validation_url predates the variable and came from the built-in URL.
    if ((raw.validation_url ?? VALIDATION_URL) !== getLicenseCheckUrl()) {
      console.error("[gitmem:license] Cache is from another license URL; not used");
      return null;
    }

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
    writePrivateFileSync(cachePath, JSON.stringify(result, null, 2));
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
 *
 * With GITMEM_LICENSE_URL set but unusable it makes no request and reads no
 * cache: the result is invalid, so the server drops to free and `activate` stops.
 */
export async function validateLicense(apiKey: string, installId: string): Promise<LicenseValidationResult> {
  const url = getLicenseCheckUrl();
  if (url === null) {
    return { valid: false, tier: null, message: "GITMEM_LICENSE_URL is not usable; no license check was made" };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(url, {
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
        validation_url: url,
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
 * Get the built-in validation URL (for diagnostics/testing). `deactivate` builds
 * its URL from it, so it never follows GITMEM_LICENSE_URL.
 */
export function getValidationUrl(): string {
  return VALIDATION_URL;
}

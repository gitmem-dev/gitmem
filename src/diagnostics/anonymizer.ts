/**
 * GitMem Anonymizer
 *
 * Strips PII from diagnostic data before it's collected.
 * Built-in to collector, not post-process.
 *
 * Anonymization rules:
 * - Supabase URL → https://*.supabase.co
 * - API keys → configured: true/false
 * - IP addresses → stripped
 * - Scar/session/decision content → counts only
 * - Error messages → URLs/keys stripped via regex
 * - Cache paths → normalized to ~/.gitmem/...
 * - Hostnames → excluded
 * - Platform/Node version → included
 *
 * Issue: OD-584
 */

/**
 * Regex patterns for sensitive data
 */
const PATTERNS = {
  // API keys (common formats like sk_test_xxx, sk_live_xxx, sk-xxx)
  API_KEY: /(?:sk|pk)[_-](?:test|live|or)?[_-]?[a-zA-Z0-9]{10,}/gi,

  // Bearer tokens
  BEARER_TOKEN: /Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*/gi,

  // JWT tokens
  JWT: /eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*/g,

  // Supabase URLs
  SUPABASE_URL: /https?:\/\/[a-z0-9-]+\.supabase\.co/gi,

  // Generic URLs with potential secrets
  URL_WITH_PARAMS: /https?:\/\/[^\s"']+\?[^\s"']*/gi,

  // IP addresses (IPv4)
  IPV4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,

  // IP addresses (IPv6)
  IPV6: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,

  // Email addresses
  EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,

  // File paths (home directory)
  HOME_PATH: /(?:\/Users\/[^\/\s]+|\/home\/[^\/\s]+|C:\\Users\\[^\\]+)/gi,

  // UUIDs (may be session/user IDs)
  UUID: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
};

/**
 * Anonymize a Supabase URL
 */
export function anonymizeSupabaseUrl(url: string | undefined): string {
  if (!url) return "not_configured";
  if (url.includes("supabase.co")) {
    return "https://*.supabase.co";
  }
  // Local or custom URL
  return "custom_url_configured";
}

/**
 * Check if an API key is configured (returns boolean, not the key)
 */
export function isApiKeyConfigured(key: string | undefined): boolean {
  return Boolean(key && key.length > 0);
}

/**
 * Anonymize a file path
 */
export function anonymizePath(filepath: string): string {
  if (!filepath) return "";

  // Replace home directory variations
  let result = filepath
    .replace(/\/Users\/[^\/]+/g, "~")
    .replace(/\/home\/[^\/]+/g, "~")
    .replace(/C:\\Users\\[^\\]+/gi, "~");

  // Normalize .gitmem paths
  if (result.includes(".gitmem") || result.includes(".cache/gitmem")) {
    const gitmemIndex = result.indexOf(".gitmem");
    const cacheIndex = result.indexOf(".cache/gitmem");
    const startIndex = gitmemIndex !== -1 ? gitmemIndex : cacheIndex;
    if (startIndex !== -1) {
      result = "~/" + result.slice(startIndex);
    }
  }

  return result;
}

/**
 * Anonymize an error message
 */
export function anonymizeError(error: Error | string): string {
  let message = typeof error === "string" ? error : error.message;

  // Strip API keys
  message = message.replace(PATTERNS.API_KEY, "[API_KEY]");
  message = message.replace(PATTERNS.BEARER_TOKEN, "Bearer [TOKEN]");
  message = message.replace(PATTERNS.JWT, "[JWT]");

  // Strip URLs with potential secrets
  message = message.replace(PATTERNS.SUPABASE_URL, "https://*.supabase.co");
  message = message.replace(PATTERNS.URL_WITH_PARAMS, "[URL_REDACTED]");

  // Strip IP addresses
  message = message.replace(PATTERNS.IPV4, "[IP]");
  message = message.replace(PATTERNS.IPV6, "[IP]");

  // Strip email addresses
  message = message.replace(PATTERNS.EMAIL, "[EMAIL]");

  // Strip home paths
  message = message.replace(PATTERNS.HOME_PATH, "~");

  return message;
}

/**
 * Anonymize arbitrary string content
 */
export function anonymizeString(content: string): string {
  if (!content) return "";

  let result = content;

  // Apply all anonymization patterns
  result = result.replace(PATTERNS.API_KEY, "[API_KEY]");
  result = result.replace(PATTERNS.BEARER_TOKEN, "Bearer [TOKEN]");
  result = result.replace(PATTERNS.JWT, "[JWT]");
  result = result.replace(PATTERNS.SUPABASE_URL, "https://*.supabase.co");
  result = result.replace(PATTERNS.IPV4, "[IP]");
  result = result.replace(PATTERNS.IPV6, "[IP]");
  result = result.replace(PATTERNS.EMAIL, "[EMAIL]");
  result = result.replace(PATTERNS.HOME_PATH, "~");

  return result;
}

/**
 * Anonymize a cache key (preserve structure, strip values)
 */
export function anonymizeCacheKey(key: string): string {
  // Cache keys are like: scar_search:abc123:project:5 or decisions:myproject:10
  // Keep the type, anonymize the middle parts, keep the last numeric part
  const parts = key.split(":");
  if (parts.length >= 3) {
    // Keep first and last, hash the middle
    return `${parts[0]}:[hash]:${parts.slice(2).join(":")}`;
  } else if (parts.length === 2) {
    // Two parts like decisions:myproject - anonymize second
    return `${parts[0]}:[hash]`;
  }
  return "[cache_key]";
}

/**
 * Safe environment info extraction
 */
export function getSafeEnvironmentInfo(): {
  platform: string;
  nodeVersion: string;
  arch: string;
} {
  return {
    platform: process.platform,
    nodeVersion: process.version,
    arch: process.arch,
  };
}

/**
 * Anonymize tool call parameters
 */
export function anonymizeToolParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!params) return {};

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    // Skip content fields entirely
    if (["description", "content", "message", "reflection", "rationale"].includes(key)) {
      result[key] = "[content_redacted]";
      continue;
    }

    // Anonymize string values
    if (typeof value === "string") {
      // Keep short identifiers, redact longer content
      if (value.length > 50) {
        result[key] = `[string:${value.length}chars]`;
      } else if (PATTERNS.API_KEY.test(value) || PATTERNS.EMAIL.test(value)) {
        result[key] = "[redacted]";
      } else {
        result[key] = value;
      }
    } else if (typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    } else if (Array.isArray(value)) {
      result[key] = `[array:${value.length}items]`;
    } else if (typeof value === "object" && value !== null) {
      result[key] = "[object]";
    } else {
      result[key] = "[unknown]";
    }
  }

  return result;
}

/**
 * Unit tests for anonymizer
 *
 * Issue: OD-584
 */

import { describe, it, expect } from "vitest";
import {
  anonymizeSupabaseUrl,
  anonymizePath,
  anonymizeError,
  anonymizeString,
  anonymizeCacheKey,
  anonymizeToolParams,
  isApiKeyConfigured,
  getSafeEnvironmentInfo,
} from "../../../src/diagnostics/anonymizer.js";

describe("anonymizeSupabaseUrl", () => {
  it("anonymizes supabase.co URLs", () => {
    expect(anonymizeSupabaseUrl("https://abc123.supabase.co")).toBe("https://*.supabase.co");
    expect(anonymizeSupabaseUrl("https://my-project.supabase.co")).toBe("https://*.supabase.co");
  });

  it("marks custom URLs as configured", () => {
    expect(anonymizeSupabaseUrl("http://localhost:54321")).toBe("custom_url_configured");
    expect(anonymizeSupabaseUrl("https://my-custom-db.example.com")).toBe("custom_url_configured");
  });

  it("handles undefined/empty", () => {
    expect(anonymizeSupabaseUrl(undefined)).toBe("not_configured");
    expect(anonymizeSupabaseUrl("")).toBe("not_configured");
  });
});

describe("anonymizePath", () => {
  it("replaces Unix home paths", () => {
    expect(anonymizePath("/Users/john/code/project")).toBe("~/code/project");
    expect(anonymizePath("/home/jane/.gitmem/cache")).toBe("~/.gitmem/cache");
  });

  it("replaces Windows home paths", () => {
    expect(anonymizePath("C:\\Users\\Admin\\Documents")).toBe("~\\Documents");
  });

  it("normalizes .gitmem paths", () => {
    expect(anonymizePath("/Users/test/.cache/gitmem/results")).toBe("~/.cache/gitmem/results");
    expect(anonymizePath("/home/user/.gitmem/learnings.json")).toBe("~/.gitmem/learnings.json");
  });

  it("handles empty paths", () => {
    expect(anonymizePath("")).toBe("");
  });
});

describe("anonymizeError", () => {
  it("strips API keys", () => {
    const error = "Error: Invalid API key sk_test_1234567890abcdefghij";
    expect(anonymizeError(error)).toBe("Error: Invalid API key [API_KEY]");
  });

  it("strips JWT tokens", () => {
    const error = "Token expired: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(anonymizeError(error)).toContain("[JWT]");
    expect(anonymizeError(error)).not.toContain("eyJ");
  });

  it("strips Supabase URLs", () => {
    const error = "Failed to connect to https://myproject.supabase.co/rest/v1";
    expect(anonymizeError(error)).toContain("https://*.supabase.co");
    expect(anonymizeError(error)).not.toContain("myproject");
  });

  it("strips IP addresses", () => {
    const error = "Connection refused: 192.168.1.100:5432";
    expect(anonymizeError(error)).toContain("[IP]");
    expect(anonymizeError(error)).not.toContain("192.168");
  });

  it("strips email addresses", () => {
    const error = "User not found: admin@example.com";
    expect(anonymizeError(error)).toContain("[EMAIL]");
    expect(anonymizeError(error)).not.toContain("admin@example");
  });

  it("handles Error objects", () => {
    const error = new Error("API key sk_live_abcdefghijklmnopqrst is invalid");
    expect(anonymizeError(error)).toContain("[API_KEY]");
  });
});

describe("anonymizeString", () => {
  it("applies all anonymization patterns", () => {
    const content = "User john@test.com connected from 10.0.0.1 with token sk_test_abc123def456ghi789";
    const result = anonymizeString(content);
    expect(result).toContain("[EMAIL]");
    expect(result).toContain("[IP]");
    expect(result).toContain("[API_KEY]");
    expect(result).not.toContain("john@test.com");
    expect(result).not.toContain("10.0.0.1");
  });
});

describe("anonymizeCacheKey", () => {
  it("preserves cache key structure with 4+ parts", () => {
    expect(anonymizeCacheKey("scar_search:abc123def:project:5")).toBe("scar_search:[hash]:project:5");
  });

  it("preserves cache key structure with 3 parts", () => {
    // decisions:myproject:10 -> decisions:[hash]:10
    expect(anonymizeCacheKey("decisions:myproject:10")).toBe("decisions:[hash]:10");
  });

  it("anonymizes 2-part keys", () => {
    expect(anonymizeCacheKey("type:value")).toBe("type:[hash]");
  });

  it("handles simple keys", () => {
    expect(anonymizeCacheKey("simple")).toBe("[cache_key]");
  });
});

describe("anonymizeToolParams", () => {
  it("redacts content fields", () => {
    const params = {
      tool: "recall",
      description: "This is sensitive content",
      plan: "short plan",
    };
    const result = anonymizeToolParams(params);
    expect(result.description).toBe("[content_redacted]");
    expect(result.tool).toBe("recall");
    expect(result.plan).toBe("short plan");
  });

  it("summarizes long strings", () => {
    const params = {
      plan: "a".repeat(100),
    };
    const result = anonymizeToolParams(params);
    expect(result.plan).toBe("[string:100chars]");
  });

  it("summarizes arrays", () => {
    const params = {
      items: [1, 2, 3, 4, 5],
    };
    const result = anonymizeToolParams(params);
    expect(result.items).toBe("[array:5items]");
  });

  it("preserves numbers and booleans", () => {
    const params = {
      count: 42,
      enabled: true,
    };
    const result = anonymizeToolParams(params);
    expect(result.count).toBe(42);
    expect(result.enabled).toBe(true);
  });

  it("handles undefined", () => {
    expect(anonymizeToolParams(undefined)).toEqual({});
  });
});

describe("isApiKeyConfigured", () => {
  it("returns true for non-empty keys", () => {
    expect(isApiKeyConfigured("sk_test_123")).toBe(true);
    expect(isApiKeyConfigured("any-value")).toBe(true);
  });

  it("returns false for empty/undefined", () => {
    expect(isApiKeyConfigured(undefined)).toBe(false);
    expect(isApiKeyConfigured("")).toBe(false);
  });
});

describe("getSafeEnvironmentInfo", () => {
  it("returns platform info", () => {
    const info = getSafeEnvironmentInfo();
    expect(info.platform).toBeDefined();
    expect(info.nodeVersion).toBeDefined();
    expect(info.arch).toBeDefined();
  });

  it("does not include hostname or username", () => {
    const info = getSafeEnvironmentInfo();
    expect(info).not.toHaveProperty("hostname");
    expect(info).not.toHaveProperty("username");
    expect(info).not.toHaveProperty("home");
  });
});

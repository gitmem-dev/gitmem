/**
 * Unit tests for license key validation
 *
 * Tests the license module in isolation:
 * - getLicenseKey() reads from env and config
 * - getProConfig() reads credentials with env override
 * - getCachedLicenseTier() reads/validates cache TTL
 * - clearLicenseCache() removes cache file
 * - Re-activation safety (config not destroyed)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TEST_DIR = path.join(os.tmpdir(), `gitmem-license-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

vi.mock("../../../src/services/gitmem-dir.js", () => ({
  getGitmemDir: () => TEST_DIR,
  getInstallId: () => "test-install-id",
}));

import {
  getLicenseKey,
  getProConfig,
  getCachedLicenseTier,
  clearLicenseCache,
  validateLicense,
} from "../../../src/services/license.js";

describe("license service", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    delete process.env.GITMEM_API_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("getLicenseKey", () => {
    it("returns null when no key configured", () => {
      expect(getLicenseKey()).toBeNull();
    });

    it("reads from GITMEM_API_KEY env var", () => {
      process.env.GITMEM_API_KEY = "gitmem_pro_test123";
      expect(getLicenseKey()).toBe("gitmem_pro_test123");
    });

    it("reads from config.json api_key field", () => {
      const configPath = path.join(TEST_DIR, "config.json");
      fs.writeFileSync(configPath, JSON.stringify({ api_key: "gitmem_pro_fromconfig" }));
      expect(getLicenseKey()).toBe("gitmem_pro_fromconfig");
    });

    it("env var takes priority over config.json", () => {
      process.env.GITMEM_API_KEY = "gitmem_pro_fromenv";
      const configPath = path.join(TEST_DIR, "config.json");
      fs.writeFileSync(configPath, JSON.stringify({ api_key: "gitmem_pro_fromconfig" }));
      expect(getLicenseKey()).toBe("gitmem_pro_fromenv");
    });
  });

  describe("getProConfig", () => {
    it("returns empty strings when nothing configured", () => {
      const config = getProConfig();
      expect(config.supabaseUrl).toBe("");
      expect(config.supabaseKey).toBe("");
      expect(config.openrouterKey).toBe("");
    });

    it("reads from config.json", () => {
      const configPath = path.join(TEST_DIR, "config.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          supabase_url: "https://test.supabase.co",
          supabase_key: "eyJtest",
          openrouter_key: "sk-or-test",
        })
      );
      const config = getProConfig();
      expect(config.supabaseUrl).toBe("https://test.supabase.co");
      expect(config.supabaseKey).toBe("eyJtest");
      expect(config.openrouterKey).toBe("sk-or-test");
    });

    it("env vars override config.json", () => {
      process.env.SUPABASE_URL = "https://env.supabase.co";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJenv";
      process.env.OPENROUTER_API_KEY = "sk-or-env";

      const configPath = path.join(TEST_DIR, "config.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          supabase_url: "https://config.supabase.co",
          supabase_key: "eyJconfig",
          openrouter_key: "sk-or-config",
        })
      );

      const config = getProConfig();
      expect(config.supabaseUrl).toBe("https://env.supabase.co");
      expect(config.supabaseKey).toBe("eyJenv");
      expect(config.openrouterKey).toBe("sk-or-env");
    });

    it("partial env var override (only some fields from env)", () => {
      process.env.SUPABASE_URL = "https://env.supabase.co";

      const configPath = path.join(TEST_DIR, "config.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          supabase_url: "https://config.supabase.co",
          supabase_key: "eyJconfig",
        })
      );

      const config = getProConfig();
      expect(config.supabaseUrl).toBe("https://env.supabase.co");
      expect(config.supabaseKey).toBe("eyJconfig");
    });
  });

  describe("getCachedLicenseTier", () => {
    it("returns null when no cache exists", () => {
      expect(getCachedLicenseTier()).toBeNull();
    });

    it("returns cached tier when valid", () => {
      const cachePath = path.join(TEST_DIR, "license-cache.json");
      fs.writeFileSync(
        cachePath,
        JSON.stringify({
          valid: true,
          tier: "pro",
          validated_at: new Date().toISOString(),
          api_key_prefix: "gitmem_pro_test...",
        })
      );
      expect(getCachedLicenseTier()).toBe("pro");
    });

    it("returns null when cache expired (72h+)", () => {
      const cachePath = path.join(TEST_DIR, "license-cache.json");
      const expiredDate = new Date(Date.now() - 73 * 60 * 60 * 1000);
      fs.writeFileSync(
        cachePath,
        JSON.stringify({
          valid: true,
          tier: "pro",
          validated_at: expiredDate.toISOString(),
          api_key_prefix: "gitmem_pro_test...",
        })
      );
      expect(getCachedLicenseTier()).toBeNull();
    });

    it("returns null when cache says invalid", () => {
      const cachePath = path.join(TEST_DIR, "license-cache.json");
      fs.writeFileSync(
        cachePath,
        JSON.stringify({
          valid: false,
          tier: "pro",
          validated_at: new Date().toISOString(),
          api_key_prefix: "gitmem_pro_test...",
        })
      );
      expect(getCachedLicenseTier()).toBeNull();
    });
  });

  describe("clearLicenseCache", () => {
    it("removes cache file", () => {
      const cachePath = path.join(TEST_DIR, "license-cache.json");
      fs.writeFileSync(cachePath, JSON.stringify({ valid: true, tier: "pro" }));
      expect(fs.existsSync(cachePath)).toBe(true);

      clearLicenseCache();
      expect(fs.existsSync(cachePath)).toBe(false);
    });

    it("does not throw when cache doesn't exist", () => {
      expect(() => clearLicenseCache()).not.toThrow();
    });
  });

  describe("re-activation safety", () => {
    it("config.json preserves non-credential fields during overwrite", () => {
      const configPath = path.join(TEST_DIR, "config.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          project: "my-project",
          install_id: "device-abc",
          feedback_enabled: true,
          api_key: "gitmem_pro_old",
          supabase_url: "https://old.supabase.co",
          supabase_key: "eyJold",
          openrouter_key: "sk-or-old",
        })
      );

      // Simulate what activate does: read, modify, write
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      raw.api_key = "gitmem_pro_new";
      raw.supabase_url = "https://new.supabase.co";
      raw.supabase_key = "eyJnew";
      raw.openrouter_key = "sk-or-new";
      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));

      const result = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(result.project).toBe("my-project");
      expect(result.install_id).toBe("device-abc");
      expect(result.feedback_enabled).toBe(true);
      expect(result.api_key).toBe("gitmem_pro_new");
      expect(result.supabase_url).toBe("https://new.supabase.co");
    });

    it("same URL re-activation preserves data reference", () => {
      const configPath = path.join(TEST_DIR, "config.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          project: "my-project",
          install_id: "device-abc",
          api_key: "gitmem_pro_key1",
          supabase_url: "https://same.supabase.co",
          supabase_key: "eyJsame",
        })
      );

      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      raw.api_key = "gitmem_pro_key2";
      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));

      const result = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(result.supabase_url).toBe("https://same.supabase.co");
      expect(result.api_key).toBe("gitmem_pro_key2");
    });
  });

  describe("credentials supplied only by the environment (activate --no-save-keys)", () => {
    it("reads all four credentials from the environment when config.json holds none (AC-30.5)", () => {
      fs.writeFileSync(path.join(TEST_DIR, "config.json"), JSON.stringify({ project: "p", install_id: "i" }));
      process.env.GITMEM_API_KEY = "gitmem_dev_fromenv";
      process.env.SUPABASE_URL = "https://env.supabase.co";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJenv";
      process.env.OPENROUTER_API_KEY = "sk-or-env";

      expect(getLicenseKey()).toBe("gitmem_dev_fromenv");
      expect(getProConfig()).toEqual({
        supabaseUrl: "https://env.supabase.co",
        supabaseKey: "eyJenv",
        openrouterKey: "sk-or-env",
      });
    });
  });

  describe("license-cache.json", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it.skipIf(process.platform === "win32")("is written owner-only (AC-17.1)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify([{ valid: true, tier: "pro", message: "ok" }]), { status: 200 })),
      );

      const result = await validateLicense("gitmem_dev_test", "install-1");

      expect(result.valid).toBe(true);
      const cachePath = path.join(TEST_DIR, "license-cache.json");
      expect(fs.statSync(cachePath).mode & 0o777).toBe(0o600);
    });
  });

  describe("OPENROUTER_BASE_URL", () => {
    // The warnings are once per process, so each case loads a fresh copy of the module.
    type LicenseModule = typeof import("../../../src/services/license.js");
    let mod: LicenseModule;
    let stderr: ReturnType<typeof vi.spyOn>;

    const warnings = (): string[] =>
      stderr.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes("OPENROUTER_BASE_URL"));

    beforeEach(async () => {
      delete process.env.OPENROUTER_BASE_URL;
      vi.resetModules();
      stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      mod = await import("../../../src/services/license.js");
    });

    afterEach(() => {
      delete process.env.OPENROUTER_BASE_URL;
      stderr.mockRestore();
    });

    it("returns the default when unset (AC-1.1)", () => {
      expect(mod.getOpenRouterBaseUrl()).toBe("https://openrouter.ai/api/v1");
    });

    it("trims whitespace and trailing slashes (AC-1.2)", () => {
      process.env.OPENROUTER_BASE_URL = " https://gw.example/or/v1/ ";
      expect(mod.getOpenRouterBaseUrl()).toBe("https://gw.example/or/v1");
    });

    it("accepts a loopback http base without a warning (AC-1.3)", () => {
      process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:8080/api/v1";
      expect(mod.getOpenRouterBaseUrl()).toBe("http://127.0.0.1:8080/api/v1");
      expect(warnings()).toEqual([]);
    });

    it("treats empty and blank values as unset, with no warning (AC-1.4, AC-2.5)", () => {
      for (const value of ["", " ", "   "]) {
        process.env.OPENROUTER_BASE_URL = value;
        expect(mod.getOpenRouterBaseUrl()).toBe("https://openrouter.ai/api/v1");
      }
      expect(warnings()).toEqual([]);
    });

    it("does not read the base URL from config.json (AC-1.4)", () => {
      fs.writeFileSync(
        path.join(TEST_DIR, "config.json"),
        JSON.stringify({ openrouter_base_url: "https://gw.example/v1" }),
      );
      expect(mod.getOpenRouterBaseUrl()).toBe("https://openrouter.ai/api/v1");
    });

    it("builds the three endpoint URLs the code used before (AC-1.5)", () => {
      expect(mod.getOpenRouterUrl("embeddings")).toBe("https://openrouter.ai/api/v1/embeddings");
      expect(mod.getOpenRouterUrl("chat/completions")).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(mod.getOpenRouterUrl("models")).toBe("https://openrouter.ai/api/v1/models");
    });

    it("returns null for an unusable base, and no endpoint URL", () => {
      process.env.OPENROUTER_BASE_URL = "ftp://gw.example/v1";
      expect(mod.getOpenRouterUrl("embeddings")).toBeNull();
    });

    it("refuses a wrong scheme with one warning that never prints the value (AC-2.1)", () => {
      process.env.OPENROUTER_BASE_URL = "ftp://gw.example/v1";
      expect(mod.getOpenRouterBaseUrl()).toBeNull();
      expect(mod.getOpenRouterBaseUrl()).toBeNull();

      const w = warnings();
      expect(w).toHaveLength(1);
      expect(w[0]).toContain("http or https");
      expect(w[0]).not.toContain("gw.example");
    });

    it("refuses a username or password without printing it (AC-2.2)", () => {
      process.env.OPENROUTER_BASE_URL = "https://user:s3cret@gw.example/v1";
      expect(mod.getOpenRouterBaseUrl()).toBeNull();

      const w = warnings();
      expect(w).toHaveLength(1);
      expect(w[0]).toContain("username or password");
      expect(w[0]).not.toContain("s3cret");
    });

    it("refuses a value that is not a URL (AC-2.3)", () => {
      process.env.OPENROUTER_BASE_URL = "not a url";
      expect(mod.getOpenRouterBaseUrl()).toBeNull();
      expect(warnings()[0]).toContain("not a URL");
    });

    it.each([
      "https://gw.example/v1?key=abc123",
      "https://gw.example/v1#x",
      "https://gw.example/v1?",
      "https://gw.example/v1#",
    ])("refuses a query or fragment, a lone ? or # included: %s (AC-2.4)", (value) => {
      process.env.OPENROUTER_BASE_URL = value;
      expect(mod.getOpenRouterBaseUrl()).toBeNull();

      const w = warnings();
      expect(w).toHaveLength(1);
      expect(w[0]).toContain("query or fragment");
      expect(w[0]).not.toContain("abc123");
    });

    it("accepts a plain-http base on a non-local host with one cleartext warning (AC-2.6)", () => {
      process.env.OPENROUTER_BASE_URL = "http://gw.internal:8080/v1";
      expect(mod.getOpenRouterBaseUrl()).toBe("http://gw.internal:8080/v1");
      expect(mod.getOpenRouterBaseUrl()).toBe("http://gw.internal:8080/v1");

      const w = warnings();
      expect(w).toHaveLength(1);
      expect(w[0]).toContain("unencrypted");
      expect(w[0]).not.toContain("gw.internal");
    });

    it.each([
      "http://localhost:8080/v1",
      "http://127.0.0.2/v1",
      "http://[::1]:8080/v1",
      "https://gw.internal/v1",
    ])("does not warn for %s (AC-2.6)", (value) => {
      process.env.OPENROUTER_BASE_URL = value;
      expect(mod.getOpenRouterBaseUrl()).toBe(value);
      expect(warnings()).toEqual([]);
    });
  });
});

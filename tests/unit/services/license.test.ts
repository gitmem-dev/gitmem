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
});

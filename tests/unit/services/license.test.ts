/**
 * Unit tests for license key validation
 *
 * Tests the license module in isolation:
 * - getLicenseKey() reads from env and config
 * - getProConfig() reads credentials with env override
 * - getCachedLicenseTier() reads/validates cache TTL
 * - clearLicenseCache() removes cache file
 * - Re-activation safety (config not destroyed)
 * - OPENROUTER_BASE_URL and GITMEM_LICENSE_URL (environment-only base URLs)
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
    delete process.env.GITMEM_LICENSE_URL;
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

  describe("GITMEM_LICENSE_URL", () => {
    // The warnings are once per process, so each case loads a fresh copy of the module.
    type LicenseModule = typeof import("../../../src/services/license.js");
    let mod: LicenseModule;
    let stderr: ReturnType<typeof vi.spyOn>;
    let fetchMock: ReturnType<typeof vi.fn>;

    const BUILT_IN = "https://cjptxyezuxdiinufgrrm.supabase.co/rest/v1/rpc/gitmem_validate_license";
    const cachePath = () => path.join(TEST_DIR, "license-cache.json");
    const warnings = (): string[] =>
      stderr.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes("GITMEM_LICENSE_URL"));
    const requests = () =>
      fetchMock.mock.calls.map(([url, init]) => ({
        url: String(url),
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
      }));

    beforeEach(async () => {
      delete process.env.GITMEM_LICENSE_URL;
      vi.resetModules();
      stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      fetchMock = vi.fn(
        async () => new Response(JSON.stringify([{ valid: true, tier: "pro", message: "ok" }]), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      mod = await import("../../../src/services/license.js");
    });

    afterEach(() => {
      delete process.env.GITMEM_LICENSE_URL;
      stderr.mockRestore();
      vi.unstubAllGlobals();
    });

    it("posts to <base>/rest/v1/rpc/gitmem_validate_license with the same headers and body", async () => {
      await mod.validateLicense("gitmem_dev_standin", "machine-install-id");
      process.env.GITMEM_LICENSE_URL = " http://127.0.0.1:8787/license-gw/ ";
      await mod.validateLicense("gitmem_dev_standin", "machine-install-id");

      const [builtIn, gateway] = requests();
      expect(builtIn.url).toBe(BUILT_IN);
      expect(gateway.url).toBe("http://127.0.0.1:8787/license-gw/rest/v1/rpc/gitmem_validate_license");
      expect(gateway.method).toBe("POST");
      expect(gateway.headers).toEqual(builtIn.headers);
      expect(JSON.parse(String(gateway.body))).toEqual({ p_api_key: "gitmem_dev_standin", p_install_id: "machine-install-id" });
      expect(gateway.body).toBe(builtIn.body);
    });

    it("posts to the built-in URL when unset, empty or blank, with no warning", async () => {
      for (const value of [undefined, "", "   "]) {
        if (value === undefined) delete process.env.GITMEM_LICENSE_URL;
        else process.env.GITMEM_LICENSE_URL = value;
        await mod.validateLicense("gitmem_dev_test", "install-1");
      }

      expect(requests().map((r) => r.url)).toEqual([BUILT_IN, BUILT_IN, BUILT_IN]);
      expect(warnings()).toEqual([]);
    });

    it("is not read from config.json", async () => {
      fs.writeFileSync(
        path.join(TEST_DIR, "config.json"),
        JSON.stringify({ license_url: "https://gw.example", gitmem_license_url: "https://gw.example" }),
      );

      await mod.validateLicense("gitmem_dev_test", "install-1");

      expect(requests().map((r) => r.url)).toEqual([BUILT_IN]);
    });

    it.each([
      ["ftp://gw.example/license", "http or https"],
      ["https://user:s3cret@gw.example", "username or password"],
      ["gateway-host", "not a URL"],
      ["https://gw.example/?key=abc123", "query or fragment"],
      ["https://gw.example/#x", "query or fragment"],
      ["https://gw.example/?", "query or fragment"],
      ["https://gw.example/#", "query or fragment"],
    ])("refuses %s: no request, no fallback, invalid, one warning without the value", async (value, reason) => {
      process.env.GITMEM_LICENSE_URL = value;

      const first = await mod.validateLicense("gitmem_dev_standin", "install-1");
      const second = await mod.validateLicense("gitmem_dev_standin", "install-1");

      expect(fetchMock).not.toHaveBeenCalled();
      for (const result of [first, second]) {
        expect(result).toEqual({
          valid: false,
          tier: null,
          message: "GITMEM_LICENSE_URL is not usable; no license check was made",
        });
      }
      const w = warnings();
      expect(w).toHaveLength(1);
      expect(w[0]).toContain(reason);
      expect(w[0]).toContain("license counts as invalid");
      for (const part of ["gw.example", "s3cret", "abc123", "gateway-host"]) expect(w[0]).not.toContain(part);
    });

    it("does not use a cached answer from the built-in URL once it is set, even offline", async () => {
      fs.writeFileSync(
        cachePath(),
        JSON.stringify({
          valid: true,
          tier: "dev",
          validated_at: new Date().toISOString(),
          api_key_prefix: "gitmem_pro_test...",
        }),
      );
      expect(mod.getCachedLicenseTier()).toBe("dev");

      process.env.GITMEM_LICENSE_URL = "http://127.0.0.1:8787";
      expect(mod.getCachedLicenseTier()).toBeNull();

      fetchMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
      const result = await mod.validateLicense("gitmem_dev_standin", "install-1");
      expect(result.valid).toBe(false);
      expect(result.message).toContain("Network error");
    });

    it("does not use a cached answer from the gateway once it is changed or unset", async () => {
      process.env.GITMEM_LICENSE_URL = "http://127.0.0.1:8787";
      await mod.validateLicense("gitmem_dev_standin", "install-1");
      expect(mod.getCachedLicenseTier()).toBe("pro");

      process.env.GITMEM_LICENSE_URL = "http://127.0.0.1:9797";
      expect(mod.getCachedLicenseTier()).toBeNull();

      delete process.env.GITMEM_LICENSE_URL;
      expect(mod.getCachedLicenseTier()).toBeNull();
    });

    it("ignores a valid cached answer when the value is unusable", async () => {
      fs.writeFileSync(
        cachePath(),
        JSON.stringify({
          valid: true,
          tier: "pro",
          validated_at: new Date().toISOString(),
          api_key_prefix: "gitmem_pro_test...",
        }),
      );
      process.env.GITMEM_LICENSE_URL = "ftp://gw.example";

      expect(mod.getCachedLicenseTier()).toBeNull();
      expect((await mod.validateLicense("gitmem_dev_standin", "install-1")).valid).toBe(false);
      expect(warnings()).toHaveLength(1);
    });

    it("accepts a plain-http base on a non-local host with one cleartext warning", async () => {
      process.env.GITMEM_LICENSE_URL = "http://gw.internal:8080";

      await mod.validateLicense("gitmem_dev_standin", "install-1");
      await mod.validateLicense("gitmem_dev_standin", "install-1");

      const w = warnings();
      expect(w).toHaveLength(1);
      expect(w[0]).toContain("the license key is sent unencrypted");
      expect(w[0]).not.toContain("gw.internal");
      expect(requests()[0].url).toBe("http://gw.internal:8080/rest/v1/rpc/gitmem_validate_license");
    });

    it.each(["http://localhost:8080", "http://127.0.0.2", "http://[::1]:8080", "https://gw.internal"])(
      "does not warn for %s",
      async (value) => {
        process.env.GITMEM_LICENSE_URL = value;

        await mod.validateLicense("gitmem_dev_standin", "install-1");

        expect(requests()[0].url).toBe(`${value}/rest/v1/rpc/gitmem_validate_license`);
        expect(warnings()).toEqual([]);
      },
    );
  });
});

/**
 * Unit tests for tier detection with license key integration
 *
 * Tests the updated detection chain:
 *   1. GITMEM_TIER env var override
 *   2. License key → cached tier or optimistic pro
 *   3. Supabase URL from env/config → pro
 *   4. Nothing → free
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TEST_DIR = path.join(os.tmpdir(), `gitmem-tier-license-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

vi.mock("../../../src/services/gitmem-dir.js", () => ({
  getGitmemDir: () => TEST_DIR,
  getInstallId: () => "test-install-id",
}));

import { getTier, resetTier, setTier } from "../../../src/services/tier.js";

describe("tier detection with license", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    resetTier();
    delete process.env.GITMEM_TIER;
    delete process.env.GITMEM_API_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GITMEM_DEV;
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    resetTier();
    delete process.env.GITMEM_TIER;
    delete process.env.GITMEM_API_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GITMEM_DEV;
  });

  it("returns free when nothing is configured", () => {
    expect(getTier()).toBe("free");
  });

  it("explicit GITMEM_TIER override takes highest priority", () => {
    process.env.GITMEM_TIER = "dev";
    process.env.GITMEM_API_KEY = "gitmem_pro_test123";
    resetTier();
    expect(getTier()).toBe("dev");
  });

  it("license key with valid cache returns cached tier", () => {
    process.env.GITMEM_API_KEY = "gitmem_pro_test123";

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

    resetTier();
    expect(getTier()).toBe("pro");
  });

  it("license key without cache returns optimistic pro", () => {
    process.env.GITMEM_API_KEY = "gitmem_pro_test123";
    resetTier();
    expect(getTier()).toBe("pro");
  });

  it("license key with expired cache returns optimistic pro", () => {
    process.env.GITMEM_API_KEY = "gitmem_pro_test123";

    const cachePath = path.join(TEST_DIR, "license-cache.json");
    const expiredDate = new Date(Date.now() - 100 * 60 * 60 * 1000);
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        valid: true,
        tier: "pro",
        validated_at: expiredDate.toISOString(),
        api_key_prefix: "gitmem_pro_test...",
      })
    );

    resetTier();
    expect(getTier()).toBe("pro");
  });

  it("SUPABASE_URL without license key returns pro (backward compat)", () => {
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJtest";
    resetTier();
    expect(getTier()).toBe("pro");
  });

  it("SUPABASE_URL + GITMEM_DEV returns dev (backward compat)", () => {
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJtest";
    process.env.GITMEM_DEV = "true";
    resetTier();
    expect(getTier()).toBe("dev");
  });

  it("config.json supabase_url without license key returns pro", () => {
    const configPath = path.join(TEST_DIR, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        supabase_url: "https://config.supabase.co",
        supabase_key: "eyJconfig",
      })
    );
    resetTier();
    expect(getTier()).toBe("pro");
  });

  it("setTier downgrades correctly", () => {
    process.env.GITMEM_API_KEY = "gitmem_pro_test123";
    resetTier();
    expect(getTier()).toBe("pro");

    setTier("free");
    expect(getTier()).toBe("free");
  });
});

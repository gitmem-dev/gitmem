/**
 * Unit tests for deactivate command
 *
 * Verifies:
 * - Pro credentials (including database_url) are removed from config.json
 * - config.json is left owner-only (0600) and an older open file is tightened
 * - Non-credential fields are preserved (project, install_id, feedback_enabled)
 * - License cache is cleared
 * - No error when already deactivated
 * - The device is released on the built-in license server, whatever GITMEM_LICENSE_URL says
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TEST_DIR = path.join(os.tmpdir(), `gitmem-deactivate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

vi.mock("../../../src/services/gitmem-dir.js", () => ({
  getGitmemDir: () => TEST_DIR,
  getInstallId: () => "test-install-id",
}));

import { main } from "../../../src/commands/deactivate.js";

describe("deactivate command", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    // Never reach the real deactivation endpoint: any config with an api_key and
    // an install id makes deactivate call it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ success: true, message: "Device removed" }]), { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("releases the device on the built-in license server even with GITMEM_LICENSE_URL set", async () => {
    // The deactivation URL is fixed when the module loads, so load it with the variable set.
    vi.stubEnv("GITMEM_LICENSE_URL", "http://127.0.0.1:8787/license-gw");
    vi.resetModules();
    const fresh = await import("../../../src/commands/deactivate.js");
    fs.writeFileSync(path.join(TEST_DIR, "config.json"), JSON.stringify({ api_key: "gitmem_pro_abc123" }));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await fresh.main([]);

    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual(["https://cjptxyezuxdiinufgrrm.supabase.co/rest/v1/rpc/gitmem_deactivate_device"]);
  });

  it.skipIf(process.platform === "win32")("tightens a 0644 config.json and says so (AC-15.1)", async () => {
    const configPath = path.join(TEST_DIR, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        api_key: "gitmem_pro_abc123",
        supabase_url: "https://test.supabase.co",
        supabase_key: "eyJtest",
        openrouter_key: "sk-or-test",
        database_url: "postgresql://postgres:pw@db.test.supabase.co:5432/postgres",
      })
    );
    fs.chmodSync(configPath, 0o644);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await main([]);

    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    const out = log.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(out).toContain("Restricted");
    expect(out).toContain("(was 0644)");
  });

  it("removes database_url and keeps the non-credential fields (AC-18.1)", async () => {
    const configPath = path.join(TEST_DIR, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        project: "my-project",
        install_id: "device-xyz",
        feedback_enabled: true,
        api_key: "gitmem_pro_abc123",
        supabase_url: "https://test.supabase.co",
        supabase_key: "eyJtest",
        openrouter_key: "sk-or-test",
        database_url: "postgresql://postgres:pw@db.test.supabase.co:5432/postgres",
      })
    );

    await main([]);

    const result = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(result).not.toHaveProperty("database_url");
    expect(result.project).toBe("my-project");
    expect(result.install_id).toBe("device-xyz");
    expect(result.feedback_enabled).toBe(true);
  });

  it("removes Pro credentials but preserves other config", async () => {
    const configPath = path.join(TEST_DIR, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        project: "my-project",
        install_id: "device-xyz",
        feedback_enabled: true,
        api_key: "gitmem_pro_abc123",
        supabase_url: "https://test.supabase.co",
        supabase_key: "eyJtest",
        openrouter_key: "sk-or-test",
      })
    );

    const cachePath = path.join(TEST_DIR, "license-cache.json");
    fs.writeFileSync(cachePath, JSON.stringify({ valid: true, tier: "pro" }));

    await main([]);

    const result = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    // Preserved
    expect(result.project).toBe("my-project");
    expect(result.install_id).toBe("device-xyz");
    expect(result.feedback_enabled).toBe(true);

    // Removed
    expect(result.api_key).toBeUndefined();
    expect(result.supabase_url).toBeUndefined();
    expect(result.supabase_key).toBeUndefined();
    expect(result.openrouter_key).toBeUndefined();
    expect(result.database_url).toBeUndefined();

    // Cache cleared
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it("handles missing config.json gracefully", async () => {
    await expect(main([])).resolves.toBeUndefined();
  });

  it("handles already-deactivated config (no api_key)", async () => {
    const configPath = path.join(TEST_DIR, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        project: "my-project",
        install_id: "device-xyz",
      })
    );

    await main([]);

    const result = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(result.project).toBe("my-project");
    expect(result.install_id).toBe("device-xyz");
  });
});

/**
 * Unit tests for deactivate command
 *
 * Verifies:
 * - Pro credentials are removed from config.json
 * - Non-credential fields are preserved (project, install_id, feedback_enabled)
 * - License cache is cleared
 * - No error when already deactivated
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
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
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

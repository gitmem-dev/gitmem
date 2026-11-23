/**
 * Unit tests for deactivate command
 *
 * Verifies:
 * - Pro credentials (including database_url) are removed from config.json
 * - config.json is left owner-only (0600) and an older open file is tightened
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

// Pass-through spy, so a test can see which writer wrote config.json.
vi.mock("../../../src/services/private-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/services/private-file.js")>();
  return { ...actual, writePrivateFileSync: vi.fn(actual.writePrivateFileSync) };
});

import { main } from "../../../src/commands/deactivate.js";
import { getLicenseKey } from "../../../src/services/license.js";
import { writePrivateFileSync } from "../../../src/services/private-file.js";

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
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
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

/**
 * deactivate --keys-only: the saved credentials and the license cache go, every
 * other field stays, no request is made (the device stays registered), and only
 * key names are printed. Any other argument is refused before anything happens.
 */
describe("deactivate --keys-only", () => {
  const configPath = path.join(TEST_DIR, "config.json");
  const cachePath = path.join(TEST_DIR, "license-cache.json");
  const KEYS = {
    api_key: "gitmem_pro_keysonly_test",
    supabase_url: "https://keysonly-test.supabase.co",
    supabase_key: "eyJ-keysonly-service-role",
    openrouter_key: "sk-or-keysonly-test",
    database_url: "postgresql://postgres:keysonly-pw@db.keysonly.test:5432/postgres",
  };
  const OTHER = {
    project: "my-project",
    install_id: "device-xyz",
    feedback_enabled: true,
    a_later_setting: { nested: [1, 2] },
  };
  let out: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    vi.stubEnv("GITMEM_API_KEY", undefined);
    // Answers like the real endpoint, so a request would succeed if one were made.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ success: true, message: "Device removed" }]), { status: 200 })),
    );
    out = "";
    const capture = (...a: unknown[]) => {
      out += a.map(String).join(" ") + "\n";
    };
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("removes the five keys, keeps every other field as it was, deletes the cache and makes no request (AC-U3.1)", async () => {
    // Interleaved, written the way activate writes the file.
    fs.writeFileSync(
      configPath,
      JSON.stringify({ project: OTHER.project, ...KEYS, install_id: OTHER.install_id, feedback_enabled: true,
        a_later_setting: OTHER.a_later_setting }, null, 2),
    );
    fs.writeFileSync(cachePath, JSON.stringify({ valid: true, tier: "pro", api_key_prefix: "gitmem_pro_keyso..." }));

    await main(["--keys-only"]);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.readFileSync(configPath, "utf-8")).toBe(JSON.stringify(OTHER, null, 2));
    expect(fs.existsSync(cachePath)).toBe(false);
    expect(out).toContain("this device stays registered");
  });

  it("names the keys it removed and prints no value", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ ...OTHER, api_key: KEYS.api_key, database_url: KEYS.database_url }));

    await main(["--keys-only"]);

    expect(out).toContain(`Removed api_key, database_url from ${configPath}`);
    for (const value of Object.values(KEYS)) expect(out).not.toContain(value);
  });

  it("writes config.json through the owner-only writer", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ ...OTHER, ...KEYS }));

    await main(["--keys-only"]);

    expect(vi.mocked(writePrivateFileSync).mock.calls.map((c) => c[0])).toEqual([configPath]);
  });

  it.skipIf(process.platform === "win32")("leaves config.json at 0600 and says when it tightened it", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ ...OTHER, ...KEYS }));
    fs.chmodSync(configPath, 0o644);

    await main(["--keys-only"]);

    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(out).toContain("(was 0644)");
  });

  it("afterwards a license-key read finds none in the file and takes GITMEM_API_KEY", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ ...OTHER, ...KEYS }));

    await main(["--keys-only"]);

    expect(getLicenseKey()).toBeNull();
    vi.stubEnv("GITMEM_API_KEY", "gitmem_dev_from_env_test");
    expect(getLicenseKey()).toBe("gitmem_dev_from_env_test");
  });

  it("leaves a file with none of the keys untouched, says so and exits 0; the same with no config.json", async () => {
    const text = JSON.stringify(OTHER); // compact, so a rewrite would show
    fs.writeFileSync(configPath, text);

    await main(["--keys-only"]);

    expect(fs.readFileSync(configPath, "utf-8")).toBe(text);
    expect(out).toContain(`No saved keys in ${configPath}`);

    fs.rmSync(configPath);
    await main(["--keys-only"]);

    expect(fs.existsSync(configPath)).toBe(false);
    expect(out).toContain("No config.json found");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("without --keys-only, still releases the device", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ ...OTHER, ...KEYS }));

    await main([]);

    expect(vi.mocked(fetch).mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining("/rest/v1/rpc/gitmem_deactivate_device"),
    ]);
  });

  it.each([
    { label: "a misspelt --keys-only", args: ["--key-only"] },
    { label: "--keys-only with another option", args: ["--keys-only", "--force"] },
    { label: "a license key given as an argument", args: [KEYS.api_key] },
  ])("refuses $label with exit 1, and changes and sends nothing", async ({ args }) => {
    const text = JSON.stringify({ ...OTHER, ...KEYS });
    fs.writeFileSync(configPath, text);
    fs.writeFileSync(cachePath, "{}");

    await expect(main(args)).rejects.toThrow("process.exit called");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.readFileSync(configPath, "utf-8")).toBe(text);
    expect(fs.existsSync(cachePath)).toBe(true);
    expect(out).toContain("Usage: npx gitmem-mcp deactivate [--keys-only]");
    expect(out).not.toContain(KEYS.api_key);
  });
});

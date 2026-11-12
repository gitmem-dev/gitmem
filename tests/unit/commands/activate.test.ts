/**
 * Unit tests for the activate command
 *
 * Verifies what activate leaves on disk and prints, not the order of its steps:
 * - config.json is written owner-only (0600), an older open file is tightened
 *   and the command says so, and a chmod failure warns without stopping
 * - OPENROUTER_BASE_URL is never saved
 * - --no-save-keys writes none of the credentials, keeps what is already there,
 *   and is accepted before or after the license key
 * - without the option the credentials are saved as before
 *
 * fetch is stubbed and the store is a temp folder: no network, no real store.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TEST_DIR = path.join(os.tmpdir(), `gitmem-activate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const WORK_DIR = `${TEST_DIR}-cwd`;

vi.mock("../../../src/services/gitmem-dir.js", () => ({
  getGitmemDir: () => TEST_DIR,
  // A fresh store has no install id, so activate generates and saves one.
  getInstallId: () => null,
}));

vi.mock("../../../src/services/license.js", () => ({
  validateLicense: vi.fn(),
  clearLicenseCache: vi.fn(),
}));

vi.mock("../../../src/commands/migrate-local.js", () => ({
  hasLocalData: () => false,
  hasPreMigrationData: () => false,
  migrateLocalToSupabase: vi.fn(),
  reimportFromBackups: vi.fn(),
  archiveLocalData: vi.fn(() => []),
}));

// Pass-through spy so a test can make chmod fail.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, chmodSync: vi.fn(actual.chmodSync) };
});

import { main } from "../../../src/commands/activate.js";
import { validateLicense } from "../../../src/services/license.js";

const isWindows = process.platform === "win32";
const CREDENTIAL_KEYS = ["api_key", "supabase_url", "supabase_key", "openrouter_key", "database_url"];
const ENV_VALUES = {
  GITMEM_API_KEY: "gitmem_dev_test",
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "eyJ-service-role-test",
  OPENROUTER_API_KEY: "sk-or-test-key",
};

describe("activate command", () => {
  const configPath = path.join(TEST_DIR, "config.json");
  let out: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

  const readConfig = () => JSON.parse(fs.readFileSync(configPath, "utf-8"));

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(WORK_DIR, { recursive: true });

    for (const name of ["GITMEM_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENROUTER_API_KEY",
      "OPENROUTER_BASE_URL", "DATABASE_URL", "SUPABASE_ACCESS_TOKEN"]) {
      vi.stubEnv(name, undefined);
    }
    for (const [name, value] of Object.entries(ENV_VALUES)) vi.stubEnv(name, value);

    vi.mocked(validateLicense).mockResolvedValue({ valid: true, tier: "pro", message: "ok" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    vi.spyOn(process, "cwd").mockReturnValue(WORK_DIR);
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });

    out = "";
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out += a.map(String).join(" ") + "\n";
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.rmSync(WORK_DIR, { recursive: true, force: true });
  });

  describe("owner-only config.json", () => {
    it.skipIf(isWindows)("tightens an existing 0644 file and says so (AC-14.1)", async () => {
      fs.writeFileSync(configPath, JSON.stringify({ api_key: "gitmem_dev_old" }));
      fs.chmodSync(configPath, 0o644);

      await main([]);

      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      const config = readConfig();
      expect(config.api_key).toBe(ENV_VALUES.GITMEM_API_KEY);
      expect(config.supabase_key).toBe(ENV_VALUES.SUPABASE_SERVICE_ROLE_KEY);
      expect(out).toContain(`Restricted ${configPath} to your user account (was 0644)`);
    });

    it.skipIf(isWindows)("creates a new file at 0600 with no Restricted line (AC-14.2)", async () => {
      await main([]);

      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      expect(out).not.toContain("Restricted");
    });

    it.skipIf(isWindows)("warns with the chmod command when it cannot restrict, and still saves (AC-14.3)", async () => {
      fs.writeFileSync(configPath, JSON.stringify({ api_key: "gitmem_dev_old" }));
      fs.chmodSync(configPath, 0o644);
      vi.mocked(fs.chmodSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      });

      await main([]);

      expect(exitSpy).not.toHaveBeenCalled();
      expect(readConfig().api_key).toBe(ENV_VALUES.GITMEM_API_KEY);
      expect(out).toContain("Could not restrict");
      expect(out).toContain(`chmod 600 ${configPath}`);
    });
  });

  it("never saves OPENROUTER_BASE_URL (AC-9.1)", async () => {
    vi.stubEnv("OPENROUTER_BASE_URL", "https://gw.example/v1");

    await main([]);

    expect(readConfig()).not.toHaveProperty("openrouter_base_url");
    expect(fs.readFileSync(configPath, "utf-8")).not.toContain("gw.example");
  });

  describe("--no-save-keys", () => {
    it("writes none of the credentials, only install_id, and says so (AC-30.1)", async () => {
      await main(["--no-save-keys"]);

      expect(exitSpy).not.toHaveBeenCalled();
      const config = readConfig();
      expect(config.install_id).toBeTruthy();
      for (const key of CREDENTIAL_KEYS) expect(config).not.toHaveProperty(key);
      const text = fs.readFileSync(configPath, "utf-8");
      for (const value of Object.values(ENV_VALUES)) expect(text).not.toContain(value);
      expect(out).toContain("Credentials not saved");
      if (!isWindows) expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    });

    it("leaves values already in the file as they are and adds no other credential (AC-30.2)", async () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ project: "my-project", feedback_enabled: true, api_key: "gitmem_dev_old" }),
      );

      await main(["--no-save-keys"]);

      const config = readConfig();
      expect(config.project).toBe("my-project");
      expect(config.feedback_enabled).toBe(true);
      expect(config.api_key).toBe("gitmem_dev_old");
      for (const key of CREDENTIAL_KEYS.filter((k) => k !== "api_key")) expect(config).not.toHaveProperty(key);
    });

    it("accepts the option before or after the license key (AC-30.3)", async () => {
      vi.stubEnv("GITMEM_API_KEY", undefined);

      await main(["--no-save-keys", "gitmem_dev_arg"]);
      expect(vi.mocked(validateLicense).mock.calls[0][0]).toBe("gitmem_dev_arg");

      fs.rmSync(configPath, { force: true });
      vi.mocked(validateLicense).mockClear();

      await main(["gitmem_dev_arg", "--no-save-keys"]);
      expect(vi.mocked(validateLicense).mock.calls[0][0]).toBe("gitmem_dev_arg");
    });

    it("still saves the credentials without the option (AC-30.4)", async () => {
      await main([]);

      const config = readConfig();
      expect(config.api_key).toBe(ENV_VALUES.GITMEM_API_KEY);
      expect(config.supabase_url).toBe(ENV_VALUES.SUPABASE_URL);
      expect(config.supabase_key).toBe(ENV_VALUES.SUPABASE_SERVICE_ROLE_KEY);
      expect(config.openrouter_key).toBe(ENV_VALUES.OPENROUTER_API_KEY);
      expect(out).not.toContain("Credentials not saved");
    });
  });
});

/**
 * Unit tests for the activate command
 *
 * Verifies what activate leaves on disk and prints, not the order of its steps:
 * - config.json is written owner-only (0600), an older open file is tightened
 *   and the command says so, and a chmod failure warns without stopping
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
      "DATABASE_URL", "SUPABASE_ACCESS_TOKEN"]) {
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
});

/**
 * GitMem Pro Deactivation
 *
 * Usage: npx gitmem-mcp deactivate [--keys-only]
 *
 * 1. Calls gitmem_deactivate_device RPC to remove this device server-side
 * 2. Removes api_key, supabase_url, supabase_key, openrouter_key, database_url from config.json
 * 3. Deletes license-cache.json
 * Does NOT remove .gitmem/ directory or local data.
 *
 * --keys-only: steps 2 and 3 without step 1. No request is made, so the device
 * stays registered and a later `activate` with the key carries on where it was.
 * gitmem then reads the license key and credentials from the environment only.
 * Any other argument is refused before anything is read or sent.
 */

import * as fs from "fs";
import * as path from "path";
import { getGitmemDir, getInstallId } from "../services/gitmem-dir.js";
import {
  clearLicenseCache,
  getLicenseKey,
  getValidationUrl,
} from "../services/license.js";
import { writePrivateFileSync, wasReadableByOthers } from "../services/private-file.js";

// Same infra endpoint as validation — just different RPC
const DEACTIVATION_URL =
  getValidationUrl().replace("gitmem_validate_license", "gitmem_deactivate_device");
const VALIDATION_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqcHR4eWV6dXhkaWludWZncnJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYxODY3MDMsImV4cCI6MjA4MTc2MjcwM30.L0oZy3LYCMikmZ15IUU5DnfJmucM37DJ14nUkM3AreY";

async function deactivateDeviceRemote(
  apiKey: string,
  installId: string,
): Promise<{ success: boolean; message: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(DEACTIVATION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: VALIDATION_ANON_KEY,
        Authorization: `Bearer ${VALIDATION_ANON_KEY}`,
      },
      body: JSON.stringify({ p_api_key: apiKey, p_install_id: installId }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return { success: false, message: `HTTP ${response.status}` };
    }

    const rows = (await response.json()) as { success: boolean; message: string }[];
    const data = Array.isArray(rows) ? rows[0] : rows;
    return data || { success: false, message: "Empty response" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, message: `Network error: ${message}` };
  }
}

/** The credentials removed from config.json, by `deactivate` and by `deactivate --keys-only`. */
const CREDENTIAL_FIELDS = ["api_key", "supabase_url", "supabase_key", "openrouter_key", "database_url"] as const;

/** Write config.json owner-only (mode 0600 on POSIX; an older, more open file is tightened first) and say what happened. */
function writeConfig(configPath: string, config: Record<string, unknown>): void {
  const writeResult = writePrivateFileSync(configPath, JSON.stringify(config, null, 2));
  if (writeResult.tightenError) {
    console.log(`  ⚠ Could not restrict ${configPath} to your user account (${writeResult.tightenError}). Run: chmod 600 ${configPath}`);
  } else if (wasReadableByOthers(writeResult)) {
    const was = (writeResult.previousMode as number).toString(8).padStart(4, "0");
    console.log(`  ✓ Restricted ${configPath} to your user account (was ${was})`);
  }
}

/**
 * `deactivate --keys-only`: removes the saved credentials and the license cache,
 * and makes no request, so the device stays registered with the license server.
 * Prints key names only, never a value.
 */
function removeSavedKeys(gitmemDir: string, configPath: string): void {
  if (!fs.existsSync(configPath)) {
    console.log("No config.json found — no saved keys to remove.");
  } else {
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      console.error("Error reading config.json");
      process.exit(1);
      return;
    }

    const removed = CREDENTIAL_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(config, k));
    if (removed.length === 0) {
      // Nothing to remove: the file is not rewritten.
      console.log(`No saved keys in ${configPath}; left it as it was.`);
    } else {
      for (const k of removed) delete config[k];
      writeConfig(configPath, config);
      console.log(`  ✓ Removed ${removed.join(", ")} from ${configPath}`);
    }
  }

  // The cache holds the license key's first 16 characters (api_key_prefix), so it
  // goes too, as with plain deactivate. The next start checks the license again.
  const cachePath = path.join(gitmemDir, "license-cache.json");
  const hadCache = fs.existsSync(cachePath);
  clearLicenseCache();
  if (hadCache && !fs.existsSync(cachePath)) {
    console.log("  ✓ Removed license-cache.json");
  } else if (hadCache) {
    console.log(`  ⚠ Could not remove ${cachePath}. Delete it by hand.`);
  }

  console.log("");
  console.log("No request was made to the license server: this device stays registered.");
  console.log("gitmem now reads the license key and credentials from the environment only");
  console.log("(GITMEM_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY).");
  console.log("Restart your editor to apply.");
}

export async function main(args: string[]): Promise<void> {
  // Refuse anything else before reading or sending anything: a mistyped
  // --keys-only must not release the device. The argument is not echoed, in
  // case it is a key.
  if (args.some((a) => a !== "--keys-only")) {
    console.error("Error: unknown option. Usage: npx gitmem-mcp deactivate [--keys-only]");
    console.error("Nothing was changed.");
    process.exit(1);
    return;
  }

  const gitmemDir = getGitmemDir();
  const configPath = path.join(gitmemDir, "config.json");

  if (args.includes("--keys-only")) {
    removeSavedKeys(gitmemDir, configPath);
    return;
  }

  if (!fs.existsSync(configPath)) {
    console.log("No config.json found — nothing to deactivate.");
    return;
  }

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    console.error("Error reading config.json");
    process.exit(1);
  }

  const apiKey = getLicenseKey();
  const installId = getInstallId();
  const hadKey = !!apiKey;

  // Step 1: Remove device server-side (if we have both key and install_id)
  if (apiKey && installId) {
    const result = await deactivateDeviceRemote(apiKey, installId);
    if (result.success) {
      console.log(`  ✓ ${result.message}`);
    } else {
      console.log(`  ⚠ Server deactivation failed: ${result.message}`);
      console.log("    Local credentials will still be removed.");
    }
  }

  // Step 2: Remove Pro credentials from config
  for (const k of CREDENTIAL_FIELDS) delete config[k];

  // Write back config (preserving project, install_id, feedback_enabled).
  writeConfig(configPath, config);

  // Step 3: Clear license cache
  clearLicenseCache();

  if (hadKey) {
    console.log("\nPro tier deactivated.");
    console.log("  - Device removed from license server");
    console.log("  - License key removed from config.json");
    console.log("  - Supabase and OpenRouter credentials removed");
    console.log("  - License cache cleared");
    console.log("");
    console.log("Local data in .gitmem/ is preserved (scars, threads, sessions).");
    console.log("Restart your editor to switch to free tier.");
  } else {
    console.log("No active Pro license found. Already on free tier.");
  }
}

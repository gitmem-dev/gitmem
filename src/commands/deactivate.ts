/**
 * GitMem Pro Deactivation
 *
 * 1. Calls gitmem_deactivate_device RPC to remove this device server-side
 * 2. Removes api_key, supabase_url, supabase_key, openrouter_key from config.json
 * 3. Deletes license-cache.json
 * Does NOT remove .gitmem/ directory or local data.
 */

import * as fs from "fs";
import * as path from "path";
import { getGitmemDir, getInstallId } from "../services/gitmem-dir.js";
import {
  clearLicenseCache,
  getLicenseKey,
  getValidationUrl,
} from "../services/license.js";

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

export async function main(_args: string[]): Promise<void> {
  const gitmemDir = getGitmemDir();
  const configPath = path.join(gitmemDir, "config.json");

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
  delete config.api_key;
  delete config.supabase_url;
  delete config.supabase_key;
  delete config.openrouter_key;

  // Write back config (preserving project, install_id, feedback_enabled)
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

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

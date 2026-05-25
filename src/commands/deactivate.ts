/**
 * GitMem Pro Deactivation
 *
 * Removes api_key, supabase_url, supabase_key, openrouter_key from config.json.
 * Deletes license-cache.json.
 * Does NOT remove .gitmem/ directory or local data.
 */

import * as fs from "fs";
import * as path from "path";
import { getGitmemDir } from "../services/gitmem-dir.js";
import { clearLicenseCache } from "../services/license.js";

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

  const hadKey = !!config.api_key;

  // Remove Pro credentials
  delete config.api_key;
  delete config.supabase_url;
  delete config.supabase_key;
  delete config.openrouter_key;

  // Write back config (preserving project, install_id, feedback_enabled)
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Clear license cache
  clearLicenseCache();

  if (hadKey) {
    console.log("Pro tier deactivated.");
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

/**
 * GitMem Pro Activation Wizard
 *
 * Usage: npx gitmem-mcp activate [license-key]
 *
 * Steps:
 *   1. Accept key as argument or prompt for it
 *   2. Validate key against our endpoint (register device)
 *   3. Prompt for Supabase URL + service role key (with re-activation safety check)
 *   4. Test Supabase connection (verify tables exist)
 *   5. Prompt for OpenRouter API key
 *   6. Tell user to run schema setup manually if tables missing
 *   7. Write everything to ~/.gitmem/config.json
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { getGitmemDir, getInstallId } from "../services/gitmem-dir.js";
import { validateLicense, clearLicenseCache } from "../services/license.js";

function createReadline(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

/**
 * Test basic Supabase connectivity via REST API
 */
async function testSupabaseConnection(url: string, key: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/rest/v1/`, {
      method: "GET",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });
    return response.ok || response.status === 200;
  } catch {
    return false;
  }
}

/**
 * Check if gitmem tables exist in the user's Supabase
 * Returns list of missing tables (empty = all present)
 */
async function checkSchemaExists(url: string, key: string): Promise<string[]> {
  const requiredTables = ["gitmem_learnings", "gitmem_sessions", "gitmem_decisions", "gitmem_scar_usage"];
  const missing: string[] = [];

  for (const table of requiredTables) {
    try {
      const response = await fetch(`${url}/rest/v1/${table}?select=id&limit=0`, {
        method: "GET",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      });
      // 404 or 400 means table doesn't exist; 200 (even empty) means it does
      if (!response.ok) {
        missing.push(table);
      }
    } catch {
      missing.push(table);
    }
  }

  return missing;
}

export async function main(args: string[]): Promise<void> {
  console.log("");
  console.log("GitMem Pro Activation");
  console.log("─────────────────────");
  console.log("");

  const gitmemDir = getGitmemDir();
  const configPath = path.join(gitmemDir, "config.json");

  // Load existing config
  let config: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }
  } catch {
    // Start fresh
  }

  // Ensure install_id exists
  let installId = (config.install_id as string) || getInstallId();
  if (!installId) {
    const { randomUUID } = await import("crypto");
    installId = randomUUID();
    config.install_id = installId;
  }

  // Step 1: Get license key
  let apiKey = args[0] || "";

  if (!apiKey) {
    // Check if non-interactive (piped stdin)
    if (!process.stdin.isTTY) {
      console.error("Error: License key required. Usage: npx gitmem-mcp activate <key>");
      process.exit(1);
    }

    const rl = createReadline();
    apiKey = await ask(rl, "License key: ");
    rl.close();

    if (!apiKey) {
      console.error("Error: License key is required.");
      process.exit(1);
    }
  }

  // Validate key format
  if (!apiKey.startsWith("gitmem_pro_") && !apiKey.startsWith("gitmem_dev_")) {
    console.error("Error: Invalid key format. Keys start with 'gitmem_pro_' or 'gitmem_dev_'.");
    process.exit(1);
  }

  // Step 2: Validate key against endpoint
  console.log("Validating license key...");
  const result = await validateLicense(apiKey, installId);

  if (!result.valid) {
    console.error(`\nError: ${result.message}`);
    process.exit(1);
  }

  console.log(`✓ Key validated (${result.tier} tier)`);
  console.log("");

  // Interactive mode for credentials
  if (!process.stdin.isTTY) {
    // Non-interactive: just save the key
    config.api_key = apiKey;
    if (!fs.existsSync(gitmemDir)) {
      fs.mkdirSync(gitmemDir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log("License key saved. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars for Supabase.");
    return;
  }

  const rl = createReadline();

  // Step 3: Supabase credentials (with re-activation safety check)
  const existingUrl = config.supabase_url as string | undefined;

  console.log("Supabase Setup");
  console.log("  (Create a free project at https://database.new)");
  if (existingUrl) {
    console.log(`  Current: ${existingUrl}`);
  }
  console.log("");

  let supabaseUrl: string;
  if (existingUrl) {
    const urlInput = await ask(rl, `  Project URL [${existingUrl}]: `);
    supabaseUrl = urlInput || existingUrl;

    // Warn if changing to a different Supabase instance
    if (urlInput && urlInput !== existingUrl) {
      console.log("");
      console.log("  ⚠ WARNING: You are changing your Supabase URL.");
      console.log(`    Old: ${existingUrl}`);
      console.log(`    New: ${urlInput}`);
      console.log("    Your existing data in the old project will NOT be migrated.");
      console.log("");
      const confirm = await ask(rl, "  Continue with new URL? (y/N): ");
      if (confirm.toLowerCase() !== "y" && confirm.toLowerCase() !== "yes") {
        console.log("  Keeping existing URL.");
        supabaseUrl = existingUrl;
      }
    }
  } else {
    supabaseUrl = await ask(rl, "  Project URL: ");
  }

  if (!supabaseUrl) {
    console.error("Error: Supabase URL is required for Pro tier.");
    rl.close();
    process.exit(1);
  }

  const existingKey = config.supabase_key as string | undefined;
  let supabaseKey: string;
  if (existingKey && supabaseUrl === existingUrl) {
    // Same URL, offer to keep existing key
    const keyInput = await ask(rl, "  Service Role Key [keep existing]: ");
    supabaseKey = keyInput || existingKey;
  } else {
    supabaseKey = await ask(rl, "  Service Role Key: ");
  }

  if (!supabaseKey) {
    console.error("Error: Service Role Key is required.");
    rl.close();
    process.exit(1);
  }

  // Step 4: Test connection and check schema
  console.log("  Testing connection...");
  const connected = await testSupabaseConnection(supabaseUrl, supabaseKey);
  if (!connected) {
    console.error("  ✗ Could not connect to Supabase. Check your URL and key.");
    rl.close();
    process.exit(1);
  }
  console.log("  ✓ Connected to Supabase");

  // Check if required tables exist
  const missingTables = await checkSchemaExists(supabaseUrl, supabaseKey);
  if (missingTables.length > 0) {
    console.log("");
    console.log("  ⚠ Missing tables: " + missingTables.join(", "));
    console.log("  Run the schema setup in your Supabase SQL Editor:");
    console.log("");
    console.log("    npx gitmem-mcp setup | pbcopy   (macOS — copies SQL to clipboard)");
    console.log("    npx gitmem-mcp setup            (prints SQL to paste manually)");
    console.log("");
    console.log("  Then: Supabase Dashboard → SQL Editor → New query → Paste → Run");
    console.log("");
  } else {
    console.log("  ✓ Schema verified (all tables present)");
  }
  console.log("");

  // Step 5: OpenRouter key
  console.log("OpenRouter Setup");
  console.log("  (Get a key at https://openrouter.ai/keys)");

  const existingOpenRouter = config.openrouter_key as string | undefined;
  if (existingOpenRouter) {
    console.log(`  Current: ${existingOpenRouter.substring(0, 12)}...`);
  }
  console.log("");

  let openrouterKey: string;
  if (existingOpenRouter) {
    const orInput = await ask(rl, "  API Key [keep existing]: ");
    openrouterKey = orInput || existingOpenRouter;
  } else {
    openrouterKey = await ask(rl, "  API Key: ");
  }

  if (openrouterKey) {
    console.log("  ✓ OpenRouter configured");
  } else {
    console.log("  ⚠ Skipped (semantic search will not work without embeddings)");
  }

  rl.close();

  // Step 6: Write config (preserves existing fields like project, install_id, feedback_enabled)
  config.api_key = apiKey;
  config.supabase_url = supabaseUrl;
  config.supabase_key = supabaseKey;
  if (openrouterKey) {
    config.openrouter_key = openrouterKey;
  }

  if (!fs.existsSync(gitmemDir)) {
    fs.mkdirSync(gitmemDir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Clear any stale license cache
  clearLicenseCache();

  console.log("");
  console.log("─────────────────────");
  if (missingTables.length > 0) {
    console.log("Pro tier activated! Run schema setup, then restart your editor.");
  } else {
    console.log("Pro tier activated! Restart your editor to apply.");
  }
  console.log(`Config saved to ${configPath}`);
  console.log("");
}

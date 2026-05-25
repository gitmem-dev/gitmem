/**
 * GitMem Pro Activation Wizard
 *
 * Usage: npx gitmem-mcp activate [license-key]
 *
 * Steps:
 *   1. Accept key as argument or prompt for it
 *   2. Validate key against our endpoint (register device)
 *   3. Prompt for Supabase URL + service role key
 *   4. Test Supabase connection
 *   5. Prompt for OpenRouter API key
 *   6. Optionally run setup SQL against their Supabase
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

  // Step 3: Supabase credentials
  console.log("Supabase Setup");
  console.log("  (Create a free project at https://database.new)");
  console.log("");

  const supabaseUrl = await ask(rl, "  Project URL: ");
  if (!supabaseUrl) {
    console.error("Error: Supabase URL is required for Pro tier.");
    rl.close();
    process.exit(1);
  }

  const supabaseKey = await ask(rl, "  Service Role Key: ");
  if (!supabaseKey) {
    console.error("Error: Service Role Key is required.");
    rl.close();
    process.exit(1);
  }

  // Step 4: Test connection
  console.log("  Testing connection...");
  const connected = await testSupabaseConnection(supabaseUrl, supabaseKey);
  if (!connected) {
    console.error("  ✗ Could not connect to Supabase. Check your URL and key.");
    rl.close();
    process.exit(1);
  }
  console.log("  ✓ Connected to Supabase");
  console.log("");

  // Step 5: OpenRouter key
  console.log("OpenRouter Setup");
  console.log("  (Get a key at https://openrouter.ai/keys)");
  console.log("");

  const openrouterKey = await ask(rl, "  API Key: ");
  if (openrouterKey) {
    console.log("  ✓ OpenRouter configured");
  } else {
    console.log("  ⚠ Skipped (semantic search will not work without embeddings)");
  }
  console.log("");

  // Step 6: Offer to run setup SQL
  const runSetup = await ask(rl, "Run database schema setup? (y/N): ");
  if (runSetup.toLowerCase() === "y" || runSetup.toLowerCase() === "yes") {
    console.log("  Running schema setup...");
    try {
      const sqlPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "schema", "setup.sql");
      const sql = fs.readFileSync(sqlPath, "utf-8");

      // Execute SQL via Supabase REST API (using the pg_dump-style endpoint isn't available,
      // but we can use the SQL query endpoint if available)
      const response = await fetch(`${supabaseUrl}/rest/v1/rpc/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({ query: sql }),
      });

      if (response.ok) {
        console.log("  ✓ Schema created");
      } else {
        console.log("  ⚠ Could not auto-run SQL. Please run manually:");
        console.log("    npx gitmem-mcp setup  (copy output → Supabase SQL Editor)");
      }
    } catch {
      console.log("  ⚠ Could not auto-run SQL. Please run manually:");
      console.log("    npx gitmem-mcp setup  (copy output → Supabase SQL Editor)");
    }
  }

  rl.close();

  // Step 7: Write config
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
  console.log("───��─────────────────");
  console.log(`Pro tier activated! Restart your editor to apply.`);
  console.log(`Config saved to ${configPath}`);
  console.log("");
}

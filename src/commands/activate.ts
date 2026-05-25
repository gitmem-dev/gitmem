/**
 * GitMem Pro Activation Wizard
 *
 * Usage: npx gitmem-mcp activate [license-key]
 *
 * Credential resolution (priority order):
 *   1. Environment variables (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY)
 *   2. Existing values in .gitmem/config.json (re-activation)
 *   3. Interactive prompt (TTY only)
 *
 * Steps:
 *   1. Accept key as argument or prompt for it
 *   2. Validate key against our endpoint (register device)
 *   3. Resolve Supabase URL + service role key (env → config → prompt)
 *   4. Test Supabase connection (verify tables exist)
 *   5. Resolve OpenRouter API key (env → config → prompt)
 *   6. Write everything to ~/.gitmem/config.json
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
 * Resolve a credential value using the priority chain:
 *   1. Environment variable
 *   2. Existing config value
 *   3. Interactive prompt (if TTY available)
 *
 * Returns the resolved value or empty string.
 */
async function resolveCredential(opts: {
  envVar: string;
  configValue: string | undefined;
  promptLabel: string;
  required: boolean;
  rl: readline.Interface | null;
  existingHint?: string;
}): Promise<{ value: string; source: "env" | "config" | "prompt" | "none" }> {
  // 1. Environment variable
  const envValue = process.env[opts.envVar];
  if (envValue) {
    return { value: envValue, source: "env" };
  }

  // 2. Existing config value
  if (opts.configValue) {
    return { value: opts.configValue, source: "config" };
  }

  // 3. Interactive prompt
  if (opts.rl) {
    const prompt = opts.existingHint
      ? `  ${opts.promptLabel} [${opts.existingHint}]: `
      : `  ${opts.promptLabel}: `;
    const input = await ask(opts.rl, prompt);
    if (input) {
      return { value: input, source: "prompt" };
    }
  }

  return { value: "", source: "none" };
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

  // Step 1: Get license key (arg → env → prompt)
  let apiKey = args[0] || process.env.GITMEM_API_KEY || (config.api_key as string) || "";

  if (!apiKey) {
    if (!process.stdin.isTTY) {
      console.error("Error: License key required. Usage: npx gitmem-mcp activate <key>");
      console.error("  Or set GITMEM_API_KEY environment variable.");
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

  // Create readline only if TTY is available
  const rl = process.stdin.isTTY ? createReadline() : null;

  // Step 3: Resolve Supabase credentials (env → config → prompt)
  const existingUrl = config.supabase_url as string | undefined;
  const existingKey = config.supabase_key as string | undefined;

  if (rl) {
    console.log("Supabase Setup");
    console.log("  (Create a free project at https://database.new)");
    if (existingUrl) {
      console.log(`  Current: ${existingUrl}`);
    }
    console.log("");
  }

  const supabaseUrlResult = await resolveCredential({
    envVar: "SUPABASE_URL",
    configValue: existingUrl,
    promptLabel: "Project URL",
    required: true,
    rl,
  });

  const supabaseUrl = supabaseUrlResult.value;

  // Re-activation safety: warn if changing URL interactively
  if (rl && existingUrl && supabaseUrl !== existingUrl && supabaseUrlResult.source === "prompt") {
    console.log("");
    console.log("  ⚠ WARNING: You are changing your Supabase URL.");
    console.log(`    Old: ${existingUrl}`);
    console.log(`    New: ${supabaseUrl}`);
    console.log("    Your existing data in the old project will NOT be migrated.");
    console.log("");
    const confirm = await ask(rl, "  Continue with new URL? (y/N): ");
    if (confirm.toLowerCase() !== "y" && confirm.toLowerCase() !== "yes") {
      console.log("  Keeping existing URL.");
      // Fall back handled below by using existingUrl
    }
  }

  // Resolve service role key — if same URL, offer to keep existing
  const supabaseKeyResult = await resolveCredential({
    envVar: "SUPABASE_SERVICE_ROLE_KEY",
    configValue: (supabaseUrl === existingUrl) ? existingKey : undefined,
    promptLabel: "Service Role Key",
    required: true,
    rl,
    existingHint: (existingKey && supabaseUrl === existingUrl) ? "keep existing" : undefined,
  });

  const supabaseKey = supabaseKeyResult.value;

  // Step 4: Test connection if we have credentials
  let missingTables: string[] = [];
  let connectionFailed = false;
  if (supabaseUrl && supabaseKey) {
    if (supabaseUrlResult.source !== "config" || supabaseKeyResult.source !== "config") {
      // Only test if credentials are new (not just re-read from config)
      console.log("  Testing connection...");
      const connected = await testSupabaseConnection(supabaseUrl, supabaseKey);
      if (!connected) {
        connectionFailed = true;
        if (rl) {
          // Interactive: hard failure — user can re-enter
          console.error("  ✗ Could not connect to Supabase. Check your URL and key.");
          rl.close();
          process.exit(1);
        } else {
          // Non-interactive: warn but save credentials anyway
          console.log("  ⚠ Could not connect to Supabase (credentials saved anyway).");
          console.log("    Verify your SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are correct.");
        }
      } else {
        console.log("  ✓ Connected to Supabase");
      }
    }

    if (!connectionFailed) {
      missingTables = await checkSchemaExists(supabaseUrl, supabaseKey);
      if (missingTables.length > 0) {
        console.log("");
        console.log("  ⚠ Missing tables: " + missingTables.join(", "));
        console.log("  Run the schema setup in your Supabase SQL Editor:");
        console.log("");
        console.log("    npx gitmem-mcp setup | pbcopy   (macOS — copies SQL to clipboard)");
        console.log("    npx gitmem-mcp setup            (prints SQL to paste manually)");
        console.log("");
        console.log("  Then: Supabase Dashboard → SQL Editor → New query → Paste → Run");
      } else {
        console.log("  ✓ Schema verified (all tables present)");
      }
    }
    console.log("");
  } else if (!supabaseUrl || !supabaseKey) {
    console.log("  ⚠ Supabase credentials not provided.");
    console.log("    Pro features require Supabase. Set via:");
    console.log("      - Environment: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    console.log("      - Config: edit .gitmem/config.json (supabase_url, supabase_key)");
    console.log("      - Re-run: npx gitmem-mcp activate (interactive)");
    console.log("");
  }

  // Step 5: Resolve OpenRouter key (env → config → prompt)
  if (rl) {
    console.log("OpenRouter Setup");
    console.log("  (Get a key at https://openrouter.ai/keys)");
    const existingOpenRouter = config.openrouter_key as string | undefined;
    if (existingOpenRouter) {
      console.log(`  Current: ${existingOpenRouter.substring(0, 12)}...`);
    }
    console.log("");
  }

  const openrouterResult = await resolveCredential({
    envVar: "OPENROUTER_API_KEY",
    configValue: config.openrouter_key as string | undefined,
    promptLabel: "API Key",
    required: false,
    rl,
    existingHint: (config.openrouter_key as string) ? "keep existing" : undefined,
  });

  const openrouterKey = openrouterResult.value;

  if (openrouterKey) {
    if (openrouterResult.source === "env") {
      console.log("  ✓ OpenRouter configured (from env)");
    } else if (openrouterResult.source === "config") {
      // Silent — already configured
    } else {
      console.log("  ✓ OpenRouter configured");
    }
  } else if (rl) {
    console.log("  ⚠ Skipped (semantic search will not work without embeddings)");
  }

  if (rl) rl.close();

  // Step 6: Write config (preserves existing fields like project, install_id, feedback_enabled)
  config.api_key = apiKey;
  if (supabaseUrl) config.supabase_url = supabaseUrl;
  if (supabaseKey) config.supabase_key = supabaseKey;
  if (openrouterKey) config.openrouter_key = openrouterKey;

  if (!fs.existsSync(gitmemDir)) {
    fs.mkdirSync(gitmemDir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Clear any stale license cache
  clearLicenseCache();

  // Summary
  console.log("");
  console.log("─────────────────────");

  const sources: string[] = [];
  if (supabaseUrl) sources.push(`Supabase (${supabaseUrlResult.source})`);
  if (openrouterKey) sources.push(`OpenRouter (${openrouterResult.source})`);

  if (!supabaseUrl) {
    console.log("License key activated. Supabase credentials still needed for Pro features.");
  } else if (missingTables.length > 0) {
    console.log("Pro tier activated! Run schema setup, then restart your editor.");
  } else {
    console.log("Pro tier activated! Restart your editor to apply.");
  }

  if (sources.length > 0) {
    console.log(`  Credentials: ${sources.join(", ")}`);
  }
  console.log(`  Config: ${configPath}`);
  console.log("");
}

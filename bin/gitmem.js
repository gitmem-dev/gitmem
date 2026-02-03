#!/usr/bin/env node

/**
 * GitMem CLI
 *
 * Commands:
 *   gitmem setup     — Output SQL to paste into Supabase SQL Editor (pro/dev)
 *   gitmem init      — Load starter scars (local JSON or Supabase)
 *   gitmem configure — Generate .mcp.json entry for Claude Code
 *   gitmem server    — Start MCP server (default)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const command = process.argv[2];

function printUsage() {
  console.log(`
GitMem — Institutional Memory for AI Coding

Usage:
  npx gitmem setup      Output SQL for Supabase schema setup (pro/dev tier)
  npx gitmem init       Load starter scars (auto-detects tier)
  npx gitmem configure  Generate .mcp.json config for Claude Code
  npx gitmem server     Start MCP server (default)
  npx gitmem help       Show this help message

Free Tier (zero config):
  1. npx gitmem init
  2. npx gitmem configure
  3. Copy CLAUDE.md.template into your project
  4. Start coding — memory is active!

Pro Tier (with Supabase):
  1. Create free Supabase project → database.new
  2. npx gitmem setup   (copy SQL → Supabase SQL Editor)
  3. Get API key for embeddings (OpenAI, OpenRouter, or Ollama)
  4. npx gitmem configure
  5. npx gitmem init    (load starter scars into Supabase)
  6. Copy CLAUDE.md.template into your project
  7. Start coding — memory is active!
`);
}

async function cmdSetup() {
  try {
    const sqlPath = join(__dirname, "..", "schema", "setup.sql");
    const sql = readFileSync(sqlPath, "utf-8");
    console.log("-- GitMem Schema Setup (Pro/Dev Tier)");
    console.log("-- Copy and paste this SQL into your Supabase SQL Editor");
    console.log("-- (Dashboard → SQL Editor → New query → Paste → Run)");
    console.log("");
    console.log(sql);
  } catch {
    console.error("Error: Could not read setup.sql. Ensure the package is installed correctly.");
    process.exit(1);
  }
}

async function cmdInit() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  let starterScars;
  try {
    const scarsPath = join(__dirname, "..", "schema", "starter-scars.json");
    starterScars = JSON.parse(readFileSync(scarsPath, "utf-8"));
  } catch {
    console.error("Error: Could not read starter-scars.json.");
    process.exit(1);
  }

  if (!supabaseUrl || !supabaseKey) {
    // Free tier: copy starter scars to local .gitmem/ directory
    console.log("No Supabase credentials found — initializing free tier (local storage).");
    console.log("");

    const gitmemDir = join(process.cwd(), ".gitmem");
    if (!existsSync(gitmemDir)) {
      mkdirSync(gitmemDir, { recursive: true });
    }

    const learningsPath = join(gitmemDir, "learnings.json");
    let existing = [];
    if (existsSync(learningsPath)) {
      try {
        existing = JSON.parse(readFileSync(learningsPath, "utf-8"));
      } catch {
        existing = [];
      }
    }

    // Merge: skip scars that already exist by id
    const existingIds = new Set(existing.map((s) => s.id));
    let added = 0;
    for (const scar of starterScars) {
      if (!existingIds.has(scar.id)) {
        existing.push(scar);
        added++;
        console.log(`  + ${scar.title}`);
      } else {
        console.log(`  = ${scar.title} (already exists)`);
      }
    }

    writeFileSync(learningsPath, JSON.stringify(existing, null, 2));

    // Create empty files for other collections
    for (const file of ["sessions.json", "decisions.json", "scar-usage.json"]) {
      const filePath = join(gitmemDir, file);
      if (!existsSync(filePath)) {
        writeFileSync(filePath, "[]");
      }
    }

    console.log("");
    console.log(`Done: ${added} new scars added to .gitmem/learnings.json`);
    console.log("");
    console.log("Add .gitmem/ to your .gitignore:");
    console.log("  echo '.gitmem/' >> .gitignore");
    console.log("");
    console.log("To upgrade to Pro tier (semantic search + Supabase persistence):");
    console.log("  Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then run init again.");
    return;
  }

  // Pro/Dev tier: load into Supabase via REST API
  const tablePrefix = process.env.GITMEM_TABLE_PREFIX || "gitmem_";
  const restUrl = `${supabaseUrl}/rest/v1/${tablePrefix}learnings`;

  console.log(`Loading ${starterScars.length} starter scars into Supabase (${tablePrefix}learnings)...`);

  let loaded = 0;
  let failed = 0;

  for (const scar of starterScars) {
    try {
      const response = await fetch(restUrl, {
        method: "POST",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          Prefer: "return=representation,resolution=merge-duplicates",
          "Content-Profile": "public",
        },
        body: JSON.stringify(scar),
      });

      if (response.ok) {
        loaded++;
        console.log(`  ✓ ${scar.title}`);
      } else {
        const text = await response.text();
        failed++;
        console.error(`  ✗ ${scar.title}: ${text.slice(0, 100)}`);
      }
    } catch (err) {
      failed++;
      console.error(`  ✗ ${scar.title}: ${err}`);
    }
  }

  console.log("");
  console.log(`Done: ${loaded} loaded, ${failed} failed`);

  if (loaded > 0) {
    console.log("");
    console.log("Starter scars are ready! Start a session and try:");
    console.log('  recall({ plan: "deploy to production" })');
  }
}

function cmdConfigure() {
  const supabaseUrl = process.env.SUPABASE_URL;

  if (!supabaseUrl) {
    // Free tier config — no env vars needed
    const config = {
      mcpServers: {
        gitmem: {
          command: "npx",
          args: ["-y", "@nteg-dev/gitmem"],
        },
      },
    };

    console.log("Free tier — no API keys needed!");
    console.log("");
    console.log("Add this to your .mcp.json (Claude Code) or settings (Cursor):");
    console.log("");
    console.log(JSON.stringify(config, null, 2));
    console.log("");
    console.log("To upgrade to Pro tier (semantic search + cloud persistence):");
    console.log("  Set SUPABASE_URL and an embedding API key in the env block.");
  } else {
    // Pro/Dev tier config
    const config = {
      mcpServers: {
        gitmem: {
          command: "npx",
          args: ["-y", "@nteg-dev/gitmem"],
          env: {
            SUPABASE_URL: "https://YOUR_PROJECT.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY: "eyJ...",
            OPENAI_API_KEY: "sk-...",
          },
        },
      },
    };

    console.log("Add this to your .mcp.json (Claude Code) or settings (Cursor):");
    console.log("");
    console.log(JSON.stringify(config, null, 2));
    console.log("");
    console.log("Replace the placeholder values with your actual keys:");
    console.log("  SUPABASE_URL            — From Supabase Dashboard → Settings → API");
    console.log("  SUPABASE_SERVICE_ROLE_KEY — From Supabase Dashboard → Settings → API");
    console.log("  OPENAI_API_KEY          — From platform.openai.com/api-keys");
    console.log("");
    console.log("Alternative embedding providers:");
    console.log("  OPENROUTER_API_KEY=sk-or-...  (instead of OPENAI_API_KEY)");
    console.log("  OLLAMA_URL=http://localhost:11434  (local, no API key needed)");
  }
}

switch (command) {
  case "setup":
    cmdSetup();
    break;
  case "init":
    cmdInit();
    break;
  case "configure":
    cmdConfigure();
    break;
  case "server":
  case "--stdio":
    import("../dist/index.js");
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    printUsage();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}

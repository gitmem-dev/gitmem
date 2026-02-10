#!/usr/bin/env node

/**
 * GitMem CLI
 *
 * Commands:
 *   gitmem setup           — Output SQL to paste into Supabase SQL Editor (pro/dev)
 *   gitmem init            — Load starter scars (local JSON or Supabase)
 *   gitmem configure       — Generate .mcp.json entry for Claude Code
 *   gitmem install-hooks   — Install Claude Code hooks plugin
 *   gitmem uninstall-hooks — Remove Claude Code hooks plugin
 *   gitmem server          — Start MCP server (default)
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  cpSync,
  rmSync,
  readdirSync,
  chmodSync,
  statSync,
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const command = process.argv[2];

function printUsage() {
  console.log(`
GitMem — Institutional Memory for AI Coding

Usage:
  npx gitmem setup             Output SQL for Supabase schema setup (pro/dev tier)
  npx gitmem init              Load starter scars (auto-detects tier)
  npx gitmem configure         Generate .mcp.json config for Claude Code
  npx gitmem install-hooks     Install Claude Code hooks plugin
  npx gitmem uninstall-hooks   Remove Claude Code hooks plugin
  npx gitmem server            Start MCP server (default)
  npx gitmem help              Show this help message

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

/**
 * Run session-start directly (for hook scripts that need context without MCP)
 *
 * Outputs formatted session context to stdout.
 * Used by gitmem-hooks SessionStart hook to provide immediate context
 * without requiring ToolSearch → session_start two-step dance.
 *
 * Args: --project <project> --agent <agent>
 */
async function cmdSessionStart() {
  const args = process.argv.slice(3);
  let project = "orchestra_dev";
  let agentIdentity = undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) project = args[i + 1];
    if (args[i] === "--agent" && args[i + 1]) agentIdentity = args[i + 1];
  }

  try {
    const { sessionStart } = await import("../dist/tools/session-start.js");
    const result = await sessionStart({ project, agent_identity: agentIdentity });

    // Use pre-formatted display from formatStartDisplay() — single source of truth
    console.log(result.display || "GITMEM SESSION ACTIVE");
  } catch (error) {
    console.error("[gitmem session-start]", error.message || error);
    process.exit(1);
  }
}

/**
 * Run session-refresh directly (re-surface context without new session)
 *
 * Args: --project <project>
 */
async function cmdSessionRefresh() {
  const args = process.argv.slice(3);
  let project = undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) project = args[i + 1];
  }

  try {
    const { sessionRefresh } = await import("../dist/tools/session-start.js");
    const result = await sessionRefresh({ project });

    if (!result.session_id) {
      console.error(result.message || "No active session");
      process.exit(1);
    }

    // Format as readable text (same structure as session-start output)
    const lines = [];
    lines.push(`GITMEM CONTEXT REFRESHED`);
    lines.push(``);
    lines.push(`Session: ${result.session_id} | Agent: ${result.agent} | Refreshed`);

    if (result.last_session) {
      lines.push(``);
      lines.push(`Last session: "${result.last_session.title}" (${result.last_session.date})`);
      if (result.last_session.key_decisions?.length) {
        lines.push(`  Decisions: ${result.last_session.key_decisions.slice(0, 3).join("; ")}`);
      }
    }

    if (result.open_threads?.length) {
      lines.push(``);
      lines.push(`Open threads (${result.open_threads.length}):`);
      for (const thread of result.open_threads.slice(0, 5)) {
        const text = typeof thread === "string" ? thread : thread.text;
        const truncated = text && text.length > 80 ? text.slice(0, 77) + "..." : text;
        lines.push(`  - ${truncated || "[unnamed thread]"}`);
      }
      if (result.open_threads.length > 5) {
        lines.push(`  ... and ${result.open_threads.length - 5} more`);
      }
    }

    if (result.relevant_scars?.length) {
      lines.push(``);
      lines.push(`Relevant scars (${result.relevant_scars.length}):`);
      for (const scar of result.relevant_scars) {
        const sev = (scar.severity || "medium").toUpperCase();
        lines.push(`  [${sev}] ${scar.title}`);
        if (scar.description) {
          lines.push(`    ${scar.description.slice(0, 150)}`);
        }
      }
    }

    if (result.recent_decisions?.length) {
      lines.push(``);
      lines.push(`Recent decisions (${result.recent_decisions.length}):`);
      for (const d of result.recent_decisions) {
        lines.push(`  - ${d.title} (${d.date})`);
      }
    }

    if (result.recent_wins?.length) {
      lines.push(``);
      lines.push(`Recent wins (${result.recent_wins.length}):`);
      for (const w of result.recent_wins) {
        lines.push(`  - ${w.title} (${w.date})`);
      }
    }

    if (result.project_state) {
      lines.push(``);
      lines.push(`Project state: ${result.project_state}`);
    }

    console.log(lines.join("\n"));
  } catch (error) {
    console.error("[gitmem session-refresh]", error.message || error);
    process.exit(1);
  }
}

/**
 * Install the bundled hooks plugin to ~/.claude/plugins/gitmem-hooks/
 *
 * Copies the hooks/ directory from this package into the Claude Code
 * plugins directory. Use --force to overwrite an existing installation.
 */
function cmdInstallHooks() {
  const force = process.argv.includes("--force");
  const hooksSource = join(__dirname, "..", "hooks");
  const pluginsDir = join(homedir(), ".claude", "plugins");
  const targetDir = join(pluginsDir, "gitmem-hooks");

  console.log("GitMem Hooks Plugin — Install");
  console.log("=============================");
  console.log("");

  // Check that bundled hooks exist
  if (!existsSync(hooksSource) || !existsSync(join(hooksSource, ".claude-plugin", "plugin.json"))) {
    console.error("Error: Bundled hooks directory not found.");
    console.error("Expected at:", hooksSource);
    console.error("Ensure the package is installed correctly.");
    process.exit(1);
  }

  // Check if already installed
  if (existsSync(targetDir) && !force) {
    console.log("Hooks plugin is already installed at:");
    console.log(`  ${targetDir}`);
    console.log("");
    console.log("To reinstall (overwrite), run:");
    console.log("  npx gitmem install-hooks --force");
    return;
  }

  // Create plugins directory if needed
  if (!existsSync(pluginsDir)) {
    mkdirSync(pluginsDir, { recursive: true });
  }

  // Copy hooks to target
  console.log(`Source:  ${hooksSource}`);
  console.log(`Target:  ${targetDir}`);
  console.log("");

  try {
    cpSync(hooksSource, targetDir, { recursive: true });
  } catch (err) {
    console.error("Error copying hooks plugin:", err.message);
    process.exit(1);
  }

  // Make shell scripts executable
  const scriptsDir = join(targetDir, "scripts");
  if (existsSync(scriptsDir)) {
    for (const file of readdirSync(scriptsDir)) {
      if (file.endsWith(".sh")) {
        chmodSync(join(scriptsDir, file), 0o755);
      }
    }
  }
  const testsDir = join(targetDir, "tests");
  if (existsSync(testsDir)) {
    for (const file of readdirSync(testsDir)) {
      if (file.endsWith(".sh")) {
        chmodSync(join(testsDir, file), 0o755);
      }
    }
  }

  console.log("Installed successfully!");
  console.log("");

  // Verify gitmem MCP is configured (non-blocking warning)
  let mcpFound = false;
  const mcpPaths = [
    join(process.cwd(), ".mcp.json"),
    join(process.cwd(), ".claude", "mcp.json"),
    join(homedir(), ".claude.json"),
  ];
  for (const p of mcpPaths) {
    if (existsSync(p)) {
      try {
        const cfg = JSON.parse(readFileSync(p, "utf-8"));
        const servers = cfg.mcpServers || {};
        if (servers.gitmem || servers["gitmem-mcp"]) {
          mcpFound = true;
          break;
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  if (!mcpFound) {
    console.log("WARNING: gitmem MCP server not detected in .mcp.json.");
    console.log("  Hooks will be silent until gitmem MCP is configured.");
    console.log("  Run: npx gitmem configure");
    console.log("");
  }

  console.log("Next steps:");
  console.log("  1. Restart Claude Code (exit and re-open)");
  console.log("  2. The plugin hooks will activate on next session");
  console.log("");
  console.log("To update after a gitmem version bump:");
  console.log("  npx gitmem install-hooks --force");
}

/**
 * Uninstall the hooks plugin from ~/.claude/plugins/gitmem-hooks/
 *
 * Removes the plugin directory, cleans up enabledPlugins from settings,
 * and removes temp state directories.
 */
function cmdUninstallHooks() {
  const pluginDir = join(homedir(), ".claude", "plugins", "gitmem-hooks");

  console.log("GitMem Hooks Plugin — Uninstall");
  console.log("===============================");
  console.log("");

  // Remove plugin directory
  if (existsSync(pluginDir)) {
    rmSync(pluginDir, { recursive: true, force: true });
    console.log("[uninstall] Removed plugin directory:", pluginDir);
  } else {
    console.log("[uninstall] Plugin directory not found (already removed)");
  }

  // Clean enabledPlugins from .claude/settings.json
  // (Key scar: claude plugin uninstall doesn't always clean this up)
  const settingsFiles = [
    join(process.cwd(), ".claude", "settings.json"),
    join(process.cwd(), ".claude", "settings.local.json"),
  ];

  for (const settingsPath of settingsFiles) {
    if (existsSync(settingsPath)) {
      try {
        const cfg = JSON.parse(readFileSync(settingsPath, "utf-8"));
        if (cfg.enabledPlugins) {
          let cleaned = false;
          for (const key of Object.keys(cfg.enabledPlugins)) {
            if (key.startsWith("gitmem-hooks")) {
              delete cfg.enabledPlugins[key];
              cleaned = true;
            }
          }
          if (cleaned) {
            writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + "\n");
            console.log(`[cleanup] Removed enabledPlugins entry from ${settingsPath}`);
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  // Clean temp state directories
  let cleaned = 0;
  try {
    const tmpDir = "/tmp";
    for (const entry of readdirSync(tmpDir)) {
      if (entry.startsWith("gitmem-hooks-")) {
        const fullPath = join(tmpDir, entry);
        try {
          if (statSync(fullPath).isDirectory()) {
            rmSync(fullPath, { recursive: true, force: true });
            cleaned++;
          }
        } catch {
          // ignore permission errors on other users' temp dirs
        }
      }
    }
  } catch {
    // /tmp read error — not critical
  }

  if (cleaned > 0) {
    console.log(`[cleanup] Removed ${cleaned} temp state director(ies) from /tmp/`);
  }

  // Clean debug log
  const debugLog = "/tmp/gitmem-hooks-plugin-debug.log";
  if (existsSync(debugLog)) {
    rmSync(debugLog, { force: true });
    console.log("[cleanup] Removed debug log");
  }

  console.log("");
  console.log("Uninstall complete.");
  console.log("");
  console.log("Notes:");
  console.log("  - gitmem MCP server config (.mcp.json) was NOT modified");
  console.log("  - Restart Claude Code for changes to take effect");
  console.log("  - To reinstall: npx gitmem install-hooks");
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
  case "install-hooks":
    cmdInstallHooks();
    break;
  case "uninstall-hooks":
    cmdUninstallHooks();
    break;
  case "session-start":
    cmdSessionStart();
    break;
  case "session-refresh":
    cmdSessionRefresh();
    break;
  case "server":
  case "--stdio":
    import("../dist/index.js");
    break;
  case "help":
  case "--help":
  case "-h":
    printUsage();
    break;
  case undefined:
    // Default: start MCP server (npx @nteg-dev/gitmem should start serving)
    import("../dist/index.js");
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}

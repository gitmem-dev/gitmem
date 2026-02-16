#!/usr/bin/env node

/**
 * GitMem CLI
 *
 * Commands:
 *   gitmem init            — Interactive setup wizard (detects, prompts, merges)
 *   gitmem uninstall       — Clean reverse of everything init did
 *   gitmem setup           — Output SQL to paste into Supabase SQL Editor (pro/dev)
 *   gitmem configure       — Generate .mcp.json entry for Claude Code
 *   gitmem check           — Run diagnostic health check
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
  npx gitmem-mcp init              Interactive setup wizard (recommended)
  npx gitmem-mcp init --yes        Non-interactive setup (accept all defaults)
  npx gitmem-mcp init --dry-run    Show what would be configured
  npx gitmem-mcp init --client cursor   Set up for Cursor IDE
  npx gitmem-mcp uninstall         Clean removal of gitmem from project
  npx gitmem-mcp uninstall --all   Also delete .gitmem/ data directory

Other commands:
  npx gitmem-mcp setup             Output SQL for Supabase schema setup (pro/dev tier)
  npx gitmem-mcp configure         Generate .mcp.json config for Claude Code / Cursor
  npx gitmem-mcp check             Run diagnostic health check
  npx gitmem-mcp check --full      Full diagnostic with benchmarks
  npx gitmem-mcp install-hooks     Install hooks (standalone)
  npx gitmem-mcp uninstall-hooks   Remove hooks (standalone)
  npx gitmem-mcp server            Start MCP server (default)
  npx gitmem-mcp help              Show this help message

Options:
  --client <claude|cursor>   Target IDE (auto-detected if not specified)
  --project <name>           Set project namespace
  --yes / -y                 Accept all defaults (non-interactive)
  --dry-run                  Show what would change without writing files

Quick Start:
  npx gitmem-mcp init              One command sets up everything
  npx gitmem-mcp uninstall         One command removes everything

Pro Tier (with Supabase):
  1. Create free Supabase project → database.new
  2. npx gitmem-mcp setup   (copy SQL → Supabase SQL Editor)
  3. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars
  4. npx gitmem-mcp init    (auto-detects pro tier)
  5. Start coding — memory is active!
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

  // Parse --project flag
  const projectIdx = process.argv.indexOf("--project");
  const projectArg = projectIdx !== -1 ? process.argv[projectIdx + 1] : null;

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

    // Write config.json (with project if specified via --project)
    const configPath = join(gitmemDir, "config.json");
    if (!existsSync(configPath)) {
      const config = {};
      if (projectArg) config.project = projectArg;
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      if (projectArg) {
        console.log(`  + Created .gitmem/config.json (project: "${projectArg}")`);
      } else {
        console.log("  + Created .gitmem/config.json");
      }
    } else if (projectArg) {
      // Config exists — update project field
      try {
        const existing = JSON.parse(readFileSync(configPath, "utf-8"));
        existing.project = projectArg;
        writeFileSync(configPath, JSON.stringify(existing, null, 2));
        console.log(`  + Updated .gitmem/config.json project: "${projectArg}"`);
      } catch {
        console.warn("  (Could not update config.json)");
      }
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

    // Auto-allow gitmem MCP tools in Claude Code project settings
    const claudeDir = join(process.cwd(), ".claude");
    const settingsPath = join(claudeDir, "settings.json");
    try {
      let settings = {};
      if (existsSync(settingsPath)) {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      } else {
        mkdirSync(claudeDir, { recursive: true });
      }
      const permissions = settings.permissions || {};
      const allow = permissions.allow || [];
      const pattern = "mcp__gitmem__*";
      if (!allow.includes(pattern)) {
        allow.push(pattern);
        settings.permissions = { ...permissions, allow };
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        console.log("  + Auto-allowed gitmem tools in .claude/settings.json");
      }
    } catch (err) {
      console.warn("  (Could not update .claude/settings.json — you may need to allow gitmem tools manually)");
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

  // Write/update .gitmem/config.json if --project specified
  if (projectArg) {
    const gitmemDir = join(process.cwd(), ".gitmem");
    if (!existsSync(gitmemDir)) {
      mkdirSync(gitmemDir, { recursive: true });
    }
    const configPath = join(gitmemDir, "config.json");
    let config = {};
    if (existsSync(configPath)) {
      try { config = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
    }
    config.project = projectArg;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`  + Set project: "${projectArg}" in .gitmem/config.json`);
    console.log("");
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

  // Auto-allow gitmem MCP tools in Claude Code project settings
  const claudeDir = join(process.cwd(), ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  try {
    let settings = {};
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } else {
      mkdirSync(claudeDir, { recursive: true });
    }
    const permissions = settings.permissions || {};
    const allow = permissions.allow || [];
    const pattern = "mcp__gitmem__*";
    if (!allow.includes(pattern)) {
      allow.push(pattern);
      settings.permissions = { ...permissions, allow };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log("  + Auto-allowed gitmem tools in .claude/settings.json");
    }
  } catch (err) {
    console.warn("  (Could not update .claude/settings.json — you may need to allow gitmem tools manually)");
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
          args: ["-y", "gitmem-mcp"],
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
          args: ["-y", "gitmem-mcp"],
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
  let project = undefined;
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
 * Install gitmem hooks as project-level hooks.
 *
 * Claude Code: writes to .claude/settings.json
 * Cursor: writes to .cursor/hooks.json
 *
 * Use --force to overwrite existing hook entries.
 * Use --client <claude|cursor> to target a specific IDE.
 */
function cmdInstallHooks() {
  const force = process.argv.includes("--force");
  const clientIdx = process.argv.indexOf("--client");
  const clientArg = clientIdx !== -1 ? process.argv[clientIdx + 1]?.toLowerCase() : null;
  const scriptsDir = join(__dirname, "..", "hooks", "scripts");

  // Detect client
  let clientName;
  if (clientArg === "cursor") {
    clientName = "cursor";
  } else if (clientArg === "claude") {
    clientName = "claude";
  } else if (clientArg) {
    console.error(`Error: Unknown client "${clientArg}". Use --client claude or --client cursor.`);
    process.exit(1);
  } else {
    // Auto-detect
    const hasCursorDir = existsSync(join(process.cwd(), ".cursor"));
    const hasClaudeDir = existsSync(join(process.cwd(), ".claude"));
    clientName = (hasCursorDir && !hasClaudeDir) ? "cursor" : "claude";
  }

  console.log(`GitMem Hooks — Install (${clientName === "cursor" ? "Cursor" : "Claude Code"})`);
  console.log("======================");
  console.log("");

  // Verify bundled scripts exist
  if (!existsSync(scriptsDir) || !existsSync(join(scriptsDir, "session-start.sh"))) {
    console.error("Error: Hook scripts not found at:", scriptsDir);
    console.error("Ensure gitmem-mcp is installed correctly.");
    process.exit(1);
  }

  // Make scripts executable
  for (const file of readdirSync(scriptsDir)) {
    if (file.endsWith(".sh")) {
      chmodSync(join(scriptsDir, file), 0o755);
    }
  }

  // Copy hook scripts to .gitmem/hooks/
  const gitmemDir = join(process.cwd(), ".gitmem");
  const destHooksDir = join(gitmemDir, "hooks");
  if (!existsSync(destHooksDir)) {
    mkdirSync(destHooksDir, { recursive: true });
  }
  for (const file of readdirSync(scriptsDir)) {
    if (file.endsWith(".sh")) {
      const src = join(scriptsDir, file);
      const dest = join(destHooksDir, file);
      writeFileSync(dest, readFileSync(src));
      chmodSync(dest, 0o755);
    }
  }

  const relScripts = ".gitmem/hooks";

  if (clientName === "cursor") {
    // Cursor: write to .cursor/hooks.json
    const cursorDir = join(process.cwd(), ".cursor");
    const hooksPath = join(cursorDir, "hooks.json");

    const gitmemHooks = {
      sessionStart: [{ command: `bash ${relScripts}/session-start.sh`, timeout: 5000 }],
      beforeMCPExecution: [
        { command: `bash ${relScripts}/credential-guard.sh`, timeout: 3000 },
        { command: `bash ${relScripts}/recall-check.sh`, timeout: 5000 },
      ],
      afterMCPExecution: [{ command: `bash ${relScripts}/post-tool-use.sh`, timeout: 3000 }],
      stop: [{ command: `bash ${relScripts}/session-close-check.sh`, timeout: 5000 }],
    };

    let config = {};
    if (existsSync(hooksPath)) {
      try {
        config = JSON.parse(readFileSync(hooksPath, "utf-8"));
      } catch {
        console.warn("  Warning: Could not parse existing .cursor/hooks.json, creating fresh");
      }
    } else {
      mkdirSync(cursorDir, { recursive: true });
    }

    if (config.hooks && !force) {
      const hasGitmem = JSON.stringify(config.hooks).includes("gitmem");
      if (hasGitmem) {
        console.log("GitMem hooks already installed in .cursor/hooks.json");
        console.log("");
        console.log("To reinstall (overwrite), run:");
        console.log("  npx gitmem-mcp install-hooks --client cursor --force");
        return;
      }
    }

    config.hooks = gitmemHooks;
    writeFileSync(hooksPath, JSON.stringify(config, null, 2));

    console.log("Hooks written to .cursor/hooks.json");
    console.log(`Scripts at: ${relScripts}/`);
    console.log("");
    console.log("Installed! Hooks will activate on next Cursor Agent session.");

  } else {
    // Claude Code: write to .claude/settings.json
    const claudeDir = join(process.cwd(), ".claude");
    const settingsPath = join(claudeDir, "settings.json");

    const gitmemHooks = {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: `bash ${relScripts}/session-start.sh`,
              statusMessage: "Initializing GitMem session...",
              timeout: 5000,
            },
          ],
        },
      ],
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: `bash ${relScripts}/credential-guard.sh`, timeout: 3000 }, { type: "command", command: `bash ${relScripts}/recall-check.sh`, timeout: 5000 }] },
        { matcher: "Read", hooks: [{ type: "command", command: `bash ${relScripts}/credential-guard.sh`, timeout: 3000 }] },
        { matcher: "Write", hooks: [{ type: "command", command: `bash ${relScripts}/recall-check.sh`, timeout: 5000 }] },
        { matcher: "Edit", hooks: [{ type: "command", command: `bash ${relScripts}/recall-check.sh`, timeout: 5000 }] },
      ],
      PostToolUse: [
        { matcher: "mcp__gitmem__recall", hooks: [{ type: "command", command: `bash ${relScripts}/post-tool-use.sh`, timeout: 3000 }] },
        { matcher: "mcp__gitmem__search", hooks: [{ type: "command", command: `bash ${relScripts}/post-tool-use.sh`, timeout: 3000 }] },
        { matcher: "Bash", hooks: [{ type: "command", command: `bash ${relScripts}/post-tool-use.sh`, timeout: 3000 }] },
        { matcher: "Write", hooks: [{ type: "command", command: `bash ${relScripts}/post-tool-use.sh`, timeout: 3000 }] },
        { matcher: "Edit", hooks: [{ type: "command", command: `bash ${relScripts}/post-tool-use.sh`, timeout: 3000 }] },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: `bash ${relScripts}/session-close-check.sh`,
              timeout: 5000,
            },
          ],
        },
      ],
    };

    let settings = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      } catch {
        console.warn("  Warning: Could not parse existing .claude/settings.json, creating fresh");
      }
    } else {
      mkdirSync(claudeDir, { recursive: true });
    }

    if (settings.hooks && !force) {
      const hasGitmem = JSON.stringify(settings.hooks).includes("gitmem");
      if (hasGitmem) {
        console.log("GitMem hooks already installed in .claude/settings.json");
        console.log("");
        console.log("To reinstall (overwrite), run:");
        console.log("  npx gitmem-mcp install-hooks --force");
        return;
      }
    }

    settings.hooks = gitmemHooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    console.log("Hooks written to .claude/settings.json");
    console.log(`Scripts at: ${relScripts}/`);
    console.log("");

    // Verify gitmem MCP is configured
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
      console.log("  Run: npx gitmem-mcp configure");
      console.log("");
    }

    console.log("Installed! Hooks will activate on next Claude Code session.");
  }

  console.log("");
  console.log("To update after a gitmem version bump:");
  console.log("  npx gitmem-mcp install-hooks --force");
}

/**
 * Uninstall gitmem hooks.
 *
 * Claude Code: removes from .claude/settings.json
 * Cursor: removes from .cursor/hooks.json
 *
 * Also cleans up legacy plugin directories and temp state.
 * Use --client <claude|cursor> to target a specific IDE.
 */
function cmdUninstallHooks() {
  const clientIdx = process.argv.indexOf("--client");
  const clientArg = clientIdx !== -1 ? process.argv[clientIdx + 1]?.toLowerCase() : null;

  // Detect client
  let clientName;
  if (clientArg === "cursor") {
    clientName = "cursor";
  } else if (clientArg === "claude") {
    clientName = "claude";
  } else if (clientArg) {
    console.error(`Error: Unknown client "${clientArg}". Use --client claude or --client cursor.`);
    process.exit(1);
  } else {
    const hasCursorDir = existsSync(join(process.cwd(), ".cursor"));
    const hasClaudeDir = existsSync(join(process.cwd(), ".claude"));
    clientName = (hasCursorDir && !hasClaudeDir) ? "cursor" : "claude";
  }

  console.log(`GitMem Hooks — Uninstall (${clientName === "cursor" ? "Cursor" : "Claude Code"})`);
  console.log("========================");
  console.log("");

  if (clientName === "cursor") {
    // Remove hooks from .cursor/hooks.json
    const hooksPath = join(process.cwd(), ".cursor", "hooks.json");
    if (existsSync(hooksPath)) {
      try {
        const cfg = JSON.parse(readFileSync(hooksPath, "utf-8"));
        if (cfg.hooks) {
          // Filter out gitmem hooks, preserve others
          const cleaned = {};
          let removed = 0;
          for (const [eventType, entries] of Object.entries(cfg.hooks)) {
            if (!Array.isArray(entries)) continue;
            const nonGitmem = entries.filter((e) => {
              if (typeof e.command === "string" && e.command.includes("gitmem")) {
                removed++;
                return false;
              }
              return true;
            });
            if (nonGitmem.length > 0) cleaned[eventType] = nonGitmem;
          }
          if (removed > 0) {
            if (Object.keys(cleaned).length > 0) {
              cfg.hooks = cleaned;
            } else {
              delete cfg.hooks;
            }
            writeFileSync(hooksPath, JSON.stringify(cfg, null, 2));
            console.log(`[uninstall] Removed ${removed} gitmem hooks from .cursor/hooks.json`);
          } else {
            console.log("[uninstall] No gitmem hooks found in .cursor/hooks.json");
          }
        } else {
          console.log("[uninstall] No hooks found in .cursor/hooks.json");
        }
      } catch {
        // ignore parse errors
      }
    } else {
      console.log("[uninstall] No .cursor/hooks.json found");
    }
  } else {
    // Remove hooks from .claude/settings.json
    const settingsPath = join(process.cwd(), ".claude", "settings.json");
    if (existsSync(settingsPath)) {
      try {
        const cfg = JSON.parse(readFileSync(settingsPath, "utf-8"));
        if (cfg.hooks) {
          delete cfg.hooks;
          writeFileSync(settingsPath, JSON.stringify(cfg, null, 2));
          console.log("[uninstall] Removed hooks from .claude/settings.json");
        } else {
          console.log("[uninstall] No hooks found in .claude/settings.json");
        }
        // Also clean legacy enabledPlugins
        if (cfg.enabledPlugins) {
          for (const key of Object.keys(cfg.enabledPlugins)) {
            if (key.startsWith("gitmem-hooks")) {
              delete cfg.enabledPlugins[key];
              writeFileSync(settingsPath, JSON.stringify(cfg, null, 2));
              console.log("[cleanup] Removed legacy enabledPlugins entry");
            }
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  // Clean legacy plugin directory (from old install-hooks)
  const pluginDir = join(homedir(), ".claude", "plugins", "gitmem-hooks");
  if (existsSync(pluginDir)) {
    rmSync(pluginDir, { recursive: true, force: true });
    console.log("[cleanup] Removed legacy plugin directory:", pluginDir);
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
  const mcpConfig = clientName === "cursor" ? ".cursor/mcp.json" : ".mcp.json";
  console.log(`Notes:`);
  console.log(`  - gitmem MCP server config (${mcpConfig}) was NOT modified`);
  console.log(`  - Restart ${clientName === "cursor" ? "Cursor" : "Claude Code"} for changes to take effect`);
  console.log(`  - To reinstall: npx gitmem-mcp install-hooks${clientName === "cursor" ? " --client cursor" : ""}`);
}

switch (command) {
  case "setup":
    cmdSetup();
    break;
  case "init":
    // New interactive wizard (replaces old cmdInit for CLI usage)
    import("./init-wizard.js");
    break;
  case "uninstall":
    import("./uninstall.js");
    break;
  case "init-scars":
    // Legacy: load starter scars only (old init behavior)
    cmdInit();
    break;
  case "configure":
    cmdConfigure();
    break;
  case "check":
    import("../dist/commands/check.js").then((m) => m.main(process.argv.slice(3)));
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
    // Default: start MCP server (npx gitmem-mcp should start serving)
    import("../dist/index.js");
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}

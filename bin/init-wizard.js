#!/usr/bin/env node

/**
 * GitMem Init Wizard
 *
 * Interactive setup that detects existing config, prompts, and merges.
 * Supports Claude Code and Cursor IDE.
 *
 * Usage: npx gitmem-mcp init [--yes] [--dry-run] [--project <name>] [--client <claude|cursor|vscode|windsurf|generic>]
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  chmodSync,
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();

// Parse flags
const args = process.argv.slice(2);
const autoYes = args.includes("--yes") || args.includes("-y");
const dryRun = args.includes("--dry-run");
const projectIdx = args.indexOf("--project");
const projectName = projectIdx !== -1 ? args[projectIdx + 1] : null;
const clientIdx = args.indexOf("--client");
const clientFlag = clientIdx !== -1 ? args[clientIdx + 1]?.toLowerCase() : null;

// ── Client Configuration ──

// Resolve user home directory for clients that use user-level config
const homeDir = process.env.HOME || process.env.USERPROFILE || "~";

const CLIENT_CONFIGS = {
  claude: {
    name: "Claude Code",
    mcpConfigPath: join(cwd, ".mcp.json"),
    mcpConfigName: ".mcp.json",
    mcpConfigScope: "project",
    instructionsFile: join(cwd, "CLAUDE.md"),
    instructionsName: "CLAUDE.md",
    templateFile: join(__dirname, "..", "CLAUDE.md.template"),
    startMarker: "<!-- gitmem:start -->",
    endMarker: "<!-- gitmem:end -->",
    configDir: join(cwd, ".claude"),
    settingsFile: join(cwd, ".claude", "settings.json"),
    settingsLocalFile: join(cwd, ".claude", "settings.local.json"),
    hasPermissions: true,
    hooksInSettings: true,
    hasHooks: true,
    completionMsg: "Setup complete! Start Claude Code \u2014 memory is active.",
  },
  cursor: {
    name: "Cursor",
    mcpConfigPath: join(cwd, ".cursor", "mcp.json"),
    mcpConfigName: ".cursor/mcp.json",
    mcpConfigScope: "project",
    instructionsFile: join(cwd, ".cursorrules"),
    instructionsName: ".cursorrules",
    templateFile: join(__dirname, "..", "cursorrules.template"),
    startMarker: "# --- gitmem:start ---",
    endMarker: "# --- gitmem:end ---",
    configDir: join(cwd, ".cursor"),
    settingsFile: null,
    settingsLocalFile: null,
    hasPermissions: false,
    hooksInSettings: false,
    hasHooks: true,
    hooksFile: join(cwd, ".cursor", "hooks.json"),
    hooksFileName: ".cursor/hooks.json",
    completionMsg: "Setup complete! Open Cursor (Agent mode) \u2014 memory is active.",
  },
  vscode: {
    name: "VS Code (Copilot)",
    mcpConfigPath: join(cwd, ".vscode", "mcp.json"),
    mcpConfigName: ".vscode/mcp.json",
    mcpConfigScope: "project",
    instructionsFile: join(cwd, ".github", "copilot-instructions.md"),
    instructionsName: ".github/copilot-instructions.md",
    templateFile: join(__dirname, "..", "copilot-instructions.template"),
    startMarker: "<!-- gitmem:start -->",
    endMarker: "<!-- gitmem:end -->",
    configDir: join(cwd, ".vscode"),
    settingsFile: null,
    settingsLocalFile: null,
    hasPermissions: false,
    hooksInSettings: false,
    hasHooks: false,
    completionMsg: "Setup complete! Open VS Code \u2014 memory is active via Copilot.",
  },
  windsurf: {
    name: "Windsurf",
    mcpConfigPath: join(homeDir, ".codeium", "windsurf", "mcp_config.json"),
    mcpConfigName: "~/.codeium/windsurf/mcp_config.json",
    mcpConfigScope: "user",
    instructionsFile: join(cwd, ".windsurfrules"),
    instructionsName: ".windsurfrules",
    templateFile: join(__dirname, "..", "windsurfrules.template"),
    startMarker: "# --- gitmem:start ---",
    endMarker: "# --- gitmem:end ---",
    configDir: null,
    settingsFile: null,
    settingsLocalFile: null,
    hasPermissions: false,
    hooksInSettings: false,
    hasHooks: false,
    completionMsg: "Setup complete! Open Windsurf \u2014 memory is active.",
  },
  generic: {
    name: "Generic MCP Client",
    mcpConfigPath: join(cwd, ".mcp.json"),
    mcpConfigName: ".mcp.json",
    mcpConfigScope: "project",
    instructionsFile: join(cwd, "CLAUDE.md"),
    instructionsName: "CLAUDE.md",
    templateFile: join(__dirname, "..", "CLAUDE.md.template"),
    startMarker: "<!-- gitmem:start -->",
    endMarker: "<!-- gitmem:end -->",
    configDir: null,
    settingsFile: null,
    settingsLocalFile: null,
    hasPermissions: false,
    hooksInSettings: false,
    hasHooks: false,
    completionMsg:
      "Setup complete! Configure your MCP client to use the gitmem server from .mcp.json.",
  },
};

// Shared paths (client-agnostic)
const gitmemDir = join(cwd, ".gitmem");
const gitignorePath = join(cwd, ".gitignore");
const starterScarsPath = join(__dirname, "..", "schema", "starter-scars.json");
const hooksScriptsDir = join(__dirname, "..", "hooks", "scripts");

let rl;
let client; // "claude" | "cursor" — set by detectClient()
let cc; // shorthand for CLIENT_CONFIGS[client]

// ── Client Detection ──

const VALID_CLIENTS = Object.keys(CLIENT_CONFIGS);

function detectClient() {
  // Explicit flag takes priority
  if (clientFlag) {
    if (!VALID_CLIENTS.includes(clientFlag)) {
      console.error(`  Error: Unknown client "${clientFlag}". Use --client ${VALID_CLIENTS.join("|")}.`);
      process.exit(1);
    }
    return clientFlag;
  }

  // Auto-detect based on directory/file presence
  const hasCursorDir = existsSync(join(cwd, ".cursor"));
  const hasClaudeDir = existsSync(join(cwd, ".claude"));
  const hasMcpJson = existsSync(join(cwd, ".mcp.json"));
  const hasClaudeMd = existsSync(join(cwd, "CLAUDE.md"));
  const hasCursorRules = existsSync(join(cwd, ".cursorrules"));
  const hasCursorMcp = existsSync(join(cwd, ".cursor", "mcp.json"));
  const hasVscodeDir = existsSync(join(cwd, ".vscode"));
  const hasVscodeMcp = existsSync(join(cwd, ".vscode", "mcp.json"));
  const hasCopilotInstructions = existsSync(join(cwd, ".github", "copilot-instructions.md"));
  const hasWindsurfRules = existsSync(join(cwd, ".windsurfrules"));
  const hasWindsurfMcp = existsSync(
    join(homeDir, ".codeium", "windsurf", "mcp_config.json")
  );

  // Strong Cursor signals
  if (hasCursorDir && !hasClaudeDir && !hasMcpJson && !hasClaudeMd) return "cursor";
  if (hasCursorRules && !hasClaudeMd && !hasCopilotInstructions) return "cursor";
  if (hasCursorMcp && !hasMcpJson && !hasVscodeMcp) return "cursor";

  // Strong Claude signals
  if (hasClaudeDir && !hasCursorDir && !hasVscodeDir) return "claude";
  if (hasMcpJson && !hasCursorMcp && !hasVscodeMcp) return "claude";
  if (hasClaudeMd && !hasCursorRules && !hasCopilotInstructions) return "claude";

  // VS Code signals
  if (hasVscodeMcp && !hasMcpJson && !hasCursorMcp) return "vscode";
  if (hasCopilotInstructions && !hasClaudeMd && !hasCursorRules) return "vscode";

  // Windsurf signals
  if (hasWindsurfRules && !hasClaudeMd && !hasCursorRules && !hasCopilotInstructions) return "windsurf";

  // Default to Claude Code (most common)
  return "claude";
}

// ── Helpers ──

async function confirm(message, defaultYes = true) {
  if (autoYes) return true;
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
  }
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await rl.question(`  ${message} ${suffix} `);
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "") return defaultYes;
  return trimmed === "y" || trimmed === "yes";
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function buildMcpConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    return { command: "npx", args: ["-y", "gitmem-mcp"] };
  }
  return {
    command: "npx",
    args: ["-y", "gitmem-mcp"],
    env: {
      SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY:
        process.env.SUPABASE_SERVICE_ROLE_KEY || "<your-service-role-key>",
      OPENAI_API_KEY:
        process.env.OPENAI_API_KEY || "<your-openai-key-or-remove>",
    },
  };
}

function buildClaudeHooks() {
  const relScripts = ".gitmem/hooks";
  return {
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
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: `bash ${relScripts}/auto-retrieve-hook.sh`,
            timeout: 3000,
          },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: `bash ${relScripts}/credential-guard.sh`,
            timeout: 3000,
          },
          {
            type: "command",
            command: `bash ${relScripts}/recall-check.sh`,
            timeout: 5000,
          },
        ],
      },
      {
        matcher: "Read",
        hooks: [
          {
            type: "command",
            command: `bash ${relScripts}/credential-guard.sh`,
            timeout: 3000,
          },
        ],
      },
      {
        matcher: "Write",
        hooks: [
          {
            type: "command",
            command: `bash ${relScripts}/recall-check.sh`,
            timeout: 5000,
          },
        ],
      },
      {
        matcher: "Edit",
        hooks: [
          {
            type: "command",
            command: `bash ${relScripts}/recall-check.sh`,
            timeout: 5000,
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "mcp__gitmem__recall",
        hooks: [
          {
            type: "command",
            command: `bash ${relScripts}/post-tool-use.sh`,
            timeout: 3000,
          },
        ],
      },
      {
        matcher: "mcp__gitmem__search",
        hooks: [
          {
            type: "command",
            command: `bash ${relScripts}/post-tool-use.sh`,
            timeout: 3000,
          },
        ],
      },
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: `bash ${relScripts}/post-tool-use.sh`,
            timeout: 3000,
          },
        ],
      },
      {
        matcher: "Write",
        hooks: [
          {
            type: "command",
            command: `bash ${relScripts}/post-tool-use.sh`,
            timeout: 3000,
          },
        ],
      },
      {
        matcher: "Edit",
        hooks: [
          {
            type: "command",
            command: `bash ${relScripts}/post-tool-use.sh`,
            timeout: 3000,
          },
        ],
      },
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
}

function buildCursorHooks() {
  const relScripts = ".gitmem/hooks";
  // Cursor hooks format: .cursor/hooks.json
  // Events: sessionStart, beforeMCPExecution, afterMCPExecution, stop
  // No per-tool matchers — all MCP calls go through beforeMCPExecution
  return {
    sessionStart: [
      {
        command: `bash ${relScripts}/session-start.sh`,
        timeout: 5000,
      },
    ],
    beforeMCPExecution: [
      {
        command: `bash ${relScripts}/credential-guard.sh`,
        timeout: 3000,
      },
      {
        command: `bash ${relScripts}/recall-check.sh`,
        timeout: 5000,
      },
    ],
    afterMCPExecution: [
      {
        command: `bash ${relScripts}/post-tool-use.sh`,
        timeout: 3000,
      },
    ],
    stop: [
      {
        command: `bash ${relScripts}/session-close-check.sh`,
        timeout: 5000,
      },
    ],
  };
}

function isGitmemHook(entry) {
  // Claude Code format: entry.hooks is an array of {command: "..."}
  if (entry.hooks && Array.isArray(entry.hooks)) {
    return entry.hooks.some(
      (h) => typeof h.command === "string" && h.command.includes("gitmem")
    );
  }
  // Cursor format: entry itself has {command: "..."}
  if (typeof entry.command === "string") {
    return entry.command.includes("gitmem");
  }
  return false;
}

function getInstructionsTemplate() {
  try {
    return readFileSync(cc.templateFile, "utf-8");
  } catch {
    return null;
  }
}

// ── Steps ──

async function stepMemoryStore() {
  const learningsPath = join(gitmemDir, "learnings.json");
  const exists = existsSync(learningsPath);
  let existingCount = 0;
  if (exists) {
    try {
      existingCount = JSON.parse(readFileSync(learningsPath, "utf-8")).length;
    } catch {}
  }

  let starterScars;
  try {
    starterScars = JSON.parse(readFileSync(starterScarsPath, "utf-8"));
  } catch {
    console.log("  ! Could not read starter-scars.json. Skipping.");
    return;
  }

  if (exists && existingCount >= starterScars.length) {
    console.log(
      `  Already configured (${existingCount} scars in .gitmem/). Skipping.`
    );
    return;
  }

  const prompt = exists
    ? `Merge ${starterScars.length} starter scars into .gitmem/? (${existingCount} existing)`
    : `Create .gitmem/ with ${starterScars.length} starter scars?`;

  if (!(await confirm(prompt))) {
    console.log("  Skipped.");
    return;
  }

  if (dryRun) {
    console.log(`  [dry-run] Would create .gitmem/ with ${starterScars.length} starter scars`);
    return;
  }

  if (!existsSync(gitmemDir)) {
    mkdirSync(gitmemDir, { recursive: true });
  }

  // Config
  const configPath = join(gitmemDir, "config.json");
  if (!existsSync(configPath)) {
    const config = {};
    if (projectName) config.project = projectName;
    writeJson(configPath, config);
  } else if (projectName) {
    const config = readJson(configPath) || {};
    config.project = projectName;
    writeJson(configPath, config);
  }

  // Merge scars
  let existing = [];
  if (existsSync(learningsPath)) {
    existing = readJson(learningsPath) || [];
  }
  const existingIds = new Set(existing.map((s) => s.id));
  let added = 0;
  const now = new Date().toISOString();
  for (const scar of starterScars) {
    if (!existingIds.has(scar.id)) {
      existing.push({ ...scar, created_at: now, source_date: now.slice(0, 10) });
      added++;
    }
  }
  writeJson(learningsPath, existing);

  // Empty collection files
  for (const file of ["sessions.json", "decisions.json", "scar-usage.json"]) {
    const filePath = join(gitmemDir, file);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, "[]");
    }
  }

  // Closing payload template — agents read this before writing closing-payload.json
  const templatePath = join(gitmemDir, "closing-payload-template.json");
  if (!existsSync(templatePath)) {
    writeJson(templatePath, {
      closing_reflection: {
        what_broke: "",
        what_took_longer: "",
        do_differently: "",
        what_worked: "",
        wrong_assumption: "",
        scars_applied: [],
        institutional_memory_items: "",
        collaborative_dynamic: "",
        rapport_notes: ""
      },
      task_completion: {
        questions_displayed_at: "ISO-8601 timestamp",
        reflection_completed_at: "ISO-8601 timestamp",
        human_asked_at: "ISO-8601 timestamp",
        human_response_at: "ISO-8601 timestamp",
        human_response: "no corrections | actual corrections text"
      },
      human_corrections: "",
      scars_to_record: [],
      learnings_created: [],
      open_threads: [],
      decisions: []
    });
  }

  console.log(
    `  Created .gitmem/ with ${starterScars.length} starter scars` +
      (added < starterScars.length
        ? ` (${added} new, ${starterScars.length - added} already existed)`
        : "")
  );
}

async function stepMcpServer() {
  const mcpPath = cc.mcpConfigPath;
  const mcpName = cc.mcpConfigName;
  const isUserLevel = cc.mcpConfigScope === "user";

  const existing = readJson(mcpPath);
  const hasGitmem =
    existing?.mcpServers?.gitmem || existing?.mcpServers?.["gitmem-mcp"];

  if (hasGitmem) {
    console.log(`  Already configured in ${mcpName}. Skipping.`);
    return;
  }

  const serverCount = existing?.mcpServers
    ? Object.keys(existing.mcpServers).length
    : 0;
  const tierLabel = process.env.SUPABASE_URL ? "pro" : "free";
  const scopeNote = isUserLevel ? " (user-level config)" : "";
  const prompt = existing
    ? `Add gitmem to ${mcpName}?${scopeNote} (${serverCount} existing server${serverCount !== 1 ? "s" : ""} preserved)`
    : `Create ${mcpName} with gitmem server?${scopeNote}`;

  if (!(await confirm(prompt))) {
    console.log("  Skipped.");
    return;
  }

  if (dryRun) {
    console.log(`  [dry-run] Would add gitmem entry to ${mcpName} (${tierLabel} tier${scopeNote})`);
    return;
  }

  // Ensure parent directory exists (for .cursor/mcp.json, .vscode/mcp.json, ~/.codeium/windsurf/)
  const parentDir = dirname(mcpPath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  const config = existing || { mcpServers: {} };
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers.gitmem = buildMcpConfig();
  writeJson(mcpPath, config);

  console.log(
    `  Added gitmem entry to ${mcpName} (${tierLabel} tier` +
      (process.env.SUPABASE_URL ? " \u2014 Supabase detected" : " \u2014 local storage") +
      ")" +
      (isUserLevel ? " [user-level]" : "")
  );
}

async function stepInstructions() {
  const template = getInstructionsTemplate();
  const instrName = cc.instructionsName;

  if (!template) {
    console.log(`  ! ${instrName} template not found. Skipping.`);
    return;
  }

  const instrPath = cc.instructionsFile;
  const exists = existsSync(instrPath);
  let content = exists ? readFileSync(instrPath, "utf-8") : "";

  if (content.includes(cc.startMarker)) {
    console.log(`  Already configured in ${instrName}. Skipping.`);
    return;
  }

  const prompt = exists
    ? `Append gitmem section to ${instrName}?`
    : `Create ${instrName} with gitmem instructions?`;

  if (!(await confirm(prompt))) {
    console.log("  Skipped.");
    return;
  }

  if (dryRun) {
    console.log(
      `  [dry-run] Would ${exists ? "append gitmem section to" : "create"} ${instrName}`
    );
    return;
  }

  // Template should already have delimiters, but ensure they're there
  let block = template;
  if (!block.includes(cc.startMarker)) {
    block = `${cc.startMarker}\n${block}\n${cc.endMarker}`;
  }

  // Ensure parent directory exists (for .github/copilot-instructions.md)
  const instrParentDir = dirname(instrPath);
  if (!existsSync(instrParentDir)) {
    mkdirSync(instrParentDir, { recursive: true });
  }

  if (exists) {
    content = content.trimEnd() + "\n\n" + block + "\n";
  } else {
    content = block + "\n";
  }

  writeFileSync(instrPath, content);
  console.log(
    `  ${exists ? "Added gitmem section to" : "Created"} ${instrName}`
  );
}

async function stepPermissions() {
  // Cursor doesn't have an equivalent permissions system
  if (!cc.hasPermissions) {
    console.log(`  Not needed for ${cc.name}. Skipping.`);
    return;
  }

  const existing = readJson(cc.settingsFile);
  const allow = existing?.permissions?.allow || [];
  const pattern = "mcp__gitmem__*";

  if (allow.includes(pattern)) {
    console.log(`  Already configured in ${cc.configDir}/settings.json. Skipping.`);
    return;
  }

  if (!(await confirm(`Add mcp__gitmem__* to ${cc.configDir}/settings.json?`))) {
    console.log("  Skipped.");
    return;
  }

  if (dryRun) {
    console.log("  [dry-run] Would add gitmem tool permissions");
    return;
  }

  const settings = existing || {};
  if (!existsSync(cc.configDir)) {
    mkdirSync(cc.configDir, { recursive: true });
  }
  const permissions = settings.permissions || {};
  const newAllow = permissions.allow || [];
  newAllow.push(pattern);
  settings.permissions = { ...permissions, allow: newAllow };
  writeJson(cc.settingsFile, settings);

  console.log("  Added gitmem tool permissions");
}

function copyHookScripts() {
  const destHooksDir = join(gitmemDir, "hooks");
  if (!existsSync(destHooksDir)) {
    mkdirSync(destHooksDir, { recursive: true });
  }
  if (existsSync(hooksScriptsDir)) {
    try {
      for (const file of readdirSync(hooksScriptsDir)) {
        if (file.endsWith(".sh")) {
          const src = join(hooksScriptsDir, file);
          const dest = join(destHooksDir, file);
          writeFileSync(dest, readFileSync(src));
          chmodSync(dest, 0o755);
        }
      }
    } catch {
      // Non-critical
    }
  }
}

async function stepHooks() {
  if (!cc.hasHooks) {
    console.log(`  ${cc.name} does not support lifecycle hooks. Skipping.`);
    console.log("  Enforcement relies on system prompt instructions instead.");
    return;
  }
  if (cc.hooksInSettings) {
    return stepHooksClaude();
  }
  return stepHooksCursor();
}

async function stepHooksClaude() {
  const existing = readJson(cc.settingsFile);
  const hooks = existing?.hooks || {};
  const hasGitmem = JSON.stringify(hooks).includes("gitmem");

  if (hasGitmem) {
    console.log("  Already configured in .claude/settings.json. Skipping.");
    return;
  }

  // Count existing non-gitmem hooks
  let existingHookCount = 0;
  for (const entries of Object.values(hooks)) {
    if (Array.isArray(entries)) {
      existingHookCount += entries.filter((e) => !isGitmemHook(e)).length;
    }
  }

  const prompt =
    existingHookCount > 0
      ? `Merge gitmem hooks into .claude/settings.json? (${existingHookCount} existing hook${existingHookCount !== 1 ? "s" : ""} preserved)`
      : "Add gitmem lifecycle hooks to .claude/settings.json?";

  if (!(await confirm(prompt))) {
    console.log("  Skipped.");
    return;
  }

  if (dryRun) {
    console.log("  [dry-run] Would merge 4 gitmem hook types");
    return;
  }

  copyHookScripts();

  const settings = existing || {};
  if (!existsSync(cc.configDir)) {
    mkdirSync(cc.configDir, { recursive: true });
  }

  const gitmemHooks = buildClaudeHooks();
  const merged = { ...(settings.hooks || {}) };

  for (const [eventType, gitmemEntries] of Object.entries(gitmemHooks)) {
    const existingEntries = merged[eventType] || [];
    const nonGitmem = existingEntries.filter((e) => !isGitmemHook(e));
    merged[eventType] = [...nonGitmem, ...gitmemEntries];
  }

  settings.hooks = merged;
  writeJson(cc.settingsFile, settings);

  const preservedMsg =
    existingHookCount > 0
      ? ` (${existingHookCount} existing hook${existingHookCount !== 1 ? "s" : ""} preserved)`
      : "";
  console.log(`  Merged 4 gitmem hook types${preservedMsg}`);

  // Warn about settings.local.json
  if (cc.settingsLocalFile && existsSync(cc.settingsLocalFile)) {
    const local = readJson(cc.settingsLocalFile);
    if (local?.hooks) {
      console.log("");
      console.log(
        "  Note: .claude/settings.local.json also has hooks."
      );
      console.log(
        "  Local hooks take precedence. You may need to manually merge."
      );
    }
  }
}

async function stepHooksCursor() {
  const hooksPath = cc.hooksFile;
  const hooksName = cc.hooksFileName;

  const existing = readJson(hooksPath);
  const hasGitmem = existing ? JSON.stringify(existing).includes("gitmem") : false;

  if (hasGitmem) {
    console.log(`  Already configured in ${hooksName}. Skipping.`);
    return;
  }

  // Count existing non-gitmem hooks
  let existingHookCount = 0;
  if (existing?.hooks) {
    for (const entries of Object.values(existing.hooks)) {
      if (Array.isArray(entries)) {
        existingHookCount += entries.filter((e) => !isGitmemHook(e)).length;
      }
    }
  }

  const prompt =
    existingHookCount > 0
      ? `Merge gitmem hooks into ${hooksName}? (${existingHookCount} existing hook${existingHookCount !== 1 ? "s" : ""} preserved)`
      : `Add gitmem lifecycle hooks to ${hooksName}?`;

  if (!(await confirm(prompt))) {
    console.log("  Skipped.");
    return;
  }

  if (dryRun) {
    console.log("  [dry-run] Would merge 4 gitmem hook types");
    return;
  }

  copyHookScripts();

  if (!existsSync(cc.configDir)) {
    mkdirSync(cc.configDir, { recursive: true });
  }

  const gitmemHooks = buildCursorHooks();
  const config = existing || {};
  const merged = { ...(config.hooks || {}) };

  for (const [eventType, gitmemEntries] of Object.entries(gitmemHooks)) {
    const existingEntries = merged[eventType] || [];
    const nonGitmem = existingEntries.filter((e) => !isGitmemHook(e));
    merged[eventType] = [...nonGitmem, ...gitmemEntries];
  }

  config.hooks = merged;
  writeJson(hooksPath, config);

  const preservedMsg =
    existingHookCount > 0
      ? ` (${existingHookCount} existing hook${existingHookCount !== 1 ? "s" : ""} preserved)`
      : "";
  console.log(`  Merged 4 gitmem hook types${preservedMsg}`);
}

async function stepGitignore() {
  const exists = existsSync(gitignorePath);
  let content = exists ? readFileSync(gitignorePath, "utf-8") : "";

  if (content.includes(".gitmem/")) {
    console.log("  Already configured in .gitignore. Skipping.");
    return;
  }

  if (!(await confirm("Add .gitmem/ to .gitignore?"))) {
    console.log("  Skipped.");
    return;
  }

  if (dryRun) {
    console.log("  [dry-run] Would add .gitmem/ to .gitignore");
    return;
  }

  if (exists) {
    content = content.trimEnd() + "\n.gitmem/\n";
  } else {
    content = ".gitmem/\n";
  }
  writeFileSync(gitignorePath, content);

  console.log(`  ${exists ? "Updated" : "Created"} .gitignore`);
}

// ── Main ──

async function main() {
  const pkg = readJson(join(__dirname, "..", "package.json"));
  const version = pkg?.version || "1.0.0";

  // Detect client before anything else
  client = detectClient();
  cc = CLIENT_CONFIGS[client];

  console.log("");
  console.log(`  gitmem v${version} \u2014 Setup for ${cc.name}`);
  if (dryRun) {
    console.log("  (dry-run mode \u2014 no files will be written)");
  }
  if (clientFlag) {
    console.log(`  (client: ${client} \u2014 via --client flag)`);
  } else {
    console.log(`  (client: ${client} \u2014 auto-detected)`);
  }
  console.log("");

  // Detect environment
  console.log("  Detecting environment...");
  const detections = [];

  if (existsSync(cc.mcpConfigPath)) {
    const mcp = readJson(cc.mcpConfigPath);
    const count = mcp?.mcpServers ? Object.keys(mcp.mcpServers).length : 0;
    detections.push(
      `  ${cc.mcpConfigName} found (${count} server${count !== 1 ? "s" : ""})`
    );
  }

  if (existsSync(cc.instructionsFile)) {
    const content = readFileSync(cc.instructionsFile, "utf-8");
    const hasGitmem = content.includes(cc.startMarker);
    detections.push(
      `  ${cc.instructionsName} found (${hasGitmem ? "has gitmem section" : "no gitmem section"})`
    );
  }

  if (cc.settingsFile && existsSync(cc.settingsFile)) {
    const settings = readJson(cc.settingsFile);
    const hookCount = settings?.hooks
      ? Object.values(settings.hooks).flat().length
      : 0;
    detections.push(
      `  .claude/settings.json found (${hookCount} hook${hookCount !== 1 ? "s" : ""})`
    );
  }

  if (!cc.hooksInSettings && cc.hasHooks && cc.hooksFile && existsSync(cc.hooksFile)) {
    const hooks = readJson(cc.hooksFile);
    const hookCount = hooks?.hooks
      ? Object.values(hooks.hooks).flat().length
      : 0;
    detections.push(
      `  ${cc.hooksFileName} found (${hookCount} hook${hookCount !== 1 ? "s" : ""})`
    );
  }

  if (existsSync(gitignorePath)) {
    detections.push("  .gitignore found");
  }

  if (existsSync(gitmemDir)) {
    detections.push("  .gitmem/ found");
  }

  for (const d of detections) {
    console.log(d);
  }

  const tier = process.env.SUPABASE_URL ? "pro" : "free";
  console.log(
    `  Tier: ${tier}` +
      (tier === "free" ? " (no SUPABASE_URL detected)" : " (SUPABASE_URL detected)")
  );
  console.log("");

  // Run steps — step count depends on client capabilities
  let stepCount = 4; // memory store + mcp server + instructions + gitignore
  if (cc.hasPermissions) stepCount++;
  if (cc.hasHooks) stepCount++;
  let step = 1;

  console.log(`  Step ${step}/${stepCount} \u2014 Memory Store`);
  await stepMemoryStore();
  console.log("");
  step++;

  console.log(`  Step ${step}/${stepCount} \u2014 MCP Server`);
  await stepMcpServer();
  console.log("");
  step++;

  console.log(`  Step ${step}/${stepCount} \u2014 Project Instructions`);
  await stepInstructions();
  console.log("");
  step++;

  if (cc.hasPermissions) {
    console.log(`  Step ${step}/${stepCount} \u2014 Tool Permissions`);
    await stepPermissions();
    console.log("");
    step++;
  }

  if (cc.hasHooks) {
    console.log(`  Step ${step}/${stepCount} \u2014 Lifecycle Hooks`);
    await stepHooks();
    console.log("");
    step++;
  }

  console.log(`  Step ${step}/${stepCount} \u2014 Gitignore`);
  await stepGitignore();
  console.log("");

  if (dryRun) {
    console.log("  Dry run complete \u2014 no files were modified.");
  } else {
    console.log(`  ${cc.completionMsg}`);
    console.log("  To remove: npx gitmem-mcp uninstall");
  }
  console.log("");

  if (rl) rl.close();
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  if (rl) rl.close();
  process.exit(1);
});

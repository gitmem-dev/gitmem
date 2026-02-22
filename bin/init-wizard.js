#!/usr/bin/env node

/**
 * GitMem Init Wizard — v2
 *
 * Non-interactive by default on fresh install. Prompts only when
 * existing config needs a merge decision.
 *
 * Usage: npx gitmem-mcp init [--yes] [--interactive] [--dry-run] [--project <name>] [--client <claude|cursor|vscode|windsurf|generic>]
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

// ── ANSI Colors — matches gitmem MCP display-protocol.ts ──

function useColor() {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.GITMEM_NO_COLOR !== undefined) return false;
  return true;
}

const _color = useColor();

const C = {
  reset: _color ? "\x1b[0m" : "",
  bold:  _color ? "\x1b[1m" : "",
  dim:   _color ? "\x1b[2m" : "",
  red:   _color ? "\x1b[31m" : "",   // brand accent (Racing Red)
  green: _color ? "\x1b[32m" : "",   // success
  yellow: _color ? "\x1b[33m" : "",  // warning / prompts
  underline: _color ? "\x1b[4m" : "",
  italic: _color ? "\x1b[3m" : "",
};

// Brand mark: ripple icon — dim outer ring, red inner ring, bold center dot
const RIPPLE = `${C.dim}(${C.reset}${C.red}(${C.reset}${C.bold}\u25cf${C.reset}${C.red})${C.reset}${C.dim})${C.reset}`;
const PRODUCT = `${RIPPLE} ${C.red}gitmem${C.reset}`;

const CHECK = `${C.bold}\u2714${C.reset}`;
const SKIP = `${C.dim}\u00b7${C.reset}`;
const WARN = `${C.yellow}!${C.reset}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Parse flags ──

const args = process.argv.slice(2);
const autoYes = args.includes("--yes") || args.includes("-y");
const interactive = args.includes("--interactive") || args.includes("-i");
const dryRun = args.includes("--dry-run");
const projectIdx = args.indexOf("--project");
const projectName = projectIdx !== -1 ? args[projectIdx + 1] : null;
const clientIdx = args.indexOf("--client");
const clientFlag = clientIdx !== -1 ? args[clientIdx + 1]?.toLowerCase() : null;

// ── Client Configuration ──

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
    completionVerb: "Start Claude Code",
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
    completionVerb: "Open Cursor (Agent mode)",
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
    completionVerb: "Open VS Code",
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
    completionVerb: "Open Windsurf",
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
    completionVerb: "Configure your MCP client with .mcp.json",
  },
};

// Shared paths
const gitmemDir = join(cwd, ".gitmem");
const gitignorePath = join(cwd, ".gitignore");
const starterScarsPath = join(__dirname, "..", "schema", "starter-scars.json");
const hooksScriptsDir = join(__dirname, "..", "hooks", "scripts");

let rl;
let client;
let cc;

// ── Client Detection ──

const VALID_CLIENTS = Object.keys(CLIENT_CONFIGS);

function detectClient() {
  if (clientFlag) {
    if (!VALID_CLIENTS.includes(clientFlag)) {
      console.error(`  Error: Unknown client "${clientFlag}". Use --client ${VALID_CLIENTS.join("|")}.`);
      process.exit(1);
    }
    return clientFlag;
  }

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

  if (hasCursorDir && !hasClaudeDir && !hasMcpJson && !hasClaudeMd) return "cursor";
  if (hasCursorRules && !hasClaudeMd && !hasCopilotInstructions) return "cursor";
  if (hasCursorMcp && !hasMcpJson && !hasVscodeMcp) return "cursor";

  if (hasClaudeDir && !hasCursorDir && !hasVscodeDir) return "claude";
  if (hasMcpJson && !hasCursorMcp && !hasVscodeMcp) return "claude";
  if (hasClaudeMd && !hasCursorRules && !hasCopilotInstructions) return "claude";

  if (hasVscodeMcp && !hasMcpJson && !hasCursorMcp) return "vscode";
  if (hasCopilotInstructions && !hasClaudeMd && !hasCursorRules) return "vscode";

  if (hasWindsurfRules && !hasClaudeMd && !hasCursorRules && !hasCopilotInstructions) return "windsurf";

  return "claude";
}

// ── Helpers ──

async function confirm(message, defaultYes = true) {
  if (autoYes) return true;
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
  }
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await rl.question(`${C.yellow}?${C.reset} ${message} ${C.dim}${suffix}${C.reset} `);
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

function log(icon, main, detail) {
  if (detail) {
    console.log(`${icon} ${C.bold}${main}${C.reset}`);
    console.log(`  ${C.dim}${detail}${C.reset}`);
  } else {
    console.log(`${icon} ${main}`);
  }
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
          { type: "command", command: `bash ${relScripts}/credential-guard.sh`, timeout: 3000 },
          { type: "command", command: `bash ${relScripts}/recall-check.sh`, timeout: 5000 },
        ],
      },
      {
        matcher: "Read",
        hooks: [
          { type: "command", command: `bash ${relScripts}/credential-guard.sh`, timeout: 3000 },
        ],
      },
      {
        matcher: "Write",
        hooks: [
          { type: "command", command: `bash ${relScripts}/recall-check.sh`, timeout: 5000 },
        ],
      },
      {
        matcher: "Edit",
        hooks: [
          { type: "command", command: `bash ${relScripts}/recall-check.sh`, timeout: 5000 },
        ],
      },
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
          { type: "command", command: `bash ${relScripts}/session-close-check.sh`, timeout: 5000 },
        ],
      },
    ],
  };
}

function buildCursorHooks() {
  const relScripts = ".gitmem/hooks";
  return {
    sessionStart: [{ command: `bash ${relScripts}/session-start.sh`, timeout: 5000 }],
    beforeMCPExecution: [
      { command: `bash ${relScripts}/credential-guard.sh`, timeout: 3000 },
      { command: `bash ${relScripts}/recall-check.sh`, timeout: 5000 },
    ],
    afterMCPExecution: [{ command: `bash ${relScripts}/post-tool-use.sh`, timeout: 3000 }],
    stop: [{ command: `bash ${relScripts}/session-close-check.sh`, timeout: 5000 }],
  };
}

function isGitmemHook(entry) {
  if (entry.hooks && Array.isArray(entry.hooks)) {
    return entry.hooks.some((h) => typeof h.command === "string" && h.command.includes("gitmem"));
  }
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

// ── Steps ──
// Each returns { done: bool } so main can track progress

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
    log(WARN, "Could not read starter lessons. Skipping.");
    return { done: false };
  }

  if (exists && existingCount >= starterScars.length) {
    log(CHECK, `Memory store already set up ${C.dim}(${existingCount} lessons in .gitmem/)${C.reset}`);
    return { done: false };
  }

  // Needs merge — prompt if existing data OR interactive mode
  if (exists || interactive) {
    const prompt = exists
      ? `Merge ${starterScars.length} lessons into .gitmem/? (${existingCount} existing)`
      : `Create .gitmem/ with ${starterScars.length} starter lessons?`;
    if (!(await confirm(prompt))) {
      log(SKIP, "Memory store skipped");
      return { done: false };
    }
  }

  if (dryRun) {
    log(CHECK, `Would create .gitmem/ with ${starterScars.length} starter lessons`, "[dry-run]");
    return { done: true };
  }

  if (!existsSync(gitmemDir)) {
    mkdirSync(gitmemDir, { recursive: true });
  }

  // Config
  const configPath = join(gitmemDir, "config.json");
  if (!existsSync(configPath)) {
    const config = { feedback_enabled: false, telemetry_enabled: false };
    if (projectName) config.project = projectName;
    writeJson(configPath, config);
  } else if (projectName) {
    const config = readJson(configPath) || {};
    config.project = projectName;
    writeJson(configPath, config);
  }

  // Closing payload template (prevents permission prompt on first session close)
  const payloadPath = join(gitmemDir, "closing-payload.json");
  if (!existsSync(payloadPath)) {
    writeJson(payloadPath, {
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
        questions_displayed_at: null,
        reflection_completed_at: null,
        human_asked_at: null,
        human_response_at: null,
        human_response: null
      },
      human_corrections: "",
      scars_to_record: [],
      learnings_created: [],
      open_threads: [],
      decisions: []
    });
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

  // Starter thread — nudges user to add their own project-specific scar
  const threadsPath = join(gitmemDir, "threads.json");
  if (!existsSync(threadsPath)) {
    writeJson(threadsPath, [
      {
        id: "t-welcome01",
        text: "Add your first project-specific scar from a real mistake — starter lessons are generic, yours will be relevant",
        status: "open",
        created_at: now,
      },
    ]);
  }

  // Empty collection files
  for (const file of ["sessions.json", "decisions.json", "scar-usage.json"]) {
    const filePath = join(gitmemDir, file);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, "[]");
    }
  }

  // Closing payload template
  const templatePath = join(gitmemDir, "closing-payload-template.json");
  if (!existsSync(templatePath)) {
    writeJson(templatePath, {
      closing_reflection: {
        what_broke: "", what_took_longer: "", do_differently: "",
        what_worked: "", wrong_assumption: "", scars_applied: [],
        institutional_memory_items: "", collaborative_dynamic: "", rapport_notes: ""
      },
      task_completion: {
        questions_displayed_at: "ISO-8601 timestamp",
        reflection_completed_at: "ISO-8601 timestamp",
        human_asked_at: "ISO-8601 timestamp",
        human_response_at: "ISO-8601 timestamp",
        human_response: "no corrections | actual corrections text"
      },
      human_corrections: "", scars_to_record: [],
      learnings_created: [], open_threads: [], decisions: []
    });
  }

  const mergeNote = added < starterScars.length
    ? ` (${added} new, ${starterScars.length - added} already existed)`
    : "";

  log(CHECK,
    "Created .gitmem/ \u2014 your local memory store",
    `${starterScars.length} lessons from common mistakes included${mergeNote}`
  );
  return { done: true };
}

async function stepMcpServer() {
  const mcpPath = cc.mcpConfigPath;
  const mcpName = cc.mcpConfigName;

  const existing = readJson(mcpPath);
  const hasGitmem = existing?.mcpServers?.gitmem || existing?.mcpServers?.["gitmem-mcp"];

  if (hasGitmem) {
    log(CHECK, `MCP server already configured ${C.dim}(${mcpName})${C.reset}`);
    return { done: false };
  }

  const serverCount = existing?.mcpServers ? Object.keys(existing.mcpServers).length : 0;

  // Existing servers — prompt for merge
  if ((existing && serverCount > 0) || interactive) {
    const prompt = existing
      ? `Add gitmem to ${mcpName}? (${serverCount} existing server${serverCount !== 1 ? "s" : ""} preserved)`
      : `Create ${mcpName} with gitmem server?`;
    if (!(await confirm(prompt))) {
      log(SKIP, "MCP server skipped");
      return { done: false };
    }
  }

  if (dryRun) {
    log(CHECK, `Would configure MCP server in ${mcpName}`, "[dry-run]");
    return { done: true };
  }

  const parentDir = dirname(mcpPath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  const config = existing || { mcpServers: {} };
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers.gitmem = buildMcpConfig();
  writeJson(mcpPath, config);

  const preserveNote = serverCount > 0 ? ` (${serverCount} existing server${serverCount !== 1 ? "s" : ""} preserved)` : "";
  log(CHECK,
    `Configured MCP server${preserveNote}`,
    `${cc.name} connects to gitmem automatically`
  );
  return { done: true };
}

async function stepInstructions() {
  const template = getInstructionsTemplate();
  const instrName = cc.instructionsName;

  if (!template) {
    log(WARN, `${instrName} template not found. Skipping.`);
    return { done: false };
  }

  const instrPath = cc.instructionsFile;
  const exists = existsSync(instrPath);
  let content = exists ? readFileSync(instrPath, "utf-8") : "";

  if (content.includes(cc.startMarker)) {
    log(CHECK, `Instructions already configured ${C.dim}(${instrName})${C.reset}`);
    return { done: false };
  }

  // Existing file without gitmem section — prompt for append
  if (exists || interactive) {
    const prompt = exists
      ? `Add gitmem section to existing ${instrName}?`
      : `Create ${instrName} with gitmem instructions?`;
    if (!(await confirm(prompt))) {
      log(SKIP, "Instructions skipped");
      return { done: false };
    }
  }

  if (dryRun) {
    log(CHECK, `Would ${exists ? "update" : "create"} ${instrName}`, "[dry-run]");
    return { done: true };
  }

  let block = template;
  if (!block.includes(cc.startMarker)) {
    block = `${cc.startMarker}\n${block}\n${cc.endMarker}`;
  }

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

  log(CHECK,
    `${exists ? "Updated" : "Created"} ${instrName}`,
    exists
      ? "Added gitmem section (your existing content is preserved)"
      : "Teaches your agent how to use memory"
  );
  return { done: true };
}

async function stepPermissions() {
  if (!cc.hasPermissions) return { done: false };

  const existing = readJson(cc.settingsFile);
  const allow = existing?.permissions?.allow || [];
  const pattern = "mcp__gitmem__*";

  if (allow.includes(pattern)) {
    log(CHECK, `Tool permissions already configured`);
    return { done: false };
  }

  if (interactive) {
    if (!(await confirm(`Auto-approve gitmem tools in ${cc.configDir}/settings.json?`))) {
      log(SKIP, "Tool permissions skipped");
      return { done: false };
    }
  }

  if (dryRun) {
    log(CHECK, "Would auto-approve gitmem tools", "[dry-run]");
    return { done: true };
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

  log(CHECK,
    "Auto-approved gitmem tools",
    "Memory tools run without interrupting you"
  );
  return { done: true };
}

async function stepHooks() {
  if (!cc.hasHooks) {
    return { done: false };
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
    log(CHECK, `Automatic memory hooks already configured`);
    return { done: false };
  }

  let existingHookCount = 0;
  for (const entries of Object.values(hooks)) {
    if (Array.isArray(entries)) {
      existingHookCount += entries.filter((e) => !isGitmemHook(e)).length;
    }
  }

  // Existing hooks — prompt for merge
  if (existingHookCount > 0 || interactive) {
    const prompt = existingHookCount > 0
      ? `Add memory hooks? (${existingHookCount} existing hook${existingHookCount !== 1 ? "s" : ""} preserved)`
      : "Add automatic memory hooks for session tracking?";
    if (!(await confirm(prompt))) {
      log(SKIP, "Hooks skipped");
      return { done: false };
    }
  }

  if (dryRun) {
    log(CHECK, "Would add automatic memory hooks", "[dry-run]");
    return { done: true };
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

  const preserveNote = existingHookCount > 0
    ? ` (${existingHookCount} existing hook${existingHookCount !== 1 ? "s" : ""} preserved)`
    : "";

  log(CHECK,
    `Added automatic memory hooks${preserveNote}`,
    "Sessions auto-start, memory retrieval on key actions"
  );

  if (cc.settingsLocalFile && existsSync(cc.settingsLocalFile)) {
    const local = readJson(cc.settingsLocalFile);
    if (local?.hooks) {
      console.log(`  ${C.yellow}Note:${C.reset} ${C.dim}.claude/settings.local.json also has hooks \u2014 may need manual merge${C.reset}`);
    }
  }

  return { done: true };
}

async function stepHooksCursor() {
  const hooksPath = cc.hooksFile;
  const hooksName = cc.hooksFileName;

  const existing = readJson(hooksPath);
  const hasGitmem = existing ? JSON.stringify(existing).includes("gitmem") : false;

  if (hasGitmem) {
    log(CHECK, `Automatic memory hooks already configured ${C.dim}(${hooksName})${C.reset}`);
    return { done: false };
  }

  let existingHookCount = 0;
  if (existing?.hooks) {
    for (const entries of Object.values(existing.hooks)) {
      if (Array.isArray(entries)) {
        existingHookCount += entries.filter((e) => !isGitmemHook(e)).length;
      }
    }
  }

  if (existingHookCount > 0 || interactive) {
    const prompt = existingHookCount > 0
      ? `Add memory hooks to ${hooksName}? (${existingHookCount} existing hook${existingHookCount !== 1 ? "s" : ""} preserved)`
      : `Add automatic memory hooks to ${hooksName}?`;
    if (!(await confirm(prompt))) {
      log(SKIP, "Hooks skipped");
      return { done: false };
    }
  }

  if (dryRun) {
    log(CHECK, "Would add automatic memory hooks", "[dry-run]");
    return { done: true };
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

  const preserveNote = existingHookCount > 0
    ? ` (${existingHookCount} existing hook${existingHookCount !== 1 ? "s" : ""} preserved)`
    : "";

  log(CHECK,
    `Added automatic memory hooks${preserveNote}`,
    "Sessions auto-start, memory retrieval on key actions"
  );
  return { done: true };
}

async function stepGitignore() {
  const exists = existsSync(gitignorePath);
  let content = exists ? readFileSync(gitignorePath, "utf-8") : "";

  if (content.includes(".gitmem/")) {
    log(CHECK, `.gitignore already configured`);
    return { done: false };
  }

  if (interactive) {
    if (!(await confirm("Add .gitmem/ to .gitignore?"))) {
      log(SKIP, "Gitignore skipped");
      return { done: false };
    }
  }

  if (dryRun) {
    log(CHECK, "Would update .gitignore", "[dry-run]");
    return { done: true };
  }

  if (exists) {
    content = content.trimEnd() + "\n.gitmem/\n";
  } else {
    content = ".gitmem/\n";
  }
  writeFileSync(gitignorePath, content);

  log(CHECK,
    `${exists ? "Updated" : "Created"} .gitignore`,
    "Memory stays local \u2014 not committed to your repo"
  );
  return { done: true };
}

async function stepAgentsMd() {
  const agentsPath = join(cwd, "AGENTS.md");
  const templatePath = join(__dirname, "..", "AGENTS.md.template");

  // Already exists — don't overwrite
  if (existsSync(agentsPath)) {
    const content = readFileSync(agentsPath, "utf-8");
    if (content.includes("GitMem")) {
      log(CHECK, `AGENTS.md already includes gitmem`);
      return { done: false };
    }
    // Existing AGENTS.md without gitmem — ask before appending
    if (interactive) {
      if (!(await confirm("Add gitmem section to existing AGENTS.md?"))) {
        log(SKIP, "AGENTS.md skipped");
        return { done: false };
      }
    }
  }

  let template;
  try {
    template = readFileSync(templatePath, "utf-8");
  } catch {
    // Template not found — skip silently
    return { done: false };
  }

  if (dryRun) {
    log(CHECK, `Would ${existsSync(agentsPath) ? "update" : "create"} AGENTS.md`, "[dry-run]");
    return { done: true };
  }

  if (existsSync(agentsPath)) {
    const existing = readFileSync(agentsPath, "utf-8");
    writeFileSync(agentsPath, existing.trimEnd() + "\n\n" + template + "\n");
    log(CHECK, "Updated AGENTS.md", "Added gitmem section (your existing content is preserved)");
  } else {
    writeFileSync(agentsPath, template + "\n");
    log(CHECK, "Created AGENTS.md", "IDE-agnostic agent discovery file");
  }

  return { done: true };
}

async function stepFeedbackOptIn() {
  const configPath = join(gitmemDir, "config.json");
  const config = readJson(configPath) || {};

  // Already opted in — skip
  if (config.feedback_enabled === true) {
    log(CHECK, "Feedback sharing already enabled");
    return { done: false };
  }

  // Non-interactive default install: show what's off and move on
  if (!interactive && autoYes) {
    log(CHECK,
      "Anonymous feedback sharing is off",
      "Run with --interactive to enable, or set feedback_enabled in .gitmem/config.json"
    );
    return { done: false };
  }

  // Ask the user
  const accepted = await confirm(
    "Help improve gitmem by sharing anonymous feedback? (no code, no content — just tool friction reports)",
    false  // default No
  );

  if (!accepted) {
    log(CHECK,
      "Anonymous feedback sharing is off",
      "You can enable it later in .gitmem/config.json"
    );
    return { done: false };
  }

  if (dryRun) {
    log(CHECK, "Would enable feedback sharing in config.json", "[dry-run]");
    return { done: true };
  }

  config.feedback_enabled = true;
  writeJson(configPath, config);

  log(CHECK,
    "Anonymous feedback sharing enabled",
    "Agents can report friction \u2014 no code or content is ever sent"
  );
  return { done: true };
}

// ── Main ──

async function main() {
  const pkg = readJson(join(__dirname, "..", "package.json"));
  const version = pkg?.version || "1.0.0";

  client = detectClient();
  cc = CLIENT_CONFIGS[client];

  // ── Header — matches gitmem MCP product line format ──
  console.log("");
  console.log(`${PRODUCT} \u2500\u2500 init v${version}`);
  console.log(`${C.dim}Setting up for ${cc.name}${clientFlag ? "" : " (auto-detected)"}${C.reset}`);

  if (dryRun) {
    console.log(`${C.dim}dry-run mode \u2014 no files will be written${C.reset}`);
  }

  console.log("");

  // ── Run steps ──

  let configured = 0;

  const d = _color && !dryRun ? 500 : 0;

  const r1 = await stepMemoryStore();
  if (r1.done) configured++;
  if (d) await sleep(d);

  const r2 = await stepMcpServer();
  if (r2.done) configured++;
  if (d) await sleep(d);

  const r3 = await stepInstructions();
  if (r3.done) configured++;
  if (d) await sleep(d);

  if (cc.hasPermissions) {
    const r4 = await stepPermissions();
    if (r4.done) configured++;
    if (d) await sleep(d);
  }

  if (cc.hasHooks) {
    const r5 = await stepHooks();
    if (r5.done) configured++;
    if (d) await sleep(d);
  }

  const r6 = await stepGitignore();
  if (r6.done) configured++;

  const r6b = await stepAgentsMd();
  if (r6b.done) configured++;

  const r7 = await stepFeedbackOptIn();
  if (r7.done) configured++;

  // ── Footer ──
  if (dryRun) {
    console.log(`${C.dim}Dry run complete \u2014 no files were modified.${C.reset}`);
  } else if (configured === 0) {
    console.log(`${C.dim}gitmem-mcp is already installed and configured.${C.reset}`);
    console.log(`${C.dim}Need help? ${C.reset}${C.red}https://gitmem.ai/docs${C.reset}`);
  } else {
    console.log("");
    console.log("───────────────────────────────────────────────────");
    console.log("");
    console.log(`${PRODUCT} ${C.red}${C.bold}installed successfully!${C.reset}`);
    console.log(`${C.dim}Docs:${C.reset}  ${C.red}https://gitmem.ai/docs${C.reset}`);
    console.log("");
    console.log(`${C.dim}Try asking your agent:${C.reset}`);
    console.log(`  ${C.italic}"Review the gitmem tools, test them, convince yourself"${C.reset}`);
  }

  console.log("");

  if (rl) rl.close();
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  if (rl) rl.close();
  process.exit(1);
});

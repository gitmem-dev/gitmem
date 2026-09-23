#!/usr/bin/env node

/**
 * GitMem Uninstall
 *
 * Cleanly reverses everything `npx gitmem-mcp init` did.
 * Supports Claude Code and Cursor IDE.
 *
 * Usage: npx gitmem-mcp uninstall [--yes] [--all] [--client <claude|cursor>]
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline/promises";
import { storeRoot, repoGitmemDir, displayPath } from "./gitmem-root.js";
import { removeGitmemHooks, backupFile } from "./hooks-merge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();

const args = process.argv.slice(2);
const autoYes = args.includes("--yes") || args.includes("-y");
const deleteAll = args.includes("--all");
const clientIdx = args.indexOf("--client");
const clientFlag = clientIdx !== -1 ? args[clientIdx + 1]?.toLowerCase() : null;

// ── Colors (brand-matched to init wizard) ──

const _color =
  !process.env.NO_COLOR &&
  !process.env.GITMEM_NO_COLOR &&
  process.stdout.isTTY;

const C = {
  reset: _color ? "\x1b[0m" : "",
  bold:  _color ? "\x1b[1m" : "",
  dim:   _color ? "\x1b[2m" : "",
  red:   _color ? "\x1b[31m" : "",
  green: _color ? "\x1b[32m" : "",
  yellow: _color ? "\x1b[33m" : "",
};

const RIPPLE = `${C.dim}(${C.reset}${C.red}(${C.reset}${C.bold}\u25cf${C.reset}${C.red})${C.reset}${C.dim})${C.reset}`;
const PRODUCT = `${RIPPLE} ${C.red}gitmem${C.reset}`;
const CHECK = `${C.bold}\u2714${C.reset}`;
const SKIP = `${C.dim}\u00b7${C.reset}`;

let actionsTaken = 0;

function log(icon, msg, extra) {
  if (icon === CHECK) actionsTaken++;
  const suffix = extra ? ` ${C.dim}${extra}${C.reset}` : "";
  console.log(`${icon} ${msg}${suffix}`);
}

// ── Client Configuration ──

const CLIENT_CONFIGS = {
  claude: {
    name: "Claude Code",
    mcpConfigPath: join(cwd, ".mcp.json"),
    mcpConfigName: ".mcp.json",
    instructionsFile: join(cwd, "CLAUDE.md"),
    instructionsName: "CLAUDE.md",
    startMarker: "<!-- gitmem:start -->",
    endMarker: "<!-- gitmem:end -->",
    configDir: join(cwd, ".claude"),
    settingsFile: join(cwd, ".claude", "settings.json"),
    hasPermissions: true,
    hooksInSettings: true,
  },
  cursor: {
    name: "Cursor",
    mcpConfigPath: join(cwd, ".cursor", "mcp.json"),
    mcpConfigName: ".cursor/mcp.json",
    instructionsFile: join(cwd, ".cursorrules"),
    instructionsName: ".cursorrules",
    startMarker: "# --- gitmem:start ---",
    endMarker: "# --- gitmem:end ---",
    configDir: join(cwd, ".cursor"),
    settingsFile: null,
    hasPermissions: false,
    hooksInSettings: false,
    hooksFile: join(cwd, ".cursor", "hooks.json"),
    hooksFileName: ".cursor/hooks.json",
  },
};

// ── Client Detection ──

function detectClient() {
  if (clientFlag) {
    if (clientFlag !== "claude" && clientFlag !== "cursor") {
      console.error(`  Error: Unknown client "${clientFlag}". Use --client claude or --client cursor.`);
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

  if (hasCursorDir && !hasClaudeDir && !hasMcpJson && !hasClaudeMd) return "cursor";
  if (hasCursorRules && !hasClaudeMd) return "cursor";
  if (hasCursorMcp && !hasMcpJson) return "cursor";

  if (hasClaudeDir && !hasCursorDir) return "claude";
  if (hasMcpJson && !hasCursorMcp) return "claude";
  if (hasClaudeMd && !hasCursorRules) return "claude";

  return "claude";
}

const client = detectClient();
const cc = CLIENT_CONFIGS[client];

// GIT-115: the repo's .gitmem/ (config.json + hooks) and the store the
// server reads are separate, and handled separately below.
const repoDir = repoGitmemDir(cwd);
const storeDir = storeRoot();
const gitignorePath = join(cwd, ".gitignore");

let rl;

// ── Helpers ──

async function confirm(message, defaultYes = true) {
  if (autoYes) return defaultYes;
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

// ── Steps ──

function stepInstructions() {
  if (!existsSync(cc.instructionsFile)) {
    log(SKIP, `No ${cc.instructionsName} found`);
    return;
  }

  let content = readFileSync(cc.instructionsFile, "utf-8");

  if (!content.includes(cc.startMarker)) {
    log(SKIP, `No gitmem section in ${cc.instructionsName}`);
    return;
  }

  const startIdx = content.indexOf(cc.startMarker);
  const endIdx = content.indexOf(cc.endMarker);
  if (startIdx === -1 || endIdx === -1) {
    log(SKIP, `Malformed gitmem markers in ${cc.instructionsName}`);
    return;
  }

  const before = content.slice(0, startIdx).trimEnd();
  const after = content.slice(endIdx + cc.endMarker.length).trimStart();
  const result = before + (before && after ? "\n\n" : "") + after;

  if (result.trim() === "") {
    rmSync(cc.instructionsFile);
    log(CHECK, `Removed ${cc.instructionsName}`, "(was gitmem-only)");
  } else {
    writeFileSync(cc.instructionsFile, result.trimEnd() + "\n");
    log(CHECK, `Stripped gitmem section from ${cc.instructionsName}`, "(your content preserved)");
  }
}

function stepMcpJson() {
  const config = readJson(cc.mcpConfigPath);
  if (!config?.mcpServers) {
    log(SKIP, `No ${cc.mcpConfigName} found`);
    return;
  }

  const had = !!config.mcpServers.gitmem || !!config.mcpServers["gitmem-mcp"];
  if (!had) {
    log(SKIP, `No gitmem in ${cc.mcpConfigName}`);
    return;
  }

  delete config.mcpServers.gitmem;
  delete config.mcpServers["gitmem-mcp"];

  const remaining = Object.keys(config.mcpServers).length;
  writeJson(cc.mcpConfigPath, config);
  if (remaining > 0) {
    log(CHECK, `Removed gitmem server`, `(${remaining} other server${remaining !== 1 ? "s" : ""} preserved)`);
  } else {
    log(CHECK, `Removed gitmem server from ${cc.mcpConfigName}`);
  }
}

function stepHooks() {
  if (cc.hooksInSettings) {
    return stepHooksClaude();
  }
  return stepHooksCursor();
}

/**
 * GIT-120 matching: remove only the commands gitmem installed. A matcher group
 * keeps its other commands; the hooks key goes only when nothing is left.
 */
function removeHooksFrom(file, name) {
  const cfg = readJson(file);
  if (!cfg?.hooks) {
    log(SKIP, `No hooks in ${name}`);
    return;
  }
  const result = removeGitmemHooks(cfg.hooks);
  if (result.removed === 0) {
    log(SKIP, "No gitmem hooks found");
    return;
  }
  if (result.hooks) cfg.hooks = result.hooks; else delete cfg.hooks;
  const backup = backupFile(file);
  writeJson(file, cfg);
  const kept = result.kept > 0 ? `(${result.kept} other hook${result.kept !== 1 ? "s" : ""} preserved)` : "";
  log(CHECK, "Removed automatic memory hooks", [kept, backup ? `backup: ${displayPath(backup)}` : ""].filter(Boolean).join(" "));
}

function stepHooksClaude() {
  removeHooksFrom(cc.settingsFile, ".claude/settings.json");
}

function stepHooksCursor() {
  removeHooksFrom(cc.hooksFile, cc.hooksFileName);
}

function stepPermissions() {
  if (!cc.hasPermissions) {
    log(SKIP, `Not needed for ${cc.name}`);
    return;
  }

  const settings = readJson(cc.settingsFile);
  const allow = settings?.permissions?.allow;
  if (!Array.isArray(allow)) {
    log(SKIP, "No permissions in .claude/settings.json");
    return;
  }

  const pattern = "mcp__gitmem__*";
  const idx = allow.indexOf(pattern);
  if (idx === -1) {
    log(SKIP, "No gitmem permissions found");
    return;
  }

  allow.splice(idx, 1);
  settings.permissions.allow = allow;

  if (allow.length === 0) {
    delete settings.permissions.allow;
  }
  if (
    settings.permissions &&
    Object.keys(settings.permissions).length === 0
  ) {
    delete settings.permissions;
  }

  writeJson(cc.settingsFile, settings);
  log(CHECK, "Removed tool permissions");
}

/**
 * GIT-115: the repo's .gitmem/ holds gitmem's config.json and hooks/, which
 * are this repo's integration and go with it. Anything else in there (a store
 * from an older install) is left alone.
 */
function stepRepoDir() {
  if (!existsSync(repoDir)) {
    log(SKIP, "No .gitmem/ in this repo");
    return;
  }
  for (const entry of ["config.json", "hooks"]) {
    rmSync(join(repoDir, entry), { recursive: true, force: true });
  }
  const rest = readdirSync(repoDir);
  if (rest.length === 0) {
    rmSync(repoDir, { recursive: true, force: true });
    log(CHECK, "Removed .gitmem/ from this repo", "(config.json and hooks)");
  } else {
    log(CHECK, "Removed .gitmem/config.json and .gitmem/hooks/",
      `(${rest.length} other file${rest.length !== 1 ? "s" : ""} left in .gitmem/)`);
  }
}

/**
 * The memory store is shared by every project on this machine, so it is kept
 * unless --all is given or the user says to delete it.
 */
async function stepGitmemDir() {
  const name = displayPath(storeDir);
  if (!existsSync(storeDir)) {
    log(SKIP, `No memory store at ${name}`);
    return;
  }

  if (deleteAll) {
    rmSync(storeDir, { recursive: true, force: true });
    log(CHECK, `Deleted memory store ${name}`);
    return;
  }

  if (await confirm(`Keep memory store ${name}? (shared by every project on this machine)`, true)) {
    log(CHECK, `${name} preserved — your memories will be there if you reinstall`);
  } else {
    rmSync(storeDir, { recursive: true, force: true });
    log(CHECK, `Deleted memory store ${name}`);
  }
}

function stepGitignore() {
  if (!existsSync(gitignorePath)) return;

  let content = readFileSync(gitignorePath, "utf-8");
  if (!content.includes(".gitmem/")) return;

  const lines = content.split("\n");
  const filtered = lines.filter((line) => line.trim() !== ".gitmem/");
  writeFileSync(gitignorePath, filtered.join("\n"));
  log(CHECK, "Cleaned .gitignore");
}

// ── Main ──

async function main() {
  const pkg = readJson(join(__dirname, "..", "package.json"));
  const version = pkg?.version || "1.0.0";

  console.log("");
  console.log(`${PRODUCT} \u2500\u2500 uninstall v${version}`);
  console.log(`${C.dim}Removing gitmem from ${cc.name}${clientFlag ? "" : " (auto-detected)"}${C.reset}`);
  console.log("");

  stepInstructions();
  stepMcpJson();
  stepHooks();
  stepPermissions();
  stepRepoDir();
  await stepGitmemDir();
  stepGitignore();

  console.log("");
  if (actionsTaken > 0) {
    console.log(`${C.dim}gitmem-mcp has been removed.${C.reset}`);
    console.log(`${C.dim}Reinstall anytime: ${C.reset}${C.red}npx gitmem-mcp init${C.reset}`);
  } else {
    console.log(`${C.dim}gitmem-mcp is not installed in this project.${C.reset}`);
    console.log(`${C.dim}Install: ${C.reset}${C.red}npx gitmem-mcp init${C.reset}`);
  }
  console.log("");

  if (rl) rl.close();
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  if (rl) rl.close();
  process.exit(1);
});

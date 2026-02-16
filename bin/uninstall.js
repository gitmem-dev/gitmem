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
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();

const args = process.argv.slice(2);
const autoYes = args.includes("--yes") || args.includes("-y");
const deleteAll = args.includes("--all");
const clientIdx = args.indexOf("--client");
const clientFlag = clientIdx !== -1 ? args[clientIdx + 1]?.toLowerCase() : null;

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

const gitmemDir = join(cwd, ".gitmem");
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

// ── Steps ──

function stepInstructions() {
  if (!existsSync(cc.instructionsFile)) {
    console.log(`  No ${cc.instructionsName} found. Skipping.`);
    return;
  }

  let content = readFileSync(cc.instructionsFile, "utf-8");

  if (!content.includes(cc.startMarker)) {
    console.log(`  No gitmem section in ${cc.instructionsName}. Skipping.`);
    return;
  }

  const startIdx = content.indexOf(cc.startMarker);
  const endIdx = content.indexOf(cc.endMarker);
  if (startIdx === -1 || endIdx === -1) {
    console.log(`  Malformed gitmem markers in ${cc.instructionsName}. Skipping.`);
    return;
  }

  // Remove the block including markers and surrounding whitespace
  const before = content.slice(0, startIdx).trimEnd();
  const after = content.slice(endIdx + cc.endMarker.length).trimStart();

  const result = before + (before && after ? "\n\n" : "") + after;

  if (result.trim() === "") {
    rmSync(cc.instructionsFile);
    console.log(`  Removed ${cc.instructionsName} (was gitmem-only)`);
  } else {
    writeFileSync(cc.instructionsFile, result.trimEnd() + "\n");
    console.log(`  Stripped gitmem section from ${cc.instructionsName}`);
  }
}

function stepMcpJson() {
  const config = readJson(cc.mcpConfigPath);
  if (!config?.mcpServers) {
    console.log(`  No ${cc.mcpConfigName} found. Skipping.`);
    return;
  }

  const had = !!config.mcpServers.gitmem || !!config.mcpServers["gitmem-mcp"];
  if (!had) {
    console.log(`  No gitmem in ${cc.mcpConfigName}. Skipping.`);
    return;
  }

  delete config.mcpServers.gitmem;
  delete config.mcpServers["gitmem-mcp"];

  const remaining = Object.keys(config.mcpServers).length;
  writeJson(cc.mcpConfigPath, config);
  console.log(
    `  Removed gitmem server (${remaining} other server${remaining !== 1 ? "s" : ""} preserved)`
  );
}

function stepHooks() {
  if (cc.hooksInSettings) {
    return stepHooksClaude();
  }
  return stepHooksCursor();
}

function stepHooksClaude() {
  const settings = readJson(cc.settingsFile);
  if (!settings?.hooks) {
    console.log("  No hooks in .claude/settings.json. Skipping.");
    return;
  }

  let removed = 0;
  let preserved = 0;
  const cleaned = {};

  for (const [eventType, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    const nonGitmem = entries.filter((e) => {
      if (isGitmemHook(e)) {
        removed++;
        return false;
      }
      preserved++;
      return true;
    });
    if (nonGitmem.length > 0) {
      cleaned[eventType] = nonGitmem;
    }
  }

  if (removed === 0) {
    console.log("  No gitmem hooks found. Skipping.");
    return;
  }

  if (Object.keys(cleaned).length > 0) {
    settings.hooks = cleaned;
  } else {
    delete settings.hooks;
  }

  writeJson(cc.settingsFile, settings);
  console.log(
    `  Removed gitmem hooks` +
      (preserved > 0
        ? ` (${preserved} other hook${preserved !== 1 ? "s" : ""} preserved)`
        : "")
  );
}

function stepHooksCursor() {
  const config = readJson(cc.hooksFile);
  if (!config?.hooks) {
    console.log(`  No hooks in ${cc.hooksFileName}. Skipping.`);
    return;
  }

  let removed = 0;
  let preserved = 0;
  const cleaned = {};

  for (const [eventType, entries] of Object.entries(config.hooks)) {
    if (!Array.isArray(entries)) continue;
    const nonGitmem = entries.filter((e) => {
      if (isGitmemHook(e)) {
        removed++;
        return false;
      }
      preserved++;
      return true;
    });
    if (nonGitmem.length > 0) {
      cleaned[eventType] = nonGitmem;
    }
  }

  if (removed === 0) {
    console.log("  No gitmem hooks found. Skipping.");
    return;
  }

  if (Object.keys(cleaned).length > 0) {
    config.hooks = cleaned;
  } else {
    delete config.hooks;
  }

  writeJson(cc.hooksFile, config);
  console.log(
    `  Removed gitmem hooks` +
      (preserved > 0
        ? ` (${preserved} other hook${preserved !== 1 ? "s" : ""} preserved)`
        : "")
  );
}

function stepPermissions() {
  if (!cc.hasPermissions) {
    console.log(`  Not needed for ${cc.name}. Skipping.`);
    return;
  }

  const settings = readJson(cc.settingsFile);
  const allow = settings?.permissions?.allow;
  if (!Array.isArray(allow)) {
    console.log("  No permissions in .claude/settings.json. Skipping.");
    return;
  }

  const pattern = "mcp__gitmem__*";
  const idx = allow.indexOf(pattern);
  if (idx === -1) {
    console.log("  No gitmem permissions found. Skipping.");
    return;
  }

  allow.splice(idx, 1);
  settings.permissions.allow = allow;

  // Clean up empty permissions
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
  console.log("  Removed mcp__gitmem__* from permissions.allow");
}

async function stepGitmemDir() {
  if (!existsSync(gitmemDir)) {
    console.log("  No .gitmem/ directory. Skipping.");
    return;
  }

  if (deleteAll) {
    rmSync(gitmemDir, { recursive: true, force: true });
    console.log("  Deleted .gitmem/ directory");
    return;
  }

  console.log(
    "  This contains your memory data (scars, sessions, decisions)."
  );

  // Default to No for data deletion
  if (await confirm("Delete .gitmem/?", false)) {
    rmSync(gitmemDir, { recursive: true, force: true });
    console.log("  Deleted .gitmem/ directory");
  } else {
    console.log("  Skipped — .gitmem/ preserved.");
  }
}

function stepGitignore() {
  if (!existsSync(gitignorePath)) return;

  let content = readFileSync(gitignorePath, "utf-8");
  if (!content.includes(".gitmem/")) return;

  // Remove the .gitmem/ line
  const lines = content.split("\n");
  const filtered = lines.filter((line) => line.trim() !== ".gitmem/");
  writeFileSync(gitignorePath, filtered.join("\n"));
}

// ── Main ──

async function main() {
  console.log("");
  console.log(`  gitmem — Uninstall (${cc.name})`);
  if (clientFlag) {
    console.log(`  (client: ${client} — via --client flag)`);
  } else {
    console.log(`  (client: ${client} — auto-detected)`);
  }
  console.log("");

  const stepCount = cc.hasPermissions ? 5 : 4;
  let step = 1;

  console.log(`  Step ${step}/${stepCount} — Remove gitmem section from ${cc.instructionsName}`);
  stepInstructions();
  console.log("");
  step++;

  console.log(`  Step ${step}/${stepCount} — Remove gitmem from ${cc.mcpConfigName}`);
  stepMcpJson();
  console.log("");
  step++;

  const hooksTarget = cc.hooksInSettings ? ".claude/settings.json" : cc.hooksFileName;
  console.log(`  Step ${step}/${stepCount} — Remove gitmem hooks from ${hooksTarget}`);
  stepHooks();
  console.log("");
  step++;

  if (cc.hasPermissions) {
    console.log(`  Step ${step}/${stepCount} — Remove gitmem permissions from .claude/settings.json`);
    stepPermissions();
    console.log("");
    step++;
  }

  console.log(`  Step ${step}/${stepCount} — Delete .gitmem/ directory?`);
  await stepGitmemDir();

  // Also clean .gitignore entry
  stepGitignore();

  console.log("");
  console.log("  Uninstall complete.");
  console.log("");

  if (rl) rl.close();
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  if (rl) rl.close();
  process.exit(1);
});

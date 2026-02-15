#!/usr/bin/env node

/**
 * GitMem Uninstall
 *
 * Cleanly reverses everything `npx gitmem init` did.
 * Usage: npx gitmem uninstall [--yes] [--all]
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

const gitmemDir = join(cwd, ".gitmem");
const mcpJsonPath = join(cwd, ".mcp.json");
const claudeMdPath = join(cwd, "CLAUDE.md");
const claudeDir = join(cwd, ".claude");
const settingsPath = join(claudeDir, "settings.json");
const gitignorePath = join(cwd, ".gitignore");

let rl;

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
  if (!entry.hooks || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (h) => typeof h.command === "string" && h.command.includes("gitmem")
  );
}

// ── Steps ──

function stepClaudeMd() {
  if (!existsSync(claudeMdPath)) {
    console.log("  No CLAUDE.md found. Skipping.");
    return;
  }

  let content = readFileSync(claudeMdPath, "utf-8");
  const startMarker = "<!-- gitmem:start -->";
  const endMarker = "<!-- gitmem:end -->";

  if (!content.includes(startMarker)) {
    console.log("  No gitmem section in CLAUDE.md. Skipping.");
    return;
  }

  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    console.log("  Malformed gitmem markers in CLAUDE.md. Skipping.");
    return;
  }

  // Remove the block including markers and surrounding whitespace
  const before = content.slice(0, startIdx).trimEnd();
  const after = content.slice(endIdx + endMarker.length).trimStart();

  const result = before + (before && after ? "\n\n" : "") + after;

  if (result.trim() === "") {
    // CLAUDE.md would be empty — delete it
    rmSync(claudeMdPath);
    console.log("  Removed CLAUDE.md (was gitmem-only)");
  } else {
    writeFileSync(claudeMdPath, result.trimEnd() + "\n");
    console.log("  Stripped gitmem section from CLAUDE.md");
  }
}

function stepMcpJson() {
  const config = readJson(mcpJsonPath);
  if (!config?.mcpServers) {
    console.log("  No .mcp.json found. Skipping.");
    return;
  }

  const had = !!config.mcpServers.gitmem || !!config.mcpServers["gitmem-mcp"];
  if (!had) {
    console.log("  No gitmem in .mcp.json. Skipping.");
    return;
  }

  delete config.mcpServers.gitmem;
  delete config.mcpServers["gitmem-mcp"];

  const remaining = Object.keys(config.mcpServers).length;
  writeJson(mcpJsonPath, config);
  console.log(
    `  Removed gitmem server (${remaining} other server${remaining !== 1 ? "s" : ""} preserved)`
  );
}

function stepHooks() {
  const settings = readJson(settingsPath);
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

  writeJson(settingsPath, settings);
  console.log(
    `  Removed gitmem hooks` +
      (preserved > 0
        ? ` (${preserved} other hook${preserved !== 1 ? "s" : ""} preserved)`
        : "")
  );
}

function stepPermissions() {
  const settings = readJson(settingsPath);
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

  writeJson(settingsPath, settings);
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
  console.log("  gitmem — Uninstall");
  console.log("");

  console.log("  Step 1/5 — Remove gitmem section from CLAUDE.md");
  stepClaudeMd();
  console.log("");

  console.log("  Step 2/5 — Remove gitmem from .mcp.json");
  stepMcpJson();
  console.log("");

  console.log("  Step 3/5 — Remove gitmem hooks from .claude/settings.json");
  stepHooks();
  console.log("");

  console.log(
    "  Step 4/5 — Remove gitmem permissions from .claude/settings.json"
  );
  stepPermissions();
  console.log("");

  console.log("  Step 5/5 — Delete .gitmem/ directory?");
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

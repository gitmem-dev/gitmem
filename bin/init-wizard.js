#!/usr/bin/env node

/**
 * GitMem Init Wizard
 *
 * Interactive setup that detects existing config, prompts, and merges.
 * Usage: npx gitmem-mcp init [--yes] [--dry-run] [--project <name>]
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

// Paths
const gitmemDir = join(cwd, ".gitmem");
const mcpJsonPath = join(cwd, ".mcp.json");
const claudeMdPath = join(cwd, "CLAUDE.md");
const claudeDir = join(cwd, ".claude");
const settingsPath = join(claudeDir, "settings.json");
const settingsLocalPath = join(claudeDir, "settings.local.json");
const gitignorePath = join(cwd, ".gitignore");
const templatePath = join(__dirname, "..", "CLAUDE.md.template");
const starterScarsPath = join(__dirname, "..", "schema", "starter-scars.json");
const hooksScriptsDir = join(__dirname, "..", "hooks", "scripts");

let rl;

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

function buildHooks() {
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

function isGitmemHook(entry) {
  if (!entry.hooks || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (h) => typeof h.command === "string" && h.command.includes("gitmem")
  );
}

function getClaudeMdTemplate() {
  try {
    return readFileSync(templatePath, "utf-8");
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

  console.log(
    `  Created .gitmem/ with ${starterScars.length} starter scars` +
      (added < starterScars.length
        ? ` (${added} new, ${starterScars.length - added} already existed)`
        : "")
  );
}

async function stepMcpServer() {
  const existing = readJson(mcpJsonPath);
  const hasGitmem =
    existing?.mcpServers?.gitmem || existing?.mcpServers?.["gitmem-mcp"];

  if (hasGitmem) {
    console.log("  Already configured in .mcp.json. Skipping.");
    return;
  }

  const serverCount = existing?.mcpServers
    ? Object.keys(existing.mcpServers).length
    : 0;
  const tierLabel = process.env.SUPABASE_URL ? "pro" : "free";
  const prompt = existing
    ? `Add gitmem to .mcp.json? (${serverCount} existing server${serverCount !== 1 ? "s" : ""} preserved)`
    : "Create .mcp.json with gitmem server?";

  if (!(await confirm(prompt))) {
    console.log("  Skipped.");
    return;
  }

  if (dryRun) {
    console.log(`  [dry-run] Would add gitmem entry to .mcp.json (${tierLabel} tier)`);
    return;
  }

  const config = existing || { mcpServers: {} };
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers.gitmem = buildMcpConfig();
  writeJson(mcpJsonPath, config);

  console.log(
    `  Added gitmem entry to .mcp.json (${tierLabel} tier` +
      (process.env.SUPABASE_URL ? " — Supabase detected" : " — local storage") +
      ")"
  );
}

async function stepClaudeMd() {
  const template = getClaudeMdTemplate();
  if (!template) {
    console.log("  ! CLAUDE.md.template not found. Skipping.");
    return;
  }

  const exists = existsSync(claudeMdPath);
  let content = exists ? readFileSync(claudeMdPath, "utf-8") : "";

  if (content.includes("<!-- gitmem:start -->")) {
    console.log("  Already configured in CLAUDE.md. Skipping.");
    return;
  }

  const prompt = exists
    ? "Append gitmem section to CLAUDE.md?"
    : "Create CLAUDE.md with gitmem instructions?";

  if (!(await confirm(prompt))) {
    console.log("  Skipped.");
    return;
  }

  if (dryRun) {
    console.log(
      `  [dry-run] Would ${exists ? "append gitmem section to" : "create"} CLAUDE.md`
    );
    return;
  }

  // Template should already have delimiters, but ensure they're there
  let block = template;
  if (!block.includes("<!-- gitmem:start -->")) {
    block = `<!-- gitmem:start -->\n${block}\n<!-- gitmem:end -->`;
  }

  if (exists) {
    content = content.trimEnd() + "\n\n" + block + "\n";
  } else {
    content = block + "\n";
  }

  writeFileSync(claudeMdPath, content);
  console.log(
    `  ${exists ? "Added gitmem section to" : "Created"} CLAUDE.md`
  );
}

async function stepPermissions() {
  const existing = readJson(settingsPath);
  const allow = existing?.permissions?.allow || [];
  const pattern = "mcp__gitmem__*";

  if (allow.includes(pattern)) {
    console.log("  Already configured in .claude/settings.json. Skipping.");
    return;
  }

  if (!(await confirm("Add mcp__gitmem__* to .claude/settings.json?"))) {
    console.log("  Skipped.");
    return;
  }

  if (dryRun) {
    console.log("  [dry-run] Would add gitmem tool permissions");
    return;
  }

  const settings = existing || {};
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }
  const permissions = settings.permissions || {};
  const newAllow = permissions.allow || [];
  newAllow.push(pattern);
  settings.permissions = { ...permissions, allow: newAllow };
  writeJson(settingsPath, settings);

  console.log("  Added gitmem tool permissions");
}

async function stepHooks() {
  const existing = readJson(settingsPath);
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

  // Copy hook scripts to .gitmem/hooks/ (works regardless of npx vs local install)
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

  const settings = existing || {};
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  const gitmemHooks = buildHooks();
  const merged = { ...(settings.hooks || {}) };

  for (const [eventType, gitmemEntries] of Object.entries(gitmemHooks)) {
    const existingEntries = merged[eventType] || [];
    const nonGitmem = existingEntries.filter((e) => !isGitmemHook(e));
    merged[eventType] = [...nonGitmem, ...gitmemEntries];
  }

  settings.hooks = merged;
  writeJson(settingsPath, settings);

  const preservedMsg =
    existingHookCount > 0
      ? ` (${existingHookCount} existing hook${existingHookCount !== 1 ? "s" : ""} preserved)`
      : "";
  console.log(`  Merged 4 gitmem hook types${preservedMsg}`);

  // Warn about settings.local.json
  if (existsSync(settingsLocalPath)) {
    const local = readJson(settingsLocalPath);
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

  console.log("");
  console.log(`  gitmem v${version} — Setup`);
  if (dryRun) {
    console.log("  (dry-run mode — no files will be written)");
  }
  console.log("");

  // Detect environment
  console.log("  Detecting environment...");
  const detections = [];

  if (existsSync(mcpJsonPath)) {
    const mcp = readJson(mcpJsonPath);
    const count = mcp?.mcpServers ? Object.keys(mcp.mcpServers).length : 0;
    detections.push(
      `  .mcp.json found (${count} server${count !== 1 ? "s" : ""})`
    );
  }

  if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, "utf-8");
    const hasGitmem = content.includes("<!-- gitmem:start -->");
    detections.push(
      `  CLAUDE.md found (${hasGitmem ? "has gitmem section" : "no gitmem section"})`
    );
  }

  if (existsSync(settingsPath)) {
    const settings = readJson(settingsPath);
    const hookCount = settings?.hooks
      ? Object.values(settings.hooks).flat().length
      : 0;
    detections.push(
      `  .claude/settings.json found (${hookCount} hook${hookCount !== 1 ? "s" : ""})`
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

  // Run steps
  console.log("  Step 1/6 — Memory Store");
  await stepMemoryStore();
  console.log("");

  console.log("  Step 2/6 — MCP Server");
  await stepMcpServer();
  console.log("");

  console.log("  Step 3/6 — Project Instructions");
  await stepClaudeMd();
  console.log("");

  console.log("  Step 4/6 — Tool Permissions");
  await stepPermissions();
  console.log("");

  console.log("  Step 5/6 — Lifecycle Hooks");
  await stepHooks();
  console.log("");

  console.log("  Step 6/6 — Gitignore");
  await stepGitignore();
  console.log("");

  if (dryRun) {
    console.log("  Dry run complete — no files were modified.");
  } else {
    console.log("  Setup complete! Start Claude Code — memory is active.");
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

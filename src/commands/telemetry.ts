/**
 * CLI commands for telemetry control
 *
 * gitmem telemetry status
 * gitmem telemetry enable
 * gitmem telemetry disable
 * gitmem telemetry show [--limit N]
 * gitmem telemetry clear
 */

import { getTelemetry, Telemetry } from "../lib/telemetry.js";
import { join } from "path";
import { readFileSync } from "fs";

const VERSION = getPackageVersion();

function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function getGitmemDir(): string {
  return join(process.cwd(), ".gitmem");
}

export function main(args: string[]): void {
  const subcommand = args[0];
  const gitmemDir = getGitmemDir();
  const telemetry = getTelemetry(gitmemDir, VERSION);

  switch (subcommand) {
    case "status":
      cmdStatus(telemetry);
      break;
    case "enable":
      cmdEnable(telemetry);
      break;
    case "disable":
      cmdDisable(telemetry);
      break;
    case "show":
      cmdShow(telemetry, args);
      break;
    case "clear":
      cmdClear(telemetry);
      break;
    default:
      printUsage();
      process.exit(1);
  }
}

function cmdStatus(telemetry: Telemetry): void {
  const status = telemetry.getStatus();

  console.log("GitMem Telemetry — Status");
  console.log("========================\n");

  if (status.enabled) {
    console.log("Status: \x1b[32mEnabled\x1b[0m");
    console.log(`Session ID: ${status.session_id} (random, not persistent)`);
    console.log(`Events logged: ${status.event_count} (local)`);
    if (status.consented_at) {
      const date = new Date(status.consented_at).toLocaleDateString();
      console.log(`Consented: ${date}`);
    }
    console.log("");
    console.log("What's collected:");
    console.log("  • Tool names (recall, session_close, etc.)");
    console.log("  • Success/failure status");
    console.log("  • Execution duration");
    console.log("  • Result counts (not content)");
    console.log("  • Platform (darwin, linux, win32)");
    console.log("  • Version number");
    console.log("");
    console.log("What's NOT collected:");
    console.log("  ✗ Queries or search terms");
    console.log("  ✗ Scar/learning content");
    console.log("  ✗ Project names or file paths");
    console.log("  ✗ IP addresses or identifiers");
    console.log("");
    console.log("Commands:");
    console.log("  gitmem telemetry show      View pending events");
    console.log("  gitmem telemetry disable   Turn off telemetry");
    console.log("");
    console.log("Privacy policy: https://gitmem.ai/privacy");
  } else {
    console.log("Status: \x1b[33mDisabled\x1b[0m");
    console.log("");
    console.log("No data is being sent.");
    console.log("");
    console.log("To help improve GitMem:");
    console.log("  gitmem telemetry enable");
    console.log("");
    console.log("Privacy policy: https://gitmem.ai/privacy");
  }
}

function cmdEnable(telemetry: Telemetry): void {
  console.log("GitMem Telemetry — Enable");
  console.log("=========================\n");

  console.log("Help improve GitMem by sending anonymous usage data.\n");
  console.log("What we collect:");
  console.log("  ✓ Tool usage patterns (which tools are most useful)");
  console.log("  ✓ Error rates (to prioritize fixes)");
  console.log("  ✓ Performance metrics (duration, platform)");
  console.log("");
  console.log("What we DON'T collect:");
  console.log("  ✗ Your queries or content");
  console.log("  ✗ Scar/learning text");
  console.log("  ✗ Project names or file paths");
  console.log("  ✗ IP addresses or persistent IDs");
  console.log("");
  console.log("Transparency:");
  console.log("  • All events logged to .gitmem/telemetry.log");
  console.log("  • View before sending: gitmem telemetry show");
  console.log("  • Disable anytime: gitmem telemetry disable");
  console.log("");
  console.log("Full privacy policy: https://gitmem.ai/privacy");
  console.log("");

  // Prompt for confirmation (skip if --yes flag)
  if (!process.argv.includes("--yes") && !process.argv.includes("-y")) {
    const readline = require("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question("Enable telemetry? [y/N] ", (answer: string) => {
      rl.close();

      if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
        telemetry.enable();
        console.log("");
        console.log("\x1b[32m✓\x1b[0m Telemetry enabled");
        console.log("  Data logged to: .gitmem/telemetry.log");
        console.log("  Review anytime: gitmem telemetry show");
        console.log("  Disable anytime: gitmem telemetry disable");
      } else {
        console.log("");
        console.log("Telemetry not enabled.");
      }
    });
  } else {
    telemetry.enable();
    console.log("\x1b[32m✓\x1b[0m Telemetry enabled (--yes flag)");
  }
}

function cmdDisable(telemetry: Telemetry): void {
  telemetry.disable();

  console.log("GitMem Telemetry — Disable");
  console.log("==========================\n");
  console.log("\x1b[32m✓\x1b[0m Telemetry disabled");
  console.log("  Pending events: will not be sent");
  console.log("  Local logs: preserved at .gitmem/telemetry.log");
  console.log("");
  console.log("To re-enable: gitmem telemetry enable");
}

function cmdShow(telemetry: Telemetry, args: string[]): void {
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 100;

  const events = telemetry.getRecentEvents(limit);

  console.log(`GitMem Telemetry — Recent Events (last ${Math.min(limit, events.length)})`);
  console.log("=".repeat(60));
  console.log("");

  if (events.length === 0) {
    console.log("No events logged yet.");
    console.log("");
    console.log("Events are logged automatically as you use gitmem tools.");
    return;
  }

  for (const eventJson of events) {
    console.log(Telemetry.formatEvent(eventJson));
  }

  console.log("");
  console.log(`Total events: ${events.length}`);
  console.log(`Status: ${telemetry.isEnabled() ? "\x1b[32mEnabled\x1b[0m (will be sent)" : "\x1b[33mDisabled\x1b[0m (logged only)"}`);
}

function cmdClear(telemetry: Telemetry): void {
  const status = telemetry.getStatus();
  const count = status.event_count;

  telemetry.clearLog();

  console.log("GitMem Telemetry — Clear");
  console.log("========================\n");
  console.log("\x1b[32m✓\x1b[0m Cleared all local telemetry logs");
  console.log(`  Events removed: ${count}`);
  console.log("");
  console.log("Note: Remote data (already sent) cannot be deleted.");
  console.log("      It's already anonymous and not linked to you.");
}

function printUsage(): void {
  console.log(`
GitMem Telemetry — Control

Usage:
  gitmem telemetry status           Show current status
  gitmem telemetry enable           Enable anonymous usage tracking
  gitmem telemetry disable          Disable usage tracking
  gitmem telemetry show [--limit N] View recent events (default: 100)
  gitmem telemetry clear            Clear local event log

Privacy:
  • Opt-in only (disabled by default)
  • No PII (queries, scars, project names, IPs)
  • Transparent (local logs before sending)
  • Anonymous (random session IDs, not persistent)

Full policy: https://gitmem.ai/privacy
`);
}

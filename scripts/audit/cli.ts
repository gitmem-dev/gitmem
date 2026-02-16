#!/usr/bin/env npx tsx
/**
 * Cast File Audit Pipeline — CLI Entry Point
 *
 * Scans a directory of asciinema .cast recordings, detects gitmem events,
 * and outputs structured JSON reports measuring helpfulness and frictionlessness.
 *
 * Usage:
 *   npx tsx scripts/audit/cli.ts [recordings-dir]
 *   npm run audit:sessions
 *   npm run audit:sessions | jq .headline_metrics
 *
 * Default recordings dir: /home/claude/recordings
 */

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyzeSession } from "./session-analyzer.js";
import { aggregate } from "./aggregate-report.js";
import type { SessionReport } from "./types.js";

const DEFAULT_RECORDINGS_DIR = "/home/claude/recordings";
const ACTIVE_THRESHOLD_SEC = 60;

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

async function main(): Promise<void> {
  const dir = resolve(process.argv[2] || DEFAULT_RECORDINGS_DIR);

  log(`Scanning: ${dir}`);

  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".cast"))
      .sort();
  } catch (err) {
    log(`Error reading directory: ${dir}`);
    process.exit(1);
  }

  log(`Found ${files.length} .cast files`);

  const sessions: SessionReport[] = [];
  let skippedActive = 0;
  let errors = 0;

  for (let i = 0; i < files.length; i++) {
    const filePath = join(dir, files[i]);

    // Skip actively recording files (mtime < 60s ago)
    const stat = statSync(filePath);
    const ageSeconds = (Date.now() - stat.mtimeMs) / 1000;
    if (ageSeconds < ACTIVE_THRESHOLD_SEC) {
      log(`  [${i + 1}/${files.length}] SKIP (active): ${files[i]}`);
      skippedActive++;
      continue;
    }

    try {
      log(`  [${i + 1}/${files.length}] Processing: ${files[i]}`);
      const report = await analyzeSession(filePath);
      sessions.push(report);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  [${i + 1}/${files.length}] ERROR: ${files[i]} — ${msg}`);
      errors++;
    }
  }

  log(`\nDone: ${sessions.length} processed, ${skippedActive} skipped, ${errors} errors`);

  const report = aggregate(sessions, skippedActive);

  // JSON to stdout (pipe-friendly)
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((err) => {
  log(`Fatal error: ${err}`);
  process.exit(1);
});

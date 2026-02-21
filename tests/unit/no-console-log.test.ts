/**
 * Regression test: no console.log in src/ files
 *
 * MCP servers use stdio transport — console.log writes to stdout,
 * which is the JSON-RPC channel. Any console.log corrupts the protocol.
 * Only console.error (stderr) is safe.
 *
 *
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      // Skip test directories
      if (entry === "__tests__" || entry === "test" || entry === "tests") continue;
      results.push(...collectTsFiles(fullPath));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".spec.ts")) {
      results.push(fullPath);
    }
  }
  return results;
}

// CLI commands run outside MCP stdio transport — console.log is correct there
const CLI_COMMAND_ALLOWLIST = new Set([
  "src/commands/telemetry.ts",
]);

describe("no console.log in src/", () => {
  const srcDir = join(__dirname, "../../src");
  const files = collectTsFiles(srcDir);

  it("should have found source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("should not contain console.log in any src/ file (except CLI commands)", () => {
    const violations: string[] = [];

    for (const file of files) {
      const relative = file.replace(srcDir, "src");
      // CLI commands use stdout directly — not MCP stdio
      if (CLI_COMMAND_ALLOWLIST.has(relative)) continue;

      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comments
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
        if (line.includes("console.log")) {
          violations.push(`${relative}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

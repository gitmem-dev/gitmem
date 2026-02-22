/**
 * contribute_feedback Smoke Test (Clean Room)
 *
 * Tests the new contribute_feedback tool end-to-end:
 *   1. Start session
 *   2. Submit valid feedback — verify local file written
 *   3. Submit feedback with short description — verify rejection
 *   4. Submit 10 feedbacks — verify 11th is rate-limited
 *   5. Close session
 *
 * Run: npx tsx feedback-smoke.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "fs";
import * as path from "path";

interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

async function createClient(): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "gitmem-mcp"],
    env: {
      ...process.env,
      NO_COLOR: "1",
      NODE_ENV: "test",
    },
  });

  const client = new Client(
    { name: "feedback-smoke", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  return {
    client,
    cleanup: async () => {
      try { await client.close(); } catch {}
      try { await transport.close(); } catch {}
    },
  };
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolCallResult> {
  return (await client.callTool({ name, arguments: args })) as ToolCallResult;
}

function getResponseText(result: ToolCallResult): string {
  return result.content.find((c) => c.type === "text")?.text || "";
}

// ── Main ──

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`    PASS  ${name}`);
    passed++;
  } else {
    console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

console.log("  contribute_feedback Smoke Test");
console.log("");

const { client, cleanup } = await createClient();

// 1. Check tool is listed
const tools = await client.listTools();
const hasFeedbackTool = tools.tools.some((t) => t.name === "contribute_feedback");
assert("contribute_feedback tool is registered", hasFeedbackTool);

// 2. Start session
const startResult = await callTool(client, "session_start", {
  project: "feedback-test",
  force: true,
});
assert("session_start succeeds", !startResult.isError);

// 3. Submit valid feedback
const fb1 = await callTool(client, "contribute_feedback", {
  type: "feature_request",
  tool: "recall",
  description: "It would be great if recall supported regex patterns for matching scar titles directly.",
  severity: "low",
  suggested_fix: "Add an optional regex_filter parameter to recall",
  context: "Noticed while searching for deployment-related scars",
});
const fb1Text = getResponseText(fb1);
assert("Valid feedback accepted", !fb1.isError);
assert("Response contains feedback ID", fb1Text.includes("Feedback recorded:"));
assert("Response mentions .gitmem/feedback/", fb1Text.includes(".gitmem/feedback/"));

// 4. Check local file was written
const gitmemDir = path.join(process.cwd(), ".gitmem", "feedback");
const feedbackFiles = fs.existsSync(gitmemDir) ? fs.readdirSync(gitmemDir) : [];
assert("Feedback file exists on disk", feedbackFiles.length >= 1, `found ${feedbackFiles.length} files`);

if (feedbackFiles.length > 0) {
  const firstFile = JSON.parse(fs.readFileSync(path.join(gitmemDir, feedbackFiles[0]), "utf-8"));
  assert("File has correct type", firstFile.type === "feature_request");
  assert("File has correct tool", firstFile.tool === "recall");
  assert("File has severity", firstFile.severity === "low");
  assert("File has gitmem_version", typeof firstFile.gitmem_version === "string");
  assert("File has session_id", typeof firstFile.session_id === "string");
  assert("File has timestamp", typeof firstFile.timestamp === "string");
}

// 5. Submit feedback with short description (should fail validation)
const fbShort = await callTool(client, "contribute_feedback", {
  type: "bug_report",
  tool: "search",
  description: "Too short",
  severity: "high",
});
assert("Short description rejected", fbShort.isError === true, getResponseText(fbShort));

// 6. Submit feedback with missing required field (should fail validation)
const fbMissing = await callTool(client, "contribute_feedback", {
  type: "friction",
  description: "Missing the required tool field in this feedback submission",
  severity: "medium",
});
assert("Missing tool field rejected", fbMissing.isError === true);

// 7. Rate limit test — submit 9 more (we already did 1 valid one)
console.log("    ... submitting 9 more for rate limit test ...");
for (let i = 2; i <= 10; i++) {
  await callTool(client, "contribute_feedback", {
    type: "suggestion",
    tool: "session_close",
    description: `Rate limit test feedback number ${i} — this is padding to meet the minimum length requirement.`,
    severity: "low",
  });
}

// 8. 11th should be rejected
const fb11 = await callTool(client, "contribute_feedback", {
  type: "suggestion",
  tool: "recall",
  description: "This is the 11th feedback and should be rate-limited by the session counter.",
  severity: "low",
});
const fb11Text = getResponseText(fb11);
assert("11th feedback rate-limited", fb11Text.includes("Feedback limit reached"), fb11Text.slice(0, 100));

// 9. Close session
const closeResult = await callTool(client, "session_close", {
  close_type: "quick",
});
assert("session_close succeeds", !closeResult.isError);

await cleanup();

// ── Summary ──
console.log("");
console.log(`  Feedback Smoke: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}

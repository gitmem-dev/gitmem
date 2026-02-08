/**
 * MCP Server Smoke Test (Clean Room)
 *
 * Tests the MCP server as a first-time user would experience it:
 *   - Server spawned via `npx -y @nteg-dev/gitmem` (same as .mcp.json config)
 *   - Session 1: start, recall starter scars, create a learning, close
 *   - Session 2: start, recall finds the new learning, proves persistence
 *
 * Requires: @modelcontextprotocol/sdk (installed by smoke-test.sh)
 * Run: npx tsx mcp-smoke.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
    args: ["-y", "@nteg-dev/gitmem"],
    env: {
      ...process.env,
      NO_COLOR: "1",
      NODE_ENV: "test",
    },
  });

  const client = new Client(
    { name: "clean-room-smoke", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  return {
    client,
    cleanup: async () => {
      try {
        await client.close();
      } catch {}
      try {
        await transport.close();
      } catch {}
    },
  };
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolCallResult> {
  return (await client.callTool({
    name,
    arguments: args,
  })) as ToolCallResult;
}

function parseResult<T>(result: ToolCallResult): T {
  const text = result.content.find((c) => c.type === "text")?.text || "";
  let cleaned = text;
  if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
  if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
  if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
  return JSON.parse(cleaned.trim()) as T;
}

// ── Main ──

const EXPECTED_FREE_TOOLS = 28;
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

console.log("  Session 1: First-time user experience");

const session1 = await createClient();

// Check tool count
const tools1 = await session1.client.listTools();
assert(
  `Tools registered (${tools1.tools.length})`,
  tools1.tools.length === EXPECTED_FREE_TOOLS,
  `expected ${EXPECTED_FREE_TOOLS}, got ${tools1.tools.length}`
);

// Session start
const startResult = await callTool(session1.client, "session_start", {
  agent_identity: "clean-room-test",
  project: "my-cool-project",
  force: true,
});
const startData = parseResult<{ session_id: string }>(startResult);
assert(
  "session_start returns UUID",
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    startData.session_id
  )
);

// Recall starter scars
const recallResult = await callTool(session1.client, "recall", {
  plan: "deploy to production",
  project: "my-cool-project",
  match_count: 5,
});
const recallData = parseResult<{ scars: Array<{ title: string }> }>(
  recallResult
);
assert(
  `Recall returns starter scars (${recallData.scars.length})`,
  recallData.scars.length > 0,
  "expected at least 1 scar from starter set"
);

// Create a test learning
const learnResult = await callTool(session1.client, "create_learning", {
  title: "Clean room test scar",
  description:
    "This scar was created during the clean room smoke test to verify persistence across sessions.",
  severity: "low",
  category: "testing",
  project: "my-cool-project",
  counter_argument:
    "You might think test scars are noise — but they prove the system works end-to-end.",
});
assert("create_learning succeeds", !learnResult.isError);

// Session close
const closeResult = await callTool(session1.client, "session_close", {
  session_id: startData.session_id,
  close_type: "quick",
});
assert("session_close succeeds", !closeResult.isError);

await session1.cleanup();

console.log("");
console.log("  Session 2: Context carries forward");

const session2 = await createClient();

// Session start (should see last session)
const start2Result = await callTool(session2.client, "session_start", {
  agent_identity: "clean-room-test",
  project: "my-cool-project",
  force: true,
});
const start2Data = parseResult<{
  session_id: string;
  last_session: { id: string } | null;
}>(start2Result);
assert("session_start returns new UUID", !!start2Data.session_id);

// Recall should find 13 scars (12 starter + 1 we created)
const recall2Result = await callTool(session2.client, "recall", {
  plan: "testing and verification",
  project: "my-cool-project",
  match_count: 20,
});
const recall2Data = parseResult<{ scars: Array<{ title: string }> }>(
  recall2Result
);
const hasTestScar = recall2Data.scars.some(
  (s) => s.title === "Clean room test scar"
);
assert(
  `Recall finds ${recall2Data.scars.length} scars (12 starter + 1 created)`,
  recall2Data.scars.length >= 13,
  `got ${recall2Data.scars.length}`
);
assert("Test scar persisted across sessions", hasTestScar);

// Close session 2
await callTool(session2.client, "session_close", {
  session_id: start2Data.session_id,
  close_type: "quick",
});

await session2.cleanup();

// ── Summary ──
console.log("");
console.log(`  MCP Smoke: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}

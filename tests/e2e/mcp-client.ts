/**
 * MCP Test Client Helper
 *
 * Spawns gitmem-mcp server as a child process and connects via MCP SDK.
 * This tests through the actual MCP protocol, catching issues that
 * direct function imports would miss (like the action/plan parameter bug).
 *
 * Reference: Scar 61d4dab8 - "Test From Consumer's Perspective"
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, type ChildProcess } from "child_process";
import { join } from "path";

/**
 * MCP client wrapper with cleanup
 */
export interface McpTestClient {
  client: Client;
  transport: StdioClientTransport;
  process: ChildProcess;
  cleanup: () => Promise<void>;
}

/**
 * Tool call result from MCP
 */
export interface ToolCallResult {
  content: Array<{
    type: string;
    text?: string;
  }>;
  isError?: boolean;
}

/**
 * Create an MCP client connected to gitmem-mcp server
 *
 * @param env - Environment variables to pass to the server
 * @returns MCP client wrapper with cleanup function
 */
export async function createMcpClient(
  env: Record<string, string> = {}
): Promise<McpTestClient> {
  // Path to the built server
  const serverPath = join(__dirname, "../../dist/index.js");

  // Merge with process env, allowing overrides
  const serverEnv = {
    ...process.env,
    ...env,
    // Disable colors for cleaner output
    NO_COLOR: "1",
    // Ensure we're in test mode
    NODE_ENV: "test",
  };

  // Create transport that spawns the server
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: serverEnv,
  });

  // Track the spawned process for cleanup
  let serverProcess: ChildProcess | null = null;

  // Create MCP client
  const client = new Client(
    {
      name: "gitmem-e2e-test-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  // Connect client to transport
  await client.connect(transport);

  // Cleanup function
  const cleanup = async () => {
    try {
      await client.close();
    } catch {
      // Ignore close errors
    }

    try {
      await transport.close();
    } catch {
      // Ignore transport close errors
    }
  };

  return {
    client,
    transport,
    process: serverProcess!,
    cleanup,
  };
}

/**
 * Call an MCP tool and return the result
 */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolCallResult> {
  const result = await client.callTool({
    name,
    arguments: args,
  });

  return result as ToolCallResult;
}

/**
 * List available tools from the MCP server
 */
export async function listTools(
  client: Client
): Promise<Array<{ name: string; description?: string }>> {
  const result = await client.listTools();
  return result.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
  }));
}

/**
 * Parse tool result text as JSON
 */
export function parseToolResult<T = unknown>(result: ToolCallResult): T {
  const textContent = result.content.find((c) => c.type === "text");
  if (!textContent?.text) {
    throw new Error("No text content in tool result");
  }

  // Handle markdown code blocks
  let text = textContent.text;
  if (text.startsWith("```json")) {
    text = text.slice(7);
  }
  if (text.startsWith("```")) {
    text = text.slice(3);
  }
  if (text.endsWith("```")) {
    text = text.slice(0, -3);
  }

  return JSON.parse(text.trim()) as T;
}

/**
 * Extract plain text from tool result
 */
export function getToolResultText(result: ToolCallResult): string {
  const textContent = result.content.find((c) => c.type === "text");
  return textContent?.text || "";
}

/**
 * Check if tool result indicates an error
 */
export function isToolError(result: ToolCallResult): boolean {
  if (result.isError) return true;

  const text = getToolResultText(result).toLowerCase();
  return text.includes("error:") || text.includes("failed:");
}

/**
 * Wait for a condition with timeout
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 100
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timeout waiting for condition after ${timeoutMs}ms`);
}

/**
 * Create a test environment with specific tier configuration
 */
export function createTierEnv(tier: "free" | "pro" | "dev"): Record<string, string> {
  switch (tier) {
    case "free":
      // No Supabase configuration
      return {
        SUPABASE_URL: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
        GITMEM_TIER: "free",
      };

    case "pro":
      // Pro tier with Supabase (actual values would come from test setup)
      return {
        GITMEM_TIER: "pro",
        // SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set by test
      };

    case "dev":
      // Dev tier with full features
      return {
        GITMEM_TIER: "dev",
        GITMEM_DEV: "1",
        // SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set by test
      };
  }
}

/**
 * Core tools available in all tiers
 */
export const CORE_TOOLS = [
  "recall",
  "session_start",
  "session_close",
  "create_learning",
  "create_decision",
  "record_scar_usage",
  "search",
  "log",
];

/**
 * Pro/Dev only tools
 */
export const PRO_TOOLS = [
  "record_scar_usage_batch",
  "save_transcript",
  "get_transcript",
  "analyze",
];

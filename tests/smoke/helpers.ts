/**
 * Smoke Test Helpers
 *
 * Re-exports all utilities from e2e/mcp-client.ts (single source of truth)
 * and adds smoke-specific timing instrumentation.
 */

// Re-export everything from mcp-client — no duplication
export {
  createMcpClient,
  callTool,
  listTools,
  parseToolResult,
  getToolResultText,
  isToolError,
  waitFor,
  createTierEnv,
  CORE_TOOLS,
  PRO_TOOLS,
  type McpTestClient,
  type ToolCallResult,
} from "../e2e/mcp-client.js";

/**
 * Execute a test step with timing instrumentation.
 *
 * Prints PASS/FAIL with latency to stderr alongside vitest output.
 * Rethrows on failure so vitest captures the assertion error.
 */
export async function timedStep<T>(
  name: string,
  fn: () => Promise<T>
): Promise<{ result: T; latencyMs: number }> {
  const start = Date.now();
  try {
    const result = await fn();
    const latencyMs = Date.now() - start;
    console.error(`  PASS  ${name} (${latencyMs}ms)`);
    return { result, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - start;
    console.error(`  FAIL  ${name} (${latencyMs}ms)`);
    throw error;
  }
}

/**
 * Expected tool counts per tier.
 *
 * Derived from src/tools/definitions.ts gating logic:
 *   Total TOOLS array:        43
 *   CACHE_TOOL_NAMES (pro+):   6
 *   ANALYZE_TOOL_NAMES (pro+): 3
 *   BATCH_TOOL_NAMES (dev):    2
 *   TRANSCRIPT_TOOL_NAMES (dev): 4
 *
 *   free = 43 - 6 - 3 - 2 - 4 = 28
 *   pro  = 43 - 2 - 4         = 37
 *   dev  = 43
 *
 * If these numbers change, a tool was added/removed from definitions.ts.
 * Update this constant and investigate.
 */
export const EXPECTED_TOOL_COUNTS = {
  free: 28,
  pro: 37,
  dev: 43,
} as const;

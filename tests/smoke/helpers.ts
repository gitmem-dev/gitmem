/**
 * Smoke Test Helpers
 *
 * Re-exports all utilities from e2e/mcp-client.ts (single source of truth)
 * and adds smoke-specific timing instrumentation.
 */

// Re-export everything from mcp-client — single source of truth
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
  EXPECTED_TOOL_COUNTS,
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

# Telemetry Integration Guide

## How to Instrument Tools

Here's how to add telemetry tracking to gitmem tools:

```typescript
import { trackToolCall } from "../lib/telemetry.js";
import { getGitmemDir } from "../lib/config.js";

export async function myTool(params: ToolParams): Promise<ToolResult> {
  const startTime = Date.now();
  const gitmemDir = getGitmemDir();

  try {
    // ... tool logic ...
    const result = performWork(params);

    // Track successful execution
    await trackToolCall({
      gitmemDir,
      version: VERSION,
      tool: "my_tool",
      success: true,
      duration_ms: Date.now() - startTime,
      result_count: result.items?.length,
      mcp_host: detectMcpHost(),
    });

    return result;

  } catch (error) {
    // Track failed execution
    await trackToolCall({
      gitmemDir,
      version: VERSION,
      tool: "my_tool",
      success: false,
      duration_ms: Date.now() - startTime,
      error_type: error.name || "unknown",
      mcp_host: detectMcpHost(),
    });

    throw error;
  }
}
```

## Event Schema

All telemetry events follow this schema:

```typescript
interface TelemetryEvent {
  event: "tool_called";
  tool: string;           // Tool name (e.g., "recall", "session_close")
  success: boolean;       // Whether the tool succeeded
  duration_ms: number;    // Execution time
  result_count?: number;  // Number of results (if applicable)
  error_type?: string;    // Error class name (if failed)
  version: string;        // gitmem-mcp version
  platform: string;       // OS (darwin, linux, win32)
  mcp_host?: string;      // MCP host (claude-desktop, cursor, cli)
  tier: "free" | "pro";   // Detected tier
  timestamp: string;      // ISO 8601
  session_id: string;     // Random 8-char hex (not persistent)
}
```

## Privacy Guarantees

**Never track:**
- User input (queries, plans, content)
- Learning content (scars, wins, decisions)
- File paths or project names
- Environment variables or credentials
- IP addresses or persistent identifiers

**Only track:**
- Tool usage patterns
- Success/failure rates
- Performance metrics
- Platform/version distribution

## Detecting MCP Host

```typescript
function detectMcpHost(): string {
  // Check environment variables set by different MCP hosts
  if (process.env.CLAUDE_CODE_ENTRYPOINT) {
    return process.env.CLAUDE_CODE_ENTRYPOINT; // "cli" or "claude-desktop"
  }
  if (process.env.CURSOR_SESSION_ID) {
    return "cursor";
  }
  return "unknown";
}
```

## Testing

Telemetry is **always logged locally** to `.gitmem/telemetry.log`, regardless of enabled state. This allows testing without sending data:

```bash
# View telemetry events
$ gitmem telemetry show

# Check status
$ gitmem telemetry status

# Clear local logs
$ gitmem telemetry clear
```

## Rollout Strategy

1. **Phase 1:** Implement logging (no transmission)
   - All events logged to `.gitmem/telemetry.log`
   - No prompts, no opt-in yet
   - Verify schema and coverage

2. **Phase 2:** Add opt-in flow
   - Telemetry disabled by default
   - Prompt in `init` flow
   - CLI commands functional

3. **Phase 3:** Enable transmission
   - Set up telemetry endpoint (Plausible Analytics)
   - Test with opt-in users
   - Monitor error rates

4. **Phase 4:** Public dashboard
   - Publish aggregate stats at https://gitmem.ai/stats
   - Tool usage rankings
   - Error rates by version
   - Platform distribution

## Example: Instrumenting recall()

```typescript
// src/tools/recall.ts
export async function recall(params: RecallParams): Promise<RecallResult> {
  const startTime = Date.now();
  const gitmemDir = getGitmemDir();

  try {
    const scars = await searchScars(params.plan);

    // Track successful recall
    await trackToolCall({
      gitmemDir,
      version: VERSION,
      tool: "recall",
      success: true,
      duration_ms: Date.now() - startTime,
      result_count: scars.length,
      mcp_host: detectMcpHost(),
    });

    return {
      scars,
      surfaced_at: new Date().toISOString(),
    };

  } catch (error) {
    await trackToolCall({
      gitmemDir,
      version: VERSION,
      tool: "recall",
      success: false,
      duration_ms: Date.now() - startTime,
      error_type: error.name,
      mcp_host: detectMcpHost(),
    });

    throw error;
  }
}
```

## Metrics We Care About

1. **Tool adoption**
   - Which tools are used most?
   - Which tools are never used?

2. **Error rates**
   - Which tools fail most often?
   - Which error types are most common?

3. **Performance**
   - 50th/95th/99th percentile latency
   - Platform differences

4. **Platform distribution**
   - Free vs Pro tier adoption
   - Claude Code vs Cursor vs CLI
   - macOS vs Linux vs Windows

## Public Dashboard Example

```
GitMem Usage Stats (Last 30 Days)
================================

Tool Usage:
  recall                47.2% (1,234 calls)
  session_close         18.3% (478 calls)
  create_learning       12.1% (316 calls)
  search                 8.4% (220 calls)
  ...

Error Rates:
  recall                 2.3% (28 failures)
  session_close          0.8% (4 failures)
  search                 5.1% (11 failures)

Platform Distribution:
  Free tier             87%
  Pro tier              13%

  macOS                 62%
  Linux                 31%
  Windows                7%

Performance (p95):
  recall               234ms
  search               456ms
  session_close        123ms
```

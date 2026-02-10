# GitMem Testing Guide

## Test Tiers

GitMem uses a 5-tier testing pyramid. Each tier adds cost/time but tests closer to the real user experience.

| Tier | Command | Speed | Cost | What it tests |
|------|---------|-------|------|---------------|
| **1 - Unit** | `npm run test:unit` | ~3s | Free | Schema validation, pure functions, golden regressions |
| **2 - Smoke** | `npm run test:smoke` | ~5s | Free | MCP server boot, tool registration, basic tool calls via stdio |
| **3 - Integration** | `npm run test:integration` | ~30s | Free (needs Docker) | Supabase PostgreSQL, session lifecycle, cache behavior, query plans |
| **4 - E2E** | `npm run test:e2e` | ~75s | API calls | Full install flow, hooks, Agent SDK user journey |
| **5 - Performance** | `npm run test:perf` | ~30s | Free | Cold start, recall latency, cache hit rate benchmarks |

Run all: `npm run test:all`

**Before pushing:** Always run `npm run test:unit` at minimum.

---

## Tier 4 — E2E Tests (Detail)

The E2E tier (`tests/e2e/`) tests the full user experience from consumer perspective. It has 5 test suites:

### `cli-fresh-install.test.ts` — 27 tests, ~1s, free

Tests the CLI commands a new user runs when installing gitmem:

- **Init CLI**: `gitmem init` creates `.gitmem/`, starter scars, permissions in `.claude/settings.json`
- **Check CLI**: `gitmem check` health check passes on initialized project
- **Hooks CLI**: `gitmem install-hooks` writes project-level hooks to `.claude/settings.json`, preserves existing permissions, `--force` overwrites, `gitmem uninstall-hooks` removes hooks cleanly
- **Hook Script Output**: Direct execution of `session-start.sh` and `session-close-check.sh` verifying protocol wording ("YOU (the agent) ANSWER"), no `orchestra_dev` leaks
- **Output Sanitization**: All CLI commands (`init`, `check`, `configure`, `help`) checked for internal reference leaks; `CLAUDE.md.template` and `starter-scars.json` verified clean

### `user-journey.test.ts` — 6 tests, ~60s, costs API calls

**Uses the Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) to spawn real Claude sessions against a test directory with gitmem installed. This is the closest test to the actual user experience.

Key design decisions:
- **Agent SDK, not subprocess**: Uses `query()` from the SDK — runs in-process, returns typed `SDKMessage` events. Much faster and more reliable than spawning `claude -p` as a subprocess.
- **Haiku model**: Fast, cheap. Budget capped at $1/test.
- **Thinking disabled**: No extended thinking needed for test prompts.
- **`settingSources: ["project"]`**: Loads `.claude/settings.json` from the test directory (picks up installed hooks).
- **`persistSession: false`**: No session files written to disk.
- **PreToolUse hook observer**: Programmatic `HookCallback` that records every tool call the agent makes — no parsing needed.

What it verifies:
1. **SessionStart hook fires** — hook_started + hook_response events, exit code 0
2. **MCP tools registered** — init event lists 10+ `mcp__gitmem__*` tools, core tools present, server status "connected"
3. **Agent calls session_start** — observed via PreToolUse hook callback
4. **Agent calls recall** — observed via PreToolUse hook callback, session completes successfully
5. **No orchestra references** — hook output and result text checked
6. **Correct ceremony wording** — "YOU (the agent) ANSWER" and "session_start" in hook output

Test setup creates a temp directory with:
```
/tmp/gitmem-journey-xxx/
  .gitmem/              # from `gitmem init`
  .mcp.json             # points to built dist/index.js
  .claude/settings.json # from `gitmem install-hooks` (hooks + permissions)
  node_modules/gitmem-mcp/hooks -> /workspace/gitmem/hooks  # symlink
```

### `free-tier.test.ts` — 15 tests, ~1s, free

Tests free tier MCP functionality via stdio transport: session lifecycle, recall, create_learning, create_decision, record_scar_usage.

### `pro-fresh.test.ts` — 11 tests, requires Docker

Tests pro tier with Supabase PostgreSQL (Testcontainers + pgvector). Skips gracefully when Docker is unavailable.

### `pro-mature.test.ts` — 7 tests, requires Docker

Tests pro tier at scale (1000 scars). Skips gracefully when Docker is unavailable.

---

## Agent SDK Testing Pattern

The `user-journey.test.ts` file establishes a reusable pattern for testing Claude CLI integrations from code:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

// Collect observations
const toolCalls: string[] = [];
const hookObserver: HookCallback = async (input) => {
  if (input.hook_event_name === "PreToolUse") {
    toolCalls.push((input as PreToolUseHookInput).tool_name);
  }
  return {};
};

// Run session
for await (const msg of query({
  prompt: "Do something",
  options: {
    cwd: "/path/to/project",
    model: "haiku",
    maxTurns: 5,
    maxBudgetUsd: 1.0,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    settingSources: ["project"],      // loads .claude/settings.json hooks
    thinking: { type: "disabled" },
    hooks: {
      PreToolUse: [{ hooks: [hookObserver] }],
    },
  },
})) {
  if (msg.type === "system" && msg.subtype === "init") {
    // Access: msg.tools, msg.mcp_servers, msg.session_id
  }
  if (msg.type === "system" && msg.subtype === "hook_response") {
    // Access: msg.hook_event, msg.exit_code, msg.stdout, msg.outcome
  }
  if (msg.type === "result") {
    // Access: msg.subtype ("success"/"error"), msg.total_cost_usd
  }
}

// Assert on observations
expect(toolCalls).toContain("mcp__gitmem__session_start");
```

### Key SDK Options for Testing

| Option | Value | Why |
|--------|-------|-----|
| `model` | `"haiku"` | Fastest, cheapest |
| `maxTurns` | 2-5 | Prevent runaway |
| `maxBudgetUsd` | 1.0 | Hard cost cap |
| `permissionMode` | `"bypassPermissions"` | No interactive prompts |
| `allowDangerouslySkipPermissions` | `true` | Required with bypassPermissions |
| `persistSession` | `false` | No disk state |
| `settingSources` | `["project"]` | Load project hooks |
| `thinking` | `{ type: "disabled" }` | No extended thinking |

### Why SDK over `claude -p` subprocess

| | Agent SDK (`query()`) | Subprocess (`claude -p`) |
|---|---|---|
| Speed | ~10s per session | 60-120s+ per session |
| Events | Typed `SDKMessage` | Parse NDJSON strings |
| Tool observation | Programmatic `HookCallback` | Parse `tool_use` blocks from JSON |
| MCP config | Via project `.mcp.json` | Via project `.mcp.json` |
| Hook observation | `SDKHookResponseMessage` events | Parse `hook_response` from NDJSON |
| Process model | In-process (spawns CLI as child) | Shell subprocess via `execFile` |
| Environment | Clean (no env var inheritance issues) | Inherits parent env (e.g., `CLAUDE_MODEL`) |

---

## Hook Tests (`hooks/tests/test-hooks.sh`)

Bash test suite (28 tests) for hook scripts. Tests detection cascades, output format, environment variable handling. Run with:

```bash
bash hooks/tests/test-hooks.sh
```

---

## Skip Conditions

Tests skip gracefully when dependencies are missing:

| Test | Skip condition | Detection |
|------|---------------|-----------|
| `user-journey.test.ts` | Claude CLI not installed | `claude --version` |
| `pro-fresh.test.ts` | Docker not available | `docker info` |
| `pro-mature.test.ts` | Docker not available | `docker info` |

---

## Adding New E2E Tests

When adding new E2E tests:

1. **Free tier / hooks / CLI**: Add to `cli-fresh-install.test.ts` — fast, deterministic, no API cost
2. **User experience / agent behavior**: Add to `user-journey.test.ts` — uses Agent SDK, costs API calls
3. **Pro tier / Supabase**: Add to `pro-fresh.test.ts` or `pro-mature.test.ts` — needs Docker
4. **Hook scripts**: Add to `hooks/tests/test-hooks.sh` — bash, no dependencies

For user-journey tests, keep prompts simple and use `appendSystemPrompt` to constrain agent behavior. The agent is non-deterministic — test that tools are _called_, not that the agent says specific words.

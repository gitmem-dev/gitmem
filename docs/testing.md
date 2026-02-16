# GitMem Testing Guide

> **Last Updated:** 2026-02-16 · **Test Totals:** 764 tests across 6 tiers

## Test Pyramid Overview

GitMem uses a 6-tier testing pyramid. Each tier adds cost/time but tests closer to the real user experience.

| Tier | Command | Files | Tests | Speed | Cost | What it tests |
|------|---------|-------|-------|-------|------|---------------|
| **1 - Unit** | `npm run test:unit` | 34 | 597 | ~3s | Free | Schema validation, pure functions, golden regressions |
| **2 - Smoke** | `npm run test:smoke` | 2 | 9 | ~5s | Free | MCP server boot, tool registration, basic tool calls via stdio |
| **3 - Integration** | `npm run test:integration` | 5 | 63 | ~30s | Free (Docker) | Real PostgreSQL, session lifecycle, cache behavior, query plans |
| **4 - E2E** | `npm run test:e2e` | 6 | 68 | ~90s | Free (Docker for pro) | CLI install flow, hooks, free/pro tier MCP via stdio |
| **5 - User Journey** | `npm run test:e2e -- tests/e2e/user-journey.test.ts` | 1 | 6 | ~60s | API calls | Real Claude session via Agent SDK |
| **6 - Performance** | `npm run test:perf` | 4 | benchmarks | ~30s | Free | Cold start, recall latency, cache hit rate microbenchmarks |

**Run all:** `npm run test:all` (runs tiers 1-4 + 6; excludes user-journey)

**Before pushing:** Always run `npm run test:unit` at minimum.

**Before shipping to npm:** Run tiers 1-5. Tier 5 (User Journey) is the most important gate — it spawns a real Claude session and verifies the full hook + MCP + agent behavior chain.

### CI Pipeline

Source: `.github/workflows/ci.yml`

**Triggers:** Push to `main`, push of `v*` tags, PRs against `main`.

#### Build job (matrix: Node 18, 20, 22)

Each step does exactly one thing. No step re-runs another step's work.

| Step | Command | What it does |
|------|---------|-------------|
| Type check | `npm run typecheck` | `tsc --noEmit` — verify types, no output |
| Build | `npm run build` | `tsc` — compile to `dist/` |
| Unit tests | `npm run test:unit` | 764 tests via vitest (one execution) |
| Smoke test | `npm run test:smoke:free` | 4 MCP integration tests (server boot, tools, session lifecycle) |

#### Publish job (tag pushes only)

Runs after all 3 build matrix jobs pass. Only fires on `v*` tag pushes.

| Step | Command | What it does |
|------|---------|-------------|
| Install | `npm ci --legacy-peer-deps` | Clean install (legacy-peer-deps for zod@4 conflict) |
| Build | `npm run build` | `tsc` — compile to `dist/` |
| Publish | `npm publish` | Publish to npm via `NPM_TOKEN` secret. `prepublishOnly` runs `tsc` (compile only, no tests) |

#### Release workflow

```bash
# 1. Make changes, commit
# 2. Bump version
npm version patch  # or: edit package.json + CHANGELOG.md manually
# 3. Tag and push
git tag v1.0.X
git push origin main --tags
# CI builds → tests → publishes automatically
```

#### What's NOT in CI

| Test tier | Why not | How to run |
|-----------|---------|-----------|
| Integration (Tier 3) | Needs Docker | `npm run test:integration` locally |
| E2E pro (Tier 4) | Needs Docker | `npm run test:e2e` locally |
| User Journey (Tier 5) | Needs Claude API key, costs ~$0.30 | `npm run test:e2e -- tests/e2e/user-journey.test.ts` |
| Performance (Tier 6) | Benchmarks, not pass/fail | `npm run test:perf` |

#### CI design principles

- **`build` = compile only.** Never embed tests in the build script. CI has dedicated test steps.
- **`prepublishOnly` = compile only.** The publish job runs after all tests pass — no need to re-test.
- **`--legacy-peer-deps`** required because `@anthropic-ai/claude-agent-sdk` depends on `zod@^4.0.0` while gitmem uses `zod@3.x`.
- **Tests set `GITMEM_DIR`** to temp directories. Without this, tests write to `~/.gitmem/` (which may not exist in CI) or `process.cwd()/.gitmem/` (wrong path when `GITMEM_DIR` is set elsewhere).

---

## Prerequisites

### Docker (Tiers 3-4)

Integration and pro E2E tests use [Testcontainers](https://node.testcontainers.org/) to spin up `pgvector/pgvector:pg16` PostgreSQL containers.

**Requirements:**
- Docker daemon running and accessible
- `docker info` must succeed
- Tests skip gracefully when Docker is unavailable

**Docker-in-Docker:** If running inside a container, mount the host Docker socket (`/var/run/docker.sock`) to enable Testcontainers.

### Auth Schema Stub

Plain pgvector PostgreSQL doesn't include Supabase's `auth` schema. All Docker-based tests must stub it before loading `schema/setup.sql`:

```sql
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
  SELECT 'service_role'::TEXT;
$$ LANGUAGE sql;
```

This stub is applied in `tests/integration/setup.ts` (shared) and individually in `pro-fresh.test.ts` and `pro-mature.test.ts`.

### Claude CLI (Tier 5)

User Journey tests require the Claude CLI installed and authenticated. Detection: `claude --version`.

---

## Tier 1 — Unit Tests (597 tests, 34 files)

Pure unit tests with no external dependencies. Fast, deterministic, run everywhere.

### Test Categories

| Category | Files | What it covers |
|----------|-------|----------------|
| **Schemas** | 13 files (`tests/unit/schemas/`) | Zod schema validation for all tool inputs: recall, session-start, session-close, create-learning, create-decision, search, analyze, log, prepare-context, absorb-observations, record-scar-usage, transcript, common |
| **Services** | 11 files (`tests/unit/services/`) | Thread manager (dedup, lifecycle, suggestions, vitality, Supabase sync, triples), active sessions (locking, multi-session), file locks, gitmem-dir, timezone |
| **Tools** | 2 files (`tests/unit/tools/`) | absorb-observations, prepare-context |
| **Hooks** | 2 files (`tests/unit/hooks/`) | format-utils, quick-retrieve |
| **Diagnostics** | 4 files (`tests/unit/diagnostics/`) | anonymizer, channels, check-command, collector |
| **Golden Regressions** | 1 file (`tests/unit/golden-regressions.test.ts`) | 11 tests replaying specific historical bugs |
| **Standalone** | 3 files (`tests/variant-*.test.ts`) | Variant assignment, variant enforcement, variant missing issue ID (21 tests total) |

### Configuration

- **Config:** `vitest.config.ts`
- **Includes:** `tests/unit/**`, `tests/od-*.test.ts`
- **Excludes:** integration, e2e, smoke, performance

---

## Tier 2 — Smoke Tests (9 tests, 2 files)

Boot the MCP server via stdio transport and verify basic functionality.

| Suite | Tests | What it covers |
|-------|-------|----------------|
| `smoke-free.test.ts` | 4 | Free tier server boot, tool list, basic recall |
| `smoke-pro.test.ts` | 5 | Pro tier server boot (skips without Supabase credentials) |

### Configuration

- **Config:** `vitest.smoke.config.ts`
- **Commands:** `npm run test:smoke:free` (always runs), `npm run test:smoke:pro` (skips without creds)

---

## Tier 3 — Integration Tests (63 tests, 5 files)

Tests against a real PostgreSQL database via Testcontainers. Catches issues mocks would miss: missing indexes, query plan regressions, schema drift.

### Shared Setup (`tests/integration/setup.ts`)

All integration tests share a single Testcontainers setup that:
1. Starts `pgvector/pgvector:pg16` container
2. Stubs `auth.role()` for Supabase compatibility
3. Loads `schema/setup.sql`
4. Sets `DATABASE_URL`, `SUPABASE_URL`, `GITMEM_TIER=pro` environment variables
5. Provides helpers: `truncateAllTables()`, `indexExists()`, `getQueryPlan()`, `analyzeQueryPlan()`, `generateRandomVector()`, `formatVector()`

### Suites

| Suite | Tests | What it covers |
|-------|-------|----------------|
| `fresh-install.test.ts` | ~12 | Empty database behavior, first session, first learning creation |
| `session-lifecycle.test.ts` | ~15 | Session create/close, concurrent sessions, close compliance |
| `cache-behavior.test.ts` | 9 | Cache file operations, TTL expiry, cache symmetry (decisions/wins), scar search caching |
| `query-plans.test.ts` | ~12 | Index usage verification (EXPLAIN), query performance at scale |
| `scale-profiles.test.ts` | ~15 | Behavior at 0, 15, 100, 500, 1000 scars |

### Configuration

- **Config:** `vitest.integration.config.ts`
- **Timeout:** 120s container startup, 30s per test
- **Skip:** Entire suite skips if Docker unavailable

---

## Tier 4 — E2E Tests (68 tests, 6 files)

Tests CLI commands and MCP protocol end-to-end. Pro tests spawn Testcontainers.

### Suites

#### `cli-fresh-install.test.ts` — 27 tests, free

Tests the CLI commands a new user runs when installing gitmem:

- **Init CLI**: `gitmem init` creates `.gitmem/`, starter scars, permissions in `.claude/settings.json`
- **Check CLI**: `gitmem check` health check passes on initialized project
- **Hooks CLI**: `gitmem install-hooks` writes project-level hooks, preserves existing permissions, `--force` overwrites, `gitmem uninstall-hooks` removes hooks cleanly
- **Hook Script Output**: Direct execution of `session-start.sh` and `session-close-check.sh` verifying protocol wording ("YOU (the agent) ANSWER"), no internal reference leaks
- **Output Sanitization**: All CLI commands checked for internal reference leaks; `CLAUDE.md.template` and `starter-scars.json` verified clean

#### `free-tier.test.ts` — 15 tests, free

Free tier MCP functionality via stdio transport: session lifecycle, recall, create_learning, create_decision, record_scar_usage, parameter validation (golden regression for 2026-02-03 crash).

#### `pro-fresh.test.ts` — 11 tests, Docker required

Pro tier with Supabase PostgreSQL (Testcontainers + pgvector, 15 starter scars):

- Tool registration (core + pro tools)
- Recall with starter scars (finds deployment-related matches)
- Session lifecycle (start, close)
- Create learning and create decision
- Pro-only tools: `analyze`, `gitmem-cache-status`

**Architectural note:** The MCP server communicates with Supabase via PostgREST (HTTP), not direct PostgreSQL connections. Tests verify MCP tool success, not direct database persistence.

#### `pro-mature.test.ts` — 7 tests, Docker required

Pro tier at scale (1000 seeded scars):

- Recall performance within baseline (2000ms × 1.5)
- Cache hit rate (second recall faster)
- Session start within baseline
- Search within baseline
- Sequential operation throughput (4 ops < 10s)
- Data volume verification (1000 learnings with embeddings)

#### `organic-discovery.test.ts` — 2 tests, API calls

Multi-session organic adoption measurement. Tests whether agents discover and adopt gitmem with varying nudge configurations. Agent SDK-based, costs ~$0.30 per 3-session chain.

#### `user-journey.test.ts` — 6 tests, API calls (Tier 5)

See Tier 5 section below.

### MCP Test Client (`tests/e2e/mcp-client.ts`)

Shared test infrastructure for E2E tests. Spawns `dist/index.js` as a child process and connects via MCP SDK's `StdioClientTransport`.

**Key exports:**

| Export | Purpose |
|--------|---------|
| `createMcpClient(env)` | Spawn MCP server with custom env, return connected client |
| `callTool(client, name, args)` | Call an MCP tool and return typed result |
| `listTools(client)` | List registered tools |
| `getToolResultText(result)` | Extract text from tool result |
| `parseToolResult<T>(result)` | Parse JSON from tool result (handles markdown code blocks) |
| `isToolError(result)` | Check if result is an error |
| `CORE_TOOLS` | Tools available in all tiers: recall, session_start, session_close, create_learning, create_decision, record_scar_usage, search, log |
| `PRO_TOOLS` | Pro-tier tools: analyze, gitmem-cache-status, gitmem-cache-health, gitmem-cache-flush |
| `DEV_TOOLS` | Dev-only tools: record_scar_usage_batch, save_transcript, get_transcript |
| `EXPECTED_TOOL_COUNTS` | free: 55, pro: 67, dev: 73 |

### Configuration

- **Config:** `vitest.e2e.config.ts`
- **Timeout:** 120-180s for container startup, 30s per test

---

## Tier 5 — User Journey (6 tests, 1 file)

**This is the most important pre-ship gate.** Spawns a real Claude session and verifies the full user experience.

### `user-journey.test.ts` — 6 tests, ~60s, costs API calls

Uses the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) to spawn real Claude sessions against a test directory with gitmem installed.

Key design decisions:
- **Agent SDK, not subprocess**: Uses `query()` from the SDK — runs in-process, returns typed `SDKMessage` events. Much faster and more reliable than spawning `claude -p` as a subprocess.
- **Haiku model**: Fast, cheap. Budget capped at $1/test.
- **Thinking disabled**: No extended thinking needed for test prompts.
- **`settingSources: ["project"]`**: Loads `.claude/settings.json` from the test directory (picks up installed hooks).
- **`persistSession: false`**: No session files written to disk.
- **PreToolUse hook observer**: Programmatic `HookCallback` that records every tool call the agent makes.

What it verifies:
1. **SessionStart hook fires** — hook_started + hook_response events, exit code 0
2. **MCP tools registered** — init event lists 10+ `mcp__gitmem__*` tools, core tools present, server status "connected"
3. **Agent calls session_start** — observed via PreToolUse hook callback
4. **Agent calls recall** — observed via PreToolUse hook callback, session completes successfully
5. **No internal references** — hook output and result text checked
6. **Correct ceremony wording** — "YOU (the agent) ANSWER" and "session_start" in hook output

Test setup creates a temp directory with:
```
/tmp/gitmem-journey-xxx/
  .gitmem/              # from `gitmem init`
  .mcp.json             # points to built dist/index.js
  .claude/settings.json # from `gitmem install-hooks` (hooks + permissions)
  node_modules/gitmem-mcp/hooks -> /workspace/gitmem/hooks  # symlink
```

---

## Tier 6 — Performance Benchmarks (4 files)

Vitest `bench()` microbenchmarks measuring operation latency with statistical rigor.

### Suites

| Suite | What it benchmarks |
|-------|--------------------|
| `cold-start.bench.ts` | Cache initialization, first session start |
| `recall.bench.ts` | Local vector search at 15 and 1000 scars |
| `cache.bench.ts` | Cache key generation |
| `session-start.bench.ts` | Session start components |

### Performance Baselines (`tests/performance/baselines.ts`)

Target latencies derived from performance targets and production measurements. Tests fail if measurement exceeds baseline × 1.5 (alert threshold).

| Component | Baseline (ms) | Source |
|-----------|--------------|--------|
| `session_start_total` | 750 | Lean start |
| `recall_with_scars` | 2000 | Production |
| `recall_empty` | 500 | Production |
| `scar_search_local` | 100 | Production |
| `scar_search_remote` | 2000 | Production |
| `session_close_total` | 1500 | Blocking path only |
| `create_learning` | 3000 | Production |
| `create_decision` | 3000 | Production |
| `cache_hit` | 5 | Production |
| `cache_key_generation` | 1 | Production |

### Configuration

- **Config:** `vitest.perf.config.ts`
- **Command:** `npm run test:perf` (runs `vitest bench`, not `vitest run`)
- **Output:** Results written to `tests/performance/results.json`
- **Pool:** Single fork for consistent measurements

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
| `organic-discovery.test.ts` | Claude CLI not installed | `claude --version` |
| `pro-fresh.test.ts` | Docker not available | `docker info` |
| `pro-mature.test.ts` | Docker not available | `docker info` |
| `smoke-pro.test.ts` | No Supabase credentials | env check |
| All integration tests | Docker not available | `docker info` |

---

## Tool Tier Gating

The MCP server gates tools by tier. Tests verify correct gating via `EXPECTED_TOOL_COUNTS`:

| Tier | Tool Count | Includes |
|------|-----------|----------|
| **free** | 55 | Core tools only |
| **pro** | 67 | + analyze (3), cache management (6), graph traverse (3) |
| **dev** | 73 | + batch operations (2), transcripts (4) |

Source: `src/tools/definitions.ts` → `getRegisteredTools()`, `src/services/tier.ts` feature flags.

---

## Mapping Changes to Test Tiers

**The rule:** Test at the tier where your change first touches a real boundary. Every change gets Tier 1. Then add the tier that matches the highest boundary crossed. Don't skip tiers — if you need Tier 3, also run 1 and 2.

### Decision Framework

```
Did you change...
  ├─ a pure function or schema?          → Tier 1 (always, non-negotiable)
  ├─ how the MCP server responds?        → + Tier 2 (5s, free)
  ├─ a database query or migration?      → + Tier 3 (30s, needs Docker)
  ├─ a CLI command or hook script?       → + Tier 4 (90s, needs Docker for pro)
  ├─ what the agent experiences?          → + Tier 5 (60s, costs ~$0.30)
  └─ performance-sensitive code?          → + Tier 6 (30s, free)
```

### Boundary Reference

| Your change touches... | Runtime boundary | Minimum tier | Example |
|------------------------|-----------------|--------------|---------|
| Schema validation, Zod rules | None — all in-memory | **Tier 1** | Adding `.max()` limits to schemas |
| Pure function logic (sorting, formatting, parsing) | None — all in-memory | **Tier 1** | Fixing `normalizeThreads` created_at preservation |
| Tool handler branching, response formatting | None — still pure functions | **Tier 1** | Changing how recall formats output |
| MCP server wiring (tool registration, error responses) | Process spawn + stdio | **Tier 2** | Changing error redaction in server.ts |
| Network calls (`fetch`, `AbortSignal.timeout`) | Network | **Tier 2** (mock) or **Tier 3** (real) | Adding timeouts to fetch calls |
| Database queries, RPC calls, migrations | Network + SQL | **Tier 3** | New Supabase RPC function |
| CLI commands (`gitmem init`, `gitmem check`) | Filesystem + process | **Tier 4** | Changing starter scar loading behavior |
| Hook scripts (SessionStart, SessionClose) | Filesystem + shell | **Tier 4** | Modifying hook output format |
| Agent behavior (does Claude call the right tools?) | Claude API + everything | **Tier 5** | Changing CLAUDE.md ceremony wording |
| Latency of hot paths | Time | **Tier 6** | Optimizing recall search |

### Practical examples

**"I added `.max()` to Zod schemas"**
- Boundary: none (pure validation)
- Run: Tier 1 unit tests for the schema
- Also run: Tier 2 smoke — confirms MCP returns clean errors on oversized input

**"I added `AbortSignal.timeout()` to fetch calls"**
- Boundary: network
- Run: Tier 1 (build compiles) — but unit tests can't meaningfully verify timeout behavior
- Also run: Tier 2 smoke (server still boots), Tier 3 if available (real network calls timeout correctly)

**"I changed how `loadStarterScars` timestamps entries"**
- Boundary: filesystem
- Run: Tier 1 (test the class method directly with tmpdir)
- Also run: Tier 4 (`cli-fresh-install.test.ts` tests the full `gitmem init` flow)

**"I changed the session close ceremony wording"**
- Boundary: Claude API (agent must follow new instructions)
- Run: Tier 1 (if schema changed), Tier 4 (hook output format), Tier 5 (agent actually follows ceremony)

### Pre-commit minimum

| Situation | Run |
|-----------|-----|
| Any code change | `npm run test:unit` (Tier 1) — always, no exceptions |
| MCP server or tool changes | + `npm run test:smoke:free` (Tier 2) |
| Before pushing to GitHub | Tiers 1 + 2 minimum |
| Before npm publish | Tiers 1-5 (Tier 5 is the ship gate) |

---

## Adding New Tests

When adding new tests:

1. **Schema validation / pure logic** (Tier 1): Add to `tests/unit/schemas/` or `tests/unit/services/` — fast, deterministic, no dependencies
2. **Database behavior** (Tier 3): Add to existing integration suite or create new file in `tests/integration/` — needs Docker
3. **Free tier CLI / hooks** (Tier 4): Add to `cli-fresh-install.test.ts` or `free-tier.test.ts` — fast, no API cost
4. **Pro tier MCP** (Tier 4): Add to `pro-fresh.test.ts` or `pro-mature.test.ts` — needs Docker
5. **User experience / agent behavior** (Tier 5): Add to `user-journey.test.ts` — uses Agent SDK, costs API calls
6. **Performance regression** (Tier 6): Add bench to `tests/performance/` — update baselines in `baselines.ts`
7. **Hook scripts**: Add to `hooks/tests/test-hooks.sh` — bash, no dependencies

For user-journey tests, keep prompts simple and use `appendSystemPrompt` to constrain agent behavior. The agent is non-deterministic — test that tools are _called_, not that the agent says specific words.

---

## MCP Protocol Compliance

A dedicated compliance suite validates gitmem-mcp against the MCP protocol specification. See [`docs/compliance/mcp-protocol-compliance.md`](compliance/mcp-protocol-compliance.md) for the full report.

**Latest result:** 2026-02-16 · v1.0.3 · **36/36 PASS**

```bash
# Run compliance tests
GITMEM_TIER=free node tests/compliance/mcp-protocol-compliance.mjs
```

Tests cover: protocol handshake, tool listing, JSON Schema validation for all tools, tool execution, error handling (correct -32601 codes), and JSON-RPC 2.0 response format compliance.

---

## Known Limitations

- **Pro E2E tests verify MCP success, not DB persistence.** The MCP server uses Supabase PostgREST (HTTP), not direct PostgreSQL. Passing a `postgres://` URI as `SUPABASE_URL` causes the server to fall back to local `.gitmem/` storage. Full DB persistence verification would require a PostgREST layer on top of the test container.
- **Performance benchmarks require `vitest bench`**, not `vitest run`. The `npm run test:perf` script handles this, but running directly with `npx vitest run --config vitest.perf.config.ts` will fail.
- **`test:all` does not include user-journey or organic-discovery tests** (they cost API calls).

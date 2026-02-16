# GitMem Cursor IDE — Test Plan

**Date:** 2026-02-16
**Purpose:** Validate gitmem-mcp works correctly in Cursor IDE. Covers installation, MCP integration, agent behavior, hook compatibility, and cross-tool continuity with Claude Code.

**Prerequisite:** Cursor installed (latest version with MCP support). The existing Claude Code test plans (HUMAN-TEST-PLAN.md, WIZARD-TEST-PLAN.md) should already be passing.

---

## Architecture Context

### How Cursor Differs from Claude Code

| Aspect | Claude Code | Cursor |
|--------|-------------|--------|
| MCP config | `.mcp.json` or `.claude/mcp.json` | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global) |
| Instructions file | `CLAUDE.md` | `.cursorrules` |
| Hook events | SessionStart, PreToolUse, PostToolUse, Stop | beforeMCPExecution, afterMCPExecution |
| Hook config | `.claude/settings.json` | Cursor Settings JSON |
| Agent detection env var | `$CLAUDE_CODE_ENTRYPOINT` | None — use MCP handshake `clientInfo.name: "cursor"` |
| Session ID env var | `$CLAUDE_SESSION_ID` | None — needs PID or workspace-state fallback |
| Modes with MCP access | All | **Agent mode only** (Composer toggle) |
| Tool permissions | `.claude/settings.json` → `permissions.allow` | Cursor Settings → auto-approve list |
| Tool approval | Per-call prompt or auto-allow | Per-call prompt or YOLO mode |

### What We're Testing

1. **MCP protocol compatibility** — same stdio JSON-RPC, same tools, same schemas
2. **Init wizard Cursor path** — correct files written to correct locations
3. **Agent behavior** — Cursor's agent follows .cursorrules instructions
4. **Hook behavior** — beforeMCPExecution/afterMCPExecution work (or graceful degradation)
5. **Cross-tool continuity** — ~/.gitmem/ shared between Claude Code and Cursor
6. **No Claude-specific leaks** — output never says "Claude Code" when running in Cursor

---

## Phase 1: MCP Compatibility (Automated)

These tests verify the MCP server works when Cursor connects to it. Can be run without Cursor by simulating the handshake.

### Test 1.1 — Client detection via initialize handshake

Send an MCP `initialize` request with Cursor's client info:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "1.0",
    "capabilities": {},
    "clientInfo": {
      "name": "cursor",
      "version": "dev"
    }
  }
}
```

- [ ] Server responds with valid `initialize` result
- [ ] Server detects client as "cursor" (not "claude-code")
- [ ] Tool list includes all expected tools (55 free / 67 pro)

### Test 1.2 — Tool registration matches Claude Code

Compare tool lists between Claude Code and Cursor connections:

- [ ] Same tool count
- [ ] Same tool names
- [ ] Same input schemas
- [ ] No Claude-specific tools leak through (all tools are client-agnostic)

### Test 1.3 — Basic tool calls via stdio

With a Cursor-identified connection, call:

```
session_start → recall → confirm_scars → session_close
```

- [ ] All four calls succeed
- [ ] Response formats are identical to Claude Code
- [ ] Agent identity recorded as "cursor" (not "cli" or "desktop")

---

## Phase 2: Init Wizard — Cursor Path

### Test 2.1 — Clean room setup

```bash
mkdir ~/test-gitmem-cursor && cd ~/test-gitmem-cursor
git init
mkdir .cursor  # Cursor project indicator
```

### Test 2.2 — Init detects Cursor environment

```bash
npx gitmem-mcp init
```

**What to verify:**
- [ ] Wizard detects Cursor (via `.cursor/` directory presence)
- [ ] Prompts use "Cursor" not "Claude Code" in messaging
- [ ] Step outputs reference correct file paths

**Alternatively, if detection requires a flag:**
```bash
npx gitmem-mcp init --client cursor
```

- [ ] Flag accepted without error

### Test 2.3 — Correct files created for Cursor

```bash
# Memory store (same for all clients)
ls .gitmem/
# Expected: config.json, learnings.json, sessions.json, decisions.json, scar-usage.json

# Starter scars
cat .gitmem/learnings.json | jq '. | length'
# Expected: 12

# MCP config — Cursor-specific path
cat .cursor/mcp.json | jq .
# Expected: mcpServers.gitmem with command "npx" and args ["-y", "gitmem-mcp"]

# Instructions file — .cursorrules, NOT CLAUDE.md
cat .cursorrules
# Expected: gitmem instructions (session start, tools table, closing ceremony)
# Must NOT contain "CLAUDE.md" references

# Gitignore
cat .gitignore
# Expected: contains .gitmem/
```

- [ ] `.cursor/mcp.json` created (not `.mcp.json`)
- [ ] `.cursorrules` created (not `CLAUDE.md`)
- [ ] No `.claude/` directory created
- [ ] No `.claude/settings.json` created
- [ ] `.gitmem/` directory and starter scars identical to Claude Code install
- [ ] `.gitignore` updated

### Test 2.4 — What should NOT exist

```bash
ls .mcp.json 2>&1         # Should not exist
ls CLAUDE.md 2>&1          # Should not exist
ls .claude/ 2>&1           # Should not exist
```

- [ ] None of the Claude-specific files were created

### Test 2.5 — Content leak check

```bash
grep -ri "claude" .cursorrules             # Should return nothing
grep -ri "claude" .cursor/mcp.json         # Should return nothing
grep -ri "orchestra" .gitmem/              # Should return nothing
grep -ri "CLAUDE.md" .cursorrules          # Should return nothing
```

- [ ] Zero Claude/orchestra references in any generated file

### Test 2.6 — Idempotency

```bash
npx gitmem-mcp init --yes
```

- [ ] All steps show "already exists" or "merged"
- [ ] Scar count still 12
- [ ] `.cursor/mcp.json` not duplicated or corrupted
- [ ] `.cursorrules` gitmem section not duplicated

### Test 2.7 — Health check

```bash
npx gitmem-mcp check
```

- [ ] All checks pass
- [ ] Detects Cursor config at `.cursor/mcp.json`
- [ ] No reference to `.claude/settings.json` in output

---

## Phase 3: Live Cursor Session

### Prerequisites

- Cursor open with the test project
- MCP server shows green in Cursor Settings → MCP
- **Agent mode** enabled in Composer (not Chat, not normal Composer)

### Test 3.1 — MCP server connects

Open Cursor Settings → MCP Servers.

- [ ] gitmem server shows as connected (green indicator)
- [ ] No "failed to start" or connection errors
- [ ] Tool count visible matches expected

### Test 3.2 — Session start

Open Composer, toggle to **Agent** mode.

**Prompt:**
> Start a gitmem session for this project

- [ ] Agent calls `session_start`
- [ ] Session ID returned
- [ ] Agent identity recorded (should be "cursor", not "cli")
- [ ] No error toast or red indicators
- [ ] Tool result displayed in Composer (expandable)

### Test 3.3 — Recall

**Prompt:**
> Recall scars for "deploying to production"

- [ ] Agent calls `recall`
- [ ] Starter scars surface (e.g., "Done != Deployed != Verified Working")
- [ ] Results displayed readably in Composer
- [ ] Agent acknowledges the scars (without needing hook enforcement)

### Test 3.4 — Confirm scars

**Prompt:**
> Confirm those scars — mark them all as APPLYING with evidence "testing cursor integration"

- [ ] Agent calls `confirm_scars` with correct scar IDs
- [ ] Confirmation accepted
- [ ] No schema validation errors

### Test 3.5 — Create a learning

**Prompt:**
> Create a scar: title "Cursor MCP tools only work in Agent mode", description "Chat and normal Composer cannot call MCP tools — must toggle Agent mode in Composer. Users who try MCP in Chat will see no tools available.", severity "medium", counter_arguments ["Agent mode is the default for complex tasks", "Cursor docs clearly state this limitation"]

- [ ] Scar created successfully
- [ ] Persisted to `~/.gitmem/learnings.json` (or `.gitmem/learnings.json`)
- [ ] Returned scar ID and confirmation

### Test 3.6 — Search

**Prompt:**
> Search gitmem for "cursor"

- [ ] Finds the scar created in 3.5
- [ ] Results formatted correctly

### Test 3.7 — Close session

**Prompt:**
> Close this gitmem session. Use standard close.

- [ ] Agent answers the 7 reflection questions
- [ ] Agent asks "Any corrections or additions?"
- [ ] After human responds, agent writes closing-payload.json
- [ ] Agent calls `session_close`
- [ ] Session closes cleanly

**Key UX question:** Without a Stop hook, does the agent reliably follow the closing ceremony from `.cursorrules` instructions alone?

### Test 3.8 — Session continuity

Close Composer. Reopen, toggle Agent mode.

**Prompt:**
> Start a gitmem session — what happened last time?

- [ ] `session_start` loads previous session context
- [ ] Threads from previous session visible
- [ ] Scar created in 3.5 available via recall

---

## Phase 4: Hook Behavior

### Test 4.1 — beforeMCPExecution hook (if supported)

If Cursor's hook system supports gitmem integration:

1. Configure a `beforeMCPExecution` hook in Cursor Settings
2. Verify it fires before each gitmem tool call
3. Check if it can inject context (e.g., "reminder: confirm scars before proceeding")

- [ ] Hook fires on gitmem tool calls
- [ ] Hook can read tool name and arguments
- [ ] Hook can return allow/deny/ask decision
- [ ] Hook latency < 100ms (doesn't noticeably slow tool calls)

### Test 4.2 — afterMCPExecution hook (if supported)

1. Configure an `afterMCPExecution` hook
2. Verify it fires after gitmem tool calls return
3. Check if it can log tool results

- [ ] Hook fires after tool completion
- [ ] Hook receives tool result
- [ ] No interference with tool response to agent

### Test 4.3 — Graceful degradation (no hooks)

If hooks are NOT configured:

- [ ] All tools still work
- [ ] No error messages about missing hooks
- [ ] Session start/close still functional
- [ ] `.cursorrules` instructions are the sole enforcement mechanism
- [ ] Agent still follows ceremony (subjective — note quality)

### Test 4.4 — Hook-less enforcement quality

Run 3 sessions without hooks, relying only on `.cursorrules`:

| Session | Did agent call session_start first? | Did agent follow closing ceremony? | Recall before actions? |
|---------|--------------------------------------|-------------------------------------|----------------------|
| 1 | | | |
| 2 | | | |
| 3 | | | |

- [ ] session_start called in >= 2/3 sessions
- [ ] Closing ceremony followed in >= 2/3 sessions
- [ ] Document any behavioral gaps vs Claude Code with hooks

---

## Phase 5: Cross-Tool Continuity

### Test 5.1 — Cursor → Claude Code

1. In Cursor: create a scar and close session
2. Open Claude Code in the same project
3. Run recall

- [ ] Claude Code sees the scar created in Cursor
- [ ] Session history includes the Cursor session
- [ ] Agent identity shows "cursor" for previous session

### Test 5.2 — Claude Code → Cursor

1. In Claude Code: create a scar and close session
2. Open Cursor on the same project
3. Run recall in Agent mode

- [ ] Cursor sees the scar created in Claude Code
- [ ] Session history includes the Claude Code session
- [ ] No format incompatibilities

### Test 5.3 — Shared ~/.gitmem/ (global storage)

```bash
# Verify both tools use the same storage location
# After sessions in both tools:
cat ~/.gitmem/learnings.json | jq '. | length'
# Should include scars from BOTH Claude Code and Cursor sessions

ls ~/.gitmem/sessions/
# Should include session directories from BOTH tools
```

- [ ] Single learnings.json contains scars from both clients
- [ ] Sessions directory contains sessions from both clients
- [ ] No file locking conflicts when switching between tools

### Test 5.4 — Concurrent sessions (if possible)

Open Claude Code AND Cursor on the same project simultaneously.

- [ ] Both connect to separate MCP server instances (stdio = one per client)
- [ ] No file corruption in ~/.gitmem/
- [ ] Sessions don't interfere with each other
- [ ] Scar created in one is visible in other after refresh

---

## Phase 6: Edge Cases

### Test 6.1 — YOLO mode (auto-approve all tools)

Enable Cursor Settings → Agent → Auto-run tools.

- [ ] All gitmem tools execute without approval prompts
- [ ] Session lifecycle works end-to-end
- [ ] No security warnings from Cursor

### Test 6.2 — Multiple MCP servers

Add another MCP server alongside gitmem (e.g., filesystem server).

- [ ] Both servers connect successfully
- [ ] No tool name collisions
- [ ] gitmem tools still prefixed correctly (`mcp__gitmem__*`)

### Test 6.3 — Cursor restart mid-session

1. Start a gitmem session
2. Close and reopen Cursor (force quit)
3. Start a new session

- [ ] Previous session detectable via session_start (shows as incomplete)
- [ ] No corrupted state files
- [ ] New session starts cleanly

### Test 6.4 — Project-level vs global MCP config

Test with config in both locations:

**Scenario A:** Config only in `.cursor/mcp.json` (project)
- [ ] Server starts and tools available

**Scenario B:** Config only in `~/.cursor/mcp.json` (global)
- [ ] Server starts and tools available

**Scenario C:** Config in BOTH locations (same server name)
- [ ] Document which takes precedence
- [ ] No duplicate server connections

### Test 6.5 — Non-Agent modes

Open Cursor Chat (not Composer Agent):

**Prompt:**
> Use gitmem to recall scars about testing

- [ ] Confirm MCP tools are NOT available in Chat mode
- [ ] Error message is clear (not confusing)
- [ ] Document the user experience

Open Composer in **Normal** mode (not Agent):

- [ ] Confirm MCP tools are NOT available
- [ ] Document the user experience

### Test 6.6 — Uninstall in Cursor context

```bash
npx gitmem-mcp uninstall
```

- [ ] Removes gitmem from `.cursor/mcp.json` (not `.mcp.json`)
- [ ] Removes gitmem section from `.cursorrules` (not `CLAUDE.md`)
- [ ] Preserves `.gitmem/` data by default
- [ ] Does not touch `.claude/` directory

```bash
npx gitmem-mcp uninstall --all
```

- [ ] Also deletes `.gitmem/` directory

---

## Pass/Fail Matrix

### Phase 1: MCP Compatibility (Automated)

| # | Test | Pass? | Notes |
|---|------|-------|-------|
| 1.1 | Client detection via handshake | | |
| 1.2 | Tool registration matches Claude Code | | |
| 1.3 | Basic tool calls via stdio | | |

### Phase 2: Init Wizard

| # | Test | Pass? | Notes |
|---|------|-------|-------|
| 2.1 | Clean room setup | | |
| 2.2 | Init detects Cursor | | |
| 2.3 | Correct files created | | |
| 2.4 | No Claude-specific files | | |
| 2.5 | No content leaks | | |
| 2.6 | Idempotency | | |
| 2.7 | Health check | | |

### Phase 3: Live Cursor Session

| # | Test | Pass? | Notes |
|---|------|-------|-------|
| 3.1 | MCP server connects | | |
| 3.2 | Session start | | |
| 3.3 | Recall | | |
| 3.4 | Confirm scars | | |
| 3.5 | Create learning | | |
| 3.6 | Search | | |
| 3.7 | Close session | | |
| 3.8 | Session continuity | | |

### Phase 4: Hook Behavior

| # | Test | Pass? | Notes |
|---|------|-------|-------|
| 4.1 | beforeMCPExecution fires | | |
| 4.2 | afterMCPExecution fires | | |
| 4.3 | Graceful degradation (no hooks) | | |
| 4.4 | Hook-less enforcement quality (3 sessions) | | |

### Phase 5: Cross-Tool Continuity

| # | Test | Pass? | Notes |
|---|------|-------|-------|
| 5.1 | Cursor → Claude Code | | |
| 5.2 | Claude Code → Cursor | | |
| 5.3 | Shared ~/.gitmem/ | | |
| 5.4 | Concurrent sessions | | |

### Phase 6: Edge Cases

| # | Test | Pass? | Notes |
|---|------|-------|-------|
| 6.1 | YOLO mode | | |
| 6.2 | Multiple MCP servers | | |
| 6.3 | Restart mid-session | | |
| 6.4 | Project vs global config | | |
| 6.5 | Non-Agent modes | | |
| 6.6 | Uninstall | | |

---

## Ship Criteria

**Must pass (blockers):**
- All Phase 1 tests (MCP compatibility)
- Phase 2: Tests 2.2-2.5 (correct Cursor-specific files, no leaks)
- Phase 3: Tests 3.1-3.3, 3.7-3.8 (connect, session lifecycle, continuity)
- Phase 5: Tests 5.1-5.3 (cross-tool continuity)

**Should pass (launch quality):**
- Phase 2: 2.6-2.7 (idempotency, health check)
- Phase 3: 3.4-3.6 (confirm, create, search)
- Phase 4: 4.3 (graceful degradation)
- Phase 6: 6.2, 6.6 (multi-server, uninstall)

**Nice to have (document gaps):**
- Phase 4: 4.1-4.2, 4.4 (hooks — depends on Cursor's hook maturity)
- Phase 6: 6.1, 6.3-6.5 (edge cases)

---

## Resolved Decisions (from research phase, 2026-02-16)

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Init wizard detection | **Both**: auto-detect `.cursor/` dir + `--client cursor` flag override | Covers auto-discovery and explicit control |
| 2 | Hook strategy | **Direct port**: write `.cursor/hooks.json` with sessionStart, beforeMCPExecution, afterMCPExecution, stop | Cursor has all 4 hook events we need. Hooks are synchronous blocking bash scripts — same model as Claude Code. Beta since Oct 2025 but enterprise partnerships (MintMCP, Akto, Snyk) suggest production-ready. |
| 3 | .cursorrules enforcement | **Soft fallback only**: hooks carry enforcement load, .cursorrules is degraded fallback | Research shows ~50% compliance rate for .cursorrules. Rules are advisory ("use if useful"). Context overflow drops them. Same role as CLAUDE.md without hooks. |
| 4 | Session ID tracking | **Hook payload bridge**: sessionStart hook receives `conversation_id` from Cursor, writes to `.gitmem/cursor-session.json`, MCP server reads it. Fallback: UUID v7 at session_start call time. | Cursor hooks provide `conversation_id` and `generation_id` in stdin payload. MCP tool calls get zero session context. The hook-to-file bridge solves this. |
| 5 | Config precedence | **Project-level default**: write to `.cursor/mcp.json` (project) | Project overrides global in Cursor, matching Claude Code's model. Community convention. |

### Key Research Sources
- Hook system: GitButler deep dive, MintMCP governance guide, Cursor 1.7 release notes
- .cursorrules: Cursor forum threads on enforcement failures, "Cursor Under the Hood" technical analysis
- Session tracking: MCP spec _meta field, Cursor Chat History MCP server, Cline PR #2990
- Config: Cursor official docs, community guides

---

## Relationship to Other Test Plans

| Plan | Scope | Overlap |
|------|-------|---------|
| **HUMAN-TEST-PLAN.md** | Claude Code free tier UX | Phases 2-3 adapted from this |
| **WIZARD-TEST-PLAN.md** | Claude Code init wizard in Docker | Phase 2 adapted from this |
| **CURSOR-TEST-PLAN.md** (this) | Cursor IDE full coverage | Unique: cross-tool, hooks, agent mode |
| **Automated tiers 1-6** | Claude Code MCP protocol | Phase 1 extends smoke/e2e tiers |

This plan is designed to be run **after** the Claude Code plans pass. Cursor-specific failures should not block Claude Code releases, but should block "Works with Cursor" marketing claims.

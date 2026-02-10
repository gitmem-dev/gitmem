# gitmem-hooks

A Claude Code **plugin** that enforces the GitMem institutional memory lifecycle through hooks. Ships inside the `gitmem-mcp` npm package.

## What It Does

| Hook | Event | Behavior |
|------|-------|----------|
| **Session Start** | `SessionStart` | Detects gitmem MCP, tells Claude to auto-call `session_start` |
| **Recall Check** | `PreToolUse` | Reminds Claude to call `recall` before consequential actions |
| **Audit Trail** | `PostToolUse` | Logs LOOKED/ACTION events to append-only JSONL |
| **Close Check** | `Stop` | Blocks session end if `session_close` wasn't called |

## Installation

```bash
npx gitmem install-hooks
```

This copies the hooks plugin to `~/.claude/plugins/gitmem-hooks/`. Restart Claude Code to activate.

### Uninstall

```bash
npx gitmem uninstall-hooks
```

Removes the plugin, cleans up settings and temp state.

## Prerequisites

- **gitmem MCP server** configured in `.mcp.json` or via `--mcp-config`
- `bash` (scripts are pure bash — no Python dependency)

## How It Works

### Session Start Hook

On every new Claude Code session:
1. Checks `.mcp.json` for a `gitmem` or `gitmem-mcp` server entry
2. If found: injects instruction telling Claude to call `session_start`
3. If not found: outputs a graceful "not detected" message — no errors
4. Creates session state in `/tmp/gitmem-hooks-{session_id}/`

### Recall Check Hook (PreToolUse)

Before consequential actions:
- **Bash**: `git push`, `git tag`, `npm publish`, deploy commands
- **Linear**: state changes to Done/Complete
- **Write/Edit**: `.sql` migrations, `.env` files

Two enforcement mechanisms:
1. **Confirmation gate** (hard block): If `recall()` surfaced scars but `confirm_scars()` wasn't called
2. **Recall nag** (soft reminder): If recall hasn't been called AND >3 tool calls

### Audit Trail Hook (PostToolUse)

Logs events to `/tmp/gitmem-hooks-{session_id}/audit.jsonl`:
- **LOOKED events**: After `recall`, `search`, `semantic_search`
- **ACTION events**: After `git push`, Linear Done transitions, `.sql`/`.env` writes

### Close Check Hook (Stop)

When Claude tries to stop:
- **Trivial sessions** (< 5 tool calls, < 5 minutes) → skip enforcement
- **Meaningful sessions** with active session → block with reminder
- **Properly closed sessions** → allow
- **Infinite loop guard**: if hook already blocked once, always allows on retry

## Session State

Tracked in `/tmp/gitmem-hooks-{session_id}/`:

| File | Purpose |
|------|---------|
| `start_time` | Unix epoch of session start |
| `tool_call_count` | Counter incremented by recall-check |
| `last_nag_time` | Cooldown tracking for recall reminders |
| `stop_hook_active` | Guard flag to prevent infinite blocking |
| `audit.jsonl` | Append-only audit trail |

Cleaned up automatically when session closes properly.

## Graceful Degradation

If gitmem MCP is not configured:
- Session start outputs informational message (no error)
- All other hooks become silent no-ops
- No errors, no blocking

## File Structure

```
hooks/
├── .claude-plugin/
│   └── plugin.json              # Plugin metadata
├── hooks/
│   └── hooks.json               # Hook registrations (4 hooks)
├── scripts/
│   ├── session-start.sh         # SessionStart → auto-call session_start
│   ├── recall-check.sh          # PreToolUse → recall reminder + confirmation gate
│   ├── session-close-check.sh   # Stop → enforce session_close
│   └── post-tool-use.sh         # PostToolUse → audit trail
├── tests/
│   └── test-hooks.sh            # Bash test suite (41 tests)
└── README.md
```

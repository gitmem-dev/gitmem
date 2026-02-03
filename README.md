# GitMem

Institutional memory for AI coding agents. Never repeat the same mistake.

## Features

- **Predict**: Check institutional memory for relevant learnings before taking action (core GitMem MVP tool)
- **Session Start**: Initialize session, detect agent identity, load last session context, retrieve relevant learnings, load recent decisions
- **Session Close**: Persist session with compliance validation (standard/quick/autonomous close types)
- **Learning Capture**: Create scars, wins, patterns, and anti-patterns in institutional memory
- **Decision Logging**: Log architectural and operational decisions
- **Scar Usage Tracking**: Track scar application for effectiveness measurement

### Learning Types

GitMem tracks **all learning types**:
- **Scars** — Failures to avoid (critical institutional memory)
- **Patterns** — Neutral observations and recurring patterns
- **Wins** — Successes to replicate
- **Anti-patterns** — Known bad approaches

All learning types use the same vector search infrastructure and are queried together for comprehensive institutional context.

## Quick Start

### Free Tier (zero config)

```bash
npx gitmem init
npx gitmem configure
```

Copy `CLAUDE.md.template` into your project, then start coding — memory is active.

### Pro Tier (with Supabase)

1. Create a free Supabase project at [database.new](https://database.new)
2. `npx gitmem setup` — copy the SQL output into Supabase SQL Editor
3. Get an API key for embeddings (OpenAI, OpenRouter, or Ollama)
4. `npx gitmem configure` — generates your `.mcp.json` config
5. `npx gitmem init` — loads starter scars into Supabase
6. Copy `CLAUDE.md.template` into your project
7. Start coding — memory is active!

## Installation

### npm (recommended)

```bash
npm install gitmem
```

### npx (no install)

```bash
npx gitmem init
```

### MCP Registration

Add to your project's `.mcp.json` (Claude Code) or IDE settings (Cursor, Windsurf):

```json
{
  "mcpServers": {
    "gitmem": {
      "command": "npx",
      "args": ["-y", "gitmem"]
    }
  }
}
```

For Pro tier, add environment variables:

```json
{
  "mcpServers": {
    "gitmem": {
      "command": "npx",
      "args": ["-y", "gitmem"],
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "eyJ...",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### Verify

```bash
claude mcp list
# Should show: gitmem: ✓ Connected
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `gitmem init` | Initialize memory (loads starter scars) |
| `gitmem setup` | Output SQL for Supabase schema setup |
| `gitmem configure` | Generate `.mcp.json` config |
| `gitmem server` | Start MCP server (default) |
| `gitmem help` | Show help |

## MCP Tools

### `predict`

Check institutional memory for relevant learnings before taking action.

**Parameters:**
- `plan` (required) - What you're about to do (e.g., "deploy to production")
- `project?` - Project scope (default: "orchestra_dev")
- `match_count?` - Number of learnings to return (default: 3)

### `session_start`

Initialize session and load institutional context.

**Parameters:**
- `agent_identity?` - Override agent identity (auto-detects if not provided)
- `linear_issue?` - Current Linear issue identifier
- `project?` - Project scope

### `session_close`

Persist session with compliance validation.

**Parameters:**
- `session_id` (required) - From session_start
- `close_type` (required) - "standard" | "quick" | "autonomous"
- `closing_reflection?` - Reflection answers (required for standard)
- `human_corrections?` - Human additions (required for standard)

### `create_learning`

Create scar, win, or pattern entry.

**Parameters:**
- `learning_type` (required) - "scar" | "win" | "pattern"
- `title`, `description` (required)
- `severity?` - For scars: "critical" | "high" | "medium" | "low"
- `counter_arguments?` - For scars: min 2 required

### `create_decision`

Log decision to institutional memory.

**Parameters:**
- `title`, `decision`, `rationale` (required)
- `alternatives_considered?` - Rejected options
- `linear_issue?` - Associated issue

### `record_scar_usage`

Track scar application.

**Parameters:**
- `scar_id` (required) - Learning UUID
- `reference_type` (required) - "explicit" | "implicit" | "acknowledged" | "refuted" | "none"
- `reference_context` (required) - How scar was applied

## Agent Detection

Automatically detects agent identity based on:
- `CLAUDE_CODE_ENTRYPOINT` environment variable
- Docker container presence (`/.dockerenv`)
- Hostname

| ENTRYPOINT | Docker | Identity |
|------------|--------|----------|
| cli | YES | CLI |
| cli | NO | CODA-1 |
| claude-desktop | NO | DAC |
| (empty) | (has fs) | Brain_Local |
| (empty) | (no fs) | Brain_Cloud |

## Development

```bash
npm install
npm run build
npm run dev  # Watch mode
npm test
```

## License

MIT

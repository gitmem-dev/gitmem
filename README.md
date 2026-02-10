# GitMem

Institutional memory for AI coding agents. Never repeat the same mistake.

GitMem is an [MCP server](https://modelcontextprotocol.io/) that gives your AI coding agent persistent memory across sessions. It remembers mistakes (scars), successes (wins), and architectural decisions — so your agent learns from experience instead of starting from scratch every time.

## How It Works

1. **Before each task**, the agent calls `recall` with a plan — GitMem surfaces relevant warnings from past sessions
2. **When mistakes happen**, the agent captures them as "scars" — failures with context and counter-arguments
3. **When things go well**, the agent captures wins and patterns to replicate
4. **At session close**, the agent reflects on what worked, what broke, and what to do differently

Over time, your agent builds institutional memory that prevents repeated mistakes and reinforces good patterns.

### Two Tiers

| | Free Tier | Pro Tier |
|---|-----------|----------|
| **Storage** | Local `.gitmem/` directory | Supabase (PostgreSQL + pgvector) |
| **Search** | Keyword matching | Semantic vector search |
| **Setup** | Zero config | Supabase project + embedding API key |
| **Best for** | Solo projects | Teams, cross-project memory |

## Quick Start

### Free Tier (zero config)

```bash
npx gitmem-mcp init
npx gitmem-mcp configure
```

This creates a `.gitmem/` directory with starter scars and prints the MCP config to add to your editor.

Add the config to your project's `.mcp.json` (Claude Code) or IDE settings (Cursor, Windsurf), then copy `CLAUDE.md.template` into your project root. Start coding — memory is active.

### Pro Tier (with Supabase)

1. Create a free Supabase project at [database.new](https://database.new)
2. `npx gitmem-mcp setup` — copy the SQL output into Supabase SQL Editor
3. Get an API key for embeddings (OpenAI, OpenRouter, or Ollama)
4. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as environment variables
5. `npx gitmem-mcp configure` — generates your MCP config with env vars
6. `npx gitmem-mcp init` — loads starter scars into Supabase
7. Copy `CLAUDE.md.template` into your project
8. Start coding — memory is active!

## Installation

### npx (no install required)

```bash
npx gitmem-mcp init
```

### Global install

```bash
npm install -g gitmem-mcp
gitmem init
```

### MCP Configuration

Add to your project's `.mcp.json` (Claude Code) or IDE MCP settings (Cursor, Windsurf):

**Free Tier:**
```json
{
  "mcpServers": {
    "gitmem": {
      "command": "npx",
      "args": ["-y", "gitmem-mcp"]
    }
  }
}
```

**Pro Tier:**
```json
{
  "mcpServers": {
    "gitmem": {
      "command": "npx",
      "args": ["-y", "gitmem-mcp"],
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "eyJ...",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

Alternative embedding providers (set instead of `OPENAI_API_KEY`):
- `OPENROUTER_API_KEY` — OpenRouter (multiple models)
- `OLLAMA_URL` — Local Ollama instance (no API key needed)

### Verify

```bash
# Claude Code
claude mcp list
# Should show: gitmem: connected
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `gitmem init` | Initialize memory — loads starter scars (auto-detects tier) |
| `gitmem setup` | Output SQL for Supabase schema setup (Pro tier) |
| `gitmem configure` | Generate MCP config for your editor |
| `gitmem check` | Run diagnostic health check |
| `gitmem check --full` | Full diagnostic with benchmarks |
| `gitmem install-hooks` | Install Claude Code hooks plugin |
| `gitmem uninstall-hooks` | Remove Claude Code hooks plugin |
| `gitmem server` | Start MCP server (default when no command given) |
| `gitmem help` | Show help |

## MCP Tools

GitMem exposes tools via the Model Context Protocol. Your AI agent calls these automatically based on the instructions in `CLAUDE.md.template`.

### Core Tools

| Tool | Purpose |
|------|---------|
| `recall` | Check memory for relevant warnings before taking action |
| `session_start` | Initialize session, load context from last session |
| `session_close` | Persist session with reflection |
| `create_learning` | Capture scars (failures), wins (successes), or patterns |
| `create_decision` | Log architectural/operational decisions |
| `record_scar_usage` | Track which scars were applied |
| `search` | Search institutional memory (exploration, no side effects) |
| `log` | List recent learnings chronologically |

### Thread Tools

Threads are persistent work items that carry across sessions.

| Tool | Purpose |
|------|---------|
| `list_threads` | List open threads |
| `create_thread` | Create a new thread |
| `resolve_thread` | Mark a thread as resolved |

### Pro Tier Tools

Available when Supabase is configured:

| Tool | Purpose |
|------|---------|
| `analyze` | Session analytics and pattern detection |
| `prepare_context` | Multi-agent context preparation |
| `absorb_observations` | Multi-agent observation absorption |
| Cache tools | `cache_status`, `cache_flush`, `cache_health` |

## Learning Types

GitMem tracks four types of institutional knowledge:

- **Scars** — Failures to avoid. Include severity and counter-arguments (why someone might think the mistake is OK). These are the core of GitMem.
- **Wins** — Successes to replicate. Capture what worked and why.
- **Patterns** — Neutral observations and recurring approaches.
- **Anti-patterns** — Known bad approaches to flag.

All types are searched together when `recall` is called, giving the agent comprehensive context.

## Hooks Plugin

GitMem includes a Claude Code hooks plugin that automates memory protocols:

- **SessionStart** — Automatically calls `session_start` when a session begins
- **PreToolUse** — Reminds the agent to call `recall` before consequential actions
- **PostToolUse** — Tracks scar acknowledgment
- **Stop** — Reminds the agent to close sessions properly

Install:
```bash
npx gitmem-mcp install-hooks
```

Uninstall:
```bash
npx gitmem-mcp uninstall-hooks
```

## Agent Detection

GitMem automatically detects the AI agent identity based on environment:

| Environment | Identity |
|-------------|----------|
| Claude Code in Docker | CLI |
| Claude Desktop app | DAC |
| Claude.ai with filesystem | Brain_Local |
| Claude.ai without filesystem | Brain_Cloud |

Override with `agent_identity` parameter in `session_start`.

## Development

```bash
git clone https://github.com/nTEG-dev/gitmem.git
cd gitmem
npm install
npm run build    # Compile TypeScript + run unit tests
npm run dev      # Watch mode
npm test         # Run unit tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing tiers, and PR guidelines.

## License

MIT — see [LICENSE](LICENSE).

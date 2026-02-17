---
name: gitmem
description: Institutional memory for AI agents via MCP. Gives your agent persistent memory that survives across sessions — mistakes (scars), successes (wins), decisions, and open threads. Use when you want your agent to stop repeating the same mistakes, carry context between sessions, and learn from experience. Not chat history — earned knowledge.
homepage: https://gitmem.ai
metadata: '{"openclaw":{"emoji":"🧠","requires":{"bins":["npx"],"env":[]},"os":["darwin","linux","win32"]}}'
user-invocable: true
---

# GitMem — Institutional Memory for AI Agents

Your agent starts from zero every session. GitMem fixes that.

It's an MCP server that gives your agent **persistent memory across sessions** — not chat history, but *earned knowledge*: mistakes to avoid, approaches that worked, architectural decisions, and unfinished work.

## Setup

### 1. Add the MCP server

```bash
openclaw mcp add gitmem -- npx -y gitmem-mcp
```

Or add manually to `~/.openclaw/mcp.json`:

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

### 2. Initialize in your project

```bash
cd your-project
npx gitmem-mcp init
```

The wizard creates:
- `.gitmem/` directory with 3 starter scars
- Memory protocol instructions for your agent
- Lifecycle hooks for automatic session management

Already have config? The wizard merges without destroying anything. Re-running is safe.

## How It Works

```
recall  →  work  →  learn  →  close  →  recall  →  ...
```

1. **Recall** — Before acting, the agent checks memory for relevant lessons
2. **Work** — The agent applies past lessons automatically
3. **Learn** — Mistakes become scars, successes become wins
4. **Close** — Session reflection persists context for next time

## What Gets Remembered

| Type | Purpose | Example |
|------|---------|---------|
| **Scars** | Mistakes to avoid | "Always validate UUID format before DB lookup" |
| **Wins** | Approaches that worked | "Parallel agent spawning cut review time by 60%" |
| **Patterns** | Reusable strategies | "5-tier test pyramid for MCP servers" |
| **Decisions** | Architectural choices + rationale | "Chose JWT over session cookies for stateless auth" |
| **Threads** | Unfinished work across sessions | "Rate limiting still needs implementation" |

Every scar includes **counter-arguments** — reasons why someone might reasonably ignore it. This prevents memory from becoming rigid rules.

## Tools Reference

Once the MCP server is running, your agent gets these tools:

| Tool | When to use |
|------|-------------|
| `recall` | Before any task — surfaces relevant warnings from past experience |
| `confirm_scars` | After recall — acknowledge each scar as APPLYING, N_A, or REFUTED |
| `search` | Explore institutional knowledge by topic |
| `log` | Browse recent learnings chronologically |
| `session_start` | Beginning of session — loads context and open threads |
| `session_close` | End of session — persists what you learned |
| `create_learning` | Capture a mistake (scar), success (win), or pattern |
| `create_decision` | Log an architectural or operational decision |
| `list_threads` | See unresolved work carrying over between sessions |
| `create_thread` | Track something that needs follow-up later |

## How This Differs from OpenClaw's Built-in Memory

OpenClaw's native memory tracks **what was said** — conversation history, user preferences, context.

GitMem tracks **what was learned** — earned lessons from things that broke, decisions and their rationale, approaches that worked and why. It's the difference between remembering a conversation and remembering the lesson from it.

They complement each other:

| | OpenClaw Memory | GitMem |
|---|----------------|--------|
| **Scope** | Conversational context | Institutional knowledge |
| **Loaded** | Automatically every turn | On-demand via recall |
| **Best for** | Preferences, history | Lessons, decisions, patterns |
| **Updates** | Continuous | Session ceremonies |
| **Example** | "User prefers Python" | "Always run migrations with --dry-run first" |

## Example Session

```
Agent: [session_start] Loading context...
       2 open threads, 15 scars in memory.

You:   "Add caching to the API"

Agent: [recall plan="implement caching layer"]
       ⚠ Scar: "Cache invalidation caused stale data bug — always set TTL"
       ⚠ Scar: "Redis connection pooling required in containerized deploys"
       [confirm_scars] APPLYING both — using TTL and connection pool.

       ... implements caching with TTL and pooling ...

You:   "done for today"

Agent: [session_close]
       Reflection:
       - What worked: Redis caching with TTL pattern
       - New scar: "Cache key collisions between services — namespace keys"
       - Open thread: "Cache warming strategy still TBD"
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `npx gitmem-mcp init` | Interactive setup wizard |
| `npx gitmem-mcp init --yes` | Non-interactive setup |
| `npx gitmem-mcp init --dry-run` | Preview changes |
| `npx gitmem-mcp check` | Diagnostic health check |
| `npx gitmem-mcp uninstall` | Clean removal (preserves data) |

## Links

- **Docs**: https://gitmem.ai/docs
- **npm**: https://www.npmjs.com/package/gitmem-mcp
- **GitHub**: https://github.com/gitmem-dev/gitmem
- **Getting Started**: https://gitmem.ai/docs/getting-started

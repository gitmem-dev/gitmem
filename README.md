<p align="center">
  <img src="assets/banner.svg" alt="GitMem — Institutional memory for AI coding agents" width="700" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/gitmem-mcp"><img src="https://img.shields.io/npm/v/gitmem-mcp?style=flat-square&color=ed1e25&label=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/gitmem-mcp"><img src="https://img.shields.io/npm/dm/gitmem-mcp?style=flat-square&color=333333&label=downloads" alt="npm downloads" /></a>
  <a href="https://github.com/nTEG-dev/gitmem/blob/main/LICENSE"><img src="https://img.shields.io/github/license/nTEG-dev/gitmem?style=flat-square&color=ed1e25" alt="MIT License" /></a>
  <a href="https://github.com/nTEG-dev/gitmem/actions"><img src="https://img.shields.io/github/actions/workflow/status/nTEG-dev/gitmem/deploy-docs.yml?style=flat-square&color=333333&label=build" alt="Build" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-ed1e25?style=flat-square" alt="Node.js >= 22" />
</p>

<p align="center">
  <a href="https://gitmem.dev/docs"><strong>Documentation</strong></a> &middot;
  <a href="https://www.npmjs.com/package/gitmem-mcp"><strong>npm</strong></a> &middot;
  <a href="https://gitmem.dev/docs/getting-started"><strong>Getting Started</strong></a> &middot;
  <a href="https://gitmem.dev/docs/tools"><strong>Tool Reference</strong></a>
</p>

---

GitMem is an [MCP server](https://modelcontextprotocol.io/) that gives your AI coding agent **persistent memory across sessions**. It remembers mistakes (scars), successes (wins), and decisions — so your agent learns from experience instead of starting from scratch every time.

Works with **Claude Code**, **Claude Desktop**, **Cursor**, and any MCP-compatible client.

## Quick Start

```bash
npx gitmem init
```

One command. The wizard sets up everything:
- `.gitmem/` directory with 12 starter scars
- `.mcp.json` with gitmem server entry
- `CLAUDE.md` with memory protocol instructions
- `.claude/settings.json` with tool permissions
- Lifecycle hooks for automatic session management
- `.gitignore` updated

Already have existing config? The wizard merges without destroying anything. Re-running is safe.

```bash
npx gitmem init --yes       # Non-interactive
npx gitmem init --dry-run   # Preview changes
```

## How It Works

```
recall  -->  work  -->  learn  -->  close  -->  recall  -->  ...
```

1. **Recall** — Before acting, the agent checks memory for relevant lessons from past sessions
2. **Work** — The agent does the task, applying past lessons automatically
3. **Learn** — Mistakes become **scars**, successes become **wins**, strategies become **patterns**
4. **Close** — Session reflection persists context for next time

Every scar includes **counter-arguments** — reasons why someone might reasonably ignore it. This prevents memory from becoming a pile of rigid rules.

## What Gets Remembered

| Type | Purpose | Example |
|------|---------|---------|
| **Scars** | Mistakes to avoid | "Always validate UUID format before DB lookup" |
| **Wins** | Approaches that worked | "Parallel agent spawning cut review time by 60%" |
| **Patterns** | Reusable strategies | "5-tier test pyramid for MCP servers" |
| **Decisions** | Architectural choices with rationale | "Chose JWT over session cookies for stateless auth" |
| **Threads** | Unfinished work that carries across sessions | "Rate limiting still needs implementation" |

## Key Features

- **Automatic Recall** — Scars surface before the agent takes similar actions
- **Session Continuity** — Context, threads, and rapport carry across sessions
- **Closing Ceremony** — Structured reflection captures what broke, what worked, and what to do differently
- **23 MCP Tools** — Full toolkit for memory management, search, threads, and multi-agent coordination
- **Zero Config** — `npx gitmem init` and you're running
- **Non-Destructive** — Merges with your existing `.mcp.json`, `CLAUDE.md`, and hooks

## Supported Clients

| Client | Setup |
|--------|-------|
| **Claude Code** | `npx gitmem init` (auto-detected) |
| **Claude Desktop** | `npx gitmem init` or add to `claude_desktop_config.json` |
| **Cursor** | `npx gitmem init` or add to `.cursor/mcp.json` |
| **Any MCP client** | Add `npx -y gitmem-mcp` as an MCP server |

<details>
<summary><strong>Manual MCP configuration</strong></summary>

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

</details>

## CLI Commands

| Command | Description |
|---------|-------------|
| `npx gitmem init` | Interactive setup wizard |
| `npx gitmem init --yes` | Non-interactive setup |
| `npx gitmem init --dry-run` | Preview changes |
| `npx gitmem uninstall` | Clean removal (preserves `.gitmem/` data) |
| `npx gitmem uninstall --all` | Full removal including data |
| `npx gitmem check` | Diagnostic health check |

## Pro Tier — Coming Soon

The free tier gives you everything you need for solo projects. **Pro** will add cloud storage (Supabase), semantic vector search, cross-machine sync, team shared memory, and session transcripts.

[Join the mailing list](https://gitmem.dev) to get notified when Pro launches.

## Development

```bash
git clone https://github.com/nTEG-dev/gitmem.git
cd gitmem
npm install
npm run build
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for full development setup.

## License

MIT — see [LICENSE](LICENSE).

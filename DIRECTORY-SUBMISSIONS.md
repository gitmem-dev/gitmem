# MCP Directory Submission Copy

Reusable copy for submitting gitmem-mcp to MCP directories. Not published — internal reference only.

---

## Short Description (one-liner)

Institutional memory for AI coding agents. Your agent remembers mistakes, successes, and decisions across sessions — so it learns from experience instead of starting from scratch.

## Medium Description (2-3 sentences)

GitMem is an MCP server that gives AI coding agents persistent memory across sessions. It tracks mistakes (scars), successes (wins), architectural decisions, and unfinished work — surfacing relevant lessons before the agent takes action. One command setup: `npx gitmem-mcp init`.

## Key Features (bullet points)

- Persistent memory across coding sessions — mistakes, wins, decisions, and open threads
- Automatic recall — relevant lessons surface before the agent repeats past errors
- Session continuity with structured closing ceremony that captures what broke and what worked
- 20+ MCP tools for memory management, search, threads, and multi-agent coordination
- Zero config setup: `npx gitmem-mcp init` auto-detects your IDE
- Local-first, no telemetry — all data in `.gitmem/` on your machine
- Works with Claude Code, Cursor, VS Code (Copilot), Windsurf, and any MCP client

## Tags/Categories

`ai-memory`, `ai-agent`, `coding`, `developer-tools`, `productivity`, `knowledge-management`, `mcp-server`

## Links

- **npm:** https://www.npmjs.com/package/gitmem-mcp
- **GitHub:** https://github.com/gitmem-dev/gitmem
- **Website:** https://gitmem.ai
- **Docs:** https://gitmem.ai/docs

## Install

```json
{
  "mcpServers": {
    "gitmem": {
      "command": "npx",
      "args": ["-y", "gitmem-mcp@latest"]
    }
  }
}
```

---

## Per-Directory Submissions

### 1. mcp.so — GitHub Issue

**Title:** Add GitMem — Institutional memory for AI coding agents

**Body:**

**Server Name:** GitMem

**Description:** Institutional memory for AI coding agents. Your agent remembers mistakes (scars), successes (wins), and decisions across sessions — surfacing relevant lessons before repeating past errors. One command setup, local-first, no telemetry.

**GitHub:** https://github.com/gitmem-dev/gitmem

**npm:** https://www.npmjs.com/package/gitmem-mcp

**Website:** https://gitmem.ai

**Features:**
- Persistent memory across coding sessions (scars, wins, decisions, threads)
- Automatic recall — surfaces relevant warnings before similar actions
- Session continuity with structured reflection
- 20+ MCP tools
- Works with Claude Code, Cursor, VS Code (Copilot), Windsurf
- Zero config: `npx gitmem-mcp init`
- Local-first, no telemetry, MIT licensed

**Install:**
```json
{
  "mcpServers": {
    "gitmem": {
      "command": "npx",
      "args": ["-y", "gitmem-mcp@latest"]
    }
  }
}
```

**Categories:** Developer Tools, Productivity, Knowledge Management

---

### 2. Smithery — Registry Listing

Smithery pulls from GitHub repos. May need a `smithery.yaml` in the repo root. Research the exact format before creating.

**Server Name:** gitmem
**Display Name:** GitMem
**Description:** Institutional memory for AI coding agents. Remembers mistakes, successes, and decisions across sessions.

---

### 3. Glama — Add Server Form

**Server Name:** GitMem
**GitHub URL:** https://github.com/gitmem-dev/gitmem
**Description:** MCP server that gives AI coding agents persistent memory across sessions. Tracks mistakes (scars), successes (wins), and architectural decisions. Surfaces relevant lessons before the agent takes action. Zero config: `npx gitmem-mcp init`.
**Email:** dev@gitmem.ai

---

### 4. Cline Marketplace — GitHub Issue

**Title:** Add GitMem — Institutional memory for AI coding agents

**Body:**

**GitHub Repo URL:** https://github.com/gitmem-dev/gitmem

**Logo:** (attach logo-400.png — 400x400 PNG)

**Reason for Addition:**
GitMem gives Cline persistent memory across sessions. Instead of starting from scratch each time, Cline remembers past mistakes (scars), successes (wins), and architectural decisions. Before taking action, relevant lessons automatically surface — preventing repeated errors.

Key benefits for Cline users:
- `npx gitmem-mcp init` auto-detects Cline and sets up everything
- Scars prevent repeating the same debugging cycles
- Session threads carry unfinished work across sessions
- Local-first, no telemetry, MIT licensed

Setup tested with Cline using README.md — installs and configures without issues.

---

### 5. mcpservers.org (Awesome MCP Servers)

Likely a GitHub PR to add an entry. Check their repo structure before submitting.

**Entry:**
- **GitMem** — Institutional memory for AI coding agents. Persistent scars, wins, decisions, and session continuity. `npx gitmem-mcp init`. [GitHub](https://github.com/gitmem-dev/gitmem)

---

### 6. MCP Market (mcpmarket.com)

**Server Name:** GitMem
**Description:** Institutional memory for AI coding agents. Remembers mistakes, successes, and decisions across sessions — surfacing relevant lessons before repeating past errors.
**GitHub:** https://github.com/gitmem-dev/gitmem
**npm:** gitmem-mcp
**Categories:** Developer Tools, Productivity

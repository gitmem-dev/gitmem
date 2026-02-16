# GitMem Clean Room Test

Validates the first-user experience in an isolated container. No gitmem source code — only what npm delivers from GitHub Packages.

## Prerequisites

1. **GitMem published to GitHub Packages** — `v0.2.0` tag pushed, CI green
2. **GitHub PAT** with `read:packages` scope (classic token)
3. **Anthropic API key** (for manual testing only)

## Automated Smoke Test

```bash
export NPM_TOKEN=ghp_your_pat_here
docker compose run --rm smoke
```

Runs 8 checks:
1. NPM_TOKEN exists
2. GitHub Packages auth works
3. `npx gitmem-mcp init` downloads package and loads starter scars
4. 12 starter scars in `.gitmem/learnings.json`
5. All local storage files created
6. `npx gitmem-mcp configure` outputs valid config
7. `.mcp.json` written from config output
8. MCP server starts, 2-session lifecycle test passes

## Manual Testing

```bash
export NPM_TOKEN=ghp_your_pat_here
export ANTHROPIC_API_KEY=sk-ant-your_key_here
docker compose run --rm manual
```

Inside the container:
```bash
# 1. Init gitmem
npx gitmem-mcp init

# 2. Generate and write config
npx gitmem-mcp configure
# Copy the JSON output to .mcp.json

# 3. Install Claude Code
npm install -g @anthropic-ai/claude-code

# 4. Start Claude Code
claude

# 5. Drive 4-10 sessions, measuring:
#    - Time to first useful recall
#    - Tool discovery experience
#    - Session persistence across restarts
#    - Value demonstration (do scars prevent mistakes?)
```

## What to Measure

| Metric | Target |
|--------|--------|
| Time to first working session | < 5 minutes |
| Scars recalled on first `recall` | > 0 |
| Context carryover across sessions | Verified |
| First `npx` download time | Document (large due to @huggingface/transformers) |

## Troubleshooting

- **First `npx` run is slow** — `@huggingface/transformers` is ~100MB. Subsequent runs use npm cache.
- **Auth fails** — Verify PAT has `read:packages` scope and `@nteg-dev` org access.
- **To test a new version** — Run `npm cache clean --force` inside the container first.

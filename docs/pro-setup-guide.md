# GitMem Pro Setup Guide

## Prerequisites

- A [Supabase](https://supabase.com) project (free tier works)
- An [OpenRouter](https://openrouter.ai) account (for embeddings/semantic search)
- A GitMem Pro license key (`gitmem_pro_...`)
- Supabase CLI installed (`npm install -g supabase`)

## Setup

### 1. Log in to Supabase CLI

```bash
npx supabase login
```

This stores an access token locally that gitmem uses to set up your database schema automatically.

### 2. Set environment variables

Set these in your shell profile (`.bashrc`, `.zshrc`) or `.env` file:

```bash
export SUPABASE_URL="https://yourproject.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="eyJ..."
export OPENROUTER_API_KEY="sk-or-v1-..."
```

**Where to find these:**
- **SUPABASE_URL**: Supabase Dashboard → Settings → API → Project URL
- **SUPABASE_SERVICE_ROLE_KEY**: Supabase Dashboard → Settings → API → `service_role` key (under "Project API keys")
- **OPENROUTER_API_KEY**: [openrouter.ai/keys](https://openrouter.ai/keys) → Create Key

### 3. Activate

```bash
npx gitmem-mcp activate <your-license-key>
```

This does everything:
- Validates your license key
- Connects to your Supabase project
- Creates all required tables, views, indexes, and RPC functions automatically
- Saves credentials to `.gitmem/config.json`

You should see:

```
✓ Key validated (pro tier)
  ✓ Connected to Supabase
  ✓ Schema applied automatically
  ✓ OpenRouter configured (from env)

Pro tier activated! Restart your editor to apply.
```

### 4. Restart your editor

Restart Claude Code or Cursor so the MCP server picks up the pro configuration.

## Credential options

You don't have to paste secrets into a terminal. The activate command resolves credentials in this order:

1. **Environment variables** — set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY` before running activate
2. **Config file** — edit `.gitmem/config.json` directly with `supabase_url`, `supabase_key`, `openrouter_key` fields
3. **Interactive prompt** — if running in a terminal, activate will prompt for any missing values

## What gets created

The activate command creates these in your Supabase project:

| Tables | Purpose |
|--------|---------|
| `gitmem_learnings` | Scars, wins, patterns with embeddings |
| `gitmem_sessions` | Session history and reflections |
| `gitmem_decisions` | Decision log with rationale |
| `gitmem_scar_usage` | Tracks when scars are surfaced and applied |
| `gitmem_threads` | Cross-session work items |
| `gitmem_query_metrics` | Performance tracking |
| `knowledge_triples` | Knowledge graph relationships |
| `scar_enforcement_variants` | A/B testing for scar delivery |

| Views | Purpose |
|-------|---------|
| `gitmem_learnings_lite` | Learnings without embedding column (fast reads) |
| `gitmem_sessions_lite` | Sessions without embedding column |
| `gitmem_decisions_lite` | Decisions without embedding column |
| `gitmem_threads_lite` | Threads without embedding column |

| RPC Functions | Purpose |
|---------------|---------|
| `gitmem_semantic_search` | Vector similarity search across learnings |
| `gitmem_scar_search` | Weighted search with temporal + behavioral decay |
| `refresh_scar_behavioral_scores` | Updates decay weights from usage patterns |

All tables have Row Level Security enabled with service role access only.

## Pro tools

With pro activated, these tools persist to Supabase with semantic search:

| Tool | What it does |
|------|-------------|
| `session_start` | Loads context from last session, open threads, recent decisions |
| `session_close` | Persists session reflection and learnings |
| `recall` | Semantic search for relevant scars before taking action |
| `create_learning` | Store a scar, win, or pattern with embedding |
| `create_decision` | Log a decision with rationale |
| `search` | Search institutional memory by keyword or semantics |
| `log` | Browse recent learnings chronologically |
| `create_thread` | Track unresolved work across sessions |
| `list_threads` | View open threads |
| `confirm_scars` | Acknowledge recalled scars before proceeding |

## Deactivation

```bash
npx gitmem-mcp deactivate
```

This removes the device from the license server (freeing a device slot), clears credentials from config, and deletes the license cache. Your Supabase data is preserved — you can re-activate on the same or different device.

## Troubleshooting

### Schema not applied automatically

If you see "Missing tables" after activation, the auto-schema needs a Supabase access token:

```bash
npx supabase login        # stores token locally
npx gitmem-mcp activate   # re-run, schema will auto-apply
```

Or apply manually:

```bash
npx gitmem-mcp setup | pbcopy    # macOS — copies SQL to clipboard
npx gitmem-mcp setup             # prints SQL
```

Then paste into Supabase Dashboard → SQL Editor → Run.

### Device limit reached

Each license allows 3 concurrent devices. Deactivate unused devices:

```bash
npx gitmem-mcp deactivate   # on the device you want to free
```

### Connection test fails

Verify your `SUPABASE_URL` ends with `.supabase.co` and your service role key is the full JWT (starts with `eyJ`).

### Recall returns no results

Recall uses semantic search via embeddings. Make sure:
- `OPENROUTER_API_KEY` is set (or `OPENAI_API_KEY`)
- You've created at least one learning with `create_learning`
- The learning has a description long enough to generate a meaningful embedding

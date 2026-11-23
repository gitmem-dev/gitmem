# GitMem Pro Setup Guide

## Prerequisites

- A [Supabase](https://supabase.com) project (free tier works)
- An [OpenRouter](https://openrouter.ai) account (for embeddings/semantic search)
- A GitMem Pro license key (`gitmem_pro_...`)
- Supabase CLI installed (`npm install -g supabase`)

## Setup

### 1. Set environment variables

Set these in your shell profile (`.bashrc`, `.zshrc`) or `.env` file:

```bash
export SUPABASE_URL="https://yourproject.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="eyJ..."
export OPENROUTER_API_KEY="sk-or-v1-..."
export DATABASE_URL="postgresql://postgres.yourref:yourpassword@aws-0-region.pooler.supabase.com:5432/postgres"
```

**Where to find these:**
- **SUPABASE_URL**: Supabase Dashboard → Settings → API → Project URL
- **SUPABASE_SERVICE_ROLE_KEY**: Supabase Dashboard → Settings → API → `service_role` key (under "Project API keys")
- **OPENROUTER_API_KEY**: [openrouter.ai/keys](https://openrouter.ai/keys) → Create Key
- **DATABASE_URL**: Supabase Dashboard → Connect → Connection string (Session pooler or Direct)

### 2. (Optional) Point at an existing schema with a custom table prefix

By default GitMem uses tables prefixed with `gitmem_` (`gitmem_learnings`, `gitmem_decisions`, …). If you are pointing GitMem at a Supabase project whose tables use a **different** prefix — for example an existing `orchestra_` schema you are not migrating yet — set:

```bash
export GITMEM_TABLE_PREFIX="orchestra_"
```

Important:

- **Env-only.** The prefix is resolved at runtime by `getTableName()` (`src/services/tier.ts`). It is **not** read from `.gitmem/config.json` and **cannot** be set by `activate`. It must be present in **every** client's environment — your shell profile for the CLI **and** the `env` block of the MCP server entry in `claude_desktop_config.json` for the desktop app.
- **You own the tables.** `activate`'s auto-schema always creates `gitmem_*` tables; with a custom prefix it will not create your prefixed tables, so they must already exist on the target project.
- **Mismatch symptom.** `create_learning` / `create_decision` fail with PostgREST `PGRST205` ("table not in schema cache"), while threads appear to work — thread writes silently fall back to the local `.gitmem` cache, and `gitmem-cache-health` reads Supabase regardless of storage tier, so both can look healthy while writes go nowhere. See the write-path health check.

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

### Where they are kept

`activate` saves what it resolved to `config.json` in your gitmem directory: `~/.gitmem/config.json`, or the one under
`GITMEM_DIR` or `GITMEM_HOME` if you set either. That file holds your license key, the service role key, the
OpenRouter key and, if `activate` applied the schema over `DATABASE_URL`, that connection string.

- **macOS and Linux:** the file is readable only by your user account (mode `0600`). A file from an older version is
  tightened when the gitmem server starts, and the next time `activate` or `deactivate` writes it. `license-cache.json`
  is tightened the same way, and `migrate-root` writes the `config.json` it copies at `0600`. To do it now:
  `chmod 600 ~/.gitmem/config.json`.
- **Windows:** file modes don't apply. By default the file is inside your user profile, which other standard accounts
  can't open (SYSTEM and administrators still can). If your gitmem directory is outside your profile, restrict the
  file. From a Command Prompt: `icacls "<path>\config.json" /inheritance:r /grant:r "%USERNAME%:F"`. From PowerShell:
  `icacls "<path>\config.json" /inheritance:r /grant:r "${env:USERNAME}:F"`. This leaves your account as the only one
  on the file, so it also removes SYSTEM and Administrators; backup or management tools that run as them can no longer
  read it.
- If another account or a container user has to read the file, give that process the values as environment variables
  instead. gitmem reads environment variables first.
- To keep the credentials out of the file altogether, for example because a secret manager injects them, run
  `npx gitmem-mcp activate --no-save-keys`. `activate` then saves none of the five values; gitmem reads
  `GITMEM_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `OPENROUTER_API_KEY` from the environment each time
  it starts, so they have to be set for every process that runs gitmem (`DATABASE_URL` is only used by `activate`
  itself). The client has to start the server with those variables in its launch environment, for example through a
  wrapper that injects them (a secret manager's run command). Writing them into an `env` block of an MCP client
  configuration file (`.mcp.json`, `claude_desktop_config.json`) puts the keys back into a plaintext file.
- `--no-save-keys` only stops new writes. Values that an earlier `activate` already saved stay in `config.json` until
  you remove them by hand. `activate --no-save-keys` lists the ones still there and points to `deactivate`, which
  removes them too, but it also deactivates this machine's license.

## Routing OpenRouter calls through a proxy or gateway

Set `OPENROUTER_BASE_URL` to send every OpenRouter request (embeddings, transcript embeddings, variant generation and
`gitmem check`) to another address, such as a proxy, an API gateway or an OpenRouter-compatible endpoint:

    export OPENROUTER_BASE_URL="https://llm-gateway.example.com/openrouter/api/v1"

- It is the URL that `/embeddings`, `/chat/completions` and `/models` are added to. The default is
  `https://openrouter.ai/api/v1`, OpenRouter's own base URL.
- It is read from the environment only, like `GITMEM_TABLE_PREFIX`. It is not read from `config.json` and `activate`
  does not save it, so it stops applying as soon as the variable is unset. Set it wherever you set
  `OPENROUTER_API_KEY`.
- The endpoint receives your OpenRouter key as a bearer token. Set the variable only in environments you trust, and
  use `https` unless the endpoint runs on your machine or on a network you control. A plain `http` base on a host that
  is not `localhost`, `127.0.0.0/8` or `::1` works, with one warning in the server log.
- Other tools use the same variable name. If you already set `OPENROUTER_BASE_URL` for one of them, gitmem uses it
  too; the `[embedding] Provider:` line in the server log shows the base whenever it isn't the default.
- A value that isn't an `http` or `https` URL, or that contains a username, password, query string or fragment, is
  refused with a warning, and gitmem makes no OpenRouter calls until it is fixed. It never falls back to openrouter.ai.
- gitmem reads it once when it starts; restart your editor after changing it.
- The model name is unchanged (`openai/text-embedding-3-small`), so the endpoint has to accept it.

## Routing Supabase calls and the license check through a gateway

With a gateway (or proxy) that holds the real keys, the processes that run gitmem only need stand-in values. Point
gitmem at the gateway with three environment variables, give it the stand-ins in `GITMEM_API_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` and `OPENROUTER_API_KEY`, and keep keys out of `config.json` with
`npx gitmem-mcp activate --no-save-keys`.

| Calls | Base URL | Where gitmem puts the key |
|-------|----------|---------------------------|
| Supabase (memory, search, transcripts) | `SUPABASE_URL` | `apikey` and `Authorization: Bearer` headers (storage calls: `Authorization` only) |
| OpenRouter (embeddings, variants, `check`) | `OPENROUTER_BASE_URL` (see above) | `Authorization: Bearer` header |
| License check | `GITMEM_LICENSE_URL` | JSON body, field `p_api_key` |

### Supabase

- `SUPABASE_URL` is already a base URL. gitmem calls `<SUPABASE_URL>/rest/v1/...` (tables, and functions under
  `/rest/v1/rpc/`) and `<SUPABASE_URL>/storage/v1/object/...` (transcripts), so the gateway has to pass both paths
  through to your project.
- gitmem only checks that a key is set, so a stand-in works. The gateway replaces it in the headers before it
  forwards a call.
- Set `GITMEM_SEARCH_MODE`. Without it, gitmem chooses the search mode from the shape of `SUPABASE_URL`: a
  `*.supabase.co` address gets `local` (searches a cache loaded from Supabase), a `localhost` or private-network address
  gets `remote` (queries Supabase on each search), and any other host gets `local` with a warning in the server log.
- With a gateway address, `activate` can apply the schema only over `DATABASE_URL`, because the Management API path needs
  the project ref from a `*.supabase.co` URL. Or apply it by hand (see Troubleshooting).

### The license check

    export GITMEM_LICENSE_URL="https://gateway.example.com/gitmem-license"

- It is a base URL: the check posts to `<GITMEM_LICENSE_URL>/rest/v1/rpc/gitmem_validate_license` with the same headers
  and body as the built-in check. The license key is in the body field `p_api_key`, next to the install id in
  `p_install_id`. The gateway replaces the stand-in in `p_api_key` with the real key and forwards the request to
  gitmem's license server, `https://cjptxyezuxdiinufgrrm.supabase.co/rest/v1/rpc/gitmem_validate_license`. The `apikey`
  and `Authorization` headers carry gitmem's public anon key, not yours: pass them through unchanged.
- Unset or blank, the check goes to gitmem's license server, as before.
- It is read from the environment only, like `OPENROUTER_BASE_URL`: not read from `config.json`, and `activate` does not
  save it. Set it for every process that runs gitmem; `activate` uses it too when it is set. gitmem reads it when it
  starts; restart your editor after changing it.
- A value that isn't an `http` or `https` URL, or that contains a username, password, query string or fragment, is
  refused with one warning, and no license check is made. The license then counts as invalid: the server log shows
  `Validation failed: GITMEM_LICENSE_URL is not usable; no license check was made` and `Tier updated: free`, and
  `activate` stops with that error and saves nothing. It never falls back to gitmem's license server, so a stand-in is
  never sent there.
- A plain `http` base on a host that is not `localhost`, `127.0.0.0/8` or `::1` works, with one warning that the license
  key is sent unencrypted.
- A cached answer counts only for the URL that gave it: after you set, change or unset the variable, gitmem checks the
  license again instead of reusing another server's answer.
- `deactivate` does not use the variable. It always asks gitmem's license server to free the device, so run it where the
  real key is set.

### One machine is one activation

Each distinct install id takes one of the license's device slots. Every gitmem process on a licensed machine should
send that machine's own install id, so that however many processes (agents, editors, scripts) run there, the machine
counts once.

- The server sends the `install_id` from the `config.json` in its gitmem directory (`unknown` when there is none).
  Processes that share the machine's gitmem directory already send the same id.
- A process with a gitmem directory of its own: put the machine's `install_id` in that directory's `config.json` (it is
  not a secret), or have the gateway set `p_install_id` to the machine's id when it forwards the check.
- Don't run `activate` in each process's own directory: where there is no `install_id`, it creates a new one, which
  registers another device.

## What gets created

The activate command creates these in your Supabase project (table and view names are prefixed by `GITMEM_TABLE_PREFIX`, default `gitmem_`):

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

All tools work in both free and pro tiers. In free tier, data is stored locally in `.gitmem/`. In pro tier, data persists to Supabase with semantic vector search via embeddings.

### Session lifecycle

| Tool | What it does |
|------|-------------|
| `session_start` | Loads last session context, open threads, recent decisions |
| `session_refresh` | Re-surface institutional context mid-session (after compaction) |
| `session_close` | Persists session reflection, learnings, and compliance |

### Memory creation

| Tool | What it does |
|------|-------------|
| `create_learning` | Store a scar, win, or pattern (with embedding in pro) |
| `create_decision` | Log a decision with rationale and alternatives |
| `record_scar_usage` | Track when a scar was surfaced and how it was applied |

### Retrieval

| Tool | What it does |
|------|-------------|
| `recall` | Semantic search for relevant scars before taking action |
| `confirm_scars` | Acknowledge recalled scars as APPLYING, N_A, or REFUTED |
| `reflect_scars` | End-of-session scar reflection (how each was handled) |
| `search` | Search institutional memory by keyword or semantics |
| `log` | Browse recent learnings chronologically |

### Threads

| Tool | What it does |
|------|-------------|
| `create_thread` | Track unresolved work across sessions |
| `list_threads` | View open threads |
| `resolve_thread` | Mark a thread as resolved |
| `promote_suggestion` | Promote a suggested thread to an open thread |
| `dismiss_suggestion` | Dismiss a suggested thread |
| `cleanup_threads` | Triage threads by lifecycle health (active/cooling/dormant) |

### Multi-agent coordination

| Tool | What it does |
|------|-------------|
| `prepare_context` | Generate compact memory payload for sub-agent injection |
| `absorb_observations` | Capture and persist findings from sub-agents |

### Knowledge graph

| Tool | What it does |
|------|-------------|
| `graph_traverse` | Traverse knowledge graph connections (connected_to, produced_by, provenance, stats) |
| `archive_learning` | Archive a scar/win/pattern (excluded from recall, preserved for audit) |

### Analytics and diagnostics

| Tool | What it does |
|------|-------------|
| `analyze` | Session analytics and insights (summary, reflections, blindspots) |
| `health` | Show write health for the current session |
| `contribute_feedback` | Submit feedback about gitmem |

### Document indexing

| Tool | What it does |
|------|-------------|
| `index_docs` | Index a directory of markdown files for semantic search |
| `search_docs` | Search indexed documentation |

### Transcripts (pro only)

| Tool | What it does |
|------|-------------|
| `save_transcript` | Save a session transcript |
| `get_transcript` | Retrieve a saved transcript |
| `search_transcripts` | Search across saved transcripts |

### Cache management

| Tool | What it does |
|------|-------------|
| `gitmem-cache-status` | Show local search cache status |
| `gitmem-cache-health` | Compare local cache against remote Supabase |
| `gitmem-cache-flush` | Force reload cache from Supabase |

Most tools also have short aliases (`gm-scar`, `gm-search`, `gm-threads`, etc.) for faster invocation.

## Deactivation

```bash
npx gitmem-mcp deactivate
```

This removes the device from the license server (freeing a device slot), clears credentials from config, and deletes the license cache. Your Supabase data is preserved — you can re-activate on the same or different device. It always uses gitmem's own license server, even with `GITMEM_LICENSE_URL` set.

## Troubleshooting

### Schema not applied automatically

Auto-schema uses either `DATABASE_URL` (direct Postgres connection) or `SUPABASE_ACCESS_TOKEN` (Management API). If neither is available, apply manually:

```bash
# Option 1: Set DATABASE_URL and re-run
export DATABASE_URL="postgresql://postgres.ref:password@pooler.supabase.com:5432/postgres"
npx gitmem-mcp activate

# Option 2: Set SUPABASE_ACCESS_TOKEN and re-run
npx supabase login
npx gitmem-mcp activate

# Option 3: Apply manually
npx gitmem-mcp setup | pbcopy    # macOS — copies SQL to clipboard
npx gitmem-mcp setup             # prints SQL
# Then paste into Supabase Dashboard → SQL Editor → Run
```

### Writes succeed but nothing appears in Supabase

`create_learning` / `create_decision` return a UUID but the row never shows up in your `*_learnings` table, and there is **no** `PGRST205` error. This means GitMem fell back to **free tier** and wrote to a local `.gitmem/` file instead of Supabase. With `SUPABASE_URL` set, the only path to free tier is an invalid or missing license, so check:

- `GITMEM_API_KEY` is a real `gitmem_pro_...` key (not a placeholder, unless `GITMEM_LICENSE_URL` sends the check through a gateway that puts the real key in), present in the **same** environment as the MCP server (e.g. the `env` block in `claude_desktop_config.json`, not just your shell).
- If `GITMEM_LICENSE_URL` is set, the startup log has no `GITMEM_LICENSE_URL is not usable` warning.
- The license validated — the startup log shows `Tier: pro`, not `Tier: free` / `Tier updated: free`.
- The device limit (3) is not exhausted — see below.

Reads can be misleading here: `gitmem-cache-health` and `recall` may still reach Supabase while the **write** path is local. Confirm pro end-to-end by creating a learning and verifying the row exists in `<prefix>learnings` with a non-null `embedding`.

### Device limit reached

Each license allows 3 concurrent devices. Deactivate unused devices:

```bash
npx gitmem-mcp deactivate   # on the device you want to free
```

### Connection test fails

Verify your `SUPABASE_URL` ends with `.supabase.co` (or is your gateway's address) and your service role key is the full JWT (starts with `eyJ`; with a gateway, the stand-in the gateway replaces).

### Recall returns no results

Recall uses semantic search via embeddings. Make sure:
- `OPENROUTER_API_KEY` is set (or `OPENAI_API_KEY`)
- You've created at least one learning with `create_learning`
- The learning has a description long enough to generate a meaningful embedding

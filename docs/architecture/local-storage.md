# GitMem Local Storage Architecture

> How GitMem uses the local filesystem, what persists across sessions, and what breaks in ephemeral containers.

## The Problem

GitMem's value proposition is **cross-session institutional memory**. But users running in locked-down containers (CI, ephemeral dev environments, Docker-per-session) lose all local state between invocations. This document maps exactly what lives where so operators can make informed decisions about persistence.

## Storage Locations

GitMem writes to two locations:

| Location | What | Owner |
|----------|------|-------|
| `<project>/.gitmem/` | Session state, threads, config, caches | GitMem MCP server |
| `~/.cache/gitmem/` | Search result cache (15-min TTL) | GitMem MCP server |

A third location exists but is **not created by GitMem**:

| Location | What | Owner |
|----------|------|-------|
| `~/.claude/projects/<hash>/*.jsonl` | Conversation transcripts | Claude Code CLI |

GitMem reads from the Claude Code transcripts during `session_close` (transcript capture), but never writes to or manages them.

## File-by-File Inventory

### `.gitmem/` — Core State

```
.gitmem/
├── active-sessions.json          # 478B   Process lifecycle
├── config.json                   # 63B    Project defaults
├── sessions.json                 # 644B   Recent session index (free tier SOT)
├── threads.json                  # ~5KB   Thread state cache / free tier SOT
├── suggested-threads.json        # ~2B    AI-suggested threads
├── closing-payload.json          # (ephemeral — deleted after use)
├── cache/
│   └── hook-scars.json           # ~517KB Local scar copy for hooks plugin
├── hooks-state/
│   ├── start_time                # 11B    Session start timestamp
│   ├── tool_call_count           # 2B     Recall nag counter
│   ├── last_nag_time             # 2B     Last recall reminder time
│   ├── stop_hook_active          # 0B     Lock file (re-entrancy guard)
│   └── audit.jsonl               # ~4KB   Hook execution log
└── sessions/
    └── <session-uuid>/
        └── session.json          # ~6KB   Per-session state (scars, confirmations)
```

**Total typical footprint: ~530KB** (dominated by `cache/hook-scars.json`).

### File Lifecycle

| File | Created | Updated | Deleted | Survives Session Close? |
|------|---------|---------|---------|------------------------|
| `active-sessions.json` | `session_start` | Every session start/close | Never (entries pruned) | Yes — multi-session registry |
| `config.json` | First `session_start` | Rarely | Never | Yes |
| `sessions.json` | `session_close` (free tier) | Each close | Never | Yes |
| `threads.json` | `session_close` | Each close | Never | Yes |
| `suggested-threads.json` | `session_close` | Each close | Never | Yes |
| `closing-payload.json` | Agent writes before close | Never | `session_close` deletes it | **No** — ephemeral |
| `cache/hook-scars.json` | Hooks plugin startup | Periodically refreshed | Never | Yes |
| `hooks-state/*` | Session start | During session | `start_time` reset each session | Partially |
| `sessions/<id>/session.json` | `session_start` | `recall`, `confirm_scars` | `session_close` cleans up | **No** — cleaned up on close |

## Cross-Session Data Flow

### What the next session needs

When `session_start` runs, it loads context from these sources:

| Data | Pro/Dev Tier Source | Free Tier Source |
|------|--------------------|--------------------|
| Last session (decisions, reflection) | Supabase `sessions` | `.gitmem/sessions.json` |
| Open threads | Supabase `threads` | `.gitmem/threads.json` |
| Recent decisions | Supabase `decisions` | `.gitmem/sessions.json` (embedded) |
| Scars for recall | Supabase `learnings` | `.gitmem/learnings.json` |
| Suggested threads | `.gitmem/suggested-threads.json` | `.gitmem/suggested-threads.json` |

### What `recall` needs

| Tier | Source | Search Method |
|------|--------|---------------|
| Pro/Dev | Supabase `learnings` | Semantic (embedding cosine similarity) |
| Pro/Dev (cached) | `~/.cache/gitmem/results/` | Local vector search (15-min TTL) |
| Free | `.gitmem/learnings.json` | Keyword tokenization match |

### What `session_close` persists

| Data | Pro/Dev Destination | Free Destination |
|------|--------------------|--------------------|
| Session record | Supabase `sessions` | `.gitmem/sessions.json` |
| New learnings | Supabase `learnings` | `.gitmem/learnings.json` |
| Decisions | Supabase `decisions` | `.gitmem/decisions.json` |
| Thread state | Supabase `threads` + `.gitmem/threads.json` | `.gitmem/threads.json` |
| Scar usage | Supabase `scar_usage` | `.gitmem/scar_usage.json` |
| Transcript | Supabase storage bucket | Not captured |

## The Container Problem

### Scenario: Ephemeral container per session

```
Container A (session 1) → writes .gitmem/ → container destroyed
Container B (session 2) → fresh .gitmem/ → no history
```

**Impact by tier:**

| Tier | Cross-Session Memory | What Breaks |
|------|---------------------|-------------|
| **Pro/Dev** | **Works** — Supabase is SOT | Hooks plugin cold-starts each time (re-downloads scar cache). Suggested threads lost. Minor UX friction, no data loss. |
| **Free** | **Completely broken** — all memory is local files | No scars, no threads, no session history, no decisions. Each session is amnesic. |

### Scenario: Persistent volume mount

```
docker run -v gitmem-data:/app/.gitmem ...
```

| Tier | Cross-Session Memory | Notes |
|------|---------------------|-------|
| **Pro/Dev** | **Works perfectly** | Local files are caches; Supabase is SOT |
| **Free** | **Works** | Local files ARE the SOT; volume mount preserves them |

### Scenario: Shared container (long-running, like our Docker setup)

```
Container stays alive across multiple `claude` invocations
```

Both tiers work. This is our current setup. `.gitmem/` persists because the container persists.

## Recommendations for Container Deployments

### Minimum viable persistence (free tier)

Mount a volume for `.gitmem/`:
```yaml
volumes:
  - gitmem-state:/workspace/.gitmem
```

Files that MUST persist for free tier cross-session:
- `learnings.json` (scars — the whole point)
- `threads.json` (open work tracking)
- `sessions.json` (session history for context)
- `decisions.json` (decision log)

### Minimum viable persistence (pro/dev tier)

**Nothing required.** Supabase is the source of truth. Local files are caches/working state. A fresh `.gitmem/` each session works — just slightly slower (cache cold start).

Optional for better UX:
```yaml
volumes:
  - gitmem-cache:/workspace/.gitmem/cache  # Avoids scar cache re-download
```

### What about Claude Code transcripts?

The `~/.claude/projects/` directory accumulates conversation transcripts (~2MB each, 167 files = 356MB in our container). These are:
- Created by Claude Code, not GitMem
- Read by GitMem during transcript capture (pro/dev `session_close`)
- Never cleaned up automatically
- Not required for GitMem to function

For ephemeral containers: don't bother persisting these. GitMem's transcript capture uploads them to Supabase before the container dies (if pro/dev tier). For free tier, transcripts aren't captured at all.

## Architecture Decision: Why Local Files Exist at All

Given that pro/dev tier uses Supabase, why does GitMem write local files?

1. **`active-sessions.json`** — Process lifecycle tracking (PIDs, hostnames). This is inherently local — Supabase can't know if a process is still alive.

2. **`sessions/<id>/session.json`** — Survives context compaction. When Claude Code compresses the conversation, the MCP server's in-memory state is fine, but the LLM loses context. The agent reads this file to recover session_id and surfaced scars. This is a Claude Code architectural constraint, not a GitMem choice.

3. **`threads.json`** — Cache/fallback. If Supabase is down or slow, session_start can still show threads.

4. **`cache/hook-scars.json`** — The hooks plugin runs as shell scripts (not MCP), so it can't call Supabase directly. It needs a local scar copy for fast pattern matching.

5. **`closing-payload.json`** — MCP tool calls have size limits. Writing the payload to a file and passing only the session_id keeps the MCP call clean.

6. **Free tier files** — The entire free tier runs without Supabase. Local JSON files ARE the database.

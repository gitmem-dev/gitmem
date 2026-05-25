# GitMem Pro Stress Test Plan v1.0

## Overview

Comprehensive end-to-end test of all GitMem Pro features on a fresh Supabase project. Simulates 5 days of real interactive usage with session cycling, data accumulation, and cross-session persistence verification.

**Test file:** `pro-stress-test.mjs`
**Last run:** 2026-05-25 — 147/147 PASS (all canonical tools covered)

## Prerequisites

- Docker (for clean room isolation)
- Fresh Supabase project (blank — schema auto-applied)
- Environment variables:
  - `SUPABASE_URL` — test project URL
  - `SUPABASE_SERVICE_ROLE_KEY` — test project service role key
  - `SUPABASE_ACCESS_TOKEN` — for auto-schema (from `npx supabase login`)
  - `OPENROUTER_API_KEY` — for embeddings

## How to run

```bash
# From /workspace/gitmem
cd /workspace/gitmem

# Build local tarball
npm run build
npm pack --pack-destination testing/clean-room/
mv testing/clean-room/gitmem-mcp-*.tgz testing/clean-room/gitmem-mcp-local.tgz

# Build Docker image
docker build --no-cache -t gitmem-claude-local -f testing/clean-room/Dockerfile.claude-local testing/clean-room/

# Run (create env file with credentials first)
docker run --rm --env-file /path/to/test.env --user root -i gitmem-claude-local bash -c '
cat > /tmp/stress-test.mjs
chown -R developer:developer /home/developer/my-project
su developer -c "cd /home/developer/my-project && gitmem-mcp init --yes --project stress-test" 2>&1 > /dev/null
su developer -c "cd /home/developer/my-project && echo \"\" | gitmem-mcp activate gitmem_pro_52061b097ac6d8b76c38ef191b74a319" 2>&1
mkdir -p /tmp/test-harness && cd /tmp/test-harness
npm init -y > /dev/null 2>&1 && npm install @modelcontextprotocol/sdk > /dev/null 2>&1
cp /tmp/stress-test.mjs /tmp/test-harness/stress-test.mjs
su developer -c "cd /home/developer/my-project && node /tmp/test-harness/stress-test.mjs"
' < testing/clean-room/pro-stress-test.mjs
```

## Test coverage — 141 tests across 5 simulated days

### Day 1: Initial setup (78 tests)
- `session_start` — first session on blank project
- 50 `create_learning` (scars) — 10 domains, 4 severity levels, real descriptions
- 10 `create_learning` (patterns) — architecture design patterns
- 5 `create_decision` — architectural decisions with rationale
- 10 `create_thread` — unresolved work items
- `list_threads` — verify all 10 visible
- `session_close` — with closing reflection

### Day 2: Recall, confirm, resolve (19 tests)
- `session_start` — loads day 1 context, verifies threads carry over
- 5x `recall` — diverse queries (deploy, auth, cache, frontend, security)
- `confirm_scars` — acknowledge recalled scars with APPLYING/N_A decisions
- 3x `resolve_thread` — close completed work items
- `list_threads` — verify 7 open, 3 resolved
- `reflect_scars` — end-of-session scar reflection
- `record_scar_usage` — track scar application
- `record_scar_usage_batch` — batch scar tracking
- `session_refresh` — re-surface context mid-session
- `session_close`

### Day 3: Docs, search, graph, analytics, transcripts (26 tests)
- `session_start` — loads 2 days of history
- Write 3 markdown docs (architecture, deployment, API reference — 1000+ words total)
- `index_docs` — embed and index the docs
- 4x `search_docs` — semantic doc search
- 4x `search` — keyword/semantic search across learnings
- 3x `log` — chronological browsing with type filters
- 2x `graph_traverse` — stats and connected_to lenses
- `analyze` — session analytics summary
- 3x `prepare_context` — compact, gate, and full sub-agent briefings
- `absorb_observations` — capture sub-agent findings (4 observations)
- `save_transcript` — save session conversation
- `get_transcript` — retrieve saved transcript
- `search_transcripts` — semantic search over transcript chunks
- `session_close`

### Day 4: Cache, health, archive, suggestions, threads (17 tests)
- `session_start`
- 4x cache management — status, health, flush, status-after
- `health` — write operation success rates
- `archive_learning` — soft-delete a scar
- `promote_suggestion` — promote a suggested thread
- `dismiss_suggestion` — dismiss a suggested thread
- `create_thread` + dedup test (similar text → returns existing)
- `list_threads`, `cleanup_threads`
- 3x `resolve_thread` — close more work items
- `list_threads` — verify final state
- `contribute_feedback` — submit tool improvement suggestion
- `session_close`

### Day 5: Persistence verification (12 tests)
- `session_start` — loads all 4 previous sessions
- `list_threads` — verify threads survived 5 sessions
- `log` — verify all 60 learnings persisted
- 3x `recall` — verify embeddings still work
- `search_docs` — verify doc index survived
- `analyze` — final analytics across all sessions
- `gitmem-help` — help output
- `session_close`

## Tools tested

| Tool | Tests | Days |
|------|-------|------|
| session_start | 5 | 1-5 |
| session_close | 5 | 1-5 |
| session_refresh | 1 | 2 |
| create_learning | 60 | 1 |
| create_decision | 5 | 1 |
| recall | 9 | 2, 5 |
| confirm_scars | 1 | 2 |
| reflect_scars | 1 | 2 |
| record_scar_usage | 1 | 2 |
| record_scar_usage_batch | 1 | 2 |
| search | 4 | 3 |
| log | 4 | 3, 5 |
| create_thread | 12 | 1, 4 |
| list_threads | 5 | 1-5 |
| resolve_thread | 6 | 2, 4 |
| cleanup_threads | 1 | 4 |
| promote_suggestion | 1 | 4 |
| dismiss_suggestion | 1 | 4 |
| index_docs | 1 | 3 |
| search_docs | 5 | 3, 5 |
| graph_traverse | 2 | 3 |
| analyze | 2 | 3, 5 |
| prepare_context | 3 | 3 |
| absorb_observations | 1 | 3 |
| save_transcript | 1 | 3 |
| get_transcript | 1 | 3 |
| search_transcripts | 1 | 3 |
| archive_learning | 1 | 4 |
| health | 1 | 4 |
| cache-status | 2 | 4 |
| cache-health | 1 | 4 |
| cache-flush | 1 | 4 |
| contribute_feedback | 1 | 4 |
| gitmem-help | 1 | 5 |
| **TOTAL** | **147** | |

## What this test validates

1. **Schema auto-application** — blank Supabase → activate → tables created automatically
2. **Data persistence** — learnings, sessions, threads survive across 5 session restarts
3. **Embedding pipeline** — 60 learnings embedded via OpenRouter, searchable via recall
4. **Semantic search** — recall finds relevant scars for diverse query topics
5. **Thread lifecycle** — create → list → resolve → verify resolved count
6. **Thread deduplication** — similar threads detected and deduplicated
7. **Document indexing** — markdown files indexed and searchable
8. **Session continuity** — each new session loads previous context
9. **Multi-agent tools** — prepare_context generates briefings, absorb_observations captures findings
10. **Cache management** — status → flush → verify reload
11. **Analytics** — cross-session analysis works
12. **Knowledge graph** — traverse returns stats and connections
13. **Scar lifecycle** — create → recall → confirm → reflect → record usage → archive

## Version history

| Version | Date | Tests | Result |
|---------|------|-------|--------|
| v1.0 | 2026-05-25 | 141 | 141 PASS |
| v1.1 | 2026-05-25 | 147 | 147 PASS — added record_scar_usage_batch, transcripts, promote/dismiss_suggestion |

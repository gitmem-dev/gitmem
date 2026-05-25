# GitMem Pro Stress Test Plan v1.4

## Overview

Comprehensive end-to-end test of the full GitMem user journey: blank-slate Supabase → 3+ month free-tier user → Pro upgrade with schema auto-apply → migration of messy real-world data → mid-failure recovery → 5 days of Pro usage. Tests real OpenRouter embeddings from config.json (NOT env var).

**Test file:** `pro-stress-test.mjs`
**Last run:** pending
**Target Supabase:** `qdontzpcevjmwkzhvvhv.supabase.co` (dedicated e2e test project)

## What changed from v1.3

v1.3 had fundamental flaws that let v1.6.0 ship with two critical bugs:

1. **OPENROUTER_API_KEY was pre-set as env var** — bypassed the config.json path that real users hit after `activate`. Bug 1 (no embeddings on Pro) went undetected.
2. **Migration test used synthetic records** that perfectly matched the schema. Real users have starter scars with `is_starter`, array-typed fields in TEXT columns, unknown fields from version drift. Bug 2 (lossy migration) went undetected.
3. **Schema already existed** before migration ran. Never tested the blank Supabase → activate → auto-schema path.

v1.4 fixes all three by restructuring the test:

- **Day 0**: DROP everything from Supabase, verify truly blank
- **Day 1**: Seed realistic 3+ month user, apply schema, migrate messy data, verify zero loss, test mid-failure recovery, test real embeddings from config.json only
- **Days 2-6**: Original stress test days (now running on freshly-migrated database)

## Prerequisites

- Docker (for clean room isolation)
- **Blank** Supabase project (schema wiped by test)
- Environment variables:
  - `SUPABASE_URL` — test project URL
  - `SUPABASE_SERVICE_ROLE_KEY` — test project service role key
  - `SUPABASE_ACCESS_TOKEN` or `DATABASE_URL` — for schema wipe/apply
  - `OPENROUTER_API_KEY` — for embeddings (test verifies config.json path by temporarily removing from env)

## How to run

```bash
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
su developer -c "cd /home/developer/my-project && echo "" | gitmem-mcp activate gitmem_pro_52061b097ac6d8b76c38ef191b74a319" 2>&1
mkdir -p /tmp/test-harness && cd /tmp/test-harness
npm init -y > /dev/null 2>&1 && npm install @modelcontextprotocol/sdk > /dev/null 2>&1
cp /tmp/stress-test.mjs /tmp/test-harness/stress-test.mjs
su developer -c "cd /home/developer/my-project && node /tmp/test-harness/stress-test.mjs"
' < testing/clean-room/pro-stress-test.mjs
```

## Test coverage — 7 days (Day 0 + Days 1-6)

### Day 0: Blank Slate (5 tests)
- DROP all gitmem tables, views, functions, triggers from Supabase
- Wait for PostgREST schema cache reload
- Verify gitmem_learnings returns 404 (table doesn't exist)
- Verify gitmem_sessions returns 404
- Verify gitmem_decisions returns 404

### Day 1: Free-Tier User (3+ months) → Pro Upgrade (~40 tests)

**Phase 1 — Seed realistic local data:**
- 12 starter scars (with `is_starter: true`, varied `scar_type` values like "verification", "architectural")
- 8 user-created scars across 2 projects (trend-pulse, side-project) spanning 85 days
- Records with `action_protocol` as string[] (TEXT column mismatch)
- Records with `self_check_criteria` as string[] (TEXT column mismatch)
- Records with unknown fields (`tags`, `reviewed`, `confidence_score`)
- Records missing optional fields (no `updated_at`, no `persona_name`)
- 3 patterns, 2 wins, 1 anti_pattern
- 5 sessions, 4 decisions, 6 scar_usage with FK references
- Total: 26 learnings, 5 sessions, 4 decisions, 6 scar_usage

**Phase 2 — Schema auto-apply:**
- Apply setup.sql to blank Supabase via Management API or direct pg
- Verify gitmem_learnings and gitmem_sessions tables exist

**Phase 3 — Migration:**
- `hasLocalData()` detects local files
- `migrateLocalToSupabase()` migrates all records
- **Zero skipped records** — any skip is a test failure
- Verify exact counts: 26 learnings, 5 sessions, 4 decisions, 6 scar_usage
- Verify migration.log written with zero FAIL entries
- Verify project-filtered queries work (trend-pulse learnings)

**Phase 4 — Archive + Mid-failure recovery:**
- Archive local files (.json → .pre-migration)
- Wipe all data from Supabase (keep schema)
- `hasPreMigrationData()` detects backup files
- `reimportFromBackups()` recovers all data
- Verify exact counts restored

**Phase 5 — Real embeddings from config.json:**
- Remove `OPENROUTER_API_KEY` from env
- Start MCP server (must read key from config.json)
- `create_learning` → verify embedding generated (not null)
- Verify embedding stored in Supabase (not.is.null query)
- `recall` returns results (semantic search works)

### Day 2: Initial Setup — Seeding Institutional Memory (78 tests)
- `session_start` — first Pro session on migrated database
- 50 `create_learning` (scars) — 10 domains, 4 severity levels
- 10 `create_learning` (patterns)
- 5 `create_decision`
- 10 `create_thread`
- `list_threads` — verify all 10 visible
- `session_close`

### Day 3: Recall, Confirm, Resolve (19 tests)
- `session_start` — loads day 2 context
- 5x `recall` — diverse queries
- `confirm_scars`, `reflect_scars`
- 3x `resolve_thread`
- `record_scar_usage`, `record_scar_usage_batch`
- `session_refresh`
- `session_close`

### Day 4: Docs, Search, Graph, Sub-Agent Handoff (27 tests)
- Write 3 markdown docs, `index_docs`
- 4x `search_docs`, 4x `search`, 3x `log`
- 2x `graph_traverse`, `analyze`
- Real sub-agent handoff (second MCP server)
- `absorb_observations`
- `save_transcript`, `get_transcript`, `search_transcripts`
- `session_close`

### Day 5: Cache, Health, Archive, Thread Lifecycle (17 tests)
- Cache management cycle (status, health, flush)
- `health`, `archive_learning`
- `promote_suggestion`, `dismiss_suggestion`
- Thread create + dedup + cleanup
- `contribute_feedback`
- `session_close`

### Day 6: Persistence Verification (12 tests)
- `session_start` — loads all previous sessions
- `list_threads`, `log` — verify data survived
- 3x `recall` — verify embeddings work
- `search_docs` — verify doc index survived
- `analyze`, `gitmem-help`
- `session_close`

## What v1.4 specifically validates (that v1.3 missed)

1. **Blank-slate Supabase** — schema applied from zero, not pre-existing
2. **Messy local data** — starter scars, unknown fields, type mismatches, mixed projects
3. **Zero data loss** — exact count verification (not "at least N")
4. **Column whitelist** — unknown fields (tags, reviewed, confidence_score) silently dropped
5. **Type coercion** — action_protocol string[] → TEXT via newline join
6. **Migration log** — .gitmem/migration.log with per-record outcomes
7. **Mid-failure recovery** — data wiped, re-activate recovers from .pre-migration backups
8. **Config.json embedding path** — OPENROUTER_API_KEY removed from env, server reads from config
9. **Real OpenRouter embeddings** — actual API call, actual 1536-dim vector stored

## Version history

| Version | Date | Tests | Result |
|---------|------|-------|--------|
| v1.0 | 2026-05-25 | 141 | 141 PASS |
| v1.1 | 2026-05-25 | 147 | 147 PASS — added batch ops, transcripts, suggestions |
| v1.2 | 2026-05-25 | 150 | 150 PASS — real sub-agent handoff, ANSI output |
| v1.3 | 2026-05-25 | 166 | 166 PASS — free→pro migration (synthetic data) |
| v1.4 | 2026-05-25 | ~200 | PENDING — blank-slate, realistic data, mid-fail recovery, config.json embeddings |

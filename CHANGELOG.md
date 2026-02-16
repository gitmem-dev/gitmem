# Changelog

All notable changes to gitmem will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.3] - 2026-02-15

### Changed
- **Tool alias consolidation (OD-691)**: Reduced advertised tools from 55 to 20 (free tier). Aliases still work when called directly. Set `GITMEM_FULL_ALIASES=1` to restore all.
- **Starter scars reduced (OD-684)**: Ship with 3 high-quality starter scars instead of 12. Starter scars deprioritized with 0.7x score multiplier so earned scars outrank them.
- **Recall similarity threshold (OD-686)**: Weak matches below threshold (0.4 BM25, 0.35 embeddings) are suppressed. Empty results show helpful guidance instead of noise.
- **Adaptive session closing (OD-685)**: Auto-detects ceremony level (micro/standard/full) based on session activity. Removed hard rejection gate that blocked standard closes on short sessions.
- **Scar relevance feedback (OD-690)**: Optional `relevance` field (high/low/noise) on `confirm_scars` for recall quality improvement. Defaults derived from decision type.
- **Pro tier messaging (OD-688)**: Rewritten from agent's perspective with concrete value propositions.

### Added
- **Agent briefing (OD-689)**: Generates `.gitmem/agent-briefing.md` at session close with memory state summary for MEMORY.md bridge.
- **PMEM/GitMem boundary docs (OD-687)**: README section documenting how GitMem complements MEMORY.md/cursorrules.

## [1.0.2] - 2026-02-15

### Fixed
- **Free tier crash**: `markSessionSuperseded` called Supabase without `hasSupabase()` guard
- **Session close UX**: Write health block only shown when failures exist (was always visible)
- **E2E test suite**: Updated for display protocol changes (session_id extraction, display format assertions, recall display text, CLAUDE.md template wording)

## [1.0.0] - 2026-02-10

### Added
- **Hooks plugin bundled**: `gitmem install-hooks` / `uninstall-hooks` CLI commands (OD-605, OD-606)
- **CLI `check` command wired**: `gitmem check` now reachable from CLI (was defined but unreachable)
- **Fresh-install E2E tests**: 16 integration tests covering CLI commands, hooks, and MCP server lifecycle (OD-607)
- **README rewrite**: External-developer-facing docs with no internal jargon (OD-608)
- **CONTRIBUTING.md**: Dev setup, testing tiers, and PR guidelines
- **First public npm release** (OD-609)

### Changed
- Package name standardized to `gitmem-mcp` for npm
- `gitmem configure` output uses `gitmem-mcp` (matching npm package name)
- Removed internal project defaults from CLI commands

## [0.2.0] - 2026-02-08

### Added
- **Full monorepo sync**: Standalone repo is now source of truth (Option A — OD-574, GIT-1)
- **Zod schemas**: 14 schema files for all tool parameter validation (`src/schemas/`)
- **Diagnostics suite**: Health checks, channel instrumentation, anonymization (`src/diagnostics/`)
- **Single source of truth constants**: Closing questions defined once (`src/constants/closing-questions.ts`)
- **Multi-agent tools**: `prepare_context` and `absorb_observations` (GitMem v2 Phase 1-2)
- **Tool definitions module**: Centralized tool registration (`src/tools/definitions.ts`)
- **Commands module**: `gitmem check` CLI health diagnostics (`src/commands/check.ts`)
- **Full test suite**: 354+ unit tests across 20 test files, plus integration, e2e, and performance benchmarks
- **Vitest configs**: Separate configs for unit, integration, e2e, and performance tests
- **Compliance validator warnings**: Q3/Q5 substantive answers warn if no learnings created

### Fixed
- **Critical**: GitMem now loads ALL learning types (scars, patterns, wins, anti-patterns) instead of just scars
- Closing reflection schema now includes Q7 (`institutional_memory_items`) field

### Changed
- `build` script now runs unit tests after compilation (`tsc && npm run test:unit`)
- Version bumped to 0.2.0 to reflect full feature parity with monorepo

## [0.1.0] - 2026-02-03

### Added
- Initial MCP server implementation
- Predict tool (scar search with temporal decay)
- Session lifecycle (session_start, session_close)
- Learning capture (scars, wins, patterns)
- Decision logging
- Scar usage tracking
- Local vector search with OpenRouter embeddings
- Cache management (status, flush, health)
- Agent identity detection

[Unreleased]: https://github.com/nTEG-dev/gitmem/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/nTEG-dev/gitmem/compare/v0.2.0...v1.0.0
[0.2.0]: https://github.com/nTEG-dev/gitmem/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nTEG-dev/gitmem/releases/tag/v0.1.0

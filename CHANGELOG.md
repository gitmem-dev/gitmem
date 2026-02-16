# Changelog

All notable changes to gitmem will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.9] - 2026-02-16

### Fixed
- **Closing payload field name mismatch**: `CLAUDE.md.template` documented wrong field names (`institutional_memory` instead of `institutional_memory_items`, bogus `started_at`/`completed_at` in task_completion) causing agents to write payloads that `session_close` couldn't parse. Fixed template and added `institutional_memory` as normalizer alias.
- **Missing Q8/Q9 in closing template**: Added `collaborative_dynamic` and `rapport_notes` fields to payload example.

## [1.0.6] - 2026-02-16

### Fixed
- **Session close crash on malformed scars_to_record**: Agents writing `{title, description, severity}` (create_learning shape) instead of `{scar_identifier, reference_type, reference_context}` (ScarUsageEntry shape) in closing payload caused `Cannot read properties of undefined (reading 'length')` crash in `formatCloseDisplay`. Now auto-coerces salvageable entries and drops invalid ones with warnings.
- **Defensive property access in formatCloseDisplay**: Guard against undefined `scar_identifier`, `reference_type`, and `reference_context` as belt-and-suspenders protection.

## [1.0.3] - 2026-02-15

### Changed
- **Tool alias consolidation**: Reduced advertised tools from 55 to 20 (free tier). Aliases still work when called directly. Set `GITMEM_FULL_ALIASES=1` to restore all.
- **Starter scars reduced**: Ship with 3 high-quality starter scars instead of 12. Starter scars deprioritized with 0.7x score multiplier so earned scars outrank them.
- **Recall similarity threshold**: Weak matches below threshold (0.4 BM25, 0.35 embeddings) are suppressed. Empty results show helpful guidance instead of noise.
- **Adaptive session closing**: Auto-detects ceremony level (micro/standard/full) based on session activity. Removed hard rejection gate that blocked standard closes on short sessions.
- **Scar relevance feedback**: Optional `relevance` field (high/low/noise) on `confirm_scars` for recall quality improvement. Defaults derived from decision type.
- **Pro tier messaging**: Rewritten from agent's perspective with concrete value propositions.

### Added
- **Agent briefing**: Generates `.gitmem/agent-briefing.md` at session close with memory state summary for MEMORY.md bridge.
- **PMEM/GitMem boundary docs**: README section documenting how GitMem complements MEMORY.md/cursorrules.

## [1.0.2] - 2026-02-15

### Fixed
- **Free tier crash**: `markSessionSuperseded` called Supabase without `hasSupabase()` guard
- **Session close UX**: Write health block only shown when failures exist (was always visible)
- **E2E test suite**: Updated for display protocol changes (session_id extraction, display format assertions, recall display text, CLAUDE.md template wording)

## [1.0.0] - 2026-02-10

### Added
- **Hooks plugin bundled**: `gitmem install-hooks` / `uninstall-hooks` CLI commands
- **CLI `check` command wired**: `gitmem check` now reachable from CLI (was defined but unreachable)
- **Fresh-install E2E tests**: 16 integration tests covering CLI commands, hooks, and MCP server lifecycle
- **README rewrite**: External-developer-facing docs with no internal jargon
- **CONTRIBUTING.md**: Dev setup, testing tiers, and PR guidelines
- **First public npm release**

### Changed
- Package name standardized to `gitmem-mcp` for npm
- `gitmem configure` output uses `gitmem-mcp` (matching npm package name)
- Removed internal project defaults from CLI commands

## [0.2.0] - 2026-02-08

### Added
- **Full monorepo sync**: Standalone repo is now source of truth
- **Zod schemas**: 14 schema files for all tool parameter validation (`src/schemas/`)
- **Diagnostics suite**: Health checks, channel instrumentation, anonymization (`src/diagnostics/`)
- **Single source of truth constants**: Closing questions defined once (`src/constants/closing-questions.ts`)
- **Multi-agent tools**: `prepare_context` and `absorb_observations`
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

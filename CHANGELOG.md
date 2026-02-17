# Changelog

All notable changes to gitmem will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.2] - 2026-02-17

### Changed
- **Repository migration**: Moved from `nTEG-dev/gitmem` to `gitmem-dev/gitmem`. All references updated.

### Added
- **OpenClaw distribution**: SKILL.md and listing materials for OpenClaw skill directory.

## [1.1.1] - 2026-02-17

### Removed
- **Dead dependency `@huggingface/transformers`**: Massive package (ONNX runtime + model files) was declared as a runtime dependency but never imported anywhere. Embedding service uses raw `fetch()` to external APIs. Shipped unused since initial release, bloating every `npx gitmem-mcp` install.

### Added
- **CI dependency audit**: `depcheck` now runs in CI pipeline. Unused runtime dependencies will fail the build. This gap allowed the dead dependency to ship through 15+ versions undetected.

## [1.1.0] - 2026-02-17

### Added
- **Cursor IDE support**: `npx gitmem-mcp init` auto-detects Cursor projects (`.cursor/` directory) and generates Cursor-specific config: `.cursor/mcp.json`, `.cursorrules`, `.cursor/hooks.json` with camelCase event names. Also supports `--client cursor` flag for explicit selection.
- **Cursor uninstall**: `npx gitmem-mcp uninstall` cleanly removes gitmem from Cursor config while preserving user hooks, other MCP servers, and existing `.cursorrules` content.
- **Cursor clean room testing**: Docker container (`Dockerfile.cursor`) with Cursor CLI v2026.02.13 + gitmem for end-to-end validation. Includes comprehensive test plan (16 tests across 3 phases).
- **34 new E2E tests**: Cross-tool Cursor integration tests covering init/uninstall for both clients, idempotency, content isolation, and edge cases.
- **454 new unit tests**: Confirm-scars rejection rate tests, recall threshold tests.

### Fixed
- **Confirm-scars rejection rate**: Reduced false rejections by improving scar matching tolerance.
- **Recall relevance threshold**: Added minimum relevance floor to reduce noise in recall results.
- **Recall nudge**: Improved guidance when recall returns low-relevance results.

### Validated
- Independent Cursor AI agent scored gitmem **88% (18.5/21)** across 7 test scenarios run 3 times each. Verdict: "GitMem is a must-have." ([OD-695](https://linear.app/nteg-labs/issue/OD-695), [OD-696](https://linear.app/nteg-labs/issue/OD-696), [OD-697](https://linear.app/nteg-labs/issue/OD-697), [OD-698](https://linear.app/nteg-labs/issue/OD-698) filed from findings.)

## [1.0.15] - 2026-02-16

### Fixed
- **Thread dedup without API key**: Dedup silently fell back to exact text match when no embedding API key (OpenAI/OpenRouter/Ollama) was set — which is the default for free tier users. Near-duplicate threads with the same topic but different wording slipped through. Added zero-dependency token overlap coefficient as a middle tier (threshold 0.6, lowered to 0.4 when threads share an issue prefix like `OD-692:`). Also upgraded `deduplicateThreadList` with the same logic. +18 unit tests.

## [1.0.12] - 2026-02-16

### Fixed
- **Table prefix for pro tier**: `getTableName()` was resolving to `gitmem_*` tables for pro tier, but those tables don't exist yet. All tiers now default to `orchestra_` prefix until schema migration is complete.

### Changed
- **Dynamic table names**: Replaced all hardcoded `orchestra_*` table name strings across 22 source files with `getTableName()` calls, making table prefixes configurable via `GITMEM_TABLE_PREFIX` env var.
- **Release status script**: Added `npm run release-status` to check unpublished commits vs npm.

## [1.0.11] - 2026-02-16

### Changed
- **CI pipeline cleanup**: `build` script is now just `tsc` (was `tsc && npm run test:unit`). Tests ran 8x per CI run due to `build`, `test`, and `prepublishOnly` all triggering the same 764-test suite. Now each step does one thing: typecheck, compile, test, smoke, publish.

## [1.0.10] - 2026-02-16

### Fixed
- **CI smoke test**: `session_close` test looked for `active-sessions.json` at `process.cwd()` instead of `GITMEM_DIR`, failing in CI where they differ.
- **CI peer dependencies**: Added `--legacy-peer-deps` to `npm ci` for `zod@4` conflict with `claude-agent-sdk`.
- **CI unit test**: `quick-retrieve.test.ts` now sets `GITMEM_DIR` so disk cache tests resolve correctly in CI.

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

[Unreleased]: https://github.com/gitmem-dev/gitmem/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/gitmem-dev/gitmem/compare/v0.2.0...v1.0.0
[0.2.0]: https://github.com/gitmem-dev/gitmem/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/gitmem-dev/gitmem/releases/tag/v0.1.0

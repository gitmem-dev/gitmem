# Changelog

All notable changes to gitmem will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Hooks plugin bundled**: `gitmem install-hooks` / `uninstall-hooks` CLI commands (OD-605, OD-606)
- **CLI `check` command wired**: `gitmem check` now reachable from CLI (was defined but unreachable)
- **Fresh-install E2E tests**: 16 integration tests covering CLI commands, hooks, and MCP server lifecycle (OD-607)
- **README rewrite**: External-developer-facing docs with no internal jargon (OD-608)
- **CONTRIBUTING.md**: Dev setup, testing tiers, and PR guidelines

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

[Unreleased]: https://github.com/nTEG-dev/gitmem/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/nTEG-dev/gitmem/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nTEG-dev/gitmem/releases/tag/v0.1.0

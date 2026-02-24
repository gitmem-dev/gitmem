# Changelog

All notable changes to gitmem will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.3] - 2026-02-24

### Fixed
- **NULL agent values in query metrics eliminated**: `recordMetrics()` now auto-detects agent via `getAgentIdentity()` when callers don't provide it. Previously 15 of 18 tools omitted the agent field, resulting in NULL values in `gitmem_query_metrics`.

### Performance
- **session_start ~200-300ms faster**: Sessions and threads queries now run in parallel (`Promise.all`) instead of sequentially inside `loadLastSession`.
- **session_close transcript upload no longer blocks**: Transcript save moved from blocking `await` to fire-and-forget via effect tracker. Removes 500-5000ms variable cost from `latency_ms`. Claude session ID extraction remains synchronous.

## [1.4.2] - 2026-02-22

### Fixed
- **Scar usage `execution_successful` nulls eliminated**: N_A confirmations now record `true` (was null/undefined). Q6 text matches now include `execution_successful: true` (was omitted). Fixes 80% null rate in scar effectiveness data.
- **Auto-bridge fires on all session closes**: Previously required Q6 `scars_applied` to be non-empty. Now fires whenever no explicit `scars_to_record` is provided, ensuring confirmations from `confirm_scars` always get recorded.
- **Surfaced scars survive MCP restart**: `getSurfacedScars()` now recovers from the active-sessions registry when `currentSession` is null after MCP restart. Scars surfaced early in a session are no longer silently lost.
- **Session close display shows scar titles**: `reference_context` now leads with the scar title instead of boilerplate. Display uses +/! indicators for applied/refuted scars.

## [1.4.1] - 2026-02-22

### Added
- **AGENTS.md generation**: Init wizard now creates an IDE-agnostic `AGENTS.md` file alongside the client-specific instructions file. Contains tool table, core workflow, sub-agent patterns (`prepare_context`, `absorb_observations`), and example JSON tool calls. Read by Codex, Copilot, Gemini, Cursor, and other AI coding assistants for automatic project discovery.

## [1.4.0] - 2026-02-22

### Changed
- **Starter scar penalty doubled** (0.7x → 0.4x): Earned scars now decisively outrank starter scars in recall and search results. 6 community reports of starter scars drowning out project-specific lessons.
- **Display protocol footer trimmed**: Removed the "Success: You echoed..." line from the display suffix — reduced noise without losing the echo instruction.
- **First-recall message rewritten**: Replaced patronizing welcome text with actionable nudge: "No project-specific lessons yet. Use create_learning to capture your first."
- **Session close description simplified**: Tool descriptions now clearly present two modes (inline params or payload file) instead of demanding the file-first approach.

### Added
- **Thread positional resolve (`#N`)**: `resolve_thread` now accepts `#3` to resolve the 3rd thread in display order. Matches the `#` column shown by `list_threads`.
- **Thread ID column in list_threads**: Thread table now shows short IDs (e.g., `t-24aefd13`) alongside positional numbers — agents can reference by either.
- **Provenance `[starter]` tag**: Recall and search results now annotate starter scars with a dim `[starter]` tag, so agents can distinguish earned vs bundled lessons.
- **Inline `closing_reflection` parameter**: `session_close` schema now exposes `closing_reflection` and `human_corrections` as direct parameters — no payload file needed for simple closes.

### Fixed
- **`log` tool missing `anti_pattern` type**: TypeScript type for `learning_type` filter excluded `"anti_pattern"`, causing type errors when filtering by anti-patterns.

## [1.3.5] - 2026-02-22

### Fixed
- **Free tier recall→confirm_scars flow broken**: Recall on free tier returned scars to the agent but never tracked them in session state, causing confirm_scars to respond with "No recall-surfaced scars to confirm" even when valid confirmations were submitted. Reported across 3 clean room sessions.

### Added
- **E2E regression test for recall→confirm_scars**: Verifies the full free tier flow — create scar, recall it, confirm it — catches the session state tracking gap.

## [1.3.4] - 2026-02-22

### Added
- **Expanded starter scar pack** (7 → 12): Five new community-proposed scars covering multi-agent delegation, memory hygiene, and communication patterns.
- **Closing payload pre-seeded during init**: `closing-payload.json` template created at install time, preventing Write permission prompt on first session close.
- **`contribute_feedback` tool**: Agents can submit anonymous feedback (feature requests, bugs, friction) to help improve gitmem.

### Fixed
- **`is_active` filter for free tier**: `list()` now treats missing `is_active` as `true` instead of filtering out all learnings without the field.
- **`learning_type` in recall results**: Recall now returns `learning_type` in search results so agents can distinguish scars from wins and patterns.
- **Explicit `is_active: true` on learning creation**: New learnings are created with `is_active: true` to prevent filter mismatches.

## [1.3.1] - 2026-02-22

### Fixed
- **Archived learnings excluded from free tier search/log**: `keywordSearch` and `log` on the free tier (local JSON storage) now filter out `is_active === false` learnings, matching pro tier behavior.

### Changed
- **Removed uninstall line from init success footer**: Cleaner post-install output.

## [1.3.0] - 2026-02-22

### Added
- **Expanded starter scars** (3 → 7): New scars covering testing, config drift, dependency management, and root-cause debugging.
- **Real UUIDs on starter scars**: Replaced placeholder `00000000-*` IDs with real v4 UUIDs — fixes 8-char prefix matching in `confirm_scars`.
- **First-recall welcome message**: When all recall results are starter scars, shows "This is your first recall — results will get more relevant as you add your own lessons."
- **Starter thread**: Fresh installs get a welcome thread nudging users to add their first project-specific scar.
- **Clean room Dockerfile for local builds**: `testing/clean-room/Dockerfile.local` for testing local tarballs.

### Fixed
- **Enforcement false positives**: `recall()` returning 0 scars no longer triggers "No recall() was run" warning. Tracks `recallCalled` boolean independently of result count.
- **Init wizard brand styling**: Unified color system and ripple branding in both init and uninstall wizards.

### Changed
- **Clean room Dockerfiles**: Updated npm to latest to suppress upgrade nag during testing.

## [1.2.1] - 2026-02-21

### Added
- **MCP Registry metadata**: Added `mcpName` field to package.json and `server.json` for official MCP Registry listing.

## [1.2.0] - 2026-02-20

### Added
- **Telemetry CLI**: `npx gitmem-mcp telemetry` command for viewing scar effectiveness metrics and recall statistics.
- **Confirm-scars prefix matching**: `confirm_scars` now accepts 8-character ID prefixes instead of requiring full UUIDs — faster agent workflows.
- **Session-close timing**: `session_close` now tracks and reports ceremony duration for performance visibility.

### Fixed
- **Test assertion alignment**: Updated smoke and E2E test assertions to match current CLI output format (branded `((●))` display, lowercase identifiers).
- **No-console-log allowlist**: CLI commands correctly excluded from console.log lint rule.

## [1.1.4] - 2026-02-20

### Changed
- **Recall default switched to c-review**: Production nudge header changed from "INSTITUTIONAL MEMORY ACTIVATED" to "N scars to review". Nudge-bench testing (54 runs × 3 models) showed 89% scar reference rate vs 44% — a 2x improvement across Opus, Sonnet, and Haiku.

### Fixed
- **Thread display cleanup**: Removed internal thread IDs from `list_threads` output. Threads now show `# | Thread | Active` — IDs were implementation detail with no user value.

## [1.1.3] - 2026-02-19

### Added
- **Multi-client init wizard**: `npx gitmem-mcp init` now supports VS Code, Windsurf, and generic MCP clients in addition to Claude Code and Cursor.
- **Server-side enforcement layer**: Universal compliance enforcement that works across all MCP clients — recall before consequential actions, scar confirmation gates.
- **Scar framing guidance**: `create_learning` tool now guides agents to frame scars as "what we now know" (factual discovery) rather than "what I did wrong" (self-criticism).
- **Auto-detect agent and session**: Scar usage tracking automatically detects the current agent identity and session context.
- **Closing payload schema**: Session close payload schema now ships with `init` and `session_start` for client reference.
- **npm discoverability keywords**: Added `mcp-server`, `claude-code`, `ai-memory`, `ai-agent` keywords for npm search.
- **Documentation site**:
  - Restored Fumadocs source for gitmem.ai/docs with emerald theme.
  - Redesigned docs landing page with improved messaging and branding.
  - Added FAQ page with 11 questions.
  - Added MCP one-liner explainer for new users.
  - Added 3 docs examples (scar stories): credential leak, phantom deploy, and first scar.
  - Inline mailing list signup form in docs pages.
  - Rich installation page with multi-client instructions.

### Fixed
- **Thread display output**: `list_threads` and `cleanup_threads` replaced ASCII box-drawing tables with markdown tables. Thread text truncation increased from 40-48 to 60 characters. Output now renders cleanly in all MCP clients instead of clipping on narrow terminals.
- **Version reporting**: Server now reads version from `package.json` instead of hardcoded `1.0.3`.
- **Log header clarity**: `gitmem log` header now says "most recent learnings" instead of ambiguous label.
- **Analyze output**: Relabeled misleading "Open Threads" to "Threads Referenced" in analyze output.
- **Stale thread cleanup**: Drop stale local-only threads on `session_start` when Supabase is authoritative source.
- **Package name in docs**: Corrected to `npx gitmem-mcp init` (was `npx gitmem init`).
- **Docs fixes**: Removed duplicate h1 headers, fixed sidebar nav duplicate entry, corrected GitHub URLs after org migration.

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

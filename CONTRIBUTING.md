# Contributing to GitMem

Thanks for your interest in contributing to GitMem! This guide covers development setup, testing, and how to submit changes.

## Development Setup

### Prerequisites

- Node.js 18+
- npm

### Getting Started

```bash
git clone https://github.com/nTEG-dev/gitmem.git
cd gitmem
npm install
npm run build
```

The `build` script compiles TypeScript and runs unit tests. If tests fail, the build fails.

### Project Structure

```
gitmem/
├── bin/gitmem.js           # CLI entrypoint (all commands)
├── src/
│   ├── index.ts            # MCP server entrypoint
│   ├── tools/              # MCP tool implementations
│   ├── schemas/            # Zod validation schemas
│   ├── commands/           # CLI command implementations (e.g., check.ts)
│   ├── diagnostics/        # Health check and instrumentation
│   ├── storage/            # Storage backends (local JSON, Supabase)
│   └── constants/          # Shared constants
├── hooks/                  # Bundled Claude Code hooks plugin
│   ├── .claude-plugin/     # Plugin manifest
│   ├── hooks/              # Hook definitions (hooks.json)
│   └── scripts/            # Shell scripts for each hook
├── schema/
│   ├── setup.sql           # Supabase schema for Pro tier
│   └── starter-scars.json  # Default scars shipped with init
├── tests/
│   ├── unit/               # Fast unit tests (~2s)
│   ├── e2e/                # End-to-end tests via MCP protocol
│   ├── integration/        # Integration tests (requires Docker)
│   ├── smoke/              # Smoke tests (free + pro tiers)
│   └── perf/               # Performance benchmarks
├── CLAUDE.md.template      # Template for user projects
└── docs/                   # Feature documentation
```

## Testing

GitMem uses a tiered test pyramid. Always run at least Tier 1 before submitting a PR.

### Tier 1: Unit Tests (required)

```bash
npm run test:unit
```

Fast (~2s), no external dependencies. Tests schemas, tool logic, storage backends, and utilities.

### Tier 2: End-to-End Tests

```bash
npm run test:e2e
```

Spawns the MCP server as a child process and tests tools through the actual MCP protocol. Includes CLI command tests (init, configure, check, install-hooks).

### Tier 3: Smoke Tests

```bash
npm run test:smoke:free    # Free tier (local storage)
npm run test:smoke:pro     # Pro tier (requires Supabase credentials)
```

### Tier 4: Integration Tests

```bash
npm run test:integration
```

Requires Docker. Uses Testcontainers to spin up PostgreSQL with pgvector for database-layer tests.

### Tier 5: Performance Benchmarks

```bash
npm run test:perf
```

Benchmarks for search, embedding, and session operations.

### Run Everything

```bash
npm run test:all
```

### Diagnostic Check

```bash
npx gitmem-mcp check          # Quick health check (~5s)
npx gitmem-mcp check --full   # Full diagnostic with benchmarks (~30s)
```

## Making Changes

### Branch Naming

```
feature/short-description
bugfix/short-description
```

### Commit Messages

```
feat: add new tool for X
fix: correct recall scoring bug
test: add e2e tests for CLI fresh install
docs: update README quick start
chore: bump dependencies
```

### Pull Request Process

1. Create a feature branch from `main`
2. Make your changes
3. Run `npm run test:unit` (minimum) and `npm run test:e2e` (recommended)
4. Commit with a descriptive message
5. Push and open a PR against `main`
6. PR description should include:
   - What changed and why
   - How to test
   - Any breaking changes

### Code Style

- TypeScript with strict mode
- Zod schemas for all tool parameter validation
- Tests alongside the code they test (in `tests/` mirror of `src/`)

## Architecture Notes

### Storage Tiers

GitMem has two storage backends:

- **Local** (`src/storage/local/`) — JSON files in `.gitmem/`, keyword search. Used when no Supabase credentials are set.
- **Supabase** (`src/storage/supabase/`) — PostgreSQL with pgvector for semantic search. Used when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set.

Tier detection happens at startup based on environment variables.

### MCP Protocol

GitMem is an MCP server that communicates via stdio. The server registers tools defined in `src/tools/definitions.ts`, with tier-based gating (some tools only available in Pro/Dev tiers).

### Tool Aliases

Every tool has a short alias (e.g., `gitmem-r` for `recall`, `gitmem-ss` for `session_start`). These are defined alongside the tool definitions and help reduce token usage in conversations.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

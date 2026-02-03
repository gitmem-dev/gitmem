# Changelog

All notable changes to gitmem will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Critical**: GitMem now loads ALL learning types (scars, patterns, wins, anti-patterns) instead of just scars. Previously only 164 scars were loaded, ignoring ~64 patterns and other learning types (~228 total learnings now loaded). ([OD-532](https://linear.app/nteg-labs/issue/OD-532))
  - Modified `loadScarsWithEmbeddings()` to use `learning_type: "in.(scar,pattern,win,anti_pattern)"`
  - Updated `getRemoteScarStats()` to match the same filter
  - Enhanced `directQuery()` to handle PostgREST operators properly

### Known Issues
- Cache health check may report false "out of sync" warnings when learnings lack embeddings ([OD-542](https://linear.app/nteg-labs/issue/OD-542))

## [0.1.0] - 2026-01-XX

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

[Unreleased]: https://github.com/nTEG-dev/gitmem/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nTEG-dev/gitmem/releases/tag/v0.1.0

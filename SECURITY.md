# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |
| < Latest | No       |

We only support the latest published version. Please upgrade before reporting.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Instead, please email **security@gitmem.ai** with:

1. Description of the vulnerability
2. Steps to reproduce
3. Affected versions
4. Any potential impact assessment

### What to Expect

- **Acknowledgment** within 48 hours
- **Assessment** within 7 days
- **Fix or mitigation** timeline communicated after assessment
- **Credit** in the release notes (unless you prefer anonymity)

## Scope

The following are in scope:

- The `gitmem-mcp` npm package
- The `npx gitmem-mcp init` CLI wizard
- MCP server tool implementations
- Local storage backends (`.gitmem/` directory)
- Bundled hooks and scripts

The following are out of scope:

- The gitmem.ai website (report separately)
- Third-party MCP clients (Claude Code, Cursor, etc.)
- Self-hosted Supabase instances

## Security Design

GitMem stores data locally in `.gitmem/` by default. No data leaves your machine unless you explicitly configure a Supabase backend (Pro tier). The MCP server communicates only via stdio with the host process.

#!/usr/bin/env bash
set -euo pipefail
#
# One command to test gitmem as a fresh user with Claude CLI.
#
# Usage (from repo root):
#   ./testing/clean-room/try-it.sh
#
# Requires:
#   - docker
#   - ANTHROPIC_API_KEY in your environment

cd "$(dirname "$0")/../.."

echo "1/3  Building gitmem tarball..."
npm run build --silent
npm pack --pack-destination testing/clean-room/ --silent

echo "2/3  Building clean-room container..."
docker build -q -t gitmem-fresh testing/clean-room/

echo "3/3  Launching Claude Code..."
echo "     (gitmem is installed, .mcp.json configured, CLAUDE.md in place)"
echo ""
docker run -it --rm \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:?Set ANTHROPIC_API_KEY first}" \
  gitmem-fresh

# Clean up tarball
rm -f testing/clean-room/gitmem-mcp-*.tgz

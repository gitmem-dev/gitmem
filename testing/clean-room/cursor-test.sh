#!/usr/bin/env bash
set -euo pipefail
#
# Launch a clean room container for Cursor wizard testing.
# You'll land in a bash shell as a fresh Cursor user with gitmem installed but NOT configured.
#
# Usage (from repo root):
#   ./testing/clean-room/cursor-test.sh
#
# No ANTHROPIC_API_KEY needed — Cursor is not in the container.
# This tests the init wizard, file generation, and uninstall.
# Live Cursor IDE testing (MCP, Agent mode) must be done on your Mac.

cd "$(dirname "$0")/../.."

echo "1/3  Building gitmem tarball..."
npm run build --silent
npm pack --silent

echo "2/3  Building Cursor test container..."
docker build -q -t gitmem-cursor -f testing/clean-room/Dockerfile.cursor .

echo "3/3  Launching clean room..."
echo ""
echo "  You are a fresh Cursor user. gitmem is npm-installed but NOT configured."
echo "  A .cursor/ directory exists (simulates Cursor IDE open)."
echo "  Run: npx gitmem-mcp init"
echo "  Follow: testing/clean-room/CURSOR-WIZARD-TEST-PLAN.md"
echo ""
docker run -it --rm gitmem-cursor

# Clean up tarball
rm -f gitmem-mcp-*.tgz

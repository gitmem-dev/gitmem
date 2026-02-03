#!/bin/bash
# Rebuild GitMem MCP after code changes
# Usage: ./reinstall.sh
#
# This script just rebuilds. The .mcp.json in project root handles registration.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🔧 Rebuilding GitMem MCP..."
npm run build

echo ""
echo "✅ GitMem MCP rebuilt"
echo ""
echo "The project-level .mcp.json handles registration automatically."
echo "Verify with: claude mcp list"

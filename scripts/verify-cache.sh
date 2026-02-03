#!/bin/bash
# GitMem Cache Verification Script
# Run this AFTER rebuilding the MCP server and starting a new Claude session
#
# Usage: ./scripts/verify-cache.sh
#
# This script rebuilds the MCP server. After running it, you need to:
# 1. Exit your current Claude session
# 2. Start a new Claude session
# 3. Run the predict tool twice with the same query
# 4. Check that the second call shows cache_hit: true

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"

echo "=================================="
echo "GitMem Cache Verification"
echo "=================================="
echo ""

# Step 1: Rebuild
echo "[1/3] Rebuilding MCP server..."
cd "$PACKAGE_DIR"
npm run build
echo "✅ Build complete"
echo ""

# Step 2: Check cache directory
CACHE_DIR="${GITMEM_CACHE_DIR:-$HOME/.cache/gitmem}"
echo "[2/3] Checking cache directory..."
if [ -d "$CACHE_DIR/results" ]; then
    COUNT=$(ls -1 "$CACHE_DIR/results"/*.json 2>/dev/null | wc -l || echo "0")
    echo "   Cache location: $CACHE_DIR"
    echo "   Existing cache files: $COUNT"
else
    echo "   Cache directory doesn't exist yet (will be created on first use)"
fi
echo ""

# Step 3: Instructions
echo "[3/3] Next steps:"
echo ""
echo "   1. Exit this Claude session (type 'exit' or Ctrl+D)"
echo ""
echo "   2. Start a new Claude session:"
echo "      $ claude"
echo ""
echo "   3. Run predict twice with the same query:"
echo "      > Use mcp__gitmem__predict with plan: \"test caching\""
echo "      > Run it again with the same plan"
echo ""
echo "   4. Verify cache is working:"
echo "      - First call: cache_hit should be false, latency ~650ms"
echo "      - Second call: cache_hit should be true, latency <100ms"
echo ""
echo "=================================="
echo "After verification, check cache files:"
echo "  ls -la $CACHE_DIR/results/"
echo "=================================="

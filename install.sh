#!/bin/bash
# First-time GitMem MCP installation
# Usage: ./install.sh
#
# Run this after cloning the repo for the first time.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "📦 Installing GitMem MCP dependencies..."
npm install

echo "🔧 Building GitMem MCP..."
npm run build

echo ""
echo "✅ GitMem MCP installed"
echo ""

# Check environment variables
MISSING_VARS=""
if [ -z "$SUPABASE_URL" ]; then
    MISSING_VARS="SUPABASE_URL"
fi
if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
    if [ -n "$MISSING_VARS" ]; then
        MISSING_VARS="$MISSING_VARS, SUPABASE_SERVICE_ROLE_KEY"
    else
        MISSING_VARS="SUPABASE_SERVICE_ROLE_KEY"
    fi
fi

if [ -n "$MISSING_VARS" ]; then
    echo "⚠️  Missing environment variables: $MISSING_VARS"
    echo ""
    echo "Set these in your environment before starting Claude:"
    echo "  export SUPABASE_URL=https://your-project.supabase.co"
    echo "  export SUPABASE_SERVICE_ROLE_KEY=your-key"
    echo ""
else
    echo "✅ Environment variables configured"
    echo ""
fi

echo "The project-level .mcp.json handles registration automatically."
echo ""
echo "Next steps:"
echo "  1. Ensure environment variables are set (see above)"
echo "  2. Start Claude: claude"
echo "  3. Verify: claude mcp list (should show gitmem ✓ Connected)"

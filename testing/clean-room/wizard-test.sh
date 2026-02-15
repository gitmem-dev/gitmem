#!/usr/bin/env bash
set -euo pipefail
#
# Launch a clean room container for wizard testing.
# You'll land in a bash shell as a fresh user with gitmem installed but NOT configured.
#
# Usage (from repo root):
#   ./testing/clean-room/wizard-test.sh
#
# Requires:
#   - docker
#   - ANTHROPIC_API_KEY in your environment

cd "$(dirname "$0")/../.."

echo "1/3  Building gitmem tarball..."
npm run build --silent
npm pack --pack-destination testing/clean-room/ --silent

echo "2/3  Building wizard test container..."
docker build -q -t gitmem-wizard -f testing/clean-room/Dockerfile.wizard testing/clean-room/

echo "3/3  Launching clean room..."
echo ""
echo "  You are a fresh user. gitmem is npm-installed but NOT configured."
echo "  Run: npx gitmem init"
echo "  Then: claude"
echo ""
docker run -it --rm \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:?Set ANTHROPIC_API_KEY first}" \
  gitmem-wizard

# Clean up tarball
rm -f testing/clean-room/gitmem-mcp-*.tgz

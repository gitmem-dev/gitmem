#!/usr/bin/env bash
# Show publish status: npm version vs local vs unpublished commits

set -euo pipefail

LOCAL=$(node -p "require('./package.json').version")
NPM=$(npm view gitmem-mcp version 2>/dev/null || echo "unpublished")
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "none")
COMMITS=$(git log "${LAST_TAG}..HEAD" --oneline 2>/dev/null | wc -l | tr -d ' ')

echo "npm (published):  ${NPM}"
echo "package.json:     ${LOCAL}"
echo "last git tag:     ${LAST_TAG}"
echo "unpublished commits: ${COMMITS}"
echo ""

if [ "$COMMITS" -gt 0 ]; then
  echo "Commits since ${LAST_TAG}:"
  git log "${LAST_TAG}..HEAD" --oneline
fi

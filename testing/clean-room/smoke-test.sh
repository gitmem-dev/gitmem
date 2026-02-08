#!/usr/bin/env bash
#
# GitMem Clean Room Smoke Test
#
# Validates the first-user experience end-to-end:
#   1. Auth to GitHub Packages works
#   2. Package installs via npx
#   3. Init loads starter scars
#   4. Configure generates valid config
#   5. MCP server starts and sessions work
#
# Exit 1 on any failure.

set -euo pipefail

PASS=0
FAIL=0

check() {
  local name="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    echo "  PASS  $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $name"
    FAIL=$((FAIL + 1))
  fi
}

check_output() {
  local name="$1"
  local expected="$2"
  shift 2
  local output
  output=$("$@" 2>&1) || true
  if echo "$output" | grep -q "$expected"; then
    echo "  PASS  $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $name"
    echo "        Expected to find: $expected"
    echo "        Got: ${output:0:200}"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "═══════════════════════════════════════════"
echo "  GitMem Clean Room Smoke Test"
echo "═══════════════════════════════════════════"
echo ""

# ── Check 1: NPM_TOKEN exists ──
echo "Check 1: NPM_TOKEN configured"
if [ -z "${NPM_TOKEN:-}" ]; then
  echo "  FAIL  NPM_TOKEN is not set"
  echo "        Export NPM_TOKEN with a GitHub PAT that has read:packages scope"
  exit 1
fi
echo "  PASS  NPM_TOKEN is set"
PASS=$((PASS + 1))

# ── Check 2: GitHub Packages auth works ──
echo "Check 2: GitHub Packages auth"
check "npm whoami" npm whoami --registry=https://npm.pkg.github.com

# ── Check 3: npx gitmem init ──
echo "Check 3: gitmem init (free tier)"
npx -y @nteg-dev/gitmem init 2>&1 | while IFS= read -r line; do echo "        $line"; done
if [ -f ".gitmem/learnings.json" ]; then
  echo "  PASS  gitmem init"
  PASS=$((PASS + 1))
else
  echo "  FAIL  gitmem init — .gitmem/learnings.json not created"
  FAIL=$((FAIL + 1))
fi

# ── Check 4: Starter scars loaded (expect 12) ──
echo "Check 4: Starter scars count"
SCAR_COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.gitmem/learnings.json','utf-8')).length)")
if [ "$SCAR_COUNT" -eq 12 ]; then
  echo "  PASS  $SCAR_COUNT starter scars loaded"
  PASS=$((PASS + 1))
else
  echo "  FAIL  Expected 12 scars, got $SCAR_COUNT"
  FAIL=$((FAIL + 1))
fi

# ── Check 5: All collection files created ──
echo "Check 5: Local storage structure"
ALL_FILES=true
for f in learnings.json sessions.json decisions.json scar-usage.json; do
  if [ ! -f ".gitmem/$f" ]; then
    echo "  FAIL  Missing .gitmem/$f"
    ALL_FILES=false
    FAIL=$((FAIL + 1))
  fi
done
if [ "$ALL_FILES" = true ]; then
  echo "  PASS  All .gitmem/ collection files present"
  PASS=$((PASS + 1))
fi

# ── Check 6: Configure generates valid JSON ──
echo "Check 6: gitmem configure"
CONFIG_OUTPUT=$(npx -y @nteg-dev/gitmem configure 2>/dev/null)
if echo "$CONFIG_OUTPUT" | grep -q '"gitmem"'; then
  echo "  PASS  Configure outputs valid MCP config"
  PASS=$((PASS + 1))
else
  echo "  FAIL  Configure output missing 'gitmem' server entry"
  echo "        Got: ${CONFIG_OUTPUT:0:200}"
  FAIL=$((FAIL + 1))
fi

# ── Check 7: Write .mcp.json from configure output ──
echo "Check 7: Write .mcp.json"
# Extract JSON block from configure output
echo "$CONFIG_OUTPUT" | grep -A 100 '{' | head -20 > .mcp.json.tmp 2>/dev/null || true
# Use node to extract just the JSON object
node -e "
  const lines = require('fs').readFileSync('.mcp.json.tmp', 'utf-8');
  const match = lines.match(/\{[\s\S]*\}/);
  if (match) {
    const parsed = JSON.parse(match[0]);
    require('fs').writeFileSync('.mcp.json', JSON.stringify(parsed, null, 2));
    console.log('ok');
  } else {
    process.exit(1);
  }
" 2>/dev/null
rm -f .mcp.json.tmp

if [ -f ".mcp.json" ] && node -e "JSON.parse(require('fs').readFileSync('.mcp.json','utf-8'))" 2>/dev/null; then
  echo "  PASS  .mcp.json written and valid"
  PASS=$((PASS + 1))
else
  echo "  FAIL  .mcp.json could not be written or is invalid"
  FAIL=$((FAIL + 1))
fi

# ── Check 8: MCP server starts and session lifecycle works ──
echo "Check 8: MCP server smoke test"
# Install MCP SDK for the smoke test
npm install --no-save @modelcontextprotocol/sdk 2>&1 | tail -1 | sed 's/^/        /'

# Run the MCP protocol test
if npx tsx ~/mcp-smoke.ts 2>&1; then
  echo "  PASS  MCP server session lifecycle"
  PASS=$((PASS + 1))
else
  echo "  FAIL  MCP server session lifecycle"
  FAIL=$((FAIL + 1))
fi

# ── Summary ──
echo ""
echo "═══════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

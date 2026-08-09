#!/usr/bin/env bash
#
# Run the restart smoke test against a chosen build.
#
#   bash testing/clean-room/verify-against.sh new        # local dist/ (this working tree)
#   bash testing/clean-room/verify-against.sh old        # the published package npx has cached
#   bash testing/clean-room/verify-against.sh cleanroom  # packaged tarball, installed in Docker
#   bash testing/clean-room/verify-against.sh published [ver]  # clean install from the npm registry
#
# WHY THIS FILE EXISTS
#
# The same verification used to be typed as a one-liner with a cd, an inline env
# assignment and a $(...) substitution. Shell like that can never match a
# permission allowlist rule — every run is a fresh prompt for a human who has
# already approved the identical thing twenty times. The fix is shape, not more
# rules: put the sequence in a committed script and invoke it with literal args.
#
# The reproducibility win is the same win. A scripted harness is reviewable in a
# diff, rerunnable by anyone, and identical between the run that proved a fix and
# the run that proves it still holds six months later. Prompt fatigue and
# unreproducible verification are one problem with one fix.
#
# Guardrails are deliberately NOT wrapped: git tag, git push and npm publish stay
# outside any script an agent can run unattended. That friction is load-bearing.

set -euo pipefail

TARGET="${1:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKDIR="${GITMEM_SMOKE_WORKDIR:-${TMPDIR:-/tmp}/gitmem-verify-$$}"

usage() {
  echo "usage: bash testing/clean-room/verify-against.sh <old|new|cleanroom|published [version]>" >&2
  exit 2
}

[[ -n "$TARGET" ]] || usage

cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

case "$TARGET" in
  new)
    SERVER="$REPO_ROOT/dist/index.js"
    if [[ ! -f "$SERVER" ]]; then
      echo "dist/ not built — run: npm run build" >&2
      exit 2
    fi
    echo "target : local working tree"
    echo "version: $(node -p "require('$REPO_ROOT/package.json').version")"
    echo "server : $SERVER"
    echo
    GITMEM_SERVER="$SERVER" node "$REPO_ROOT/testing/clean-room/restart-smoke.mjs" "$WORKDIR"
    ;;

  old)
    # Whatever npx actually resolved last — the build a user is really running,
    # not a version string we assume.
    SERVER="$(find "$HOME/.npm/_npx" -maxdepth 6 -path '*/gitmem-mcp/dist/index.js' 2>/dev/null | head -1)"
    if [[ -z "$SERVER" ]]; then
      echo "no npx-cached gitmem-mcp found; run 'npx gitmem-mcp --help' once first" >&2
      exit 2
    fi
    PKG_JSON="${SERVER%/dist/index.js}/package.json"
    echo "target : published package in the npx cache"
    echo "version: $(node -p "require('$PKG_JSON').version")"
    echo "server : $SERVER"
    echo
    # Expected to FAIL on any build predating the fixes — that is the point.
    # A gate that cannot fail is not a gate.
    GITMEM_SERVER="$SERVER" node "$REPO_ROOT/testing/clean-room/restart-smoke.mjs" "$WORKDIR"
    ;;

  cleanroom)
    # The artifact a user installs, not the working tree. Different thing: a
    # wrong "files" field or a stale build ships something no repo test touched.
    command -v docker >/dev/null || { echo "docker not available" >&2; exit 2; }
    cd "$REPO_ROOT"
    TARBALL="$(npm pack --pack-destination testing/clean-room | tail -1)"
    mv "testing/clean-room/$TARBALL" testing/clean-room/gitmem-mcp-local.tgz
    trap 'rm -f "$REPO_ROOT/testing/clean-room/gitmem-mcp-local.tgz"; cleanup' EXIT
    echo "target : packaged tarball installed in the clean-room container"
    echo "version: $(node -p "require('$REPO_ROOT/package.json').version")"
    echo
    docker build -q -t gitmem-claude-local -f testing/clean-room/Dockerfile.claude-local testing/clean-room >/dev/null
    docker run --rm \
      -v "$REPO_ROOT/testing/clean-room/restart-smoke.mjs:/tmp/restart-smoke.mjs:ro" \
      gitmem-claude-local bash -lc '
        PKG=$(npm root -g)/gitmem-mcp
        echo "installed $(node -p "require(\"$PKG/package.json\").version") on node $(node -v)"
        echo
        GITMEM_SERVER=$PKG/dist/index.js node /tmp/restart-smoke.mjs /home/developer/.smoke
      '
    ;;

  published)
    # What users actually get RIGHT NOW: a clean install straight from the
    # registry, resolved fresh, with no local build and no npx cache in play.
    # Every other target tests something we produced; this one tests what npm
    # serves. Post-publish verification has to come from here or it proves
    # nothing about the released artifact.
    VER="${2:-latest}"
    STAGE="$WORKDIR/registry"
    mkdir -p "$STAGE"
    cd "$STAGE"
    npm init -y >/dev/null 2>&1
    echo "installing gitmem-mcp@$VER from the registry..."
    npm install --no-audit --no-fund "gitmem-mcp@$VER" >/dev/null 2>&1
    SERVER="$STAGE/node_modules/gitmem-mcp/dist/index.js"
    if [[ ! -f "$SERVER" ]]; then
      echo "install failed or package layout unexpected: $SERVER missing" >&2
      exit 2
    fi
    echo "target : registry install (clean, no cache)"
    echo "version: $(node -p "require('$STAGE/node_modules/gitmem-mcp/package.json').version")"
    echo "server : $SERVER"
    echo
    GITMEM_SERVER="$SERVER" node "$REPO_ROOT/testing/clean-room/restart-smoke.mjs" "$WORKDIR/smoke"
    ;;

  *) usage ;;
esac

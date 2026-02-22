#!/bin/bash
#
# Unified clean room build & run
#
# Usage:
#   ./testing/clean-room/build-and-run.sh claude        # Claude + npm (published)
#   ./testing/clean-room/build-and-run.sh claude local   # Claude + local tarball
#   ./testing/clean-room/build-and-run.sh cursor         # Cursor + npm (published)
#   ./testing/clean-room/build-and-run.sh cursor local   # Cursor + local tarball

set -e

CLIENT="${1:-claude}"
MODE="${2:-npm}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ "$CLIENT" != "claude" && "$CLIENT" != "cursor" ]]; then
  echo "Usage: $0 <claude|cursor> [local]"
  exit 1
fi

if [[ "$MODE" != "npm" && "$MODE" != "local" ]]; then
  echo "Usage: $0 <claude|cursor> [local]"
  exit 1
fi

DOCKERFILE="$SCRIPT_DIR/Dockerfile.${CLIENT}-${MODE}"
IMAGE="gitmem-${CLIENT}-${MODE}"

if [[ ! -f "$DOCKERFILE" ]]; then
  echo "Error: $DOCKERFILE not found"
  exit 1
fi

echo "=== Clean Room: $CLIENT + $MODE ==="

# For local mode, build tarball first
if [[ "$MODE" == "local" ]]; then
  echo "--- Building local tarball ---"
  cd "$REPO_DIR"
  npm run build
  TARBALL=$(npm pack --pack-destination "$SCRIPT_DIR" 2>/dev/null | tail -1)
  mv "$SCRIPT_DIR/$TARBALL" "$SCRIPT_DIR/gitmem-mcp-local.tgz"
  echo "--- Tarball ready ---"
fi

echo "--- Building Docker image: $IMAGE ---"
docker build --no-cache -t "$IMAGE" -f "$DOCKERFILE" "$SCRIPT_DIR"

# Clean up tarball after build
if [[ "$MODE" == "local" && -f "$SCRIPT_DIR/gitmem-mcp-local.tgz" ]]; then
  rm "$SCRIPT_DIR/gitmem-mcp-local.tgz"
fi

echo "--- Running container ---"
docker run -it --rm \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  -e CURSOR_API_KEY="${CURSOR_API_KEY:-}" \
  "$IMAGE"

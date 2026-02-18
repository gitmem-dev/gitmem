#!/bin/bash
# Install agg (asciinema GIF generator) — pre-built binary, no compiler needed.
# Downloads to /tmp/agg. Supports aarch64 and x86_64 Linux.

set -e

VERSION="v1.7.0"
ARCH=$(uname -m)

case "$ARCH" in
  aarch64)  BIN="agg-aarch64-unknown-linux-gnu" ;;
  x86_64)   BIN="agg-x86_64-unknown-linux-gnu" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    echo "See https://github.com/asciinema/agg/releases for available binaries"
    exit 1
    ;;
esac

URL="https://github.com/asciinema/agg/releases/download/${VERSION}/${BIN}"
DEST="/tmp/agg"

echo "Downloading agg ${VERSION} for ${ARCH}..."
curl -L "$URL" -o "$DEST"
chmod +x "$DEST"

echo "Installed: $DEST"
"$DEST" --version

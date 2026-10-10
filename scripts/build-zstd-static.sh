#!/usr/bin/env bash
# Pinned zstd 1.5.7 source + Alpine 3.22.1 image digest, native musl Linux builds.
# Outputs only an isolated local cache; never publishes or modifies vendor/dist.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="${ZSTD_OUTPUT_DIR:-$PROJECT_DIR/.helper-release/local}"
CACHE_DIR="${ZSTD_CACHE_DIR:-$PROJECT_DIR/.helper-release/cache}"
TARGET="${1:-all}"
if [[ "$TARGET" == "windows-arm64" ]]; then
  shift
  exec bun "$SCRIPT_DIR/prepare-windows-arm64-helpers.ts" --output="$OUTPUT_DIR" "$@"
fi
build() {
  bun "$SCRIPT_DIR/prepare-helper-assets.ts" --tool=zstd --platform="linux-$1" \
    --output="$OUTPUT_DIR" --cache="$CACHE_DIR/linux-$1"
}
case "$TARGET" in
  x64|arm64) build "$TARGET" ;;
  all) build x64; build arm64 ;;
  *) printf '%s\n' "Usage: $0 [x64|arm64|all|windows-arm64]" >&2; exit 1 ;;
esac

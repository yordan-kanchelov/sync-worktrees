#!/usr/bin/env bash
#
# convert-to-gif.sh — turn demo-sync-worktrees.cast into the README GIF.
#
# Pipeline:
#   asciinema .cast  →  agg  →  raw GIF  →  gifsicle  →  optimized GIF
#
# Output: assets/sync-worktrees-demo-optimized.gif (overwrites existing).
# Target size: ≤500 KB.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CAST_IN="$SCRIPT_DIR/demo-sync-worktrees.cast"
GIF_RAW="$SCRIPT_DIR/demo-sync-worktrees.raw.gif"
GIF_OUT="$REPO_ROOT/assets/sync-worktrees-demo-optimized.gif"

if [[ ! -f "$CAST_IN" ]]; then
  echo "Missing $CAST_IN — run ./demo-recording/record-demo.sh first." >&2
  exit 1
fi

for tool in agg gifsicle; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool not installed. Run: brew install $tool" >&2
    exit 1
  fi
done

echo "→ agg: cast → raw gif"
agg "$CAST_IN" "$GIF_RAW" \
  --theme monokai \
  --font-size 14

echo "→ gifsicle: optimize"
gifsicle -O3 --colors 256 --lossy=30 -o "$GIF_OUT" "$GIF_RAW"

echo "→ cleaning intermediate raw gif"
rm -f "$GIF_RAW"

size_kb=$(($(stat -f%z "$GIF_OUT" 2>/dev/null || stat -c%s "$GIF_OUT") / 1024))
echo ""
echo "→ wrote $GIF_OUT (${size_kb} KB)"
if (( size_kb > 500 )); then
  echo "  WARNING: size exceeds 500 KB target. Consider re-recording shorter,"
  echo "  reducing terminal columns, or increasing --lossy."
fi

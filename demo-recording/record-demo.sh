#!/usr/bin/env bash
#
# record-demo.sh — clean state, run sync-worktrees TUI under asciinema.
#
# Run from any directory. Writes:
#   demo-recording/demo-sync-worktrees.cast   (asciinema raw recording)
#
# Then run convert-to-gif.sh to produce the optimized GIF.
#
# Prerequisites:
#   brew install asciinema agg gifsicle tmux
#
# The fixture downloads two small public repos (github/gitignore, octocat/Hello-World).
# Total fixture footprint on disk: ~5–10 MB.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CAST_OUT="$SCRIPT_DIR/demo-sync-worktrees.cast"
FIXTURE_DIR="$SCRIPT_DIR/fixture"

cd "$REPO_ROOT"

if [[ ! -f "dist/index.js" ]]; then
  echo "→ dist/ missing, building..."
  npx pnpm build
fi

echo "→ cleaning fixture state at $FIXTURE_DIR"
rm -rf "$FIXTURE_DIR" "$CAST_OUT"

if ! command -v asciinema >/dev/null 2>&1; then
  echo "asciinema not installed. Run: brew install asciinema" >&2
  exit 1
fi

cat <<'BANNER'

────────────────────────────────────────────────────────────────────
  Recording starts in 3 seconds. Once the TUI is up and the initial
  sync log shows two repos synced, press:

    w  →  Esc  →  o (type "fea", press Tab)  →  Esc  →  ?  →  Esc  →  q

  Aim for ≤30 seconds total. Press q to end the recording.
────────────────────────────────────────────────────────────────────

BANNER
sleep 3

asciinema rec \
  --quiet \
  --overwrite \
  --command "$SCRIPT_DIR/demo.sh" \
  "$CAST_OUT"

echo ""
echo "→ recording saved to $CAST_OUT"
echo "→ next: ./demo-recording/convert-to-gif.sh"

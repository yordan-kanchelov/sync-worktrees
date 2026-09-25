#!/usr/bin/env bash
#
# Renders the README/site demo from the tapes in this directory.
#
#   pnpm build && demo/render.sh                  # both themes
#   demo/render.sh demo/demo-light.tape           # one tape
#
# Needs vhs (https://github.com/charmbracelet/vhs), which in turn needs ttyd, ffmpeg and a Chromium; plus `tree`,
# and gifsicle to shrink the GIFs afterwards (skipped with a warning when missing).
# Uses the freshly built CLI from this checkout, not a globally installed one.
#
# Outputs (see the Output lines in the tapes): assets/demo-dark.gif, assets/demo-light.gif, and for the site
# assets/demo.mp4 plus its poster frame assets/demo-poster.webp (taken from the video by this script).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f dist/index.js ]]; then
  echo "dist/ is missing: run 'pnpm build' first" >&2
  exit 1
fi

BIN_DIR="$(mktemp -d)"
trap 'rm -rf "$BIN_DIR"' EXIT
ln -s "$ROOT/bin/sync-worktrees.js" "$BIN_DIR/sync-worktrees"
export PATH="$BIN_DIR:$PATH"

if [[ $# -eq 0 ]]; then
  set -- demo/demo.tape demo/demo-light.tape
fi

for tape in "$@"; do
  echo "rendering $tape"
  vhs "$tape"
  # The GIFs a tape wrote: its `Output <path>.gif` lines.
  while read -r gif; do
    if command -v gifsicle >/dev/null 2>&1; then
      # 128 colours and light lossy compression roughly halve the size; the text stays sharp.
      gifsicle --batch -O3 --colors 128 --lossy=20 "$gif"
    else
      echo "warning: gifsicle not found, $gif left unoptimised" >&2
    fi
    echo "$gif: $(du -h "$gif" | cut -f1)"
  done < <(sed -n 's/^Output \(.*\.gif\)$/\1/p' "$tape")
done

# The site video's poster is its last frame: the payoff screen, not an empty prompt.
if [[ -f assets/demo.mp4 ]]; then
  ffmpeg -v error -y -sseof -0.2 -i assets/demo.mp4 -frames:v 1 -update 1 -c:v libwebp -quality 85 assets/demo-poster.webp
  echo "assets/demo-poster.webp: $(du -h assets/demo-poster.webp | cut -f1)"
fi

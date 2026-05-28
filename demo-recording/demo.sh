#!/usr/bin/env bash
#
# demo.sh — launches the sync-worktrees TUI against the demo fixture config.
# Called by record-demo.sh during asciinema capture, or run standalone for dry runs.
#
# Keystroke sequence the recorder should perform (manually) once the TUI is up
# and the initial sync has populated worktrees (~5–10s after launch):
#
#   1. Wait for log stream to show repositories synced.
#   2. Press `w`        → worktree status view. Hold ~4s so flags are readable.
#   3. Press `Esc`      → back to log view.
#   4. Press `o`        → open wizard. Type "fea" to demonstrate live filter,
#                          then `Tab` to flip Terminal ↔ Editor mode. ~4s.
#   5. Press `Esc`      → close wizard.
#   6. Press `?`        → help modal. ~2s.
#   7. Press `Esc`      → close help.
#   8. Press `q`        → graceful quit.
#
# Total target: ≤ 30 seconds of recorded time.

set -euo pipefail

GREEN='\033[0;32m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="$SCRIPT_DIR/sync-worktrees.config.js"

clear
echo -e "${GREEN}🌳 sync-worktrees demo — launching TUI${NC}"
echo ""
sleep 1

# Prefer the built binary; fall back to ts-node dev runner if not built.
if [[ -f "$REPO_ROOT/dist/index.js" ]]; then
  node "$REPO_ROOT/dist/index.js" --config "$CONFIG"
else
  echo "dist/ not found — run 'pnpm build' first." >&2
  exit 1
fi

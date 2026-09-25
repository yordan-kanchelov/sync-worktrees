#!/usr/bin/env bash
#
# Simulates teammates pushing to the demo's "frontend" remote between two syncs:
# a new branch (feature/payments) appears and a merged one (feature/login) is deleted.
#
# Usage: demo/upstream-change.sh [DEMO_ROOT]    (default /tmp/demo; run demo/setup-fixture.sh first)

set -euo pipefail

DEMO_ROOT="${1:-${DEMO_ROOT:-/tmp/demo}}"
REMOTES="$DEMO_ROOT/remotes"
SCRATCH="$DEMO_ROOT/.seed-upstream"

if [[ ! -d "$REMOTES/frontend.git" ]]; then
  echo "no fixture at $DEMO_ROOT: run demo/setup-fixture.sh first" >&2
  exit 1
fi

export HOME="$DEMO_ROOT"
export TZ=UTC
export GIT_CONFIG_NOSYSTEM=1
unset GIT_CONFIG_GLOBAL XDG_CONFIG_HOME GIT_DIR GIT_WORK_TREE

TICK="$(cat "$DEMO_ROOT/.tick")"
commit() {
  TICK=$((TICK + 60))
  GIT_AUTHOR_DATE="@$TICK +0000" GIT_COMMITTER_DATE="@$TICK +0000" git commit --quiet -m "$1"
}

rm -rf "$SCRATCH"
git clone --quiet "$REMOTES/frontend.git" "$SCRATCH"
(
  cd "$SCRATCH"
  git checkout --quiet -b feature/payments origin/main
  mkdir -p src
  printf '%s\n' "export const Checkout = () => null;" >src/checkout.tsx
  git add src/checkout.tsx
  commit "Add checkout page"
  printf '%s\n' "// stripe" >>src/checkout.tsx
  git add src/checkout.tsx
  commit "Wire up payment provider"
  git push --quiet origin feature/payments
  git push --quiet origin --delete feature/login
)
rm -rf "$SCRATCH"
echo "$TICK" >"$DEMO_ROOT/.tick"

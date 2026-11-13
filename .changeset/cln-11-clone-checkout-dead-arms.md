---
"sync-worktrees": patch
---

Clone mode: switching the clone to a branch it has no local copy of now refuses before touching the checkout, instead of failing halfway with `cannot set up tracking information` and leaving the tree staged on the old branch. Unreachable branch-switch paths and an error message pointing to a non-existent "checkout" command were removed.

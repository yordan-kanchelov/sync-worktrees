---
"sync-worktrees": patch
---

Clone mode now honors the documented narrowing-safety check before it re-applies sparse-checkout patterns, and records a broken sparse config as a failure instead of a passing warning.

Two gaps, both only in clone mode — worktree mode has always done this:

- **A sparse config Git rejects no longer passes silently.** `Failed to reapply sparse-checkout for '<repo>'` was a bare warning; the sync outcome recorded nothing, so the run still reported the repository as synced and `--runOnce` exited 0. Every tick reprinted the warning and nothing watching the run ever learned. The failure is now recorded as a `sparse-checkout` action with reason `sparse_checkout_failed`, which reaches `counts.failed`, the run summary's `N failed`, the MCP `sync` result, and the exit code. It is still not fatal to the sync: the fetch and fast-forward that follow run exactly as before.

- **A narrowing sparse update is deferred while the checkout is dirty** (behaviour change). Previously clone mode called `sparse-checkout set` whenever the patterns differed. Git itself preserves modified, staged and untracked files that fall outside the new patterns, leaving them on disk and warning about it on its own stderr — which this tool captures and never prints, so the preservation was real but silent — so this was not data loss, but it did not match the narrowing-safety paragraph in the README, which promises the tool skips instead. Now, when the new pattern list drops a path that the current one included, the checkout is checked first and a dirty one is skipped with a `sparse_narrowing_unsafe` action in the outcome. The narrowing is only deferred: it applies on the first sync that finds the tree clean.

Scope of the clean check, stated plainly: clone mode reuses the same uncommitted-and-untracked-changes check that already gates its fast-forward, not worktree mode's fuller probe. Unpushed commits are a clone-mode skip of their own and their content is safe in the object store regardless; an in-progress operation is caught only insofar as it leaves the tree dirty, which in practice it does. Nothing here changes what Git does with files left outside the cone when a narrowing does go ahead.

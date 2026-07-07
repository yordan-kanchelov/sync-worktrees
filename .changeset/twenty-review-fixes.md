---
"sync-worktrees": patch
---

Fix 20 code-review findings across safety, CLI, MCP, and config subsystems (F1–F20 in REVIEW_FINDINGS.md): orphan cleanup can no longer delete a bare repo nested in worktreeDir; `filesToCopyOnBranchCreate` works again (patterns stay relative, absolute/escaping patterns rejected); default branches containing `/` are detected correctly; MCP `create_worktree`/`update_worktree` fetch before acting; runOnce exit codes no longer mask failures (SIGINT exits 130, per-repo `runOnce` rejected in favor of `defaults.runOnce`); diverged-replace preserves stashes; trash pin refs are namespaced per trash root; config validation rejects malformed `branchInclude`/`branchExclude`/`branchMaxAge`/parallelism values; `.cjs` configs hot-reload; plus assorted smaller fixes (retry classification, timing table, init wizard validation, LFS sampling, metadata guard, MCP registration probing).

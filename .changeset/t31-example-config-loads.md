---
"sync-worktrees": patch
---

`sync-worktrees.config.example.js` — the file README.md points at for "every knob" — loads again, and a new test loads the real shipped file through `ConfigLoaderService` so it cannot drift back.

It had stopped loading. The `experimental-features` entry still carried `runOnce: true`, which became a validation error once `runOnce` was restricted to `defaults`, so `buildRepositories()` on the example threw `Invalid configuration for 'Repository 'experimental-features' runOnce': cannot be set; use defaults.runOnce` — anyone who copied the reference file got that on their first run. No test loaded the file, so nothing caught it. The entry now explains that `runOnce` is a whole-file setting and points at `defaults.runOnce` and `--runOnce`.

The clone-mode section claimed the repository lock lives at `<configDir>/.sync-worktrees-state/<sanitized-name>-<hash>.lock`. It lives next to the checkout, at `<parent of worktreeDir>/.sync-worktrees-locks/<hash>.lock`, where the hash is the first 16 hex characters of sha256 over the symlink-resolved `worktreeDir`, relocatable with `SYNC_WORKTREES_LOCK_DIR` — what `src/utils/lock-path.ts` computes, and what README.md already described.

Two stale claims in the clone-mode section are corrected too: it listed five fields as conflicting with `mode: "clone"` and had never picked up `trash`, the sixth, so it told clone-mode readers a rejected key was fine; and the trash reaper is described as running at the tail of every sync attempt, failed ones included, which is what `WorktreeSyncService` does deliberately (only the periodic `git gc` is success-only). The new test pins both — the conflicting-field list against `CLONE_MODE_CONFLICTING_FIELDS`, and the defaults the example states in prose against `DEFAULT_CONFIG` — so neither can drift silently again.

Two knobs the README promises are now shown: `sparseCheckout.skipUpdateWhenOutsideSparse` (default true, cone mode only) and a worktree-mode `trash` block with all four fields and their defaults, noting that `trash` on a clone-mode repository — or under `defaults`, which every clone-mode entry inherits — is a validation error. `fetchTimeoutMs` and `cloneTimeoutMs` are shown as well, commented out under `defaults` with their defaults and the `0`-disables semantics, and set for real on the two repositories that illustrate them. The new test fails on any repository or `defaults` key the loader drops on the floor, so a knob that does not work cannot be documented as one.

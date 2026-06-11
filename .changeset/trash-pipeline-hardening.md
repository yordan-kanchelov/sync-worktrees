---
"sync-worktrees": patch
---

Harden trash/removal pipeline and clone-mode checkout against data loss:

- Legacy `.removed`/`.diverged` adoption now resets `deletedAt` to adoption time (original quarantine time preserved as `legacyQuarantinedAt`), so migrated backups can no longer be reaped in the same tick.
- Never-pushed commits are pinned: `diverged-replace` trashing and `.diverged` adoptions set `keepPinOnReap`, branch-bearing entries get an objects bundle before the branch ref is deleted, and pin/bundle failure aborts the removal (fail closed).
- Reaper no longer mass-sweeps `refs/sync-worktrees/trash/*` when the trash root is missing (e.g. unmounted volume); sweep requires a sentinel written at trash-root creation.
- Clone-mode `checkoutBranch` refuses to run from a detached HEAD and no longer double-reports the missing-ref skip; the TUI branch wizard opts out of the config-drift guard explicitly and warns to update `branch` in the config.
- Diverged recovery with trash disabled now deletes the stale local branch ref so the worktree is recreated from upstream, not from the stale local branch.
- Registered-but-missing worktree wedge heals via targeted `git worktree remove --force` plus metadata cleanup and an audit record.
- `restoreFromTrash()` is lock-coordinated (wait-queue) and reapplies sparse-checkout on restore; `getTrashService()` removed from the public surface.

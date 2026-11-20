# ADR-0007: Worktree status

- **Status:** Accepted
- **Date:** 2026-11-20
- **Source:** 100 code comments as of `5f17242`, moved here by [ADR-0001](./0001-record-decisions-in-adrs-not-comments.md)

## Context

Before sync-worktrees touches a worktree it decides whether doing so could lose work: uncommitted or untracked changes, stashes, unpushed commits, in-progress operations. The status service answers that question cheaply enough to run for every worktree on every sync.

## Decisions

Grouped by the file that implements them, source before tests. Each entry names the symbol it governs.

### `src/constants.ts`

- **GIT_CONSTANTS.SUBMODULE_STATUS_OUT_OF_SYNC**: git submodule status prefixes each line with ' ' (in sync), '-' (not initialized), '+' (checked-out commit differs from the superproject index) or 'U' (merge conflicts). Only '+' and 'U' mean the worktree holds submodule state that could be lost; '-' is what git worktree add always leaves because it never initializes submodules.

### `src/services/git-service.types.ts`

- **RegisteredWorktree.locked**: RegisteredWorktree carries git's lock flag because a locked worktree is one the user asked git to protect and git refuses to remove it even with a single --force, so callers treat it as off-limits rather than as a failed removal.
- **RegisteredWorktree.detached**: detached is set only for a worktree git lists with no branch checked out; getWorktrees omits such rows unless includeDetached asks, and their branch is the empty string because there is no ref to fetch, merge or fast-forward.

### `src/services/git.service.ts`

- **GitService constructor statusService**: maxStatusChecks is a ceiling on git processes, not worktrees: the status service shares one budget of that size across every worktree it checks, so the prune phase peaks at that many git processes however many stale worktrees a tick finds.

### `src/services/repository-operations.ts`

- **RepositoryOperations status probe fallback**: A worktree status probe that rejected answers nothing, so its flags read unknown and canRemove stays false, the same fail-closed shape WorktreeStatusService returns when its path probe cannot decide; the row renders from error, but other readers must not mistake could-not-look for nothing-here.
- **RepositoryOperations.getWorktreeStatusForRepo**: Status refresh bounds worktrees in flight with maxStatusChecks even though WorktreeStatusService already caps processes, because otherwise every worktree opens a snapshot (client and buffer) that waits on the process budget, so a 300-worktree repository holds 300 half-finished snapshots and no row finishes early.
- **RepositoryOperations.getWorktreeStatusForRepo**: The status view returns every worktree whether or not its probe succeeded, so it never shows fewer worktrees than exist without saying why, and one branch/remote-ref scan is shared across the whole refresh.

### `src/services/worktree-metadata.service.ts`

- **WorktreeMetadataService.recordRemoteTip**: recordRemoteTip stores the upstream tip observed during a sync, which later proves 'HEAD was fully pushed' after the remote branch is deleted; it must only be overwritten with a live observation, so callers must not call it once the upstream ref is gone.
- **WorktreeMetadataService.recordRemoteTip**: Missing metadata when recording a remote tip is logged at debug level, because recordRemoteTip runs every sync tick for every worktree and legacy worktrees without metadata would otherwise spam the log indefinitely.

### `src/services/worktree-mode-sync-runner.ts`

- **WorktreeModeSyncRunner.recordRemoteBranchTips**: Each worktree's upstream tip is persisted while the remote ref exists, as the proof consulted after a squash-merge deletes the branch that HEAD was on the remote; without it such worktrees read as having unpushed commits forever. Recording is best effort, so a failure only keeps that worktree conservatively preserved.
- **WorktreeModeSyncRunner.pruneOldWorktrees**: Worktree status is re-validated immediately before each removal to close the time-of-check/time-of-use window since the initial assessment.
- **WorktreeModeSyncRunner.assessPrune**: All prune status checks in one pass share a single branch/remote-ref scan (RefScanScope) instead of one per worktree; the re-check before each removal takes a fresh scan.

### `src/services/worktree-registry.service.ts`

- **WorktreeRegistryService.getWorktrees**: With includeDetached, getWorktrees still drops git's leading bare-repository row, which has neither a branch nor a detached HEAD and would otherwise surface as an empty-string branch a caller could fetch or merge. Prunable detached rows are dropped too because their checkout is gone; prunable branch-bearing rows are kept as the default listing always returned them.
- **WorktreeRegistryService.getWorktreeLock**: getWorktreeLock reports whether git holds a lock on a worktree's registration so callers leave it alone before moving anything. An unregistered path, a detached sibling or an unreadable listing all answer 'not locked', because the caller's removal reports the real problem and blocking on a failed listing would stop removals git would perform.
- **WorktreeRegistryService.getWorktreesFromBare**: The detached flag is set on registered worktrees only when true, so listings that exclude detached entries do not carry `detached: false` on every row.
- **WorktreeRegistryService.isRemovalRefusal**: `git worktree remove` refusals (dirty tree, a user-locked worktree, initialized submodules without --force) are git protecting user state, so they surface as a skip-shaped WorktreeNotCleanError rather than a hard failure. `-f -f` is never passed, because force-unlocking a deliberately locked worktree defeats the lock.
- **WorktreeRegistryService.removeWorktree**: Worktree removal is non-forced by default so git's refusal to delete a dirty worktree remains the last line of defense if status checks were wrong; --force is reserved for callers that already preserved the data or an explicit user override.

### `src/services/worktree-status.service.ts`

- **WorktreeStatusResult.fullyPushedUpstreamDeleted**: fullyPushedUpstreamDeleted is true when commits look unpushed only because the upstream ref was deleted (squash-merge plus branch deletion): metadata recorded the upstream tip while it existed, that ref is now gone, and HEAD is the recorded tip or an ancestor of it, so every local commit was on the remote at some point.
- **WorktreeStatusResult.divergence**: WorktreeStatusResult.divergence holds commits HEAD has that @{upstream} lacks and vice versa, and is null when there is no upstream ref to compare against.
- **parseModifiedSubmodulePath**: From `git submodule status`, only '+' (commit differs) and 'U' (conflicts) count as modified submodules; '-' (uninitialized) is the state every tool-created worktree starts in because `git worktree add` never initializes submodules, and counting it made such worktrees permanently unprunable. The path is everything after the object id minus the describe suffix, since submodule paths can contain spaces.
- **STASH_SUBJECT_BRANCH**: refs/stash lives in the common git dir, so `git stash list` shows every worktree's stashes; each entry is attributed to the worktree it was made in, otherwise one stash would block every prune and diverged replace. The branch is parsed from the 'WIP on <branch>:' or 'On <branch>:' reflog subject up to the first ':', which is exact because refnames cannot contain ':' or whitespace.
- **REF_SCAN_ARGS**: Branches and remote-tracking refs are read with one `for-each-ref` per repository, shareable across worktrees via RefScanScope since they live in the common git dir. %(upstream) prints the configured upstream ref whether or not it exists, which distinguishes a pruned upstream from none (rev-parse @{upstream} fails the same for both). Only names are read, since %(objecttype) would make one ref to a missing object fail the scan, and fields are NUL-separated because refnames cannot contain NUL or newline.
- **unbucketedTrackedPaths**: simple-git only buckets some porcelain codes: type changes and mixed states (e.g. 'MD', 'AD') appear only in status.files, so cleanliness also reads tracked paths from files that no bucket contains.
- **parseRefScan**: Symbolic refs such as refs/remotes/origin/HEAD are skipped when parsing the ref scan because they are aliases, not branches.
- **RefScanScope**: A RefScanScope shares one ref scan per repository across status snapshots in a single pass and is then discarded, because the scan is a point-in-time read; decisions that must see current refs, like the re-check before a removal, take a snapshot without one.
- **RefScanScope**: RefScanScope also shares one stash listing per repository, because refs/stash lives in the common git dir.
- **UpstreamState**: A status snapshot's upstream state is 'none' (no upstream or no branch), 'present' (ref exists), 'gone' (configured but ref missing) or 'unknown' (scan failed or does not know the branch).
- **WorktreeSnapshot.plainDetached**: Only a plain detached HEAD (no rebase or bisect in progress, and the operation probe answered) waives the unpushed-commits gate; a paused rebase also reads as detached but sits on the branch's own commits.
- **WorktreeSnapshot.recordedRefGone**: The recorded remote-tip ref counts as gone only when it is absent from a scan that saw remote-tracking refs; a scan with none at all may mean a failed fetch, so it fails closed.
- **WorktreeSnapshot.headPushedToRecordedTip**: headPushedToRecordedTip is null when there is no recorded tip, and false also covers probe errors (e.g. the recorded oid was garbage-collected), which must read as 'not proven'.
- **FullWorktreeStatusOptions.lastSyncCommit**: lastSyncCommit is HEAD as of the last sync; commits made since then count as unpushed in the status check.
- **WorktreeStatusService process budget**: One budget bounds every git process the status service spawns, shared across worktrees: a snapshot fans out to four commands and the prune phase runs maxStatusChecks snapshots in parallel, so without a shared ceiling the setting bounded worktrees, not processes. A slot is held around a single git command only, never around a helper that runs more, so the budget cannot wait on itself. Status clients have no inactivity timeout, so a hung command holds a shared slot.
- **WorktreeStatusService.checkWorktreeStatus**: checkWorktreeStatus only gates fast-forwards, which never touch a submodule's working tree, so it respects the repository's submodule.<name>.ignore; forcing --ignore-submodules=none would make worktrees with vendored build output permanently dirty and stop updating. Removal uses the stricter check in getFullWorktreeStatus.
- **WorktreeStatusService.checkWorktreeStatus**: status.not_added is already the untracked-and-not-ignored list, because git writes '??' only when no exclude rule matched and ignored paths appear on separate '!!' lines that simple-git puts in status.ignored; an integration test pins the behaviour.
- **WorktreeStatusService.getFullWorktreeStatus**: A failed filesystem probe of a worktree path (EMFILE/EINTR under load) is indistinguishable from a live worktree, so it is never reported as removable.
- **WorktreeStatusService.getFullWorktreeStatus**: Ahead/behind is read from the `git status -b` header, the same count as `rev-list --left-right --count HEAD...@{upstream}`, so no rev-list is spawned. It is reported only when the ref scan shows the upstream ref exists, because for a pruned upstream simple-git parses '[gone]' as a misleading 0/0. A ref pointing at a missing object still reads as 0/0, since detecting it would cost a per-worktree object read.
- **WorktreeStatusService.getFullWorktreeStatus**: Removal requires both unpushed checks to pass independently (no commits missing from every remote, and none since the last sync), since relying on lastSyncCommit alone hides unpushed work. Because lastSyncCommit moves only when the tool creates or fast-forwards the worktree, commits since sync are waived only once HEAD is on its existing upstream.
- **WorktreeStatusService.getFullWorktreeStatus**: The squash-merge 'unpushed' override applies only when the recorded upstream ref is verifiably gone and HEAD is an ancestor of the tip recorded while the ref existed.
- **WorktreeStatusService.getFullWorktreeStatus**: A detached-HEAD worktree is never auto-removed, because it may sit on commits unreachable from any ref and the tool manages only branch-tracking worktrees.
- **WorktreeStatusService.collectSnapshot**: A status snapshot runs only `status`, `submodule status` and the unpushed rev-lists per worktree, with `stash list` shared per repository; the branch and detached state come from the `status -b` header and upstream information from the repository-wide ref scan, so no `git branch`, `branch -r` or `rev-parse @{upstream}` runs per worktree.
- **WorktreeStatusService.collectSnapshot**: '## HEAD (no branch)' is the only header simple-git reports as detached, covering detached HEAD and rebase/bisect in progress. A failed status leaves the branch unknown, treated as not detached (which would waive the unpushed gate) and with no branch to probe, so it reports unpushed commits (fail closed).
- **WorktreeStatusService.collectSnapshot**: A rebase or bisect in progress reads as detached, but its HEAD is the branch being worked on, so it does not waive the unpushed gate; an unanswered operation probe counts as an operation in progress (fail closed).
- **WorktreeStatusService.collectSnapshot**: The unpushed-commit probes ask about HEAD, so they run both for a checked-out branch and for a detached HEAD in the middle of a rebase or bisect.
- **WorktreeStatusService.collectSnapshot**: The unpushed probe counts `HEAD --not --remotes` rather than using the short branch name, because git resolves a bare name through refs/tags before refs/heads; a tag sharing the branch's name would answer silently (exit 0 with an ambiguity warning) and could report zero local-only commits, letting prune remove the worktree.
- **WorktreeStatusService.collectSnapshot**: When status failed, or a rebase/bisect is in progress, the branch for stash attribution is unknown and every stash naming a branch counts; a plain detached HEAD uses null.
- **WorktreeStatusService.upstreamState**: The upstream is the full ref derived from branch.<b>.remote/merge, so a branch tracking a local branch is judged against refs/heads rather than remote-tracking refs, and a pruned upstream still has a name that can be found missing.
- **WorktreeStatusService.upstreamState**: With no ref scan, or a branch the scan has never seen (unborn or created since the scan), the upstream state is 'unknown'.
- **WorktreeStatusService.upstreamState**: A remote-tracking upstream is not called gone when the scan saw no remote-tracking refs at all, because that may be a failed fetch rather than a deletion (fail closed).
- **WorktreeStatusService.scanRefsFor**: The ref scan is shared through the RefScanScope keyed by common git dir, so worktrees of one repository share it and different repositories never do; without a scope or a readable common dir the snapshot scans on its own.
- **WorktreeStatusService.resolveCommonDir**: A linked worktree's git dir names the shared directory in its `commondir` file, relative to itself; a main worktree's git dir is itself the common dir.
- **WorktreeStatusService.describeUncommitted**: The uncommitted-changes skip reason names the paths when there are only a few, so a stray file can be told from real work at a glance, and keeps the 'uncommitted changes' prefix readers already expect.
- **WorktreeStatusService.describeUncommitted**: Tracked changed paths are deduplicated because a path staged as added and then modified appears in two simple-git lists but is one change.
- **WorktreeStatusService.buildStatusDetails**: In status details, type changes and mixed states that simple-git leaves unbucketed are listed as modified files.
- **WorktreeStatusService.detectOperationFile**: An operation-file probe that fails with anything but ENOENT is reported as unknown, so callers treat the worktree as having an operation in progress, since it may be hiding MERGE_HEAD or similar.
- **WorktreeStatusService.hasStashedChanges**: If checking stashes fails, hasStashedChanges returns true, conservatively treating the worktree as unsafe to delete.
- **WorktreeStatusService.readCurrentBranch**: readCurrentBranch returns the branch name, null for a plain detached HEAD, and undefined when unreadable or when a rebase or bisect is paused, since stashes made then name the branch.
- **WorktreeStatusService.countOwnStashes**: countOwnStashes counts the repository-wide stash entries belonging to one worktree; the branch argument is null for a detached HEAD and undefined when unreadable, in which case every stash naming a branch counts.
- **WorktreeStatusService.countOwnStashes**: A stash whose subject names a branch belongs to whichever worktree has that branch checked out, and to no other.
- **WorktreeStatusService.countOwnStashes**: A stash naming no branch (detached HEAD or custom `git stash store -m` subject) is counted for a worktree when its first parent is in that worktree's history, or whenever that cannot be established.

### `src/types/sync-metadata.ts`

- **SyncMetadata.lastKnownRemoteTip**: SyncMetadata.lastKnownRemoteTip records the last commit observed on the upstream ref while it existed and is deliberately never cleared, because git discards that fact when the remote branch is deleted (e.g. after a squash-merge) and it is the only proof HEAD was fully pushed.

### Tests

Why the tests that pin these decisions are built the way they are.

#### `src/__tests__/e2e/clone-mode.e2e.test.ts`

- **clone-mode dirty check**: simple-git puts a type change (` T`, e.g. a tracked file replaced by a symlink) in no status bucket, only in status.files, so the dirty check reads status.files; reading only the buckets treated it as clean and fast-forwarded over it.

#### `src/__tests__/integration/paused-rebase-unpushed.test.ts`

- **WorktreeStatusService.getFullWorktreeStatus**: During a paused rebase `git status -b` prints `## HEAD (no branch)`, which simple-git parses as a detached HEAD. The unpushed-commit gate is waived for a plain detached HEAD, but a paused rebase's HEAD carries the branch's own replayed commits, so it must still be checked for local-only commits.

#### `src/__tests__/integration/per-worktree-stash.test.ts`

- **WorktreeStatusService.hasStashedChanges**: refs/stash lives in the repository's common dir, so `git stash list` in any worktree lists stashes from every worktree. Stashes must be attributed to the worktree they were made in; counting the raw list made one stash block every prune and diverged replace and marked every worktree dirty.

#### `src/__tests__/integration/pushed-since-sync-removal.test.ts`

- **WorktreeStatusService unpushed check**: lastSyncCommit only moves when the tool creates or fast-forwards a worktree, so commits made and pushed from the worktree leave `lastSyncCommit..HEAD` non-zero forever. Commits already on the branch's own upstream must not count as unpushed or the worktree could never be pruned, while commits that only reached some other remote ref are still held back.
- **WorktreeStatusService unpushed check**: Without an upstream, `git status -b` prints no ahead/behind counts and simple-git reports ahead as 0, so only a present upstream may waive the since-last-sync unpushed check.

#### `src/__tests__/integration/status-probe-spawns.test.ts`

- **WorktreeStatusService**: Status probes minimise git spawns: refs/stash lives in the common git dir so one `stash list` answers for every worktree of a repository, the current branch is read without a `git branch -v -a` walk of every branch, and a rev-list with the same range is spawned once and memoized.

#### `src/__tests__/integration/uninitialized-submodule-prune.test.ts`

- **WorktreeStatusService submodule check**: `git worktree add` never initializes submodules, so every worktree of a repository with .gitmodules reports `-<oid> <path>` from `git submodule status`. That not-initialized marker must not be classified as modified submodules, otherwise clean, fully pushed worktrees could never be pruned.

#### `src/__tests__/integration/untracked-ignored-status.test.ts`

- **WorktreeStatusService.checkWorktreeStatus**: `git status --porcelain -u` never lists ignored paths as untracked, so simple-git's status.not_added is already the untracked-and-not-ignored list and no `git check-ignore` pass is needed. Such a pass also put every untracked path on one argv and failed with E2BIG past ARG_MAX, turning a dirty worktree into update_check_failed every tick.
- **WorktreeStatusService reasons**: When a worktree holds a very large number of untracked files, the status reason reports counts rather than joining every name, since tens of thousands of names do not belong in a log line.

#### `src/__tests__/integration/worktree-divergence.test.ts`

- **WorktreeStatusService divergence**: Worktree divergence is read from the ahead/behind header `git status -b` already prints and simple-git parses, instead of spawning a separate `rev-list --left-right --count HEAD...@{upstream}` per worktree. A worktree with nothing to compare against reports null, which every caller reads as cannot say; a fabricated 0/0 would read as in sync.
- **WorktreeStatusService upstream resolution**: A branch tracking a local branch (branch.<name>.remote = .) has a real upstream: git status -b prints ahead/behind for it even though git branch -r never lists it. Divergence and upstream-gone checks must not demand a remote-tracking upstream, or such branches would read as null or as gone.
- **RefScan upstreamGone**: upstreamGone is judged against the upstream git derives from branch.<b>.remote and branch.<b>.merge: a remote-tracking ref when the remote is a real remote, and a local branch when remote is `.`.
- **RefScanScope**: Status snapshots no longer spawn git branch, git branch -r or rev-parse @{upstream}; the branch and remote-ref listing runs once per repository when a pass over every worktree shares a RefScanScope, keeping per-tick cost low.
- **WorktreeStatusService**: A full status probe costs per worktree one status, one submodule status and one unpushed rev-list, plus one shared ref scan and one stash listing per pass when a RefScanScope is shared.

#### `src/components/__tests__/WorktreeStatusView.test.tsx`

- **WorktreeStatusView**: The 'could not be probed' count and the per-row 'status unknown' marker must use the same predicate. When the count used plain truthiness, it reported a worktree as unprobed while that worktree's row still rendered ordinary status flags.

#### `src/mcp/__tests__/worktree-summary.test.ts`

- **deriveLabel**: In the squash-merge case a branch's commits are absent from every remote but were proven fully pushed before the remote branch was deleted, so unpushed commits must not make the worktree dirty; it is labelled stale.

#### `src/services/__tests__/interactive-ui.status-fanout-and-disk.test.ts`

- **InteractiveUIOperations.getWorktreeStatusForRepo**: A worktree whose status probe rejected is reported in the list rather than dropped, because a silently shortened list looks complete; the test checks the whole list in order for that reason.

#### `src/services/__tests__/worktree-status.ambiguous-ref.test.ts`

- **WorktreeStatusService.getFullWorktreeStatus**: Cutting a branch from a same-named tag is a standard hotfix workflow, and git resolves a bare name through refs/tags/<name> before refs/heads/<name>, so rev-list --count <name> --not --remotes counted from the pushed tag and returned 0. Git only warns 'refname is ambiguous' on stderr with exit 0, which simple-git treats as success, so the status check uses the full refs/heads/<name> ref to avoid reading unpushed work as safe to prune.

#### `src/services/__tests__/worktree-status.process-budget.test.ts`

- **WorktreeStatusService.getFullWorktreeStatus**: A single worktree status snapshot runs status, the ref scan, stash list and submodule status concurrently when the process budget allows, a fan-out of four git commands.

#### `src/services/__tests__/worktree-status.service.test.ts`

- **WorktreeStatusService unpushed probe**: git resolves a bare name through refs/tags/<name> before refs/heads/<name>, so the rev-list --count <rev> --not --remotes unpushed probe must never name the branch by its bare name.
- **WorktreeStatusService.checkWorktreeStatus**: checkWorktreeStatus only decides whether to fast-forward, which never touches a submodule working tree, so it does not force --ignore-submodules=none; doing so would override a repo's submodule.<name>.ignore (the standard way to keep vendored output from dirtying the superproject) and stop that branch from ever updating. getFullWorktreeStatus, which gates removal, keeps the override.
- **WorktreeStatusService**: git status --porcelain -u never lists ignored paths: the ?? entries simple-git parses into not_added are by definition paths no exclude rule matched, and ignored paths appear only with --ignored. The service therefore treats not_added as the untracked-not-ignored list without running git check-ignore.
- **WorktreeStatusService skip reasons**: Uncommitted-change skip reasons name up to three paths so a stray file can be told from real work, and switch to counts beyond that to keep the reason one readable line. A path git lists twice (staged as added, then modified) counts as one change.
- **WorktreeStatusService submodule parsing**: git worktree add never initializes submodules, so git submodule status prints '-<oid> <path>' for every submodule of every worktree sync-worktrees creates. That not-initialized marker is not counted as a modification; counting it made canRemove permanently false, blocking pruning, sparse narrowing and leaving the TUI flag set forever.
- **WorktreeStatusService.getFullWorktreeStatus**: upstreamGone and the any-remote unpushed probe come from the same snapshot as every other status field: the branch comes from the status header, and what it tracks and whether that ref exists come from the repository-wide ref scan.
- **WorktreeStatusService.getFullWorktreeStatus**: A pruned upstream makes rev-parse <b>@{upstream} exit 128, so the upstream name never arrived; the ref scan names the configured upstream whether or not its ref exists. git status prints [gone] with 0/0 in that case, which is reported as upstream gone with no divergence, not as in sync.
- **WorktreeStatusService.getFullWorktreeStatus**: A branch with branch.<b>.remote = . tracks a local ref such as refs/heads/main, which no remote-tracking list will contain, so it is checked against local branches and not reported as upstream gone.
- **WorktreeStatusService.getFullWorktreeStatus**: When the ref scan sees no remote-tracking refs at all, that may be a failed fetch rather than deletions, so upstreams are not reported gone, failing closed instead of labelling every worktree stale.
- **WorktreeStatusService.getFullWorktreeStatus**: The branch, whether HEAD is detached, and what the branch tracks all come from the status header and shared ref scan, so the snapshot spawns no git branch, branch -r or rev-parse @{upstream} per worktree.
- **WorktreeStatusService.getFullWorktreeStatus**: When git status fails the branch is unknown: it is not treated as detached (which would waive the unpushed gate) and with no branch to probe it is treated as having unpushed commits, failing closed.
- **WorktreeStatusService.getFullWorktreeStatus**: git status -b prints '## HEAD (no branch)' during a paused rebase or bisect, so it reads as detached; but that HEAD carries the branch's own commits, so the unpushed gate is not waived as for a plain detached HEAD and the HEAD-based probes still run.
- **WorktreeStatusService.hasStashedChanges**: refs/stash is shared by every worktree of a repository, so the stash list includes other worktrees' stashes; only stashes attributable to the worktree being checked are counted.
- **WorktreeStatusService.hasStashedChanges**: A paused rebase or bisect detaches HEAD while stashes made before it name the branch being worked on, so hasStashedChanges counts every named stash while such an operation is in progress.
- **WorktreeStatusService.getFullWorktreeStatus**: Because git status -b reports a rebase as detached, the full status treats the branch as unknown while an operation is in progress rather than as a plain detached HEAD owning no named stash, so stashes naming the rebased branch still count.
- **WorktreeStatusService.getFullWorktreeStatus**: An age-based prune once removed a worktree with an unpushed commit. Every ambiguous or failed status probe must read as 'cannot verify, so cannot remove'.
- **WorktreeStatusService fullyPushedUpstreamDeleted**: After a squash merge and remote branch deletion, rev-list reports local commits as unpushed, but metadata recorded the upstream tip while the ref existed; HEAD being an ancestor of that recorded tip proves every local commit was pushed.
- **WorktreeStatusService fullyPushedUpstreamDeleted**: The recorded-remote-tip ancestry proof is consulted only after the upstream ref is gone, so no rev-list against the recorded tip is spawned while the upstream still exists.
- **RefScanScope**: refs/heads and refs/remotes live in the common git dir, so every worktree of a repository lists the same refs. RefScanScope shares one ref scan per repository, keyed by the common dir each worktree's .git file leads to.
- **RefScanScope**: Without a RefScanScope nothing is shared, so a check that must see refs as they are now, such as the re-check right before a removal, scans afresh.

#### `src/services/__tests__/worktree-status.unbucketed-changes.test.ts`

- **WorktreeStatusService dirty check**: simple-git has no bucket for type changes (' T', 'T ') or mixed states such as MD/AD; they appear only in status.files with every categorized array empty, so the dirty check also inspects status.files.

## Consequences

Changing code covered by an entry here means updating the entry in the same pull request. An entry that no longer holds is deleted, or superseded by a new numbered ADR when the reversal is itself a decision worth keeping.

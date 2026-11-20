# ADR-0002: Worktree-mode sync engine

- **Status:** Accepted
- **Date:** 2026-11-20
- **Source:** 213 code comments as of `5f17242`, moved here by [ADR-0001](./0001-record-decisions-in-adrs-not-comments.md)

## Context

Worktree mode keeps one bare repository per configured repo and a git worktree per remote branch. Each sync plans what to create, update, move aside or remove, then runs that plan against real working trees that may hold a person's uncommitted work. Most decisions here exist because a sync runs unattended on a schedule and must never lose local work, even when git, the network or the filesystem fails halfway.

## Decisions

Grouped by the file that implements them, source before tests. Each entry names the symbol it governs.

### `src/errors/index.ts`

- **UnpushedBranchLeftoverError**: UnpushedBranchLeftoverError marks a failed push whose rollback left the new local branch behind; the branch wizard's suffix retry must stop on it rather than discard the message naming the leftover branch.
- **WorktreeMetadataError**: When addWorktree creates a worktree but cannot record its metadata, it removes the worktree again rather than leave one sync cannot manage, and throws WorktreeMetadataError.
- **UpstreamSetupError**: UpstreamSetupError means git branch --set-upstream-to failed on a worktree addWorktree had just added; the worktree has already been rolled back (or rollbackSucceeded says why not), so callers must not retry the add through the tracking fallback.

### `src/index.ts`

- **runMultipleRepositories**: Each WorktreeSyncService gets a copy of its repository config so the loaded configuration stays as read for other holders, and services are not initialized at construction because sync() initializes under its lock and retry policy.

### `src/services/bare-repo.service.ts`

- **BareRepoService.dropClonedBranchCopies**: git clone --bare copies every remote branch into refs/heads, and the fetch refspec only updates refs/remotes/origin, so those copies freeze; a worktree added later could check out a stale tip whose rebased-away commits look like unpushed work. The copies are dropped right after the clone, before any worktree exists, keeping the branch HEAD points at. An existing bare repository is never touched, since its refs/heads may hold real local-only commits; the step is best-effort because addWorktree mitigates a leftover copy.
- **BareRepoService.detectDefaultBranch**: refs/remotes/origin/HEAD is only written by remote set-head, and fetch --prune leaves it pointing at an old name after the remote renames or deletes its default branch, so it is trusted only while its target is still a remote branch; otherwise the remote is asked again, then a common default name that exists is used. A read-only dry run asks with ls-remote --symref instead of remote set-head -a so the symref is not rewritten.
- **BareRepoService.listRemoteBranchNames**: listRemoteBranchNames returns null when the listing itself failed, which callers treat as unknown rather than as no branches.
- **BareRepoService.detectDefaultBranch**: When origin's HEAD symref is unavailable, common default branch names are probed but one is auto-picked only when exactly one exists, because a fixed priority could silently track the wrong branch (main when the remote's real default is master).

### `src/services/branch-ref.service.ts`

- **BranchRefService REMOTE_REF_PREFIX**: Every origin branch inventory listing reads the full %(refname) and strips the literal refs/remotes/origin/ prefix, never %(refname:short), because git's short form is ambiguity-dependent: it shortens refs/remotes/origin/feature/HEAD to origin/feature and prints remotes/origin/x when a local branch named origin/x exists. Either way the real branch would leave the inventory and its worktree would be pruned as stale.
- **BranchRefService ORIGIN_HEAD_REF**: The origin/HEAD symref written by git remote set-head is excluded from the branch inventory by its full refname only, because feature/HEAD is a legal branch name and an endsWith('/HEAD') test would drop a real branch and prune its worktree.
- **BranchRefService.readRemoteBranchTips**: Origin branch tips come from one for-each-ref over refs/remotes/origin rather than branch -v -r, which resolves and prints a commit subject per branch and walks the object database on every tick. The output shape is fixed by --format: full %(refname) instead of the ambiguity-dependent short form, no color escapes under color.ui=always, and a NUL field separator because a refname can contain neither NUL nor newline.
- **BranchRefService remote branch listing**: Branch listings use a NUL field delimiter because | is a legal branch-name character; a branch like feature|wip would corrupt a |-delimited line, be dropped from the inventory and have its worktree pruned as stale.
- **BranchRefService remote branch listing**: Branch names are derived by stripping the literal remote prefix from the full refname and never by filtering the stripped name, since branches literally named origin or feature/HEAD are real.
- **BranchRefService.trackRemoteBranchIfExists**: Sync never relies on a branch's upstream because its probes name origin/<branch> explicitly, but git pull, git status and ahead/behind views in the worktree do, so branches registered without tracking (trash restore, branch --no-track, the no-tracking add fallback) get one whenever origin/<branch> is known locally. It never throws: a missing remote branch is normal for unpushed work and a failed set leaves a working worktree, so failures are only logged.
- **BranchRefService.trackRemoteBranchIfExists**: Setting the upstream is a config-only operation, so it also works on a worktree added with --no-checkout.
- **BranchRefService.remoteBranchExists**: Remote branch existence is checked with a live ls-remote rather than refs/remotes, because remote-tracking refs are only as fresh as the last fetch and branchMaxAge/branchInclude/branchExclude often leave an origin branch with no local head, so git branch's collision check would miss it. A fully qualified pattern matches exactly one ref.
- **BranchRefService branch creation remote collision check**: A remote-only name collision reports the exact wording already exists, because the TUI retries with -1, -2 suffixes on that text, as for local collisions. A probe that cannot reach the remote is not fatal, since create_worktree without push works offline; the create-only lease in pushBranch is what guarantees an existing remote branch is never advanced.
- **BranchRefService.pushBranch**: New branches are pushed with --force-with-lease and an empty expected value, leasing the ref against does-not-exist, so an existing remote branch is never fast-forwarded or force-updated; a plain push would silently advance someone else's branch (and its PR or CI) whenever its tip is an ancestor of the base. git only enforces a lease on a ref the push would change, so a remote ref already at the same commit is up to date, exit 0, and -u still sets upstream (verified on git 2.43 for ancestor and diverged cases).

### `src/services/clone-sync.service.ts`

- **progress listeners**: Progress listener exceptions are caught and dropped at every emit site (ProgressEmitter and CloneSyncService): a faulty listener, such as the TUI, must never break a sync.

### `src/services/git-service.types.ts`

- **RegisteredWorktree.head**: head is the oid git worktree list --porcelain printed for the worktree's HEAD, resolved through the worktree's own HEAD symref, so it reflects detached or mid-operation checkouts the bare repo's refs cannot show, and it comes from the listing every sync already makes at no extra spawn. It is absent when git prints no HEAD line (prunable registration, the bare repo itself).
- **AddWorktreeResult**: addWorktree reports created with the new HEAD for callers to compare with origin/<branch>, or already_registered when the path was a registered worktree before the call, either registered first by a concurrent operation or a detached checkout someone left there that no sync owns.

### `src/services/git.service.ts`

- **GitService.initialize**: initialize only fetches when there are no remote-tracking refs yet (a fresh clone), because sync fetches right after and the TUI wizard and MCP fetch for themselves.
- **GitService.ensureMainWorktree**: ensureMainWorktree guarantees a registered worktree on the default branch and points mainWorktreePath at it, since every fetch runs there. A registration on the default branch at another path is adopted rather than duplicated, because it is the directory created while the branch was an ordinary remote branch and git refuses a second worktree on a checked-out branch.
- **GitService.ensureMainWorktree**: A default-branch registration whose directory was destroyed out-of-band would satisfy the check forever, since the planner never plans a create for the default branch and every sync would fail at fetch; only a definitive missing probe clears it, while an unverifiable probe keeps it, as in dropStaleRegistrations.
- **GitService.ensureMainWorktree**: If clearing a stale default-branch registration fails, for instance because it is locked and single --force refuses, the old state is left as is rather than guessed at.
- **GitService.ensureMainWorktree**: The default branch worktree is created through the normal addWorktree path; an unregistered directory already at its path (a checkout left after deleting .bare, or an unrelated directory) is moved to trash or quarantine first, never adopted, because fetches would otherwise run inside a non-repository.
- **GitService.openForPlanning**: openForPlanning is the dry run's initialize: the same bare-repo checks, fetch and default-branch resolution, without clone, refspec config, remote set-head or anchor worktree creation; the fetch is its only write. It returns missing when there is no bare repo, or ready with anchorMissing when reads must run in the bare repo, and is only for read-only services never used to sync.
- **GitService.openForPlanning**: The dry run's fetch runs in the bare repository because the anchor worktree may be missing (both name the same repository) and disables auto gc, since a dry run should not trigger repacking.
- **GitService.getMainWorktreePath**: The default branch's worktree is the directory every remote-facing command runs in: fetches, branch listings and tip probes.
- **GitService.ensureAnchorWorktree**: The anchor worktree is re-checked and rebuilt before each sync because long-lived processes (daemon, TUI, MCP) initialize once, and an anchor destroyed out-of-band otherwise made every later tick fail with spawn git ENOENT, which reads as git not installed.
- **GitService.ensureAnchorWorktree**: When the anchor path cannot be probed, ensureAnchorWorktree fails naming the directory rather than recreating a worktree that may still exist or spawning git in an unstatable path.
- **GitService.ensureAnchorWorktree**: ensureMainWorktree may settle on another registered checkout of the default branch, so the primary client is re-pointed as in initialize.
- **GitService.refreshDefaultBranch**: refreshDefaultBranch re-resolves the default from fetched refs and, if the remote renamed it, creates or adopts the new default's worktree and re-points fetches there before the caller can prune the old one. Nothing changes while origin still has the current default, and if no existing default can be resolved it throws so the sync fails before pruning, leaving the old worktree anchoring fetches.
- **GitService.refreshDefaultBranch**: If switching to a renamed default branch fails, the service keeps pointing at the old default's still-existing worktree so the next sync can retry the switch.
- **GitService.fetchAll**: The fetch start message is logged at debug because the sync runner already announces it as Step 1, and at info every sync printed it twice.
- **GitService.readWorktreeMetadataOwner**: Worktree naming reads which branch a metadata record under a directory name was written for, so a leftover record is never handed to another branch.
- **GitService.getAheadBehindCounts**: Ahead and behind counts come from one rev-list --left-right --count HEAD...refs/remotes/origin/<branch>, giving the whole update classification in one process. The remote ref is named explicitly, as updateWorktree merges, rather than read from @{upstream}, so branches without upstream are classified like any other; unrelated histories count on both sides and only a probe that could not run throws.
- **GitService.updateWorktree**: updateWorktree reports whether HEAD moved by comparing shas around the merge rather than trusting the earlier behind probe, since HEAD can reach the remote tip in between and merge --ff-only then succeeds with nothing to do; sync metadata is written only when HEAD moved. The branch is passed in because callers already hold it from git's registration listing, saving a spawn per updated worktree.
- **GitService.updateWorktree**: A fast-forward whose checkout dies partway, typically on an LFS smudge, leaves earlier paths written, so they are undone to avoid leaving the worktree permanently dirty.
- **GitService.wouldOverwriteIgnoredPaths**: Checking whether checking out origin/<branch> would overwrite ignored paths indexes the upstream tree once and answers each ignored path in constant time per segment, because comparing every ignored path against every upstream path is O(ignored x upstream) and runs synchronously under the repo lock, blocking the event loop for minutes on a monorepo.
- **GitService.wouldOverwriteIgnoredPaths**: The upstream path index includes every file and its ancestor directories, so membership means upstream has content at that path or beneath it.
- **GitService.wouldOverwriteIgnoredPaths**: The overwrite check also catches the reverse shadowing case, where upstream has a file or submodule exactly where an ignored path's parent directory sits.
- **GitService.resetToUpstream**: Ignored paths are listed with --directory so a wholly ignored directory such as a 150k-file node_modules costs one entry; directories that also hold tracked files are still expanded, so nothing is missed.

### `src/services/sync-cycle-scheduler.ts`

- **SyncCycleScheduler.runSyncServices**: The scheduler calls service.sync() without initializing the service first, because sync() performs initialization itself under the repository lock and its retry policy.
- **SyncCycleScheduler.runSyncServices**: Per-action skips inside a completed worktree sync are informational and reported on a separate partialSkips channel, so updateLastSyncTime still runs and the per-cycle log stays at info level.

### `src/services/sync-outcome.ts`

- **SyncOutcomeRecorder.restore**: Rolling the sync outcome back to a snapshot for a retry keeps the fact actions (created, removed, updated, preserved) recorded since the snapshot, because those changes already happened on disk.

### `src/services/sync-plan.ts`

- **SyncDryRunStep**: `sync --dry-run` steps are computed by the same pre-mutation assessments the sync itself runs and are never executed. They use the same reason codes the sync records in its outcome, so a plan and the following sync's outcome can be compared side by side.
- **SyncDryRunStep**: A dry-run 'create' step has reason new_branch when origin has a branch without a worktree, missing_directory when the worktree is registered but its directory is gone and will be rebuilt, and default_branch for the default branch's worktree, in which every fetch runs.
- **SyncDryRunStep**: A dry-run 'replace' step means the worktree diverged with local changes: it is preserved (in trash, or in `.diverged/` when trash is off) and recreated from origin/<branch>.
- **SyncDryRunStep**: A dry-run 'remove' step records separately why the worktree is unwanted (reason) and why removing it is safe (basis), the latter as the authorizing status check saw it.
- **SyncDryRunPlan.fetched**: SyncDryRunPlan.fetched says whether computing the plan fetched from origin, which updates only remote-tracking refs; it is false when there was no local repository to fetch into.
- **SyncDryRunPlan.notes**: SyncDryRunPlan.notes holds repository-level observations that are not steps: work a sync does before planning (unshallowing, narrowing a refspec) and places where the plan may differ from what the sync will actually do.

### `src/services/worktree-creation.service.ts`

- **WorktreeCreationService**: WorktreeCreationService owns the worktree add matrix, sparse setup, stale-registration recovery, the no-tracking fallback, the metadata record, and a shared rollback for failures after git registered the worktree. A directory in the way is moved to trash (when enabled) or quarantined, never deleted. It receives GitService's cached clients through the shared context.
- **WorktreeCreationService.addWorktree**: addWorktree resolves to the created worktree's HEAD, or to already_registered when the path was already a registered worktree (registered concurrently, or a leftover detached-HEAD checkout) and nothing was created. Callers that count creations must check status rather than assume a create happened.
- **WorktreeCreationService.addWorktree**: UpstreamSetupError and WorktreeMetadataError are rethrown without the tracking fallback, because they were already rolled back where they occurred and the fallback would silently accept a partial worktree.
- **WorktreeCreationService.claimWorktreePath**: claimWorktreePath returns already_registered when the path is a registered worktree and null once the path is free (nothing there, or the orphaned directory was trashed, quarantined or, when empty, removed). A failure to list worktrees is treated as 'nothing there' so the add reports the real problem, while a directory that could not be preserved stops the add.
- **WorktreeCreationService.recoverFromStaleRegistration**: When git refuses an add because the path is already registered, the worktree is adopted if a concurrent operation created it; otherwise the registration outlived its directory, so it is removed, the path cleared, and the add retried exactly once.
- **WorktreeCreationService.runWorktreeAddByMatrix**: When both local and remote branches exist, the local ref is usually a stale snapshot nothing fast-forwards, so local-only commits are counted before the add and the branch is fast-forwarded inside the new worktree afterwards. A branch reset such as `-B` is avoided so `worktree add` keeps its error surface for stale-registration recovery and the ref moves only once the worktree is ours. Commits not on origin are kept, since rebased-away history is indistinguishable from never-pushed work.
- **WorktreeCreationService.runWorktreeAddByMatrix**: `branch --set-upstream-to` is config-only and works on a --no-checkout worktree, so it runs before sparse setup and materialization.
- **WorktreeCreationService.runWorktreeAddByMatrix**: git creates refs/heads/<branch> before checkout and does not remove it when checkout fails (LFS smudge, full disk), which would turn later attempts into the local+remote case with an unfast-forwarded ref, so the branch is deleted after a failed `worktree add --track -b`; it can only be the one git just made because no local branch existed at the probe. The exception is an already-registered path, where addWorktree's recovery retries and adopts the existing ref.
- **WorktreeCreationService.countLocalOnlyCommits**: countLocalOnlyCommits counts local commits not reachable from origin/<branch>: zero means moving to the remote tip is a lossless fast-forward, and null when git cannot answer, which callers treat as possibly having local-only commits.
- **WorktreeCreationService.fastForwardNewWorktree**: A new worktree is fast-forwarded from the stale local tip to origin/<branch> with `merge --ff-only` when checked out, or with `reset --soft` for a --no-checkout worktree, whose later checkout populates files at the new tip. It is best effort: on failure the worktree stays at the local tip, which the next sync fast-forwards anyway.
- **WorktreeCreationService.deleteBranchLeftByFailedAdd**: Rolling back the branch left by a failed `worktree add --track -b` never throws, because the add's own error is what the caller must see, and an undeletable branch is only a stale ref.
- **WorktreeCreationService.deleteBranchLeftByFailedAdd**: The leftover branch is deleted only if it has no commits beyond origin/<branch>; anything ahead was written by someone else between probe and add, and a bare repository keeps no reflog to recover it.
- **WorktreeCreationService.rollbackPartialWorktree**: All failures after git registered a worktree (sparse setup, upstream setup, metadata) go through one rollback that removes the worktree and, if the same add created it, the branch. It never throws so the caller's error propagates, and it reports whether the worktree was really removed, which UpstreamSetupError carries.
- **WorktreeCreationService.createWorktreeMetadata**: Worktree metadata is keyed by directory name; if a record under that name belongs to another branch it is left alone and the add fails, since a worktree cannot be auto-managed on another branch's record.
- **WorktreeCreationService.createMetadataOrRollback**: A newly created worktree whose metadata cannot be written is removed again (with its branch if the same add created it) before the typed error propagates, because sync cannot auto-manage a worktree without metadata.
- **WorktreeCreationService.clearStaleWorktreeDirectory**: A stale directory at a worktree path is content sync did not create and cannot inspect (a .git may be a live checkout git failed to report, other files may be hand-placed), so without trash it is quarantined under .removed/ and never deleted; only an empty directory is removed.
- **WorktreeCreationService.clearStaleWorktreeDirectory**: A missing directory returns early from stale-directory clearing, because handing it to the trasher fails with ENOENT and would turn a recoverable stale registration into a permanent creation failure.
- **WorktreeCreationService.clearStaleWorktreeDirectory**: If a stale directory cannot be moved to trash, clearing is refused and worktree creation fails rather than silently deleting unknown content.
- **WorktreeCreationService.clearStaleWorktreeDirectory**: An empty stale directory is removed with a non-recursive rmdir, which refuses if something appeared since the listing; any refusal falls through to quarantine.
- **WorktreeCreationService stale directory handling**: A stale directory with no git checkout is removed with rmdir only if it is empty; if it is no longer empty or cannot be removed, it is quarantined (preserved) instead of deleted.
- **WorktreeCreationService.clearStaleWorktreeDirectory**: If quarantining a stale directory fails, clearing is refused and worktree creation fails instead of deleting anything, the same contract as the trash path.

### `src/services/worktree-metadata.service.ts`

- **WorktreeMetadataService.getWorktreeDirectoryName**: Worktree metadata is keyed by the worktree path's basename in a store sync-worktrees owns, not git's admin directories. Basenames are unique because PathResolutionService.branchDirectoryName checks a new directory name against every registered worktree's basename and every leftover record, and saveMetadata refuses to overwrite a record written for another upstream.
- **WorktreeMetadataService.readMetadataOwner**: readMetadataOwner returns the branch a valid metadata record was written for (upstream without `origin/`), or null. Because saveMetadata refuses to overwrite a record for another upstream, a directory name whose record belongs to another branch cannot be given to a new worktree.

### `src/services/worktree-mode-sync-runner.ts`

- **WorktreeModeSyncRunner**: Each worktree-mode sync phase is split into a read-only assessment and the mutations it requests; a sync runs both, while `sync --dry-run` (planSyncAttempt) runs only the assessments and reports their verdicts.
- **PruneAssessment**: A prune assessment is 'remove' when safe, 'keep-trash-disabled' when it is safe only because it was fully pushed, which requires trash to keep the removal reversible, and 'keep-unsafe' when the status check found local work.
- **WorktreeModeSyncRunner.runSyncAttempt**: The remote-refs-pruned flag is cleared per attempt rather than per sync, because retries call runSyncAttempt again and an attempt that fetched must not lend its answer to a later one that did not.
- **WorktreeModeSyncRunner.runSyncAttempt**: Origin's branch tips are listed once per attempt and shared by remote-tip recording and the update phase's 'nothing changed' test, since nothing fetches between them.
- **WorktreeModeSyncRunner.planSyncAttempt**: planSyncAttempt records every decision runSyncAttempt makes, using the same assessments, as plan steps; it expects a GitService opened with openForPlanning (already fetched) and never writes (no anchor heal, default-branch switch, worktree add/remove, tip recording or trash). Where a later phase depends on an earlier result it shows the earlier phase's intent, so a refused fast-forward or a re-checked removal can still end differently in a real sync.
- **WorktreeModeSyncRunner.collectInventory**: collectInventory gathers what both a sync and a dry run plan from: filtered origin branches, managed worktrees with external ones and stale registrations sorted out, and the pure plan. Default-branch resolution is injected because a sync may switch to a renamed default branch while a dry run only notes it.
- **WorktreeModeSyncRunner.collectInventory**: New worktrees get plain directory names unless another branch, a registered worktree, a leftover metadata record or an existing on-disk entry would share the name. External registrations count too, because metadata is keyed by directory basename wherever the worktree lives.
- **WorktreeModeSyncRunner.collectInventory**: The anchor worktree is removed from the prune plan whatever it has checked out, because every fetch runs in it.
- **WorktreeModeSyncRunner.assessAnchorBranch**: The anchor worktree is matched by path so a checkout there that left the default branch (detached or switched) is still adopted and reported; the planner never plans the default branch, so without the check it would silently fall behind.
- **WorktreeModeSyncRunner.assessAnchorBranch**: The default worktree listing used for the anchor check omits detached worktrees, so a detached anchor shows up as no entry rather than as a branch mismatch.
- **WorktreeModeSyncRunner.dropStaleRegistrations**: A registration whose directory is definitively gone is dropped from the inventory so the planner creates the worktree again instead of updating a nonexistent path. dropStaleRegistrations removes nothing: addWorktree's recovery clears the registration after re-checking prunability. Only branches the plan still wants are affected (removals stay with the prune pipeline), and only a definitive 'missing' probe counts, so no second worktree is built over one that still exists.
- **WorktreeModeSyncRunner.ensureFetchAnchor**: The default branch's worktree is the working directory for the fetch and all remote-facing reads, and the planner never creates it, so a directory deleted out-of-band is rebuilt at the start of every attempt; GitService.initialize also heals it, but a long-lived process initializes only once.
- **WorktreeModeSyncRunner.listRemoteBranches**: The default branch stays in the inventory even when name or age filters drop it, because every fetch runs in its worktree, but only while origin still has it; a renamed or deleted default would otherwise be a permanently failing update candidate that is never pruned.
- **WorktreeModeSyncRunner.resolveDefaultBranch**: A default branch missing from freshly fetched refs means the remote renamed or deleted it (fetch --prune never updates origin/HEAD). GitService re-resolves it and moves the fetch anchor to the new default's worktree first, so the old worktree can be pruned without breaking the next fetch; if no existing default can be resolved, the sync fails before pruning anything.
- **WorktreeModeSyncRunner.createNewWorktrees**: If a detached registration already sits at the target path (someone checked out a commit by hand), its branch looks new every tick; nothing was created, so the create phase records a detached_worktree skip instead of a creation.
- **WorktreeModeSyncRunner.createNewWorktrees**: A worktree created by the current call or registered first by a concurrent creator at the same path is recorded as created, since both leave the requested worktree in place; only actual creations get their tip verified.
- **WorktreeModeSyncRunner.verifyCreatedWorktreeTip**: addWorktree keeps the local tip when the bare repo's branch has commits origin does not reach; since the update phase was planned before creation, the mismatch is reported right after creation instead of a plain 'created'. It never fails the sync because the next sync's update rules own the worktree.
- **WorktreeModeSyncRunner.readRemoteBranchTips**: All origin tips are read with one `for-each-ref` on the bare repository, best effort: both consumers fall back to per-worktree probes, so a failed listing costs speed and a metadata record, never a sync.
- **WorktreeModeSyncRunner.pruneOldWorktrees**: If a previous removal moved the directory but left the registration, that one registration is cleared with a targeted `worktree remove --force` rather than retrying the trash (which would fail with ENOENT every tick). Global `worktree prune` is avoided because it would drop unrelated registrations on temporarily unavailable mounts; a locked registration still fails single --force and is preserved.
- **WorktreeModeSyncRunner.assessPrune**: assessPrune is the read-only half of the prune phase: one status check per candidate and the verdict the removal pass acts on. Locked worktrees come first in plan order, followed by every checked candidate in plan order.
- **WorktreeModeSyncRunner.assessPrune**: Locked prune candidates never reach the status probe, size scan or rename, because git refuses to remove them while locked and touching them would only waste work every tick.
- **WorktreeModeSyncRunner.assessPrune**: Failed prune status checks are mapped back to their worktree by allSettled index, because a git rejection carries the command and stderr but no working directory, and the log line and skip must name the worktree.
- **WorktreeModeSyncRunner.updateExistingWorktrees**: An update probe failure (status or ahead/behind) is recorded as a skip, not a hard failure: probes throw instead of answering 'no' so a failed spawn never reads as diverged, and the update is gated on success, so the worktree was never touched. The branch and path are logged at the call site because the git error omits the directory.
- **WorktreeModeSyncRunner.assessUpdates**: When the worktree's HEAD from the registration listing equals origin's tip from one for-each-ref, it is reported up to date without running git status or any per-worktree process, keeping idle ticks cheap. HEAD is used rather than the bare repo's branch ref so a checkout that moved off the branch is not missed. Both are snapshots: the comparison errs toward more work, except a HEAD moved away from the tip mid-attempt, which costs one tick of latency and mutates nothing.
- **WorktreeModeSyncRunner.assessUpdates**: One `rev-list --left-right --count` replaces the merge-base pair and behind probe with the same verdicts: no local commits means fast-forward, commits on both sides (including unrelated histories) mean diverged, only local commits mean unpushed work. It throws when it cannot run, so a spawn failure never sends a healthy worktree into diverged handling.
- **WorktreeModeSyncRunner.applyUpdates**: A worktree that was behind at assessment but had nothing to merge when the fast-forward ran (e.g. the user pulled in between) is recorded as already up to date rather than as an update.
- **WorktreeModeSyncRunner.handleDivergedBranch**: When the final safety check refuses a reset, a locked diverged worktree is skipped instead of moved aside, because git refuses to remove a locked worktree.
- **WorktreeModeSyncRunner.handleDivergedBranch**: Forced worktree removal is safe after the diverged directory has been moved to `.diverged/`, since only the stale registration remains to clear.
- **WorktreeModeSyncRunner.handleDivergedBranch**: Deleting the diverged local branch is deliberately fatal on failure, because the following addWorktree would otherwise silently recreate the worktree from the stale local branch instead of upstream.
- **WorktreeModeSyncRunner.assessDiverged**: Before resetting or moving a diverged worktree, divergence is re-confirmed with an ahead/behind probe that throws when it cannot answer, because the earlier classification ran a while ago under high concurrency. Anything not diverged is re-classified and left for the next sync; a throwing probe surfaces as diverged_recovery_failed.
- **WorktreeModeSyncRunner.assessDiverged**: A diverged worktree with local changes that is locked is reported as locked rather than replaced, because replacing moves the directory and git refuses that for a locked worktree.
- **WorktreeModeSyncRunner.recordNotDiverged**: If re-verification finds a worktree not diverged after all (HEAD moved, or the earlier probe misread), the runner records what the assessment would say for the current state and touches nothing; a worktree only behind is fast-forwarded on the next sync through the usual sparse-checkout gate.

### `src/services/worktree-sync-planner.ts`

- **WorktreeEntry.locked**: A locked worktree is never planned for prune, because git refuses to remove a locked worktree.
- **UpdateAction**: An update action carries the HEAD oid from the registration listing so the update phase can compare it with origin's tip and answer 'nothing changed' without spawning per-worktree processes; lock fields are carried so diverged handling never moves a locked worktree.
- **SyncPlanOptions.naming**: SyncPlanOptions.naming is what new worktree directory names are checked against; without it a context is built from the inventory's branches and registered worktrees alone, without looking at the disk.
- **planPruneActions**: A locked worktree missing from origin is planned as a deliberate skip rather than a prune candidate, because the user told git to protect it and probing and renaming it every tick would end in git's refusal anyway.

### `src/services/worktree-sync.service.ts`

- **WorktreeSyncService.sync**: The 'Synchronization finished' line is printed only if 'Starting' was printed, so a failed initialization prints neither.
- **WorktreeSyncService.sync**: Clone-mode sync receives the same phase timer as the worktree-mode runner so debug output prints one timing table format regardless of mode.
- **WorktreeSyncService.sync**: A repo-level sync_failed is recorded only when no failure outside sparse-checkout was already recorded, because sparse failures are caught and never what ends a sync.
- **WorktreeSyncService.planSync**: `sync --dry-run` runs on its own read-only GitService (optional locks off so even git status leaves indexes alone) and its own runner, so it cannot mark the service initialized. Its only write is the fetch, so the plan reflects origin now; it is taken under the repository lock so it never interleaves with a sync. A repository not on disk is planned as a clone without the lock or disk access.
- **WorktreeSyncService.planSync**: A dry run checks whether the repository exists before taking the lock, because taking it creates directories (the lock directory and the bare repository's directory) that a dry run of an uncloned repository must not create.

### Tests

Why the tests that pin these decisions are built the way they are.

#### `src/__tests__/e2e/bare-origin-mismatch.e2e.test.ts`

- **bare repository origin check**: The bare repo is located by bareRepoDir alone, so after a repoUrl change (org migration, fork swapped for upstream) an existing bare repo would silently keep fetching its old remote and branches only on the new remote never appear. Initialization fails naming both remotes, and the suggested `git remote set-url` is enough to converge.

#### `src/__tests__/e2e/run-once-single-fetch.e2e.test.ts`

- **run-once sync flow**: --run-once performs one fetch per run inside the retry policy, so an unreachable remote gets every retry attempt; calling initialize() and then sync() fetched twice, the first outside the retry policy.

#### `src/__tests__/e2e/stale-registration.e2e.test.ts`

- **stale worktree registration handling**: A worktree directory deleted out-of-band (rm -rf, failed backup restore, wiped volume) leaves git's registration behind; sync detects the stale (prunable) registration and rebuilds the worktree instead of treating the branch as present.

#### `src/__tests__/e2e/sync-dry-run.e2e.test.ts`

- **sync --dry-run**: `sync --dry-run` must name exactly what the next sync does, and the following sync must do exactly that, while leaving every worktree, branch, registration, config and trash entry byte-for-byte unchanged. The one documented write is the fetch, which moves remote-tracking refs and brings in objects; a second dry run with nothing new to fetch changes nothing at all.
- **GitService readOnly mode**: git status refreshes and rewrites a worktree's index when file mtimes change, so a read-only (dry-run) GitService runs git with GIT_OPTIONAL_LOCKS=0 to keep its status checks from modifying anything.
- **sync --dry-run**: A dry run of a repository that has not been cloned yet creates nothing on disk, not even the lock directory or the project directory that would hold it.

#### `src/__tests__/integration.test.ts`

- **WorktreeRegistryService remove**: Pruning a worktree runs `git worktree remove` without --force so git itself refuses to delete a worktree with local changes, as a last line of defence behind the sync's own safety checks.

#### `src/__tests__/integration/default-branch-anchor-state.test.ts`

- **default-branch anchor worktree**: The default branch's worktree is matched by path and the planner never plans the default branch, so a checkout at that path that is detached or on another branch was silently adopted while the default branch fell behind. The sync now records a skip (default_branch_detached / default_branch_mismatch) instead of a clean run.
- **WorktreeSyncService.initialize anchor adoption**: initialize() adopts the default-branch anchor worktree, so a fresh process must report a detached anchor just like a long-running one.
- **default-branch anchor worktree**: The default-branch anchor worktree is where every fetch runs, so it is never a prune candidate even when it is on a local branch origin does not have, unlike an ordinary worktree.
- **default-branch anchor worktree**: A dry run plans the same default_branch_mismatch skip as the sync and never plans removal of the anchor worktree.

#### `src/__tests__/integration/default-branch-rename.test.ts`

- **default branch resolution**: refs/remotes/origin/HEAD is only written by `remote set-head`, so after the remote renames its default branch and deletes the old one, `fetch --prune` drops origin/main while the symref still names main. Sync re-resolves the default after its fetch; keeping the stale default made its worktree an update candidate with a missing upstream (every sync failed with diverged_recovery_failed), never pruned it, and created the new default as an ordinary peer.
- **WorktreeSyncService default branch re-resolution**: In a long-running process initialize() is a no-op after the first call, so the sync itself re-resolves the default branch after its fetch prunes the old origin ref.

#### `src/__tests__/integration/detached-worktree-create.test.ts`

- **worktree sync create phase**: `git checkout <sha>` inside a managed worktree leaves it registered but detached; the sync inventory drops detached entries, so the branch looks new and the create phase targets a path that is already a worktree. The sync records a skip naming the path and leaves it untouched, instead of logging a fresh 'Created worktree' on every tick.

#### `src/__tests__/integration/foreign-upstream-worktree-update.test.ts`

- **worktree update phase**: The update phase decides 'behind' by comparing against origin/<branch> itself, not `<branch>@{upstream}`, because a user can point a branch's upstream elsewhere while the fast-forward merges origin/<branch>. The fast-forward reports whether HEAD actually moved, so a merge with nothing to do is recorded as already_up_to_date and leaves lastSyncCommit/lastSyncDate untouched.
- **SyncMetadata**: Of the sync metadata fields, lastSyncCommit and lastSyncDate record updates, while lastKnownRemoteTip is a live observation refreshed whenever the remote tip changes, so it is excluded when checking whether an update was recorded.
- **worktree update phase**: Updating a worktree does not touch the branch's configured upstream; a user's choice of branch.<name>.merge is left as is.
- **worktree update phase**: Even with the correct probe, HEAD can reach the remote tip between the behind-probe and the fast-forward (for example a `git pull` in the worktree), so the outcome is decided by whether the merge moved HEAD, recording already_up_to_date when it did not.

#### `src/__tests__/integration/head-branch-worktree.test.ts`

- **remote branch inventory**: git accepts branch names like 'feature/HEAD', and the only non-branch ref under refs/remotes/origin is the origin/HEAD symref, so the inventory excludes exactly that ref. Filtering with endsWith('/HEAD') dropped such branches: no worktree was created for them, and one created via the TUI or MCP read as stale and was trashed.

#### `src/__tests__/integration/lfs-smudge-worktree-create.test.ts`

- **worktree creation cleanup**: `git worktree add -b` creates the local branch ref before checking files out and keeps it when the checkout fails. The failed create must delete that ref, otherwise the next sync would add the worktree from the stale local ref instead of the remote branch.

#### `src/__tests__/integration/locked-worktree-diverged.test.ts`

- **diverged worktree handling**: A locked worktree whose branch diverged with local changes is left in place and reported as a worktree_locked skip, because git refuses to remove a locked worktree; moving it aside would strand a locked registration with trash off, or fail every tick with trash on.

#### `src/__tests__/integration/locked-worktree-prune.test.ts`

- **worktree prune pipeline**: `git worktree lock` is a user's signal to leave a directory alone, and git refuses `worktree remove` on a locked worktree even with a single --force. A locked worktree whose remote branch was deleted is therefore reported as a skip naming the lock before entering the prune pipeline; otherwise trash would rename it in and back every tick, or the refusal would surface as a failed sync with exit 1.

#### `src/__tests__/integration/missing-anchor-worktree.test.ts`

- **GitService.openForPlanning**: The default branch's worktree is the directory every remote-facing command runs in, and the planner never plans a create for that branch. Because GitService.initialize() only runs while the service is uninitialized, a long-lived process whose default worktree was deleted out-of-band would fail every later sync with a misleading `spawn git ENOENT`; the sync therefore re-checks and rebuilds the anchor worktree on every attempt.

#### `src/__tests__/integration/no-upstream-worktree-update.test.ts`

- **update phase behind count**: The update phase must not read a worktree's behind count through `<branch>@{upstream}`: that fails for a branch with no upstream configured (such as one made by MCP create_worktree with push:false and published without -u) and was taken as not behind, so the worktree never moved. Branches are compared against origin/<branch> instead.

#### `src/__tests__/integration/update-spawn-budget.test.ts`

- **update phase fast path**: The update phase compares the HEAD oid git prints in `worktree list --porcelain` against origin's tips from a single for-each-ref, so a worktree already at its tip costs no git process. Running status, merge-base and rev-list per worktree every tick made spawns grow with worktree count and held the repository lock long enough to skip scheduled ticks.
- **update phase fast path**: A steady sync tick where nothing changed costs a fixed handful of git processes regardless of worktree count: the fetch, the remote-branch listing, the worktree registration listing, and the tip listing the update phase compares against.

#### `src/__tests__/local-ahead-of-remote.test.ts`

- **update phase classification**: A worktree with commits of its own and none from the remote (ahead only) cannot fast-forward but is not diverged either, so it is skipped as having unpushed commits rather than moved aside or recreated.
- **update phase checks**: The update phase checks a worktree for uncommitted changes before spawning its ahead/behind probe, so a dirty worktree is skipped without the extra git process.

#### `src/__tests__/rebased-branch-handling.test.ts`

- **WorktreeModeSyncRunner.handleDivergedBranch**: The Phase 4a classification, or a refused fast-forward, can be stale by the time mutations run, so handleDivergedBranch re-verifies divergence with a throwing rev-list probe after the stash check and before it resets or moves anything; a failing probe aborts with diverged_recovery_failed.
- **diverged worktree handling**: rev-list counts every commit on each side when there is no common ancestor, so unrelated histories read as commits on both sides and are handled as genuinely diverged: the worktree is moved aside and recreated.

#### `src/mcp/__tests__/handlers.test.ts`

- **WorktreeModeSyncRunner**: The sync runner collects per-worktree failures with Promise.allSettled and records them on the outcome instead of rejecting sync().

#### `src/services/__tests__/branch-ref.remote-ref-inventory.test.ts`

- **GitService remote branch inventory**: The remote inventory listings decide which branches exist on origin, and a dropped name gets no worktree and its existing worktree is planned for prune. Names were lost because an endsWith /HEAD filter removed feature/HEAD along with the origin/HEAD symref, and because refname:short is ambiguity-dependent, printing remotes/origin/x when a local branch origin/x exists and shortening origin/feature/HEAD to origin/feature.
- **GitService remote branch inventory**: The origin/HEAD symref is the only ref under refs/remotes/origin that is not a branch, and the inventory must skip it.

#### `src/services/__tests__/git-update.test.ts`

- **GitService.getAheadBehindCounts**: Ahead/behind counts come from a single `git rev-list --left-right --count HEAD...refs/remotes/origin/<branch>` probe, with the branch supplied by the caller rather than read from `<branch>@{upstream}`. Worktrees whose branch has no upstream configured (trash restore, create_worktree with push:false, the no-tracking fallback) are therefore classified exactly like tracking ones, and no `git branch` call is needed to find the checked-out branch.
- **GitService.getAheadBehindCounts**: `git rev-list --left-right --count` does not fail on unrelated histories; every commit lands on one side or the other, so unrelated histories are reported as ahead and behind, which is the genuine diverged shape.
- **GitService.updateWorktree**: updateWorktree receives the branch name from the caller's registration and merges origin/<branch> with --ff-only, rather than spawning `git branch` to re-derive a name the caller already holds.

#### `src/services/__tests__/git.service.anchor-worktree.test.ts`

- **GitService.ensureAnchorWorktree**: The default branch's worktree anchors every remote-facing git command, so a long-lived process must re-check that it exists before each sync. initialize() heals it only once and isInitialized() never returns to false, so without the per-sync check an out-of-band `rm -rf worktrees/main` made every later fetch fail. The tests use real git with no mocks.

#### `src/services/__tests__/git.service.initialize.test.ts`

- **GitService.fetchAll**: Every fetch runs inside the main (default-branch) worktree, so a broken main worktree breaks every sync; a successful sync after recovery is the proof the main worktree was properly recreated.

#### `src/services/__tests__/git.service.test.ts`

- **BareRepoService.ensureBareRepository**: A freshly cloned bare repository's origin is the configured repoUrl by construction, so only an existing bare repository has its stored origin URL checked against the config.
- **GitService.initialize**: initialize fetches only when the bare repository has no remote-tracking refs yet, because sync() fetches immediately afterwards (and the TUI wizard and MCP fetch themselves); fetching in both places would double the network work.
- **GitService.refreshDefaultBranch**: Fetches run from the default branch's worktree. When the remote renames its default branch, the new default's worktree must be created or adopted and fetches re-pointed at it before the old one can be pruned; if that cannot be done the old worktree is left in place.
- **GitService.refreshDefaultBranch**: After fetch --prune drops the old default branch, origin/HEAD still names it until git remote set-head runs; the renamed-remote fixture models exactly that state, with set-head either reporting the new head or failing.
- **GitService.resetToUpstream**: git ls-files --directory collapses a wholly-ignored directory to a single entry with a trailing slash, so the reset safety check must treat such an entry as covering every upstream file beneath it.
- **GitService.wouldOverwriteIgnoredPaths**: Comparing every ignored path against every upstream path blocks the event loop for minutes at monorepo scale while the repo lock is held, so the ignored-path check must run in linear time and a test pins that shape.

#### `src/services/__tests__/worktree-creation.service.test.ts`

- **WorktreeCreationService.addWorktree**: A bare clone copies every remote branch into refs/heads/* and the fetch refspec never updates those copies, so a local ref without a worktree is a stale snapshot. When it is only behind origin/<branch>, the worktree is created from it and then fast-forwarded to origin's tip.
- **WorktreeCreationService.addWorktree**: When a stale local branch has commits not on origin/<branch>, they cannot be told apart from history rebased away on the remote, and only never-pushed work would be lost by a reset. The worktree keeps the local tip with the upstream set, and the log explains why it was not moved.
- **WorktreeCreationService.addWorktree**: A failed fast-forward after creating a worktree is not a failed create: the worktree stays at the local tip with a warning, and the next sync's update phase fast-forwards it.
- **WorktreeCreationService.addWorktree**: addWorktree reports the created worktree's HEAD because the sync runner compares it against origin/<branch> after each create.
- **WorktreeCreationService.recoverFromStaleRegistration**: Stale-registration recovery exists for registrations whose directory is gone; handing that missing path to the stale-directory trasher would fail with ENOENT and turn a self-healing case into a worktree that can never be rebuilt, so the trasher is skipped when the directory is absent.
- **WorktreeCreationService.claimWorktreePath**: A detached registration at the target path is reported apart from a plain already-registered result, so the runner records the skip instead of counting a creation that never happened on every tick.
- **WorktreeCreationService.createMetadataOrRollback**: Worktree metadata is keyed by directory name, and saveMetadata refuses a record there that belongs to another branch; a worktree must not continue without its own metadata, so creation rolls back.
- **WorktreeCreationService rollback**: Rollback after a failed create deletes the local branch only when the add created it (worktree add --track -b); a plain add that reused an existing branch leaves the branch alone.
- **WorktreeCreationService rollback**: When the plain-add fallback reused an existing branch and then fails, rollback removes the worktree but must not delete that pre-existing branch.

#### `src/services/__tests__/worktree-creation.stale-branch-copies.test.ts`

- **WorktreeCreationService.addWorktree**: git clone --bare copies every remote branch into refs/heads/* and the fetch refspec only updates refs/remotes/origin/*, so those copies stay frozen at clone time and a worktree created from one would read as behind or diverged on the next sync. A fresh clone therefore drops the non-default copies, a local ref that is only behind is moved to origin's tip when its worktree is created, and one with commits not on origin keeps its tip and the sync reports it.

#### `src/services/__tests__/worktree-metadata.legacy-fields.test.ts`

- **WorktreeMetadataService**: Older versions wrote createdFrom and syncHistory into every metadata record, and nothing reads them now. New records omit them, while old records carrying them must still load, validate and be rewritten unchanged.
- **WorktreeMetadataService.loadMetadataFromPath**: lastSyncCommit and lastKnownRemoteTip are the metadata fields the worktree removal safety checks read, so legacy records must preserve them exactly when loaded.

#### `src/services/__tests__/worktree-mode-sync-runner.detached-create.test.ts`

- **WorktreeModeSyncRunner create phase**: git worktree list reports a hand-checked-out worktree as detached and the sync inventory drops those, so the branch looks new every tick and the create phase targets an already-registered path. addWorktree creates nothing there, and the outcome and log must say the worktree was left alone rather than created again.
- **WorktreeModeSyncRunner create phase**: When a create finds the path already registered on the requested branch (a concurrent creator got there first), that worktree is the one the sync wanted, so it still counts as created.
- **WorktreeModeSyncRunner.verifyCreatedWorktreeTip**: The post-create comparison against origin runs only for worktrees the call actually created; an already-registered result checked nothing out, so there is nothing to compare.

#### `src/services/__tests__/worktree-mode-sync-runner.phase-timing.test.ts`

- **WorktreeModeSyncRunner phase timing**: In the --debug timing table every step of a worktree-mode attempt that costs time belongs to a phase row, so rows add up to the attempt. The test moves the clock by hand inside mocked git calls so each row's duration is exactly what its step spent.

#### `src/services/__tests__/worktree-mode-sync-runner.plan.test.ts`

- **WorktreeModeSyncRunner.planSyncAttempt**: planSyncAttempt is the worktree-mode half of sync --dry-run: every decision the sync would take, through the same assessments, with nothing that writes. Its tests use a GitService proxy that answers only allowed read-only calls and throws on anything else, so a mutation reintroduced into a shared assessment fails the test instead of touching a user's repository.

#### `src/services/__tests__/worktree-mode-sync-runner.progress.test.ts`

- **WorktreeModeSyncRunner progress events**: Each sync phase reports a count of the items it has finished, so a phase working through hundreds of branches shows movement instead of one static line; concurrent phases must still report a sequence that only moves forward.
- **WorktreeModeSyncRunner create phase progress**: Worktree creations run concurrently, so a count taken at dispatch would arrive out of order; the progress count is taken on completion instead.
- **WorktreeModeSyncRunner update phase progress**: The update phase settles worktrees whose HEAD already matches origin's tip without spawning git, but they still count toward progress: they are part of what the user waits on, and omitting them would give the count a total it could never reach.

#### `src/services/__tests__/worktree-naming.test.ts`

- **WorktreeMetadataService**: Worktree metadata is keyed by directory name, so worktrees under both the legacy hashed and the plain naming schemes each carry their own metadata record.

#### `src/services/__tests__/worktree-registry.service.test.ts`

- **WorktreeRegistryService.removeWorktree**: The removeWorktree safety tests pin two regressions: passing --force bypassed git's own refusal to delete dirty worktrees, and stale-directory cleanup could destroy a live checkout. Removal therefore runs without --force by default so git can refuse.
- **WorktreeRegistryService.removeWorktree**: git refuses to remove a user-locked worktree even with a single --force, and -f -f would defeat the lock, so that refusal is classified as WorktreeNotCleanError and surfaces as a skip rather than a hard failure on every tick.
- **WorktreeRegistryService.getWorktrees**: getWorktrees carries through the HEAD oid git prints for each worktree, because the update phase compares it against origin's tip to decide that nothing changed without a per-worktree probe.
- **WorktreeRegistryService.getWorktrees**: The locked flag from git worktree list is preserved in the listing because it is what keeps a user-protected worktree out of the prune pipeline entirely.
- **WorktreeRegistryService.getWorktrees**: getWorktrees({ includeDetached: true }) exists for callers that must find a worktree rather than act on its branch, such as MCP membership checks, which would otherwise report a registered detached path as not belonging to the repository.
- **WorktreeRegistryService.getWorktrees**: Even with includeDetached, the bare repository's own row is excluded because its branch would be the empty string and a caller fetching it would fetch origin/. Prunable detached rows are excluded too: their checkout is gone, and the service already treats prunable as absent.

#### `src/services/__tests__/worktree-sync-planner.test.ts`

- **planCreateActions**: The runner's naming context always knows about existing registrations, but the planner still checks resolved paths against registered worktrees of other branches as a backstop and skips colliding creates.
- **planPruneActions**: git worktree remove refuses a locked worktree, so the planner records a locked worktree as a deliberate skip instead of a prune candidate, avoiding a status probe and renames every tick that would only be refused.
- **planPruneActions**: The prune plan depends on the remote branch inventory; names that remote listing once lost (ending in /HEAD, containing '|', literally 'origin') were treated as unknown and trashed. Any branch present on the remote is never a prune candidate, whatever its name.

#### `src/services/__tests__/worktree-sync.service.test.ts`

- **WorktreeModeSyncRunner.verifyCreatedWorktreeTip**: addWorktree starts a worktree at origin/<branch> unless the local ref carries commits not on it, in which case it keeps that tip. Because the update phase is planned before creates, the runner checks each created HEAD against the remote tip itself and reports a mismatch instead of a plain 'created', without failing the sync.
- **WorktreeModeSyncRunner create phase**: A registration whose directory is gone must not count as the branch being checked out; the worktree is rebuilt in the same run. The registration is cleared by addWorktree's recovery, which re-asks git whether the entry is prunable, so a directory that reappeared is never force-removed on a stale probe.
- **WorktreeModeSyncRunner create phase**: When a registered worktree's directory cannot be verified (for example an unavailable mount), the registration is kept rather than building a second worktree over it.
- **WorktreeModeSyncRunner prune phase**: A status error names the git command, not the worktree it ran in, so the prune phase's error log and skip record carry the branch and path themselves.
- **WorktreeModeSyncRunner remote tip recording**: The last-known remote tip is never recorded for a branch whose remote ref is already gone, because that would overwrite the squash-merge proof with nothing.
- **RemovalAuditService**: The removal audit 'attempt' record is opened and flushed before the worktree is removed, so the record exists even if the data is gone afterwards.
- **WorktreeModeSyncRunner prune phase**: git refuses to remove a locked worktree, and one holding initialized submodules without --force; both refusals are classified as skips rather than generic failures so they do not set a non-zero exit code every tick.
- **WorktreeModeSyncRunner prune phase**: git worktree lock is a deliberate 'leave it alone' and pruning it can only end in git's refusal, so a locked worktree is skipped before any status probe or rename into .trash/.
- **WorktreeModeSyncRunner prune phase**: When a previous removal moved the directory away but left the registration, re-trashing the missing path would fail with ENOENT every tick. The registration is cleared with a targeted git worktree remove --force, not git worktree prune, which would also drop unrelated registrations whose directories sit on an unavailable mount.
- **WorktreeSyncService anchor heal**: Every remote-facing git command in a sync runs in the default branch's worktree, and the planner never plans a create for that branch, so the sync itself rebuilds that directory if it was deleted out-of-band, before the first git command and on every run.
- **WorktreeModeSyncRunner diverged handling**: Diverged handling removes the old worktree registration with force, which is safe because the directory has already been moved to .diverged/ before the remove.
- **WorktreeModeSyncRunner diverged handling**: With trash disabled there is no pin ref, so the keep ref is the only thing preserving never-pushed commits once the local branch is deleted; it must be created before the worktree leaves its original location.
- **WorktreeModeSyncRunner diverged handling**: During diverged replacement the stale local branch is deleted before addWorktree, otherwise the fresh worktree would be created from it instead of from upstream.
- **WorktreeModeSyncRunner diverged handling**: If the divergence re-verify probe cannot answer, the trash pipeline does not start: diverged-replace moves the directory, deletes the local branch and recreates the worktree from origin, which is reversible but not something to do to a worktree nobody has shown to be diverged.

#### `src/services/__tests__/worktree-update.test.ts`

- **WorktreeModeSyncRunner update assessment**: A failure that occurs only in the update-check probe is recorded as an update_check_failed skip, not a hard failure, so it does not poison the exit code. The skip names the branch and path, because the git error carries the command and stderr but not the directory, and a daemon with hundreds of worktrees could not otherwise locate the failure.
- **GitService.getAheadBehindCounts**: The ahead/behind probe names origin/<branch> explicitly, using the branch supplied by the sync runner, rather than relying on a configured upstream. A worktree whose branch has no upstream (after a trash restore or create_worktree with push:false) is therefore fast-forwarded like any other instead of passing as up to date.
- **GitService.getAheadBehindCounts**: getAheadBehindCounts throws when its rev-list cannot run (EMFILE, ENOMEM, fatal) instead of returning counts. Zero/zero would read as up to date and any invented pair could read as diverged, and diverged handling can move a healthy, fully pushed worktree to trash and recreate it.
- **WorktreeModeSyncRunner update mutations**: The update assessment phase can see origin/<branch> ahead of HEAD while, by the time the fast-forward runs, HEAD has already reached the remote tip. That outcome is recorded as already_up_to_date, not as an update, and no successful-update line is logged.
- **WorktreeModeSyncRunner update assessment**: A sync tick where nothing changed stays cheap because git's worktree registration listing already resolves every worktree's HEAD and one for-each-ref gives origin's tip for every branch; a worktree whose HEAD equals that tip is settled before any per-worktree git process runs.
- **WorktreeModeSyncRunner update assessment**: A worktree registration that git lists without a HEAD line, such as a prunable entry or an unborn branch, has nothing to compare against origin's tip, so it falls back to the per-worktree probes like any other.
- **WorktreeModeSyncRunner update assessment**: Skipping the per-worktree probes on the nothing-changed fast path must not skip the checks that cost no git process: an unfinished merge or rebase, and a worktree directory that cannot be reached, are still reported for a worktree at the remote tip.
- **WorktreeModeSyncRunner update assessment**: A worktree directory that is provably gone (ENOENT) is dropped from the inventory earlier in the sync and rebuilt as a create; what the update assessment still has to report is a path whose existence it cannot verify, such as an access error other than ENOENT.
- **WorktreeModeSyncRunner default branch retention**: The default branch is retained in the inventory only while origin still has it. Once the remote renames or deletes it, keeping it would leave its worktree a permanent failing update candidate that is never pruned, while the new default would be created as an ordinary hashed peer directory.

## Consequences

Changing code covered by an entry here means updating the entry in the same pull request. An entry that no longer holds is deleted, or superseded by a new numbered ADR when the reversal is itself a decision worth keeping.

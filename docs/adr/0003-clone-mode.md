# ADR-0003: Clone mode

- **Status:** Accepted
- **Date:** 2026-11-20
- **Source:** 258 code comments as of `5f17242`, moved here by [ADR-0001](./0001-record-decisions-in-adrs-not-comments.md)

## Context

Clone mode keeps one ordinary clone per repository and switches or fast-forwards its branches instead of materialising a worktree per branch. It deals with shallow and partial clones, narrowed fetch refspecs, interrupted bootstraps and repositories large enough that git stays silent for minutes. See also docs/internal/clone-mode-notes.md for the measurements behind several entries.

## Decisions

Grouped by the file that implements them, source before tests. Each entry names the symbol it governs.

### `src/components/BranchCreationWizard.tsx`

- **BranchCreationWizard**: The default branch only pre-selects and labels an entry in the branch list. In clone mode it is resolved from the remote when no branch is configured and that can fail, so the failure is ignored: a branch list that loaded fine must not be blanked, and no default marker beats a marker on the wrong branch.

### `src/constants.ts`

- **PATH_CONSTANTS.CLONE_INIT_PENDING_MARKER**: The clone-init pending marker is written as soon as the clone resolves, before any post-clone step, and removed once the initial file copy lands; its presence marks a tool-created clone whose initialization was interrupted and still owes the copy.
- **PATH_CONSTANTS.CLONE_INCOMPLETE_MARKER**: When a clone started by the tool fetched objects but failed to check out a working tree (git's 'Clone succeeded, but checkout failed'), the directory validates like a user's own clone. The incomplete marker is the only thing that tells the two apart, and while it exists initialize() refuses to adopt the clone.

### `src/mcp/context.ts`

- **findEnclosingCheckout**: The configured clone-root lookup runs wherever the walk would step over something, not only on a .git folder, because git clone --separate-git-dir leaves a .git file pointing elsewhere and an unreadable .git can still be the configured repository. The worktree shape is ruled out first so a real worktree pointer still answers as a worktree.

### `src/mcp/handlers.ts`

- **handleInitialize**: initialize reports success false whenever a skip was recorded, because a recorded skip means initialization refused to adopt the existing clone.

### `src/services/clone-sync.service.ts`

- **CloneSyncService**: Clone mode keeps one standalone clone per repository, held on one branch and fast-forwarded to origin every sync. CloneSyncService owns per-repository state (initialized flag, resolved branch, one-shot init skip) and the order of a sync tick, while the git work lives in the clone-sync modules; docs/internal/clone-mode-notes.md records the measurements and history behind those choices.
- **CloneSyncService.pendingInitSkip**: When init records a wrong-branch or unreadable-HEAD skip for an existing clone, it sets a one-shot token so the immediately following sync attempt in the same operation does not record the identical skip again; later ticks re-evaluate fresh.
- **CloneSyncService constructor readOnly**: A dry-run CloneSyncService is built with readOnly so its clients carry the read-only GitService environment, and only planSyncAttempt may be called on it.
- **CloneSyncService.readCloneTimeDefaultBranch**: The clone-time remote default branch is read from refs/remotes/origin/HEAD, which clone-bootstrap writes for clones it makes and git clone itself writes on older git; it is null when there is no clone or no such symref.
- **CloneSyncService.checkoutBranch**: After a clone branch switch, config drift is judged against what the config resolves to (configured branch, else the detected default), not against whatever branch an earlier switch left checked out.
- **CloneSyncService.runSyncAttempt**: phaseTimer is pure instrumentation and never changes tick behaviour. WorktreeSyncService.sync builds one PhaseTimer for every caller (CLI, MCP, TUI), shared with the worktree-mode runner so both modes print one table; debug gates only whether the table is printed. The parameter stays optional for direct callers such as tests or embedders, where every timed bracket is a plain call.
- **CloneSyncService.runSyncAttemptInternal**: If the clone's .git disappears out-of-band after init, the next sync tick runs init again so the repository is re-cloned.
- **CloneSyncService.runSyncAttemptInternal**: When init runs inside the tick it records any skip itself, so the one-shot pending init skip is cleared rather than used to suppress a duplicate.
- **CloneSyncService.runSyncAttemptInternal**: The validate phase covers everything before the first write (tracked branch, current branch, origin, primary-checkout guard). Each of its skips leaves the tick, so the phase is closed by timePhase's finally rather than on every return path, and a null result means the skip was already recorded.
- **CloneSyncService.runSyncAttemptInternal**: Every later step of a clone tick writes to the repository and ticks repeat, so the primary-checkout guard runs inside each tick, not only in initialize().
- **CloneSyncService.runSyncAttemptInternal**: The unshallow fetch uses the already-narrowed refspec, so a deleted tracked branch fails it exactly like the branch fetch; it is classified into the same soft skip instead of escaping as a hard failure that only shallow clones would hit.
- **CloneSyncService.runSyncAttemptInternal**: Remote configuration is timed as its own phase, separate from the fetch, because on the call that narrows the refspec it also sweeps stale remote-tracking refs, and a legacy all-branches clone has thousands of them.
- **CloneSyncService.runSyncAttemptInternal**: A clone tick classifies the branch relationship (a few ref reads) before running git status, which walks the whole working tree and is the only per-tick command that scales with checkout size; the common tick ends up_to_date with nothing written. A dirty clone already at origin/<branch> is therefore up to date, not skipped, and the fast-forward still reads the tree immediately before merging. The cost, a too-shallow clone spending its deepen budget even when dirty, is weighed in docs/internal/clone-mode-notes.md.
- **CloneSyncService.runSyncAttemptInternal**: Deepen fetches interleave with the classification reads they feed, so they are recorded as a count on the classify phase rather than as their own phase; PhaseTimer tracks one open phase, so a nested phase would close classify and lose the surrounding reads.
- **CloneSyncService.runSyncAttemptInternal**: HEAD is read before the fast-forward merge rather than derived afterwards, because the post-failure cleanup runs only on a commit that provably did not move, and an unreadable HEAD must not count as that proof.
- **CloneSyncService.planSyncAttempt**: sync --dry-run for a clone reports the tick's decisions as plan steps: same preconditions, fetch, classification and working-tree check. It fetches the tracked branch exactly as the tick would but writes nothing else (no clone, unshallow, refspec narrowing, deepening, sparse reapply or merge), noting where the tick would do one first; a destination init would refuse fails the plan too.
- **CloneSyncService.planSyncAttempt**: When a clone is too shallow to classify and deepen budget remains, the dry run does not spend it as the tick would, so the plan step explicitly says what was not simulated, since the outcome wording for that skip assumes the budget is spent or empty.
- **CloneSyncService.checkTickPreconditions**: A clone tick's pre-write checks (HEAD readable, on the tracked branch, origin matching repoUrl) return a skip instead of recording it, so the dry run can report the same skip.
- **CloneSyncService.checkTickPreconditions**: The clone's origin is re-checked every tick, not just at init, because the daemon reuses the service and a clone whose origin no longer matches repoUrl must keep being skipped rather than fetching from the wrong remote.
- **CloneSyncService.createContext**: The CloneSyncContext handed to the clone-sync modules exposes every member as a getter so they always see the service's current logger and outcome accumulator.

### `src/services/clone-sync/branch-operations.ts`

- **switchCloneBranch**: switchCloneBranch implements the clone-mode branch switch behind CloneSyncService.checkoutBranch, from the origin check to the final remote narrowing. Its only caller is the TUI wizard right after createAndPushCloneBranch created the branch locally, and the caller records the new branch as tracked once it returns.
- **switchCloneBranch**: A clone branch switch refuses a detached HEAD, because git switch only warns about leaving commits behind and the restore path cannot return to HEAD, which would strand commits in the reflog.
- **switchCloneBranch**: switchCloneBranch performs no writes before acquiring mutating clients, which refuse a linked worktree or submodule, so no mutation can reach the repository that actually owns the directory's git dir.
- **switchCloneBranch**: A clone branch switch converges shallow state the way a sync tick does: with no configured depth, an existing shallow clone is unshallowed before the branch fetch so the new branch is not left shallow while the rest is full.
- **switchCloneBranch**: A deleted tracked branch makes the narrowed-refspec unshallow fail with the same error as the branch fetch, so it is classified the same way, as a missing origin branch.
- **switchCloneBranch**: During a clone branch switch the branch already exists locally, so the fetch's --depth can re-cut or deepen the clone rather than merely bound a new ref; buildUntrackedBranchFetchArgs accounts for that.
- **switchCloneBranch**: After the branch fetch the switch verifies origin/<branch> exists, as the sync tick does, because a fetch can succeed without materializing the ref, which would otherwise surface later as a misleading FastForwardError.
- **switchCloneBranch**: The clone branch switch uses the same relationship classification and deepening budget a sync tick spends, asked about refs/heads/<branch> because the switch has not happened yet, so a shallow clone whose remote moved further than depth is deepened rather than refused.
- **switchCloneBranch**: When the relationship of the two histories could not be established, the switch throws a generic GitOperationError rather than a FastForwardError, because telling the user it cannot fast-forward would be wrong for a branch that may well be fast-forwardable.
- **switchCloneBranch**: A rejected fast-forward during a branch switch leaves the same half-applied checkout as a sync's; it is reported loudly, but the stray files are undone first because they would otherwise wedge every later tick with dirty_tree and git switch back would have to carry them.
- **warnConfigDriftAfterCheckout**: After a clone branch switch, resolvedBranch keeps in-session syncs on the new branch, but the config file still names the old one, so the next process start would soft-skip with branch_mismatch every tick until the config is updated; the user is warned about this drift.
- **createAndPushCloneBranch**: In clone mode there is no bare repository, so the TUI wizard's new branch is created and published from the clone itself, the only place that can later check it out. Publishing transfers no objects because the branch points at origin/<baseBranch>'s tip, so shallow and sparse clones work like full ones; the caller then calls checkoutBranch, where the tree switches and shallow state converges.
- **createAndPushCloneBranch**: createAndPushCloneBranch refuses a dirty working tree before anything reaches the remote, because checkoutBranch would later refuse it and leave a published branch the user cannot switch to.
- **createAndPushCloneBranch**: createAndPushCloneBranch refuses a detached HEAD before publishing, since checkoutBranch refuses one and the remote would be left with a branch the switch cannot move to.
- **createAndPushCloneBranch**: Both local and remote collision checks report already exists, the wording on which the TUI retries with -1, -2 suffixes as worktree mode does. The remote is asked as well because a single-branch clone's refs cannot answer for a name someone else pushed, and a plain push would fast-forward such a branch when it is an ancestor of the base.
- **createAndPushCloneBranch**: createAndPushCloneBranch acquires mutating clients, which refuse a linked worktree or submodule, before the base-branch fetch, so no refs land in the repository that actually owns the directory's git dir.
- **createAndPushCloneBranch**: A single-branch clone often lacks origin/<baseBranch>, or holds a stale copy, so the base is fetched with the same narrowed refspec and shallow depth an initial clone would use, starting the branch at the chosen tip without its full history. When the base is the tracked branch, --depth can re-cut or deepen held history. The stray origin/<baseBranch> ref is dropped as soon as the new branch holds its tip.
- **createAndPushCloneBranch**: The origin/<baseBranch> ref added to a single-branch clone is dropped immediately rather than by a later sweep, since the new local branch holds that tip and every exit path then leaves only the expected remote-tracking ref. The ref to keep is the tracked branch's, which the refspec maintains, not the checked-out one; on a hand-switched clone guarding only on the checkout would delete origin/<tracked>.
- **createAndPushCloneBranch**: The clone branch push uses --force-with-lease with an empty expected value, git's create-only push, which closes the window between the ls-remote check and the push and can never force-update; an existing ref is rejected with stale info.
- **assertCloneDirectoryPresent**: A missing clone directory is reported explicitly before building clients, because simple-git's constructor rejects it with a message that names neither the repository nor a remedy.
- **remoteBranchExists**: The clone-mode remote branch probe uses a fully qualified ls-remote pattern so it matches exactly refs/heads/<branch> and nothing that merely starts with it.
- **rollbackCreatedBranch**: When the push of a newly created clone branch fails, the local branch is rolled back so the wizard's retry with the same name does not collide with the leftover. The delete is a compare-and-swap on the creation commit, leaving a ref something else moved, and a leftover that could not be removed is named in the error.
- **createAndPushCloneBranch error handling**: A stale info rejection from the create-only lease means the ref appeared between ls-remote and push, so it is phrased as an already-exists collision, which also sends the TUI round again with a suffixed name.
- **describeBranchCreateFailure**: A ref conflict is reported as already exists only when a suffix can resolve it; when feat exists every feat/sub-N is blocked too, so a hierarchy conflict is not reported as retryable.

### `src/services/clone-sync/clone-bootstrap.ts`

- **initializeClone**: Clone init either adopts an existing clone after validating it or clones into an absent or empty directory and runs the post-clone steps. It returns the skip recorded for an existing clone that cannot be synced as configured, so the caller can stop the following tick from recording the same skip again.
- **inspectCloneDestination**: Clone init's destination checks are read-only and shared with sync --dry-run: they throw where init would refuse the destination and otherwise report what init would do with it.
- **adoptExistingClone**: An existing clone directory is first checked for the incomplete-clone marker so an unfinished clone of ours is never adopted. That check precedes validateExistingClone because validation answers with soft skips, and a wrong branch or changed origin would return early and hide the real problem.
- **adoptExistingClone**: validateExistingClone only reads; adopting a directory (narrowing its refspec, deleting stale remote-tracking refs) is the first write, so a non-primary checkout is refused at that point.
- **adoptExistingClone**: On adoption the refspec configuration always sweeps stale remote-tracking refs, even when the refspec already reads narrow, because a clone made by someone else or by an older version of the tool may still hold stale refs. It runs once per process, not every tick.
- **adoptExistingClone**: A pending init marker means an init of ours was interrupted after the clone, so the post-clone steps run again, including idempotent sparse setup. The marker is written before every post-clone step, refspec narrowing included, because a failure before a later-written marker would silently drop the file copy forever. Pre-existing user clones never carry the marker and are left alone.
- **recordCloneTimeDefaultBranch**: With no branch configured, resolveBranch reads the clone-time default from refs/remotes/origin/HEAD on every start. git clone --single-branch --branch used to write that symref, but newer git (seen on 2.56) omits it and a later fetch would fill in the remote's then-current HEAD, so the tool writes it for clones it makes.
- **cloneFresh**: The clone failure outcome carries the credential hint because it is what the MCP sync result and run summary display; the thrown error receives the hint separately at the WorktreeSyncService funnel.
- **cloneFresh**: Once the clone is on disk any later step can fail and leave a valid-looking clone the next init adopts, which runs the file copy only for a clone carrying the pending marker. The marker is written first, before refspec narrowing and everything else, shrinking the unprotected window to a single file write rather than the git subprocesses narrowing spawns.
- **cloneFresh**: The created outcome is recorded only once init is fully complete, so an aborted post-clone step does not leave the outcome reporting both created and failed.
- **settleFailedClone**: A failed clone is settled by its shape. A clone that never wrote HEAD is rubbish that maybeCleanupPartialClone removes when we created the directory. A clone that fetched everything but failed to check out (exit 128, usually a missing LFS object) leaves a complete `.git` beside a half-written tree that validateExistingClone would accept, so the checkout is retried in place (the destination was verified absent or empty before cloning, so everything under it is ours) and, when that fails, the directory is marked ours-and-unfinished so the next init refuses to adopt it instead of reporting `dirty_tree` forever. The marker is written only after `git clone` returns; see the comment-debt issue for killed checkouts.
- **settleFailedClone**: The incomplete-clone marker is written before the checkout retry, never after, so a process killed during the retry still leaves a directory the next run refuses to adopt.
- **retryCheckoutWithLfsSkipped**: checkout -f HEAD during the clone checkout retry is a write, so it goes through the primary-checkout guard like every other write, even for a directory init just cloned into.

### `src/services/clone-sync/clone-markers.ts`

- **clone-markers**: Clone init keeps its three markers inside the clone's .git rather than the working tree, where they would appear as untracked files in every status. The init marker records that the initial file copy ran and is never removed; the init pending marker flags a clone whose post-clone steps have not finished so the next adopting init reruns them; the incomplete-clone marker flags a clone whose checkout never finished so the next init refuses to adopt it.
- **writeIncompleteCloneMarker**: Writing the incomplete-clone marker is best-effort, like the init pending marker; if it fails, the next run simply adopts the unfinished clone as it did before the marker existed.
- **clearIncompleteCloneMarker**: Failing to remove the incomplete-clone marker from a repaired clone is only logged, because the leftover costs a hard error on the next run that names the file and how to remove it.
- **readIncompleteCloneMarker**: The incomplete-clone marker is read rather than probed because its second line is the failure the refusal quotes. The read has three answers: only ENOENT or ENOTDIR prove absence, while EACCES, EIO or an EISDIR marker leave it open and the caller fails closed, because the marker is the only thing distinguishing our unfinished clone from a user's clone.
- **assertPreviousCloneCompleted**: A clone this tool started but could not finish is never adopted, since its tree was never fully written and every sync would soft-skip with dirty_tree at info level and exit 0. The refusal is a GitOperationError rather than a ConfigError because the configuration is fine and the remedy is on disk, matching the error init throws when it cannot inspect the destination.
- **clone init markers**: When the final init marker exists, failing to remove a leftover pending marker is ignored: a stale pending marker is harmless because the final marker wins.

### `src/services/clone-sync/fast-forward-undo.ts`

- **undoRejectedFastForward**: A merge --ff-only that git rejects can leave a half-applied checkout (paths sorting before the unwritable one updated while index and HEAD stay old), which makes every later tick soft-skip with dirty_tree and blocks even a fixed LFS server, so the half-applied checkout is undone. Safety comes from per-path proof against origin/<branch>, not from an earlier clean check: a present path is removed or restored only if it matches origin's version, a missing path is restored only if origin does not hold it, and anything else is left alone. It is deliberately not limited to checkout failures, because an index.lock failure with someone's concurrent edits is decided by the same per-path proof.
- **undoRejectedFastForwardIn**: undoRejectedFastForwardIn provides the same undo for a checkout that is not clone mode's primary checkout, such as a linked worktree, so it does not require the MutatingGitClients brand.
- **undoRejectedFastForwardIn**: The rejected fast-forward undo fails closed without both a before and an after commit, since only they prove the merge left HEAD alone; a merge that moved HEAD wrote its files on purpose and undoing them would delete the update.
- **undoRejectedFastForwardIn**: Only paths the merge would have written are candidates for the undo; a dirty path outside that set is someone's own work and is never touched.
- **undoRejectedFastForwardIn**: Origin's tree entries are read for every candidate path, including missing ones, because a path's absence from that map is what licenses restoring a deleted file; a failed lookup must abort the whole cleanup instead of reading as origin does not have it.
- **undoRejectedFastForwardIn**: git writes only regular files and symlinks, and they are proved differently during the undo: hash-object follows a symlink and hashes its target, which never equals the blob git stores (the target path) and could read a file outside the repository.
- **undoRejectedFastForwardIn**: A symlink is also a blob, so the tree mode is checked when matching regular files; otherwise a regular file whose content equals a link target string would prove equal to a symlink origin holds at that path.
- **classifyWorktreeEntry**: Worktree entries are classified without following symlinks, so a symlink git wrote is recognized as one, and a path that became a directory or vanished is left alone.
- **symlinkTargetMatchesBlob**: git stores a symlink as a blob holding the target path, so the readlink result is compared with the blob from cat-file, which is verbatim with no trailing newline.
- **readWorktreeDeviations**: A type change (for example a file the merge turned into a symlink) falls into no deviation bucket but is still proved against origin before anything is restored.
- **readRemoteTreeEntries**: origin/<branch> tree entries are read with ls-tree, which reports only paths present in that tree, exactly the answer the deletion half of the undo needs.
- **hashWorktreeFiles**: Current file contents are hashed by git itself so repository filters (LFS clean, CRLF conversion) apply as they did when the blob was made; a path missing from the result is never acted on.
- **hashWorktreeFiles**: One unreadable path fails a whole hash-object invocation, and failing the undo over it would leave the wedge it exists to remove, so hashing falls back to one path at a time and an unhashable file disqualifies only itself.
- **removeWrittenFiles**: removeWrittenFiles deletes working-tree files, and clone mode reaches it only through undoRejectedFastForward, which requires the primary-checkout brand.
- **restoreFilesFromHead**: A restore can fail for the same reason the merge did (HEAD's version may need the smudge filter that is down); the tree is then no worse than before and the next tick reports it, so the failure is not fatal.

### `src/services/clone-sync/fetch.ts`

- **describeDeepenAttempt**: The deepen progress value passed to skip messages is null when no deepening was attempted at all, which happens when the configured depth already sits at or above every deepen target.
- **buildSyncFetchArgs**: The routine clone sync fetch keeps a --depth cap because it bounds the transfer after a force-push or rebase, when a shallow clone has no haves to offer. Re-sending the configured depth would cut back every commit the deepen budget bought, since --depth re-applies rather than caps, so the cap ratchets to max(configured depth, window held under origin/<branch>), measured in ancestry levels (not rev-list --count, which overshoots on merges) and under the remote-tracking ref (HEAD only as first-sync fallback). Measured that way the cap is a fixed point; a non-shallow clone gets no --depth, and when no depth can be measured the cap falls back to the configured depth because re-truncation is recoverable and an uncapped transfer is not.
- **measureLocalHistoryDepth**: The depth a clone holds under a ref is measured in git fetch --depth units: one plus the longest shortest-path from the ref to a local commit, since git cuts history where the minimum parent-edge count reaches depth. rev-list --topo-order prints no parent before its children, so one forward pass over --parents output settles every distance, stopping at grafted boundaries. Rejections and simple-git's empty-string resolution on a silent non-zero exit return null.
- **measureDeepenWindow**: The window origin/<branch> already holds is measured in deepen-target units, since a target at or below it could only cut the clone back. It is Infinity when every parentless commit under the ref is a true root, because no deepen can add to a complete history; the shallow file is no guide there since --depth N on an N-level history lists the root too.
- **buildUntrackedBranchFetchArgs**: The TUI branch switch and branch wizard base fetch keep --depth, which re-applies the configured depth to the named ref and, with a repository-wide shallow boundary, can shorten or deepen the clone, including the tracked branch. It does not ratchet like the sync fetch because the named ref is usually not the one the window was measured over. Dropping the flag would cost a never-seen branch's whole ancestry, and both callers leave the old branch behind anyway, since checkoutBranch re-narrows the remote and deletes the old origin ref.
- **fetchWithRecovery**: When fetchWithRecovery runs for checkoutBranch it does not record a Skipping sync skip, because checkoutBranch reports its own hard error and a sync skip would double-report a user-initiated action.
- **fetchWithRecovery**: The LFS-disabled fetch retry can itself hit a deleted remote branch, so that error is classified as a soft skip too instead of escaping as a hard failure.
- **getDeepenTargets**: git fetch --depth N can shorten a shallow repository, so deepen targets at or below the configured depth are skipped. Raising depth therefore only removes targets, and a depth at or above the largest leaves no budget; the ratcheted sync cap can widen a clone up to depth but not past it, so a clone at depth that still cannot be classified can only be fixed by removing depth, which unshallows via unshallowIfDepthRemoved.
- **classifyWithDeepening**: Both the sync tick and branch switch classify the branch relationship with a shared deepening budget: a shallow clone can be too short for merge-base, so the classifier says indeterminate_shallow rather than guessing, and each deepen target is fetched in turn until a decisive answer, so the common case costs one extra fetch. localRef is HEAD for the tick and the not-yet-switched branch for the switch.
- **classifyWithDeepening**: Deepen targets the clone already holds are not refetched, so a budget that failed once does not re-run on every later tick.

### `src/services/clone-sync/git-clients.ts`

- **MutatingGitClients**: MutatingGitClients is a brand carried only by client pairs whose directory was verified as a primary, non-linked checkout; only CloneGitClients.mutatingClientsFor can produce it, and every write helper requires it instead of a bare SimpleGit, so a future mutation cannot reach an adopted directory without passing the guard.
- **CloneGitClients.lfsSkipCheckoutClient**: The LFS-skip checkout client has no inactivity timeout, like localClientFor, because git is silent while materializing a tree. Its unused MutatingGitClients parameter must stay: requiring the brand keeps the writes it performs behind the primary-checkout guard, and removing it would let a future caller reach a checkout the tool must not touch.
- **CloneGitClients.mutatingClientsFor**: mutatingClientsFor is the single choke point for every clone-mode write. A user-supplied worktreeDir may be a linked worktree or submodule whose .git pointer shares another repository's config and refs, so refspec narrowing, origin ref deletion and --prune fetches would rewrite that repository, every run for a worktree-mode parent whose init re-adds the wide refspec. Reads keep using localClientFor; only the branded return type is accepted by write helpers.
- **CloneGitClients.assertPrimaryCheckout**: The primary-checkout guard fails closed: it protects a repository the tool may not own, so an inability to tell is never treated as safe to mutate, and since every call site already ran a read probe, a failure means the checkout changed or broke.
- **CloneGitClients.assertPrimaryCheckout**: A clone's .git must be a real directory: git worktree add and git submodule add leave a gitdir file that makes mutations land in another repository. A symlinked .git is refused too, because git reports it like a primary one and a link relocating this repo's own git dir cannot be told apart from one aimed at a checkout still using it.
- **CloneGitClients.assertPrimaryCheckout**: For a symlinked .git, git prints the symlink's own path, so the refusal reports the link target, which is the directory the user has to reason about.
- **CloneGitClients.assertPrimaryCheckout**: The refusal says which check failed, because a relocated linked worktree has a real .git directory and is caught only by the common dir, so naming the checkout's own git dir would be confusing.
- **CloneGitClients.assertPrimaryCheckout**: When .git is a file, the refusal quotes its gitdir pointer, since that is how git worktree add and submodules mark a checkout owned by another repository and quoting it makes the error recognizable without further investigation.

### `src/services/clone-sync/git-helpers.ts`

- **inBatches**: inBatches floors its limit at 1, because a zero or negative limit would loop forever instead of failing.

### `src/services/clone-sync/phases.ts`

- **CLONE_SYNC_PHASES**: Clone-mode timing phases follow worktree mode's Phase N: X naming so --debug output has one format, and the numbers are fixed labels so a phase never reached leaves a visible gap. A phase has a row only if it ran (most ticks have no Status row, Sparse only appears with sparseCheckout), because a zero-duration row would read as a scan that cost nothing rather than one that was skipped.
- **timePhase**: timePhase closes its phase in a finally block, so an early return or throw still closes it; an open phase would otherwise run until the table renders and swallow the rest of the tick. With no timer it is a plain call that allocates nothing and cannot add a new throw.

### `src/services/clone-sync/remote-config.ts`

- **REMOTE_ORIGIN_CONFIG_KEY_PATTERN**: The two remote keys configureSingleBranchRemote converges (remote.origin.fetch and tagOpt) are read with one anchored git config --get-regexp pattern, so reading them costs a single git process and matches nothing that merely contains those names.
- **STALE_REF_DELETE_BATCH**: Stale remote-tracking refs are deleted in batches of 200 per git branch -r -D, because a legacy all-branches clone of a busy repository holds thousands and one command line must fit the platform argument limit.
- **configureSingleBranchRemote**: Every clone-mode remote is held to one fetch refspec naming the tracked branch, tags off, and no other remote-tracking refs; init, the branch switch and each tick converge it, writing only what differs. It reads first because git config --replace-all is not a no-op on an unchanged value (it rewrites .git/config to a new inode and mtime on git 2.43). It stays in the tick because a long-running daemon's refspec can be widened by git remote set-branches --all or an editor after adoption.
- **configureSingleBranchRemote**: Stale refs are swept on the call that narrows the refspec and before the narrowing write, so a kill in between leaves the wide refspec and the next call redoes both; the opposite order would leave a narrow refspec with stale refs that reads as converged and is never swept.
- **assessSingleBranchRemote**: assessSingleBranchRemote is the read-only half of configureSingleBranchRemote, reporting whether origin already has the single-branch shape so sync --dry-run can say a sync would narrow it.
- **readRemoteConfigValues**: Both remote keys are read in one spawn as NUL-separated records, and anything not positively proven is treated as drift: git config reports an unset key with exit 1 and empty stderr, which simple-git resolves as an empty string indistinguishable from a silent failure, and believing it could skip the write forever. --local matches the scope --replace-all writes, and -z prevents a value containing a newline from forging an entry.
- **readRemoteConfigValues**: Parsing happens inside the same try as the spawn because readRemoteConfigValues's contract is to fail to null so the caller writes; an unexpected raw value must not escape and fail the whole tick from the function built to fail safe.
- **deleteRemoteTrackingRef**: Deleting stale remote-tracking refs is best-effort cleanup and failures are ignored; sync correctness comes from the narrowed fetch refspec, not from the sweep.
- **deleteStaleRemoteTrackingRefs**: Stale origin refs are swept only when narrowing the refspec and on adoption; a tick over a narrowed clone does not sweep because its --prune single-branch fetch cannot create or prune other origin refs. Deletion uses batched git branch -r -D rather than update-ref --stdin, which is one transaction a single locked ref aborts and which simple-git cannot feed stdin without bypassing the client factory and guard. Refs are filtered on the exact refs/remotes/origin/ prefix and only shortened, so every name starts with origin/ and can never be read as an option.
- **deleteStaleRemoteTrackingRefs**: How much of a refused git branch -r -D batch git deletes is version-dependent (all but the locked ref on 2.43, none on 2.55), so a refused batch is retried one ref at a time, paying the per-ref cost only for the failed batch and leaving exactly the refs git genuinely refuses.
- **stale remote ref sweep**: A remote-tracking ref that `git branch -r -D` refuses to delete is left in place: it is only stale cleanup, and the narrowed refspec already keeps it out of every fetch.
- **evaluateOriginMatch**: A clone whose origin no longer matches the configured repoUrl yields a skip so the tool never fetches or merges from the wrong remote; an unreadable origin is not a mismatch. URLs are compared normalized (https, .git, trailing slash) and shown with credentials stripped, and the stored remote.origin.url is read rather than remote get-url, which applies insteadOf.

### `src/services/clone-sync/sparse.ts`

- **reapplySparseCheckout**: Clone mode reconciles sparse patterns with the config in the same three steps worktree mode runs for each worktree: is an update needed, is it a narrowing one, and is the tree clean enough to take it. `sparse-checkout set` writes core.sparseCheckout, so it is a mutation and must run only after the primary-checkout guard.

### `src/services/clone-sync/types.ts`

- **CloneSyncContext**: CloneSyncContext members read through to the owning CloneSyncService at the moment of use, because updateLogger can swap the logger and each initialize or runSyncAttempt call swaps the outcome accumulator, so a module never holds a stale copy.

### `src/services/git-maintenance.service.ts`

- **GitMaintenanceService.runUnlocked**: The maintenance target guard runs before gc because a sync that soft-skipped never reached the write guard, and gc in a linked worktree would rewrite the owning repository.

### `src/services/git-service.types.ts`

- **GitServiceContext.bareRepoPath**: GitServiceContext.bareRepoPath throws a ConfigError in clone mode, which has no bare repository.

### `src/services/git.service.ts`

- **GitService.getBaseGitEnv**: GitService exposes its base environment additions so clients built outside it, such as clone mode's, behave the same way (for example optional locks off when read-only).

### `src/services/repository-operations.ts`

- **RepositoryOperations.getDefaultBranchForRepo**: The wizard's default branch comes from the sync service's clone-aware accessor, because clone mode never runs GitService.initialize and GitService's default would still be main, causing the wizard to preselect and create from a branch the clone does not track.
- **RepositoryOperations.fetchForRepo**: Clone mode tracks a single branch, so the wizard's fetch step is a no-op; branch discovery is a live ls-remote when the picker opens.
- **RepositoryOperations.createAndPushBranch**: A clone-mode repository has no bare repository for GitService's write helpers, so the branch is created and published inside the clone instead.
- **RepositoryOperations.createWorktreeForBranch**: In clone mode, switching to the branch the wizard just created is intentional config drift; checkoutBranch warns the user to update config.branch.
- **RepositoryOperations.copyBranchFiles**: Branch file copy is skipped in clone mode because a clone has one checkout, already on the new branch, so there is nothing to copy between.

### `src/services/worktree-sync.service.ts`

- **WorktreeSyncService.getWorktrees**: In clone mode the repository is one checkout whose listing always reports it whether or not HEAD is on a branch, so includeDetached has nothing to widen.
- **WorktreeSyncService.createAndPushBranch**: createAndPushBranch is clone mode's equivalent of GitService.createBranch plus pushBranch, which need a bare repository; the TUI branch wizard calls it and then checkoutBranch to switch.
- **WorktreeSyncService.sync**: A pendingInitSkip token left by an earlier standalone initialize() is cleared at sync start, because its skip record was just wiped and consuming the stale token would suppress re-detection, making the sync report clean with zero actions; the in-operation init re-arms it when it still applies.
- **WorktreeSyncService.sync**: If a clone-mode init inside the same sync just created the clone (a 'created' action in the fresh outcome), the sync attempt skips the redundant fetch. The shortcut is scoped to an init within the same operation; a flag carried from a standalone initialize() could not tell how stale it is, and a silently no-op sync is worse than one extra fetch.

### `src/types/index.ts`

- **Config.mode**: Repository mode 'worktree' (default) clones once as a bare repository and keeps one worktree per remote branch under worktreeDir/<branch>; 'clone' does a normal `git clone --branch` directly into worktreeDir with one checked-out branch and normal remote-tracking refs, designed for monorepo sibling dependencies needing fixed relative paths.
- **Config.branch**: When the clone-mode branch is omitted, it resolves to the remote default branch via `git ls-remote --symref <url> HEAD`.
- **Config.depth**: Clone-mode depth sets the initial `--single-branch --no-tags --depth N` clone; sync fetches keep a depth cap ratcheted to max(depth, the window already held under origin/<branch>), because `git fetch --depth N` re-applies N and would cut the clone back every tick. The window is measured in git's depth unit by walking from the remote-tracking tip (HEAD only before it exists), making the cap a fixed point. Raising depth deepens a clone and shrinks the deepen budget, lowering it cannot shorten a clone through sync (though branch switch/create fetches and the deepen budget re-apply it verbatim), and removing it unshallows the clone on the next sync.
- **InitRepositoryInput.branch**: InitRepositoryInput.branch applies only to clone mode; omitting it tracks the remote HEAD.
- **InitRepositoryInput.depth**: InitRepositoryInput.depth applies only to clone mode; omitting it clones full history.

### Tests

Why the tests that pin these decisions are built the way they are.

#### `src/__tests__/e2e/clone-init-crash-window.e2e.test.ts`

- **clone-mode initialization pending marker**: Between `git clone` returning and the clone-init pending marker landing, a finished clone is indistinguishable from one the user made, so whether the next run completes the init (copying filesToCopyOnBranchCreate) depends only on the marker. The marker is written before the post-clone refspec narrowing; the e2e test proves it with a git shim on PATH that SIGKILLs the real CLI at its first narrowing command.
- **clone-mode filesToCopyOnBranchCreate**: In clone mode, filesToCopyOnBranchCreate are copied from the directory that holds the config file, so the e2e fixture places .env.local next to the config.
- **clone-mode initialization pending marker**: The clone-init pending marker must be written before the post-clone narrowing: if it were written after, a kill during narrowing would leave no marker and the file copy would be lost for good.

#### `src/__tests__/e2e/clone-mode.e2e.test.ts`

- **clone-mode sync dirty check ordering**: In clone mode a dirty working tree is not a reason to report the repository out of sync when there is nothing to merge, so the up-to-date check runs before the dirty check. Asking about dirtiness first made every tick of a current-but-dirty clone print a skip and count the repo as 'with clone-mode skips' instead of synced.
- **clone-mode checkWorktreeStatus**: The clone-mode dirty check (checkWorktreeStatus) looks for both modified tracked files and untracked files, so the e2e fixture creates one of each.
- **clone-mode default branch resolution**: With `branch` unset, clone mode tracks the default branch resolved at clone time, so a later move of the remote's HEAD does not strand an existing clone.
- **clone-mode default branch resolution**: Later starts read refs/remotes/origin/HEAD to know the clone-time default branch, and newer git no longer writes it on a single-branch clone, so the sync writes it itself.
- **deleteStaleRemoteTrackingRefs**: The clone-mode stale remote-ref sweep deletes in best-effort batches so one ref git refuses (typically a lock left by a crashed git) does not stop the others; a single-transaction `update-ref --stdin` would abort with nothing deleted. Whether the locked ref itself survives depends on whether it is packed or loose, so tests leave it unasserted.
- **clone-mode run-once branch mismatch**: In run-once mode clone initialization happens inside the sync operation, so a branch mismatch is reported as the init-phase skip ('since process start').
- **clone-mode sync fetch depth cap**: The clone-mode sync fetch caps itself at max(configured depth, the depth the clone already has), bounding transfer without asking for a shorter window than the clone holds. Passing the configured depth every tick re-grafted the fetched tip, cutting the parent link merge-base needs, so every advance classified as indeterminate and paid for a 50-commit deepen that the next tick threw away.
- **clone-mode deepen budget**: A depth-1 clone cannot classify a remote advance because merge-base has no ancestry to work with, so the first tick after an advance spends exactly one deepen (to depth 50) before deciding.
- **clone-mode sync fetch depth cap**: Later ticks ask for the window the fetched ref already holds so merge-base keeps answering and the deepen never repeats; the test runs two extra ticks because the reported defect was a deepen on every tick with new commits.
- **clone-mode sync fetch depth cap**: The fetch depth cap is measured from the fetched remote-tracking ref, not HEAD, so tests check both: on fast-forward ticks HEAD equals the fetched tip, but the ref is what the cap reads.
- **clone-mode sync fetch depth cap**: `git fetch --depth N` counts ancestry levels, and on merge-heavy history a level holds several commits, so feeding a commit count back as --depth walks the boundary deeper every tick until the clone is no longer shallow (measured on git 2.43: 1 -> 147 -> 438 -> 610 commits in three ticks). The ratchet measures levels, which makes it a fixed point: a --depth D fetch measures back as exactly D.
- **clone-mode sync fetch depth cap**: A shallow clone has no ancestors to offer as haves, so an uncapped fetch of a rewritten (non-descendant) tip packs its whole ancestry (measured on git 2.43: 197 commits uncapped vs 1 capped). The test first deepens the clone via an ordinary advance so the post-force-push tick can classify as diverged and end right after the fetch, leaving origin/main holding exactly what the capped fetch asked for.
- **clone-mode deepen budget**: When merge-base can classify the remote change (histories meet a few commits down), the tick reports divergence and skips without spending the deepen budget.
- **clone-mode sync fetch depth cap**: On repeated ticks over the same divergence the cap is measured from the ref it caps, which now holds the rewritten tip, so it neither pulls the ancestry previously refused nor cuts what was fetched.
- **clone-mode sync fetch depth cap**: The depth ratchet measures origin/<branch>, the ref the fetch re-applies depth to, not HEAD. Ticks that fetch then skip the merge (dirty tree, unpushed commits, divergence, too-shallow tip) leave HEAD behind; measuring HEAD made the window shrink every tick (measured on git 2.43: --depth 50, 47, 41, 32, 20, 5) and cost a second deepen once the tree was clean.
- **clone-mode deepen budget**: When a remote branch was rewritten past the clone's shallow boundary, merge-base cannot answer and deepening cannot un-graft a local tip the branch no longer contains; the deepen budget still runs, the tick ends in the indeterminate skip, and the clone is left exactly where it was.
- **clone-mode deepen budget**: Once the deepen budget has failed for a local/remote tip pair it cannot succeed later (the fetched ref already holds every target or its whole history), so it is not re-run; re-running it re-truncated the clone to 50 and re-bought the rest every tick.
- **clone-mode deepen budget**: A capped fetch cannot classify a merge on its own: the cap stops the fetch at the merge commit, so the tick starts indeterminate_shallow. The deepen budget resolves it in one bounded 50-commit step instead of an uncapped fetch that follows the merged-in side down to its fork point; README and changeset wording describe this sequence.
- **clone-mode deepen budget**: A deepen to 50 over a remote with fewer commits completes the clone and git drops the shallow marker; a larger repository would stop at 50 commits and stay shallow. The transfer is bounded by the target either way.
- **clone-mode primary-checkout guard**: A directory whose .git is a gitdir pointer (linked worktree or submodule) shares config and refs with its owning repository, so clone mode's refspec narrowing and stale-ref deletion would land in that repository on every tick; clone mode refuses such directories as not a primary checkout.
- **clone-mode maintenance**: On the wrong branch a clone-mode tick soft-skips before the primary-checkout guard, so the sync reports success; maintenance must still not run git gc in the repository that owns a linked worktree.

#### `src/__tests__/e2e/sync-dry-run.e2e.test.ts`

- **sync --dry-run clone mode**: With `depth` configured, the dry run's fetch may move the clone's shallow boundary (.git/shallow), a documented write alongside remote-tracking refs and objects.
- **sync --dry-run clone mode**: A clone with a wide fetch refspec is narrowed by the sync first; the dry run reports that step but leaves the repository config untouched.

#### `src/__tests__/integration/clone-branch-wizard.test.ts`

- **InteractiveUIService branch wizard (clone mode)**: The branch wizard on a clone-mode repository must create and push in the clone itself; using GitService.createBranch/pushBranch fell back to a relative '.bare/<repo name>' path, which either crashed (directory missing) or, when a same-named bare store sat under the process working directory, created and pushed the branch in a different repository while reporting success.
- **InteractiveUIService createWorktreeForBranch (clone mode)**: In clone mode the wizard's follow-up step switches the existing clone to the new branch in place instead of creating a worktree directory, matching clone-mode branch switching as described in CHANGELOG 5.0.0.
- **InteractiveUIService createAndPushBranch (clone mode)**: When the remote rejects the push, the clone-mode wizard rolls back the local branch it created, so retrying the same name does not collide with the repository's own leftover.

#### `src/__tests__/integration/clone-deleted-recovery.test.ts`

- **CloneSyncService recovery**: Long-lived processes (daemon, TUI, MCP server) reuse one sync service, so a clone removed out-of-band between ticks is re-cloned on the next sync rather than failing (directory gone) or soft-skipping forever (.git gone).

#### `src/__tests__/integration/clone-shallow-branch-switch.test.ts`

- **CloneSyncService.checkoutBranch**: On a depth-N clone, a `--depth N` fetch cuts the history under a remote tip that moved by more than N commits, so `merge-base <local> <remote>` exits 1 even for a plain fast-forward. The clone-mode branch switch deepens first, exactly like a sync tick, and only then decides fast-forward or divergence; treating exit 1 as 'cannot fast-forward' wrongly ended switches with FastForwardError.
- **CloneSyncService.checkoutBranch**: A completed clone-mode branch switch narrows remote.origin.fetch to the new branch's single refspec; that narrowing marks the checkout as finished.

#### `src/__tests__/integration/inherited-git-dir.test.ts`

- **inherited-git-dir test setup**: The clone-mode checkout is cloned with the wide default refspec on purpose, so the tick under test is the one that narrows the refspec to the configured branch and sweeps origin/feature, giving an observable change to compare against the foreign repository.

#### `src/__tests__/integration/unshallow-inactivity-timeout.test.ts`

- **CloneSyncService unshallow**: Removing `depth` unshallows a clone-mode repository with `fetch --unshallow`, which transfers the whole history the shallow clone skipped: clone-sized work reached through a fetch. It therefore runs on the cloneTimeoutMs inactivity budget rather than fetchTimeoutMs, otherwise a large repository could never unshallow and every tick would be killed and fail.

#### `src/__tests__/test-utils.ts`

- **CloneSyncService.assertPrimaryCheckout**: Clone mode only writes to a checkout proved to be a primary, non-linked one: must be its own directory and must report it as both, since a linked worktree or submodule reports the owning repository's. Test fakes standing in for an ordinary clone must answer that probe or every write path refuses.

#### `src/services/__tests__/clone-branch-wizard.real-git.test.ts`

- **clone branch wizard tests**: A pre-receive hook moves the clone's new branch while the push is in flight, so the compare-and-swap rollback fails, and rejects with already exists wording that would otherwise send the wizard's suffix-retry loop round again; the wizard must not suffix past a branch it could not remove.

#### `src/services/__tests__/clone-mode-no-bare-path.test.ts`

- **GitService.getBareRepoPath**: A clone-mode repository has no bare repository, so no code path may derive a bare-repository path from its URL. Consequently a repoUrl with no repository path segment is valid in clone mode and must not make service construction throw.

#### `src/services/__tests__/clone-sync.service.test.ts`

- **recordCloneTimeDefaultBranch**: With branch unset, later starts read the clone-time default branch back from refs/remotes/origin/HEAD, but newer git does not write that symref on a single-branch clone, so clone init records it. When a branch is configured nothing is recorded, because a configured branch says nothing about the remote's default.
- **CloneSyncService.initialize**: The recorded sync outcome is what the MCP sync result and run summary display, so a clone that failed authentication records the credential remedy hint in the outcome, not only on the thrown error.
- **inspectCloneDestination**: Only a definite ENOENT from the destination probe may be treated as 'the directory did not exist', because that answer later authorizes a failed clone to rm -rf the destination. A transient probe failure aborts the init instead.
- **writeIncompleteCloneMarker**: A clone that fails after its objects land ('Clone succeeded, but checkout failed') leaves a complete .git on the tracked branch beside a half-written tree, indistinguishable on disk from a user's own clone. Such a directory is marked with an incomplete-clone marker so later runs refuse to adopt it instead of reporting dirty_tree forever while exiting 0.
- **writeIncompleteCloneMarker**: The incomplete-clone marker stores git's failing line so the next run's refusal can quote why the previous clone did not complete.
- **settleFailedClone**: A destination that holds a fetched .git after a failed clone is never deleted; it is only marked as incomplete for inspection.
- **assertPreviousCloneCompleted**: Refusing a directory with an incomplete-clone marker is a loud failure (GitOperationError), not a soft skip: no dirty_tree or branch_mismatch skip is recorded and the repository is not reported as merely skipped.
- **settleFailedClone**: The incomplete-clone marker is written before the LFS-skipped checkout retry, so a kill during the retry still leaves the directory unadoptable, and it is removed only once the retry succeeds.
- **assertPreviousCloneCompleted**: The incomplete-clone marker is the only thing distinguishing an unfinished clone of ours from a user's clone, so failing to read it must never be treated as 'no marker'; the init fails closed instead of adopting the clone.
- **settleFailedClone**: maybeCleanupPartialClone may rm -rf a directory the current init created, so a .git/HEAD probe that merely failed (e.g. EACCES) must not be read as 'nothing was fetched'; the directory is marked incomplete instead of deleted.
- **settleFailedClone**: When the .git/HEAD probe of a failed clone itself fails, no checkout retry is attempted; nothing may be checked out into a directory that cannot be probed.
- **maybeCleanupPartialClone**: maybeCleanupPartialClone is the clone subsystem's only recursive delete and requires three conditions: the destination was created by the current init, everything left in it is dot-prefixed, and there is no usable .git/HEAD. Each test varies exactly one condition so that dropping any single condition fails its own test.
- **maybeCleanupPartialClone**: A failed-clone destination that is being deleted is never also given an incomplete-clone marker.
- **maybeCleanupPartialClone**: maybeCleanupPartialClone re-checks for a usable .git/HEAD immediately before deleting, because HEAD can land between settleFailedClone's probe and the delete; a .git whose objects all arrived (the 'Clone succeeded, but checkout failed' shape) is marked for inspection and never removed.
- **maybeCleanupPartialClone**: If listing the failed-clone destination fails (e.g. EACCES), the directory is not treated as holding only dot-prefixed entries and nothing is deleted.
- **maybeCleanupPartialClone**: An empty listing satisfies the all-entries-dot-prefixed condition (`[].every(...)` is true), and that is intended: a destination the current init created that the failed clone left empty is exactly what should be cleaned up. A guard such as `entries.length > 0 &&` would wrongly leave empty directories behind.
- **maybeCleanupPartialClone**: When cleanup of a failed clone also fails, the init still rejects with git's original clone error and the cleanup failure is logged as a warning beside it, never replacing it.
- **prepareCloneDestination**: An ENOENT probe only proves the clone destination was absent a moment ago. Ownership, which authorizes deleting it after a failed clone, is established by the current init's own non-recursive mkdir after creating the parents, so a directory another process created in between is never deleted.
- **runInitialFileCopy**: An init that wrote the pending marker may have died inside sparse setup, so resuming a pending clone reapplies sparse checkout (idempotent) before running the initial file copy.
- **getInitPendingMarkerPath**: The pending marker is the only record that a finished clone still owes its initial file copy; the existing-clone path runs the copy only when the marker is present. Any step between the clone finishing and the marker being written is a window in which a kill loses the copy permanently, so the marker is written before any post-clone git write.
- **CloneSyncService.initialize**: A clone without markers is indistinguishable from one the user made and is adopted silently, without copying files or warning, which is why a missing pending marker costs the initial file copy permanently.
- **assertPreviousCloneCompleted**: The incomplete marker decides whether a clone may be adopted at all and the pending marker records what an adopted clone still owes. They coexist only when a recovered clone's incomplete marker could not be removed, and then the refusal wins: nothing is copied into a working tree that was never fully written.
- **warnConfigDriftAfterCheckout**: The TUI branch wizard creates and pushes a new branch and then switches the clone to it. That drift is deliberate, but config.branch becomes stale, so the user is warned to update the config; otherwise every sync after a restart would soft-skip silently on a branch mismatch.
- **switchCloneBranch**: The branch-switch fetch passes --depth, since without it the switch would download the target branch's history down to the repository root. --depth is not free (the shallow boundary is repository-wide and can shorten shared history), but the switch is leaving the old branch behind, so the flag stays.
- **deleteStaleRemoteTrackingRefs**: Stale remote-tracking refs are deleted with one `git branch -r -D` naming the whole batch, never one process per ref; origin/HEAD and the tracked branch's ref are never included.
- **switchCloneBranch**: Switching to an existing local branch asks the same remote-relationship classifier a sync tick uses, about refs/heads/<branch> rather than HEAD because the branch is not checked out yet, instead of a separate simplified can/cannot check.
- **CloneSyncService.checkoutBranch**: When a user-initiated checkout finds the remote ref missing, checkoutBranch throws the error itself and records no missing_remote_ref skip, which would double-report a user action as a sync skip.
- **CloneSyncService.createAndPushBranch**: createAndPushBranch is the clone-mode half of the TUI branch wizard. Its worktree-mode counterpart (GitService.createBranch plus pushBranch) runs in a bare repository that does not exist in clone mode, so every command runs in the clone itself.
- **createAndPushCloneBranch**: The base branch for a new clone-mode branch is refreshed with an explicit refspec for that branch, because under single-branch tracking origin/<base> is usually not present.
- **createAndPushCloneBranch**: The base-branch fetch keeps the configured depth, since dropping it would pull an unseen base branch's history down to the repository root. When the base is the tracked branch itself (the common case, since the wizard offers it), `--depth` re-cuts the clone's existing history to that depth; that cost is accepted over downloading a long-lived base branch in full.
- **rollbackCreatedBranch**: Rolling back a newly created branch after a failed push uses `git update-ref -d <ref> <created-sha>`, a compare-and-swap on the commit it was created at, so a ref something else moved in the meantime survives.
- **createAndPushCloneBranch**: createAndPushBranch refuses a detached HEAD before contacting the remote, because checkoutBranch refuses a detached HEAD and publishing first would strand a branch nobody can switch to.
- **createAndPushCloneBranch**: A clone is supposed to hold exactly one remote-tracking ref, and the sync tick's narrowing only writes when the refspec drifted, so it would not sweep an extra ref. createAndPushBranch therefore deletes the origin/<base> ref its own base fetch created.
- **createAndPushCloneBranch**: When the push is rejected and the created branch is rolled back, the origin/<base> ref the call fetched is deleted as well, so it does not outlive the branch.
- **unshallowIfDepthRemoved**: The unshallow fetch uses the narrowed refspec, so a deleted tracked branch makes it fail; that failure is turned into the same missing_remote_ref soft skip as the branch fetch, not a hard failure unique to shallow clones.
- **resolveSyncFetchDepth**: `git fetch --depth N` re-applies N to the fetched ref rather than capping history, so passing the configured depth every tick cut the clone back and made the next advance unclassifiable. A cap is still needed because a non-descendant remote tip would otherwise transfer its whole ancestry, so the sync fetch uses max(configured depth, depth the clone already has), which only grows. Depth is measured in ancestry levels, as --depth counts them; a commit count is larger on merge histories and would deepen the boundary every tick until the clone held the whole repository.
- **resolveSyncFetchDepth**: The ratchet measures depth from the remote-tracking ref, because --depth re-applies from the fetched tip and HEAD only matches it after a fast-forward. Ticks that fetch without merging (dirty tree, unpushed commits, divergence, unclassifiable tip) leave HEAD behind, and measuring HEAD then re-truncates the clone; on git 2.43 a HEAD-measured ratchet over a dirty worktree sent 50, 47, 41, 32, 20, 5 on successive ticks.
- **resolveSyncFetchDepth**: On a full (non-shallow) clone the sync fetch sends no --depth and does not walk history, because --depth would make the repository shallow.
- **resolveSyncFetchDepth**: If the history walks cannot be read, the sync fetch falls back to the configured depth rather than no cap, because a re-truncation can be undone by the deepen budget while an uncapped transfer cannot. simple-git resolves with "" when git exits non-zero without stderr, so the empty result is handled like a rejection; it is also what an unborn HEAD yields, where the configured depth is exactly right.
- **buildSyncFetchArgs**: A shallow clone has no ancestors to offer as haves, so when the remote tip stops descending from the clone's tip (force-push or rebase, routine on branches clone mode tracks) an uncapped fetch packs the new tip's entire ancestry. Measured on git 2.43 with a depth: 1 clone and a force-pushed 197-commit tip: capped fetch was a 3-object pack, uncapped was 201 objects. The sync fetch therefore always carries a depth cap on shallow clones.
- **resolveSyncFetchDepth**: Passing the configured depth on every tick discarded the history a deepen had just paid for, so every remote advance was indeterminate again and each tick bought another deepen fetch. With the ratchet, the tick after a deepen fetches at the clone's current size and the deepen happens only once.
- **deepenShallowHistoryToDepth**: After a failed deepen budget, origin/<branch> already holds the history of the targets reached, so deepen targets no deeper than the depth the fetched ref holds are skipped; refetching them would only cut the clone back and buy the history again.
- **CloneSyncService.runSyncAttempt**: Within a clone-mode tick the remote relationship is classified (three ref reads) before the working tree is scanned. checkWorktreeStatus is `git status`, an index refresh plus an untracked-file walk whose cost scales with the checkout's size, so the overwhelmingly common up-to-date tick must not pay for it at all.
- **CloneSyncService.runSyncAttempt**: Relationship verdicts that cannot end in a merge (local_ahead, diverged, indeterminate_shallow) are reported as skips naming the relationship, without consulting the dirty-tree gate, because the relationship is what the user has to act on.
- **CloneSyncService.runSyncAttempt**: The fast-forward merge is the only step of a tick that writes to the working tree, and it stays gated on a status scan taken immediately before it, after classification and any deepening fetches.
- **undoRejectedFastForward**: git's checkout half of `merge --ff-only` writes paths in order and stops at the first it cannot produce, leaving earlier paths on disk. Unless undone, every later tick reports dirty_tree and exits 0 forever, since git then refuses to overwrite the untracked files the failed attempt left; the service therefore undoes provably merge-written changes after a rejection.
- **undoRejectedFastForward**: Undoing a rejected fast-forward only weighs merge paths that git status reports as deviating; paths git never reached are not on disk and are not compared.
- **undoRejectedFastForward**: An untracked file left by a rejected fast-forward is removed only when it is byte-identical to the blob origin/<branch> holds for that path, so the next fast-forward writes it back unchanged.
- **restoreFilesFromHead**: A path the rejected merge deleted is restored with `git restore --source=HEAD --worktree`, writing only what HEAD already holds and only into the working tree, since the merge never reached the index.
- **undoRejectedFastForward**: Although the tree was verified clean before the merge, classification, up to three deepening fetches and the merge itself can take minutes, so a file may appear in that window. A file whose hash differs from the blob origin/<branch> holds for that path is left where it is.
- **undoRejectedFastForward**: A dirty path the incoming commit does not touch is the user's own work and never becomes an undo candidate, which keeps dirty_tree meaningful on the next tick.
- **undoRejectedFastForward**: If HEAD moved despite the merge reporting failure, the merge wrote its files on purpose and nothing is undone, since that would discard an update that landed.
- **symlinkTargetMatchesBlob**: `git hash-object` follows a symlink and hashes the target file, while git stores a symlink as a blob holding the target path. Symlinks left by a rejected fast-forward are therefore proved by comparing their readlink target with the blob content, not by hash-object.
- **hashWorktreeFiles**: `git hash-object` fails the whole invocation on one unhashable path (a dangling symlink or unreadable file). Symlinks are proved without hash-object, and when a batch fails each path is hashed again on its own so a file that cannot be hashed disqualifies only itself.
- **undoRejectedFastForward**: A merge deletes a path only when the incoming commit no longer has it. A missing path that origin/<branch> still carries was removed some other way, likely by the user inside the window, so it is not restored from HEAD.
- **undoRejectedFastForward**: Undoing a half-applied fast-forward is not LFS-specific: any rejection that stopped the checkout midway leaves the same wedge, and the same per-path proof decides what may be undone.
- **assessSingleBranchRemote**: `git config --replace-all` rewrites .git/config even when the value is unchanged, so each tick reads remote.origin.fetch and remote.origin.tagOpt in a single process and only writes (and scans origin refs) when they have drifted from the single-branch configuration.
- **readRemoteConfigValues**: `git config -z --get-regexp` prints NUL-separated records of `key\nvalue` and lower-cases the key it prints, so remote config parsing must match keys case-insensitively (e.g. remote.origin.tagopt).
- **CloneSyncService.runSyncAttempt**: The set of git processes spawned by a steady-state clone-mode tick (already narrowed, one commit behind) is pinned by a test, so any new process added to the steady-state tick must be justified. GitService's relationship classification is stubbed and its reads are not counted.
- **deleteStaleRemoteTrackingRefs**: The stale-ref sweep splits deletions into batches bounded only by command-line length, so thousands of stale refs cost a handful of processes rather than one per ref, and each ref is named exactly once.
- **deleteStaleRemoteTrackingRefs**: The stale-ref sweep is best-effort cleanup: the tick narrows the refspec and syncs regardless. `git branch -D` reports unremovable refs by failing the whole process, and how much of a refused batch it removed varies by version (2.43 continued, 2.55 rolled back), so a refused batch is retried one ref at a time and later batches are still attempted.
- **configureSingleBranchRemote**: Stale refs are swept before the refspec is narrowed, so a process killed between the two leaves the wide refspec in place and the next tick redoes both steps.
- **readRemoteConfigValues**: `git config` reports a missing key with exit code 1 and empty stderr, which simple-git resolves as "" rather than rejecting, the same answer a genuinely failed read gives. Both cases are treated as drift and rewritten, since trusting silence would leave a clone un-narrowed for as long as the daemon runs.
- **adoptExistingClone**: Adopting an existing clone always sweeps stale remote-tracking refs, even if its refspec already reads narrow, because the clone was made by someone else and a narrow refspec says nothing about refs lying beside it. Adoption runs once per process, not per tick.
- **CloneGitClients.assertPrimaryCheckout**: A clone-mode worktreeDir may be a linked worktree or a submodule, both of which share config and refs with the repository owning their git dir. Narrowing remote.origin.fetch, deleting refs/remotes/origin/* or fetching with --prune there would rewrite that other repository, so every write path first verifies the directory is a primary checkout.
- **CloneGitClients.assertPrimaryCheckout**: A linked worktree whose git dir was relocated has a real .git directory containing a commondir file, so it passes the lstat check; only comparing `--git-dir` with `--git-common-dir` detects it, and a dedicated test covers that half of the guard.
- **CloneGitClients.assertPrimaryCheckout**: git reports a symlinked .git exactly like a primary one, so a link relocating the clone's own git dir cannot be told apart from one aimed at a git dir another checkout uses; a .git symlink that cannot be proved unshared is refused.
- **CloneGitClients.assertPrimaryCheckout**: The daemon reuses one CloneSyncService across ticks, so the primary-checkout guard runs on every sync tick, refusing a directory that became a linked worktree after init.
- **CloneSyncService.getWorktrees**: getWorktrees is read-only and does not apply the primary-checkout guard, so a linked worktree is still listed; it just cannot be written to.
- **CloneGitClients.assertPrimaryCheckout**: A checkout reached through a symlinked parent (for example macOS /tmp -> /private/tmp) is the same directory spelled differently, so the guard compares real paths and adopts it as a primary checkout.

#### `src/services/__tests__/clone-sync.unshallow.test.ts`

- **unshallowIfDepthRemoved**: The unshallow fetch, triggered by removing depth from a clone-mode config, transfers the whole history, so it passes --progress explicitly: simple-git's inactivity kill resets only on output and git writes nothing to a piped stderr without the flag (verified on git 2.43). The flag is pinned in the service rather than relying on simple-git's progress plugin appending it. The unshallow uses the clone silence budget (cloneTimeoutMs), not fetchTimeoutMs, because its silent phases (shallow boundary computation, object enumeration, connectivity check) scale with total history like a fresh clone.
- **unshallowIfDepthRemoved**: Progress that simple-git reports from git's stderr during the unshallow fetch must be forwarded to the same progress emitter as clone progress, so the TUI and MCP notifications keep updating through a long unshallow.

#### `src/services/__tests__/git.service.test.ts`

- **GitService.classifyRemoteRelationship**: Clone mode's branch switch asks about a branch it has not checked out yet, so classifyRemoteRelationship accepts a named local ref for the local side of the comparison instead of always using HEAD.

#### `src/services/__tests__/interactive-ui.service.test.ts`

- **InteractiveUIOperations.getDefaultBranchForRepo**: GitService.initialize() never runs in clone mode, so GitService's default branch is the constructor's 'main' placeholder; the wizard reads the tracked branch from the sync service instead so it does not pre-select a branch the clone does not track.
- **InteractiveUIOperations.createAndPushBranch**: Clone-mode repositories have no bare repository, while GitService.createBranch and pushBranch operate in one, so for clone-mode repositories the branch is created and pushed inside the clone via the sync service instead of through GitService.
- **InteractiveUIOperations.createWorktreeForBranch**: In clone mode the wizard's follow-up after creating a branch checks the clone out onto it in place instead of adding a worktree.
- **InteractiveUIOperations.createWorktreeForBranch**: Checking out a just-created branch in a clone-mode repository is allowed even though it drifts from config.branch; the drift is warned about downstream rather than blocked.

#### `src/services/__tests__/worktree-sync.clone-phase-timing.test.ts`

- **CloneSyncService phase timing**: A clone-mode tick classifies before reading the working tree, so most ticks never scan. A phase that did not run gets no timing row, as worktree mode omits the update phase when updates are off, and the fixed phase numbers leave the gap visible; a zero-duration row would falsely claim the scan ran.
- **CloneSyncService phase timing**: The sparse-checkout phase follows the same no-row rule as skipped phases, driven by configuration: with no sparse-checkout configured, the timing table has no sparse row.
- **CloneSyncService phase timing**: Deepen fetches in a shallow clone interleave with the classification reads they feed, so they are counted in the classify phase rather than reported as a phase of their own.

#### `src/services/__tests__/worktree-sync.service.test.ts`

- **WorktreeSyncService.sync**: A fresh clone lands at origin/<branch> by construction, so the sync operation that performed the clone skips the follow-up sync attempt that would re-fetch a ref the clone already has and run git status over a just-checked-out tree.
- **CloneSyncService.initialize**: A 'created' record in the operation's own outcome accumulator is what marks a clone made by the current initialize() call, as opposed to an existing clone it adopted.
- **WorktreeSyncService.sync**: When initialize() only adopts an existing clone it records nothing, and the sync attempt runs as normal, since that is exactly the case a sync tick is for.
- **WorktreeSyncService.sync**: Skipping the sync attempt after a clone is scoped to the operation that cloned and not remembered, so the next tick runs an ordinary sync attempt.
- **WorktreeSyncService.sync**: A sparse-checkout failure is recorded and the clone tick continues; an error that later ends the tick must still be recorded as sync_failed in the outcome.
- **WorktreeSyncService force clean busy probe**: Clone mode has no bare repo: the object store is the checkout's own .git and the busy markers sit directly in it, not under worktrees/. The busy probe inspects that .git directory, because probing the checkout root would find nothing and silently drop the gc guard for clone-mode repositories.

## Consequences

Changing code covered by an entry here means updating the entry in the same pull request. An entry that no longer holds is deleted, or superseded by a new numbered ADR when the reversal is itself a decision worth keeping.

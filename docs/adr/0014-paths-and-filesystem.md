# ADR-0014: Paths and the filesystem

- **Status:** Accepted
- **Date:** 2026-11-20
- **Source:** 69 code comments as of `5f17242`, moved here by [ADR-0001](./0001-record-decisions-in-adrs-not-comments.md)

## Context

Paths come from config, git and the filesystem, and they disagree about symlinks, case and relative bases. These decisions cover how paths are resolved and compared and how files are written safely.

## Decisions

Grouped by the file that implements them, source before tests. Each entry names the symbol it governs.

### `src/constants.ts`

- **PATH_CONSTANTS.BARE_CLONE_PENDING_MARKER_SUFFIX**: In worktree mode the pending marker is written beside the bare repository directory, never inside it, because git clone refuses a non-empty destination. It is written only for a destination verified absent or empty and removed when the clone ends (on failure only once the destination is verifiably gone or empty), so a HEAD-less directory next to the marker is a leftover of the tool's own initialization and the only kind initialize() may delete.
- **PATH_CONSTANTS.STATE_DIR_NAME**: Per-config state such as removal audit logs is kept in a .sync-worktrees-state directory under the config file's directory.

### `src/mcp/context.ts`

- **RepoEntry.realPaths**: For config entries, bareRepoDir and worktreeDir are realpathed at load time because git reports canonical paths and comparisons must match them.
- **RepositoryContext.detectFromPath**: detectFromPath realpaths the probed path because agents pass $PWD, which keeps symlinks, while git lists canonical paths.
- **findEnclosingCheckout**: path.dirname is its own fixed point at a filesystem root, and at a Windows UNC share root the current === root check does not recognise it, so the walk also stops when the parent equals the current directory; otherwise it would loop forever.

### `src/services/bare-repo.service.ts`

- **BareRepoService BareCloneDestination**: A bare clone destination is classified as missing, empty, recovered (a marked leftover just removed) or unverifiable. Only the three positive verdicts let the clone claim the destination with a pending marker; an unverifiable destination is cloned into but never claimed, so a failed clone leaves nothing that would authorize a later deletion.
- **BareRepoService.ensureBareRepository**: A bare-clone pending marker next to a repository that has a HEAD is stale (the clone landed but the marker removal did not), so only the marker is removed; that path must never delete a directory.
- **BareRepoService.ensureBareRepository**: The bare-clone pending marker authorizes a later init to delete the destination, so it is written only for a destination positively verified as ours. An unverifiable destination is cloned into without a marker, letting the clone report what is wrong without licensing deletion of someone else's data on the next run.
- **BareRepoService.ensureBareRepository**: git removes the destination it created when a clone fails, so after a failed bare clone the pending marker survives only while a partial directory actually remains on disk.
- **BareRepoService.ensureBareRepository**: A clone git reports as successful always wrote HEAD, so the pending marker is cleared immediately after it, before the post-clone steps. Those steps are deliberately not covered by the marker: dropClonedBranchCopies is best-effort and must never run against an adopted repository whose refs/heads may hold real local-only commits.
- **BareRepoService.getBareClonePendingMarkerPath**: The bare-clone pending marker lives next to the bare repository, never inside it, because git clone refuses any non-empty destination (dotfiles count) and a marker inside would break the clone it guards. It is named after its directory so repositories sharing a .bare parent each get their own marker.
- **BareRepoService.writeBareClonePendingMarker**: Writing the bare-clone pending marker is best-effort, as with clone mode's init marker: if it cannot be written, an interrupted clone simply needs manual cleanup instead of automatic recovery.
- **BareRepoService.clearBareClonePendingMarker**: Failing to remove the bare-clone pending marker is only logged, because a leftover marker is harmless while HEAD exists: every later init clears it again and never deletes a repository that has a HEAD.
- **BareRepoService.releaseBareClonePendingMarkerAfterFailure**: After a failed bare clone the pending marker is dropped unless a partial directory is really left on disk. When the destination cannot be probed the marker is kept, since not being able to tell must not silently disown a directory the tool did create.
- **BareRepoService.prepareBareCloneDestination**: git clone --bare writes HEAD almost immediately, so a HEAD-less bare directory is residue of a half-finished cleanup or external damage, and git refuses to clone into it, which used to leave initialization retrying forever with no actionable log. A directory carrying the pending marker was verified and claimed by this tool, so it is deleted and cloned again; anything else (non-empty directory, non-directory path, unlistable directory) is never deleted and gets a named, actionable error. The check only runs when HEAD is missing, so a working repository is out of scope.
- **BareRepoService.prepareBareCloneDestination**: When the bare clone destination cannot be probed at all (EACCES on a parent, EIO), it may or may not exist, so nothing is deleted or claimed and the clone itself reports the real problem.
- **BareRepoService.prepareBareCloneDestination**: A bare clone destination whose listing fails for any reason other than ENOENT (ENOTDIR, EACCES, EMFILE) raises a ConfigError instead of being cloned into, because a failed clone there could otherwise leave a marker on a path holding someone's data and license its deletion on the next run.

### `src/services/clone-sync/clone-bootstrap.ts`

- **inspectCloneDestination**: Only a definitively missing clone destination proceeds as a fresh clone, because that lets prepareCloneDestination claim it and the claim authorizes maybeCleanupPartialClone to rm -rf the directory after a failed clone. A transient probe failure such as EMFILE or EACCES must never read as absent, or a pre-existing directory could be deleted.
- **prepareCloneDestination result**: A failed clone may remove only what the same init created: createdDir is true only when init's own mkdir made the destination, and createdParent is the outermost ancestor that call had to create.
- **prepareCloneDestination**: A readdir that found the destination missing does not prove this process creates it, so parents are made first and the destination with a plain non-recursive mkdir; EEXIST means someone else created it in between, and a directory someone else created (or one that already existed empty) is never deleted by init.
- **settleFailedClone**: Only a definitively absent HEAD may reach maybeCleanupPartialClone, whose rm -rf is live for a directory init created; a probe that merely failed (EACCES, EMFILE) must not read as nothing fetched. An unverifiable HEAD is marked as an incomplete clone instead, since marking deletes nothing and a false refusal costs only a clearable error.
- **removeCreatedParents**: Cleanup of parents created by init walks them innermost first up to the outermost one it made, using rmdir, which only removes empty directories, so anything another process placed there stops the walk instead of being deleted.

### `src/services/clone-sync/clone-markers.ts`

- **readIncompleteCloneMarker**: As with lstatOrNull and realPathOrNull, a filesystem result that does not have the shape the API promises is not passed on as a verdict about the incomplete-clone marker.

### `src/services/clone-sync/git-clients.ts`

- **CloneGitClients.assertPrimaryCheckout**: The git dir and common dir are compared after resolving real paths so a symlinked parent (macOS /tmp to /private/tmp) is not refused; the earlier lstat already established .git is the checkout's own directory, so this only forgives path normalization.

### `src/services/clone-sync/git-helpers.ts`

- **lstatOrNull / realPathOrNull**: lstatOrNull and realPathOrNull normalize unusable answers to null so that two could-not-resolve results never compare equal and read as proof that two paths are the same directory.

### `src/services/git.service.ts`

- **GitService.resolveNewWorktreePath**: A new worktree's path is its existing registration inside worktreeDir when there is one, since a worktree keeps the directory it was created with, hashed or not; otherwise the name is chosen by PathResolutionService.branchDirectoryName against origin's branches, registrations and disk contents.
- **GitService.resolveNewWorktreePath**: Detached checkouts are left to the disk probe when naming a worktree, so a detached checkout of this repository at the plain name keeps that name and the caller meets it there, refusing or adopting it, instead of creating a second worktree beside it.
- **GitService.resolveNewWorktreePath**: If origin's branches cannot be listed, worktree naming still checks the disk and registrations; only a sibling branch with no worktree yet goes unseen.

### `src/services/path-resolution.service.ts`

- **PLAIN_BRANCH_RE**: Only branch names made of ASCII letters, digits, dot, underscore, hyphen and slash get a plain directory name (slash becoming hyphen); any other character would need substitution, and a substituted name is not worth keeping readable at the cost of ambiguity.
- **WINDOWS_DEVICE_RE**: Branch names matching Windows device names (con, prn, aux, nul, comN, lptN, with any extension) never get a plain directory name, because Windows cannot create them as directories.
- **RESERVED_WORKTREE_DIR_NAMES**: Directory names in worktreeDir that belong to the tool are reserved; no plain name can currently equal one because plain names never start with a dot, but the reservation keeps that true if the rule loosens.
- **foldWorktreeDirName**: Worktree directory names are always compared case-insensitively, regardless of the local filesystem, because a worktreeDir can be shared, synced or copied to a case-insensitive volume and two names differing only in case must never both be plain.
- **PathResolutionService.sanitizeBranchName**: The collision-proof worktree directory name is the flattened branch name truncated to 80 characters plus a hyphen and 8 hex digits of the branch name's SHA-256; all worktrees created before plain names use it, and new worktrees still get it whenever the plain name is ambiguous or taken.
- **PathResolutionService.plainBranchName**: A branch's readable directory name replaces every slash with a hyphen; it is unavailable (forcing the hashed name) for names with other characters, longer than 80 characters flattened, starting with dot or hyphen, ending with dot, or matching a Windows device name. Flattening is not reversible, so branchDirectoryName checks the plain name against other branches before using it.
- **PathResolutionService.branchDirectoryName**: With a naming context, a plain name is used only when no other known branch flattens to it case-insensitively and nothing holds it; every branch sharing a plain name is hashed, not just the later one, so the result does not depend on discovery order. Without a context the plain name is only a preference, so code creating a worktree must pass a context.
- **PathResolutionService.createNamingContext**: The naming context records which branches flatten to each plain name and which names are already held by a registered worktree's directory (anywhere, since metadata is keyed by basename), by the default branch's worktree path, by the tool's own directories, or by probed disk entries.
- **PathResolutionService.createNamingContext**: Every segment of the default branch's anchor path is reserved, since the anchor is <worktreeDir>/<defaultBranch> and a multi-segment default such as release/2024 occupies release and uses 2024 as its metadata key.
- **PathResolutionService.probeTakenNames**: Any entry at a candidate plain name (including a dangling symlink, or a failed probe) counts as taken, since sync would otherwise trash or quarantine it to make room. The exception is a checkout of this repository whose .git points into the bare repo's worktrees directory, which creation already adopts or clears; a metadata record is held by the branch it was written for so that branch can reclaim its name. Only candidates are probed, never a full listing of worktreeDir.
- **PathResolutionService.probeTakenNames**: Name probes run with bounded concurrency because a first sync can name hundreds of branches at once and unbounded fan-out would queue every probe on libuv's thread pool together.
- **PathResolutionService.resolveBaseDir**: resolveBaseDir canonicalizes a base directory once for a batch of containment checks; the result is a snapshot that does not notice later replacement, so it must be kept to one batch and not cached across operations.
- **PathResolutionService.isPathInsideResolvedBaseDir**: isPathInsideResolvedBaseDir uses a pre-resolved base but still canonicalizes each target, so a candidate escaping the base through a symlink is rejected exactly as in the synchronous variant, without blocking the event loop.

### `src/services/repository-operations.ts`

- **RepositoryOperations.createWorktreeForBranch**: The new worktree's directory name is resolved inside the queued operation because choosing between plain and hashed names depends on current registrations and disk state.

### `src/services/trash.service.ts`

- **TrashService.movePayloadInto**: Although the trash root lives under worktreeDir, a bind mount or symlinked worktreeDir can put them on different filesystems, so on EXDEV the destination and its `.git` link are rebuilt and the payload is copied instead.

### `src/services/worktree-creation.service.ts`

- **WorktreeCreationService.isEmptyDirectory**: isEmptyDirectory returns true only for a directory positively read as empty; an unreadable directory is treated as holding content.

### `src/services/worktree-mode-sync-runner.ts`

- **PATH_CONTAINMENT_CONCURRENCY**: At most eight worktreeDir containment probes run at once; they are pure stat work, so the limit protects event-loop latency rather than a process budget.
- **WorktreeModeSyncRunner.partitionByWorktreeDir**: Registered worktrees are split into those inside worktreeDir and external ones the sync leaves alone. worktreeDir is canonicalized once per partition rather than per candidate, because hundreds of realpath walks per attempt block the shared TUI/daemon event loop; each candidate is still canonicalized so symlinks escaping the base are classified external. The single snapshot makes the batch consistent, and swapping worktreeDir mid-run already requires control of the managed tree.
- **WorktreeModeSyncRunner.partitionByWorktreeDir**: Containment probes are bounded rather than launched all at once, because hundreds of in-flight probes queue behind libuv's thread pool and land in a single poll phase, stalling the loop longer than the synchronous version did.

### `src/utils/atomic-write.ts`

- **atomicWriteFile**: Files are written to a temporary path and renamed into place so a crash never leaves a half-written file. The temp name carries the pid and a random suffix so concurrent writers of the same file never share a temp path.
- **atomicWriteFile**: The temp file is fsynced before the rename. Without it a crash can make the rename durable while the content is not, leaving a valid-looking empty or truncated file.

### `src/utils/disk-space.ts`

- **calculateDirectorySize**: Directory size is measured with du rather than a Node tree walk because du is 10-100x faster. -k is the POSIX block size GNU and BSD du agree on, -H follows a symlinked argument, execFile avoids shell parsing of the path, and an exit code of 1 that still printed a total (an unreadable subdirectory) is accepted.

### `src/utils/file-exists.ts`

- **probePathExists**: Removal decisions need to distinguish a path that is gone from a probe that failed (EMFILE or EINTR under load). probePathExists returns missing only for ENOENT/ENOTDIR and unknown otherwise, so an unverifiable path is never treated as deleted.

### `src/utils/path-compare.ts`

- **resolveRealPathAsync**: resolveRealPathAsync realpaths the deepest existing ancestor and re-joins the missing tail, falling back to the lexical path when nothing exists or realpath throws. Like existsSync, any access error counts as not existing.
- **sameWorktreePath**: git lists worktrees by canonical path, so a configured path through a symlink (all of /tmp on macOS) never matches lexically; sameWorktreePath falls back to comparing real paths.

### Tests

Why the tests that pin these decisions are built the way they are.

#### `src/__tests__/e2e/symlinked-worktree-dir.e2e.test.ts`

- **worktree path comparison**: git records canonical (realpath) worktree paths, so a worktreeDir reached through a symlink (every /tmp path on macOS) must be canonicalized before comparing with git's registrations; otherwise the first run failed with 'main worktree ... is not registered ... after creation'.

#### `src/__tests__/integration/default-branch-rename.test.ts`

- **PathResolutionService worktree naming**: Worktrees created before plain directory names use the hashed name and sync leaves them where they are (including when that branch becomes the new default and is adopted as the default's worktree), while branches new to the current version get plain names.
- **PathResolutionService worktree naming**: A single-segment branch's plain directory name is the same path the default branch's worktree uses, so nothing has to move when such a branch becomes the default.

#### `src/__tests__/integration/stale-directory-quarantine.test.ts`

- **PathResolutionService.branchDirectoryName**: A branch's plain directory name is used only when nothing occupies it yet; a hand-made directory at that plain name is left alone and the branch's worktree gets its hashed name instead of moving the directory aside.

#### `src/mcp/__tests__/symlinked-paths.test.ts`

- **MCP symlinked path tests**: Git lists worktrees by canonical path while agents pass $PWD, which keeps symlinks (every path under /tmp and /var on macOS); the tests reach the whole workspace, config included, through a symlink to cover that mismatch with real git.

#### `src/services/__tests__/path-resolution.service.test.ts`

- **isPathInsideResolvedBaseDir**: The sync runner partitions actions with the async isPathInsideResolvedBaseDir, so it must answer exactly what the synchronous isPathInsideBaseDir answers; any divergence is a hole in the boundary deciding which directories the tool may touch.
- **isPathInsideResolvedBaseDir**: The worktree a create action is about to make does not exist yet, so resolving a path by walking up over missing components is the common case for the boundary check, not an edge case.

#### `src/services/__tests__/trash.service.test.ts`

- **TrashService.restore**: Restore is the only writer to a manifest's originalPath, so restore is where a destination escaping worktreeDir (for example through a symlinked parent) is refused. The entry itself stays listable and reapable, because marking it invalid would leak its payload and pin forever.

#### `src/services/__tests__/worktree-creation.symlinked-path.test.ts`

- **WorktreeCreationService.claimWorktreePath**: git lists worktrees by their canonical path, so a caller spelling the same directory through a symlink must still be recognized as already registered rather than treated as an orphaned directory to move aside and recreate.

#### `src/services/__tests__/worktree-mode-sync-runner.path-partition.test.ts`

- **WorktreeModeSyncRunner worktreeDir partition**: The worktreeDir partition resolves worktreeDir once and then canonicalizes each candidate individually, because per-candidate resolution is what catches a worktree escaping worktreeDir through a symlink.
- **PATH_CONTAINMENT_CONCURRENCY**: Resolving all worktree paths at once queues them behind libuv's four-thread pool and lands every callback in one poll phase, which measured worse than the synchronous loop it replaced. The partition therefore caps outstanding realpath calls at PATH_CONTAINMENT_CONCURRENCY, and the test asserts that bound rather than elapsed time.

#### `src/services/__tests__/worktree-naming.test.ts`

- **PathResolutionService.getBranchWorktreePath**: New worktrees get the plain sanitized directory name (feature/x becomes feature-x) unless another branch would share it; worktrees created with the older hashed names stay where they are.

#### `src/services/__tests__/worktree-sync-planner.test.ts`

- **planCreateActions**: A default branch like release/2024 has its anchor worktree at <worktreeDir>/release/2024 with metadata keyed by its basename 2024, so other branches whose plain name would be 2024 get the hashed directory name instead.

#### `src/services/__tests__/worktree-sync.service.test.ts`

- **PathResolutionService.getBranchWorktreePath**: Branch names containing slashes are flattened to sanitized single directory names so worktree paths never nest inside each other and collide.

#### `src/utils/__tests__/disk-space.test.ts`

- **calculateSyncDiskSpace**: calculateSyncDiskSpace does not bound concurrency: it fans all directories into one Promise.all, so the bound comes from the measure function the caller passes; the shipped caller passes DiskUsageCache's bounded measure.
- **DiskUsageCache**: The shipped caller bounds disk walks with DiskUsageCache(2); measured on a 197 MB, 50,407-path workspace it took 48 ms versus 101 ms sequential and 29 ms unbounded.

## Consequences

Changing code covered by an entry here means updating the entry in the same pull request. An entry that no longer holds is deleted, or superseded by a new numbered ADR when the reversal is itself a decision worth keeping.

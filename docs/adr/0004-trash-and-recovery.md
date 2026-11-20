# ADR-0004: Trash and recovery

- **Status:** Accepted
- **Date:** 2026-11-20
- **Source:** 301 code comments as of `5f17242`, moved here by [ADR-0001](./0001-record-decisions-in-adrs-not-comments.md)

## Context

Nothing sync-worktrees removes is deleted outright. Worktrees and directories are moved into a trash with their unpushed commits pinned by refs, and a reaper expires them later. Restore puts them back. The decisions here protect one invariant: a person's commits and files are recoverable until they say otherwise, across crashes, concurrent syncs and older on-disk formats.

## Decisions

Grouped by the file that implements them, source before tests. Each entry names the symbol it governs.

### `src/cli/trash-command.ts`

- **formatTrashSize**: Trash sizes are measured off the repository lock, so a freshly trashed entry is unmeasured rather than empty; it renders as a dash instead of 0 B, which would misstate what deleting it frees.
- **listTrash**: The trash listing uses listEntries rather than listEntriesWithSizes, because sizing runs `du` over every payload including node_modules, and a listing that waits minutes for one column is worse than showing unmeasured sizes as a dash.
- **purgeTrashEntry**: Purging one trash entry requires an interactive TTY, a typed confirmation naming the entry, and an audit record written by the reap path inside the lock so it records the attempt rather than the intent. The entry is read once before the prompt only to tell the person whether it is keep-on-reap; the purge itself re-reads under the lock.
- **purgeAllTrashEntries**: Purge --all deletes exactly the entries listed before the typed confirmation, so an entry a concurrent sync trashes meanwhile is untouched. Each entry goes through the single-entry purge (same lock, keep ref minted first for keep-on-reap entries), and a failing entry is reported and left listed without stopping the rest.

### `src/components/ForceCleanModal.tsx`

- **ForceCleanModal**: Force-clean only purges repositories whose preview counts were shown (a repository whose preview failed was never shown a number) and, within each, only the trash entries and refs those counts were computed from. A sync may trash more while the modal waits for confirmation, and those extra entries were not part of what the user approved.

### `src/constants.ts`

- **PATH_CONSTANTS.DETACHED_GIT_LINK**: A preserved copy of a worktree has its .git link renamed to .git.detached so git no longer resolves it as a worktree.
- **MAINTENANCE_CONSTANTS.FORCE_CLEAN_PRUNE_EXPIRE**: Force clean runs gc with --prune=1.hour.ago unless maintenance.aggressive opts into now, because the object store is shared with every checkout and --prune=now deletes objects a concurrent commit has written but not yet referenced. Expiry reads the mtime of the file holding an object, so loose objects from purged recovery refs are collected immediately, while packed objects inherit the pack's mtime and a recent repack defers reclamation to the next maintenance run; cruft-pack mtimes are per-object, so nothing is pinned indefinitely.

### `src/services/branch-ref.service.ts`

- **BranchRefService REMOTES_GLOB**: Unpushed-commit counting excludes only what is reachable from origin's remote-tracking refs, deliberately not --remotes, for the reasons recorded on countCommitsNotOnAnyRemote.
- **BranchRefService.removeBranchConfigSection**: update-ref -d removes only the ref, unlike branch -D, so the branch config section is removed separately; otherwise the bare repo config grows with every pruned worktree and a later restore of the same name inherits a stale upstream. Removal is best-effort and swallows every error, since git fails on an absent section and on a concurrent config.lock, and a leftover section must never turn a successful branch deletion into a failure. --remove-section treats everything after the first dot as one literal, case-sensitive subsection, so names like v1.2 are passed exactly as git recorded them.
- **BranchRefService.createBundleFromRef**: Trash bundles include only commits unreachable from origin; for fully pushed refs that set is empty and bundle create would fail. Emptiness is pre-checked with rev-list, which is locale-independent, instead of parsing git's localized empty-bundle stderr, so any bundle-create error after the pre-check is a real failure the caller treats as fail-closed.
- **BranchRefService.countCommitsNotOnAnyRemote**: Counting commits not on any remote uses only refs/remotes/origin, not --remotes, because refs left by a since-deleted remote survive fetch --all --prune and would still anchor commits (measured: count 0 with such a ref, 2 without), releasing the only anchor for commits no remote has; narrowing can only over-count. The bundle decision and the reaper keep-ref re-check share this question, which only proves reachability from refs as they stand now, so callers acting on zero must justify that their refs are current. Unparseable output throws rather than reading as zero, since zero means nothing to preserve.
- **BranchRefService.countCommitsNotOnAnyRemote**: The digit regex is the real validation of rev-list --count output; Number.isInteger additionally rejects a digit string too long for parseInt (which reads back as Infinity) that would otherwise be returned as non-zero and mint a keep ref anyway.

### `src/services/git.service.ts`

- **GitService.resetWorktreeIndex**: resetWorktreeIndex does a mixed reset, pointing the index at HEAD without touching files, so a restored payload's content appears as ordinary uncommitted changes.

### `src/services/removal-audit.service.ts`

- **RemovalAuditService**: RemovalAuditService keeps an append-only JSONL log of destructive worktree operations that outlives terminal logs; the stale-directory rmdir or quarantine during worktree creation is deliberately not logged.
- **RemovalAuditService.append**: An audit line gates a destructive operation, and the attempt record must survive a crash mid-delete, so it is flushed to disk before returning.

### `src/services/repository-operations.ts`

- **repository operations keep refs**: Trash entries written before keep refs existed carry no keep-ref metadata and are handled as having none.
- **RepositoryOperations.forceClean**: Force clean takes the per-repository selections the confirmation actually showed (trash entry ids and recovery ref names); a repository whose preview failed is skipped because purging it would destroy content the user was never shown, and within a selected repository only those names are purged.

### `src/services/trash-migration.service.ts`

- **REMOVED_ENTRY_RE**: Legacy `.removed/` entries are recognized by the name format quarantineDirectory writes: an ISO timestamp with ':' and '.' replaced by '-', a dash, then the original directory name.
- **DivergedInfo.keepRef**: DivergedInfo.keepRef names the permanent `keep/<dirname>` ref the legacy diverge flow created to hold a backup's never-pushed commits; adopting the backup into trash replaces that ref with the trash entry's own protection.
- **TrashMigrationService**: TrashMigrationService adopts legacy `.removed/` quarantines and `.diverged/` backups into `.trash/` so they age out under the same retention policy. Only entries in the exact formats those flows wrote are adopted; anything else is warned about and left alone, since the reaper never touches unmanifested content.
- **TrashMigrationService.warnOnce**: Legacy migration warnings are emitted once, like the reaper's: a stuck entry warns when it first appears and again only after it disappears and comes back.
- **TrashMigrationService.migrateDivergedDir**: Legacy `.diverged-info.json` is an unvalidated JSON.parse, so the fields that become a manifest's branch and headOid are validated with the same rules readManifest applies. Otherwise an entry could be moved out of `.diverged/` with a manifest that is never listed, restored or reaped; a failing entry stays in `.diverged/` under its legacy keep ref.
- **TrashMigrationService.migrateDivergedDir**: Adopted `.diverged/` backups are trashed with keepPinOnReap, because they exist precisely because their commits were never pushed and adoption must not weaken that to a files-only entry that expires. Entries whose commit cannot be pinned (missing localCommit, gc'd oid) fail adoption and stay in `.diverged/` indefinitely, as before trash existed.
- **TrashMigrationService.migrateDivergedDir**: When adopting a `.diverged/` backup fails, its legacy keep ref is not touched, because the backup is still in `.diverged/` and that ref remains the only thing holding its commits.
- **TrashMigrationService.retireLegacyKeepRef**: The legacy keep ref is retired only after trashDirectory resolves, the first moment the replacement protection (pin ref, plus bundle unless commits are on a remote) is durable; trashDirectory restores the directory on any failure, so the legacy ref survives and the next run retries. The ref is released before the info file is rewritten, so a crash in between leaves only an outdated note rather than an orphaned ref nothing records.
- **TrashMigrationService.retireLegacyKeepRef**: If deleting the legacy keep ref fails after adoption, it is logged as a warning naming the ref and the drop-keep-ref command rather than reported as a failed adoption, because the entry is adopted and protected either way.
- **TrashMigrationService.rewriteAdoptedDivergedInfo**: After adoption, the tool-written `.diverged-info.json` inside the payload is rewritten in place and atomically, changing only tool-owned fields, because its old discard instruction points at a TUI view that lists only `.diverged/` directories. User files are untouched, and restore drops the payload copy so it does not reappear as an untracked file.
- **TrashMigrationService.rewriteAdoptedDivergedInfo**: The rewritten discard instruction for an adopted backup says the files age out but the commit is kept, first by the entry and then by a permanent `keep/<id>` ref, because adopted backups are keepPinOnReap entries; claiming that discarding needs no action would describe a discard that does not discard.
- **TrashMigrationService.parseQuarantineTimestamp**: Legacy quarantine timestamps replaced ':' and '.' with '-' (e.g. 2026-06-06T18-34-18-123Z), so parsing restores them before constructing the Date.

### `src/services/trash-reaper.service.ts`

- **ReapOptions.remoteRefsFresh**: ReapOptions.remoteRefsFresh is true only when the current tick's `fetch --all --prune` completed, so remote-tracking refs reflect the remote. Without it the reaper cannot distinguish an existing remote-tracking ref from one git has not yet pruned, and never skips a keep ref on its evidence.
- **TrashReapResult.keepRefsMinted**: TrashReapResult.keepRefsMinted lists the permanent `refs/sync-worktrees/keep/<id>` refs created for entries whose commits were on no remote. A ref is recorded when it is created rather than when the payload delete succeeds, because the ref protects the commits and exists either way.
- **TrashReaperService**: TrashReaperService deletes expired trash entries at the end of every sync attempt, including failed ones, inside the already-held repository lock. It is fail-closed like the removal pipeline: only manifested entries whose realpath stays under the trash root are touched, and only after the attempt is durably recorded in the audit log.
- **TrashReaperService.warnedInvalidPaths**: The reaper warns about unrecognized containers and legacy flat pin refs only when they first appear and stays quiet until the situation changes, because they are steady states it never acts on and repeating the warning every hourly tick buries important lines. The trash listing and force-clean preview report invalid entries independently, so nothing becomes invisible.
- **TrashReaperService.reapExpiredUnlocked**: When trash is disabled, existing entries are left alone rather than aged out behind the user's back. remoteRefsFresh defaults to false so any caller that cannot vouch for fresh remote-tracking refs gets the unconditional keep-ref behaviour.
- **TrashReaperService.purgeAllUnlocked**: purgeAllUnlocked purges exactly the entry ids a force-clean confirmation showed, regardless of expiry; ids no longer present cost nothing and unnamed entries are left alone and counted as skippedNotSelected. It mints no keep refs, because force clean's confirmation covers the recovery refs too and deletes them, so new ones would undo the user's request.
- **TrashReaperService.purgeEntryUnlocked**: Purging a single named entry keeps the reap path's keep-ref protection, unlike force clean, because a person deleting one entry confirmed that entry, not the unpushed commits behind a keepPinOnReap entry. remoteRefsFresh is false because the CLI invocation fetched nothing, so a stale remote-tracking ref can never release the anchor.
- **TrashReaperService.reapUnlocked**: A missing trash root is not treated as an empty trash, because worktreeDir may be an unmounted volume that sync recreated empty; sweeping pin refs then would let gc collect objects whose manifests return on remount. Pins from a manually deleted trash root linger only until trashDirectory recreates the root and the sweep resumes.
- **TrashReaperService.reapUnlocked**: The set of already-warned invalid trash paths is rebuilt each run rather than accumulated, so an entry that is repaired and later breaks again is reported again.
- **TrashReaperService.reapUnlocked**: For keepPinOnReap entries the pin is moved to a permanent keep ref before anything is deleted, and if creating the keep ref fails the entry's reap is deferred to the next run, since those commits may be the only remaining copy.
- **TrashReaperService.reapUnlocked**: The reaper deletes an entry's payload before its manifest: if the payload delete is refused, the manifest remains so the entry stays listed and expired, is reported with a hint, and is retried next run.
- **TrashReaperService.reapUnlocked**: The pin ref is deleted after the payload but before the container and manifest are removed, so a refused container delete cannot strand a ref; the orphaned-pin sweep keys on container names, and the container still exists.
- **TrashReaperService.removeIfCrashLeftover**: Containers left empty or holding only atomic-write temp files (by a crash between mkdir and the first manifest write, or an rm that unlinked the manifest before a refused rmdir) are cleaned up with a non-recursive rmdir, so anything else that appears meanwhile keeps the container in place.
- **TrashReaperService.commitsReachedARemote**: Before minting a permanent keep ref, the reaper re-asks the bundle question (`rev-list --count <oid> --not --remotes`) and skips the ref only when the count parses as exactly zero and remote refs are fresh from a completed `fetch --all --prune`; any failure mints the ref. Freshness matters because an unpruned remote-tracking ref still reports the commits as reachable after the remote deleted them (measured). The re-check deliberately does not address keep refs accumulating from squash or rebase merges, whose original commits stay unreachable from remotes.
- **TrashReaperService.reapOrphanedPinRefs**: Pin refs whose trash container is gone (failed ref delete during restore, manually emptied trash) are deleted, keyed on container existence rather than manifest validity because invalid-manifest entries still own their pins. Any dirent name counts as a container, since deleting a pin is irreversible once gc runs while a stray name collision only keeps one ref alive.
- **TrashReaperService.warnIfOverThreshold**: The accumulated-trash warning reports its byte total as a lower bound and counts unmeasured entries, because sizing runs off the repository lock after the sync and entries trashed in the current tick still have a null size.

### `src/services/trash.service.ts`

- **TrashManifest.bundleFile**: TrashManifest.bundleFile is the bundle of pinned commits not on any remote, stored relative to the container, and is null when there was nothing to bundle.
- **TrashManifest.legacyQuarantinedAt**: TrashManifest.legacyQuarantinedAt records when the legacy quarantine flow originally preserved the entry, but retention still counts from adoption.
- **TrashManifest.keepPinOnReap**: When keepPinOnReap is set the reaper moves the pin to a permanent keep ref instead of unpinning. It is set for removals authorized only by 'fully pushed before upstream deletion' proof, because the remote may have deleted an unmerged branch and the commits must never silently become gc-eligible.
- **TrashManifest.replacedAt**: TrashManifest.replacedAt records when a diverged-replace entry's replacement worktree was created. Until then the entry reserves originalPath so restore can put the payload back; afterwards the branch syncs normally again.
- **TrashDirectoryOptions.legacyQuarantinedAt**: The legacy quarantine timestamp passed to trashDirectory is forensic only; retention always counts from adoption time so a just-adopted entry can never be reaped in the same tick.
- **TrashDirectoryOptions.headOid**: TrashDirectoryOptions.headOid is given explicitly by legacy adoption; when undefined, trashDirectory resolves HEAD from dirPath if a branch is set.
- **TrashService**: Reversible removal moves directories to <worktreeDir>/.trash/<id>/payload with a manifest sidecar and, when a commit is known, a pin ref that keeps the trashed HEAD's objects alive through git gc until the reaper runs. Payloads whose `du` failed are remembered for the process lifetime so they are not re-walked every sync tick.
- **TrashService.trashDirectory**: Trash containers are created with a non-recursive mkdir and retried on EEXIST, because the undo path may rm -rf the container and must never adopt one it did not create.
- **TrashService.trashDirectory**: trashDirectory never measures payload size, because the scan is the most expensive step in the trash pipeline and every caller holds the repository lock; listEntriesWithSizes fills the size in later, off the lock.
- **TrashService.trashDirectory**: The first manifest write has keepPinOnReap false and the real value is set in the second write, because the manifest validator rejects keepPinOnReap with a null pinRef and the pin ref does not exist yet.
- **TrashService.trashDirectory**: The manifest is written before the pin ref is created: a crash in between leaves a valid payload-less entry that ages out normally, instead of an unrecognized container the reaper warns about forever while its pin keeps objects alive.
- **TrashService.trashDirectory**: Keep-on-reap entries may hold the only copy of their commits, so a self-contained bundle backs up the pin ref; a bundle failure aborts the removal (fail-closed) while the source directory is still untouched.
- **TrashService.trashDirectory**: trashDirectory re-verifies the worktree's HEAD after creating the pin and bundle and fails closed if it moved, because a commit made in that window would lose every protection once the removal pipeline runs `branch -D`. Nothing slower than the bundle may run between resolution and re-check, which is why no size scan happens there; legacy adoption with an explicit headOid is exempt because its source is not a live worktree.
- **TrashService.listEntriesWithSizes**: Trash entry sizes are measured and written back by listEntriesWithSizes, never under the repository lock: the size is only informational (reaper warning, force-clean total) but `du` over a whole payload is the pipeline's most expensive step. Callers must not hold the lock (sync tail after release, force-clean preview). Measurement is best effort: failures leave sizeBytes null, reported as unknown rather than zero, and a payload whose scan failed is not walked again in the process.
- **TrashService.listEntriesWithSizes**: Payload size scans run with bounded concurrency (maxWorktreeRemoval) rather than serially, so a large prune is not slowed by a factor of that limit. Each entry is its own container, so concurrent scans touch disjoint paths and their manifest read-backs cannot race.
- **TrashService.measurePayload**: Because size measurement holds no repository lock, an entry may be restored or reaped concurrently: payloads already set aside for deletion are not scanned, and the size is merged into the manifest as re-read after the scan. A removed container has no manifest and atomicWriteFile creates no directories, so a losing write fails instead of resurrecting a deleted entry.
- **TrashService.measurePayload**: If a measured size cannot be written back to the manifest it is reported as unknown, so the single rule 'the size is whatever the manifest says' keeps the force-clean preview total and the reaper's warning consistent.
- **TrashService.trashAndUnregisterWorktree**: trashAndUnregisterWorktree is the reversible-removal sequence shared by prune and diverge-replace: move payload to trash, clear the dangling registration, delete the branch ref. A branch-ref delete failure is reported as hygiene, not a failed removal, because the payload and pin ref already capture everything restore needs and restore tolerates a leftover ref at the trashed commit.
- **TrashService.trashAndUnregisterWorktree**: Locked worktrees are refused before anything moves, because git refuses to unregister a locked worktree even with --force, so trashing one would move it into .trash/ and back on every tick.
- **TrashService.trashAndUnregisterWorktree**: `git worktree remove --force` is safe after trashing because the directory has already moved to trash and only the dangling registration is being cleared.
- **TrashService.trashAndUnregisterWorktree**: When unregistering fails and the directory is moved back, a trash_create failure audit record is written, because trashDirectory already logged success for a container that no longer exists.
- **TrashService.markReplacementCreated**: Once a diverged branch's replacement worktree exists, the trash entry's reservation of originalPath is spent (restore would collide anyway), so it is recorded as replaced and the branch syncs normally instead of staying blocked until expiry.
- **TrashService.restore**: If a reap has already set an entry's payload aside, restore reports the entry as being deleted rather than as missing, since it is committed to deletion and the user may still see files under the container.
- **TrashService.restore**: An entry is restored as a worktree only when it has a pin ref, because without it gc may already have collected the trashed HEAD's objects; otherwise only files are restored.
- **TrashService.restore**: A files-only restore of a still-synced branch warns that the next sync will treat the unregistered directory as stale (clearStaleWorktreeDirectory) and move it back to trash as a new 'orphan' entry; the warning is the user's only notice.
- **TrashService.restore**: Once the payload is back in place, cleanup failures only warn, since a retry would see 'payload missing'. The container normally holds only its manifest by then; only the cross-device fallback leaves files, so the reaper's deletion ordering is kept for that case.
- **TrashService.deleteTrashedBranchRef**: When a trash entry has no pin ref, its branch ref is kept, because it may be the last thing keeping the trashed commits out of gc.
- **TrashService.deleteTrashedBranchRef**: The trashed branch ref is deleted with headOid as the expected old value, because HEAD verification is not atomic with the deletion and a commit can land before the .git link is detached; a moved ref is then refused and reported as a leftover ref instead of orphaning the new commit.
- **TrashService.releaseAdoptedKeepRef**: Releasing an adopted legacy keep ref does not require a bundle, because createBundleFromRef produces none exactly when the commits are already on a remote, the case where the legacy ref protects least.
- **TrashService.stripToolFiles**: Before restore, tool-written files (the detached git link and `.diverged-info.json`) are removed from the payload because they would otherwise show up as untracked files in the restored tree.
- **TrashService.restoreAsWorktree**: Because `git branch <name> <sha>` sets no upstream, a restored branch is pointed at origin/<branch> when it exists so pull and status work; setting it is best effort since the worktree is complete either way.
- **TrashService.restoreAsWorktree**: If restore fails after the payload was moved into the new worktree, the payload is renamed back into the container before the rollback deletes the half-built worktree, because that directory holds the only copy of the user's files; a failed restore must leave a complete, restorable entry.
- **TrashService.restoreAsWorktree**: If the payload cannot be moved back into the container, nothing is rolled back, because deleting the directory would destroy the files; the worktree and branch stay and the user finishes with `git reset`.
- **TrashService.movePayloadInto**: Restore puts the payload back with a single rename into the directory `worktree add --no-checkout` created, which holds only its `.git` link: the link is kept, the directory dropped, the payload renamed in and the link written back, making restore O(1) instead of O(payload) under the repository lock. Git addresses the checkout by path, so an identical `.git` keeps `worktree list`, `reset` and `status` working (measured on git 2.43). onMoved fires as soon as the container no longer holds the payload, so the caller's rollback knows whether it holds the only copy; it never fires on the cross-device path.
- **TrashService.movePayloadInto**: Before recursively deleting the restore destination, movePayloadInto verifies it holds exactly the `.git` link git just registered, because the invariant that makes the delete safe is enforced in another function.
- **TrashService.movePayloadInto**: The payload's `.git` link is replaced before the rename into the destination, not after, so no crash leaves files at the destination describing themselves wrongly (a stale or missing link needing `git worktree repair`). The old `.git` is removed rather than overwritten because it can be a directory, which writeFile cannot replace.
- **TrashService.movePayloadInto**: Only a cross-device (EXDEV) rename failure falls back to copying; every other error propagates, because silently falling back would trade the O(1) move for an O(payload) copy under the repository lock without notice.
- **TrashService.copyPayloadOver**: The cross-device restore fallback overlays the payload onto the destination while skipping the payload's top-level `.git`, which is stale, so the fresh link already written into the destination survives.
- **TrashService.createPinRef**: A failure to create a trash pin ref degrades the entry to files-only instead of blocking the removal, since the payload itself is still fully preserved.
- **TrashService.undoPartialTrash**: Undoing a partial trash uses the reaper's deletion ordering so a refused delete leaves a container that still reads as a trash entry (listed, sized, ageing out) rather than unrecognized content.
- **TrashService.generateId**: Trash ids become refname components, so the base name is sanitized: the timestamp prefix and hex suffix rule out leading dots and '.lock' endings, and '..' runs are replaced because they would make the pin ref invalid and silently degrade the entry to files-only.

### `src/services/worktree-creation.service.ts`

- **WorktreeCreationService.staleDirectoryTrasher**: The stale-directory trasher is injected by WorktreeSyncService when trash is enabled so stale-directory cleanup uses the reversible-removal pipeline; GitService cannot own a TrashService directly because TrashService depends on GitService.
- **WorktreeCreationService.addWorktreeNoCheckout**: addWorktreeNoCheckout registers a worktree and writes its .git link without populating files, so restore can move the preserved payload in; the resulting directory holds only the `.git` file, which makes replacing it wholesale safe.

### `src/services/worktree-mode-sync-runner.ts`

- **WorktreeModeSyncRunner.remoteRefsPrunedThisAttempt**: remoteRefsPrunedThisAttempt starts false so a runner that has never fetched (a sync that threw before the fetch phase, or an idle TUI instance) cannot vouch that remote-tracking refs are freshly pruned.
- **WorktreeModeSyncRunner.getPendingDivergedBranches**: A diverged-replace trash entry whose replacement worktree was never created reserves its branch, so sync does not take originalPath before the user can restore the only copy of the work. To avoid stranding branches, the reserve ends once replacedAt is set, only a definitive 'missing' probe reserves (an unverifiable one lets the branch sync), and `.diverged/` copies never reserve because nothing restores from or cleans them up.
- **WorktreeModeSyncRunner.getPendingDivergedBranches**: With trash disabled no diverged branch is reserved, because the reaper leaves existing entries alone and nothing would ever release the reserve, permanently stopping the branch from syncing.
- **WorktreeModeSyncRunner.getPendingDivergedBranches**: Listing trash entries for diverged reservations is deliberately not wrapped in error handling: listEntries already returns empty for a missing root, so an error means an unreadable existing root, and treating it as 'nothing reserved' could let sync take a path a payload is waiting on.
- **WorktreeModeSyncRunner.getPendingDivergedBranches**: A diverged reservation ends at the entry's expiresAt even though the reaper may keep an expired entry listed.
- **WorktreeModeSyncRunner.didPruneAllRemoteRefs**: didPruneAllRemoteRefs is true only after a completed `fetch --all --prune`, because the reaper uses it to decide whether a 'commits are on a remote' reading is trustworthy enough to release a permanent recovery ref.
- **WorktreeModeSyncRunner.blockedByDisabledTrash**: A removal authorized only by the fully-pushed-before-upstream-deletion proof is blocked when trash is disabled, because it would permanently delete commits whose remote branch may have been deleted unmerged.
- **WorktreeModeSyncRunner.pruneOldWorktrees**: The removal audit record must be written before data is removed; an unwritable audit log blocks the removal (fail-closed).
- **WorktreeModeSyncRunner.handleDivergedBranch**: Recording that a diverged branch's replacement worktree was created is best effort; if it fails the trash entry keeps reserving the branch until it expires, which the reservation log line makes visible.
- **WorktreeModeSyncRunner.divergeWorktree**: Diverged-replace trashes with keepPinOnReap because it holds the only copy of never-pushed commits, so a pin or bundle failure aborts while the worktree is still intact.
- **WorktreeModeSyncRunner.divergeWorktree**: For trashed diverged worktrees the diverged-info file is written next to manifest.json rather than into the payload, so restore does not leave it behind as an untracked file.
- **WorktreeModeSyncRunner.writeDivergedInfoFile**: The diverged-info instructions assume the copy is detached from git, so every step runs elsewhere: a trashed copy is restored through the trash CLI, while a `.diverged/` copy is held only by its keep ref.

### `src/services/worktree-sync.service.ts`

- **WorktreeSyncService.purgeTrashEntry**: Purging one trash entry goes through TrashReaperService.purgeEntryUnlocked rather than unlinking the container, so keepPinOnReap entries get their permanent keep ref before anything is deleted (aborting if that fails) and the payload is set aside and audited exactly as in an expiry reap. The entry is looked up inside the lock so 'no such entry' is judged against the listing the purge acts on.
- **WorktreeSyncService.getForceCleanPreview**: The force-clean preview is the only screen showing trash bytes and runs outside the repository mutex, so it measures unmeasured payloads; measuring there keeps the scan off the lock while showing a fresh entry's size on first open rather than 'unknown'.
- **WorktreeSyncService.forceClean**: forceClean receives the entry ids and ref names the confirmation actually showed, not counts, because the preview runs outside the mutex and a sync during the human pause can add entries and keep refs holding never-pushed commits that the final gc would destroy. Anything not selected is left in place and reported.
- **WorktreeSyncService.forceClean**: Force clean retains and reports keep refs whose `.diverged/<name>` directory still exists, because the directory and the ref are two halves of one preserved worktree and dropping the ref before gc would leave the directory's recovery instructions dead.
- **WorktreeSyncService.forceClean**: Force clean iterates the live keep-ref listing filtered by the selection, so refs minted since the preview are skipped and selected refs already gone are never attempted.
- **WorktreeSyncService.forceClean**: The force-clean result drops the survivors' ids because a result reports counts, never a set to act on; the recount runs inside the exclusive operation so it does not measure sizes and reports what manifests already say.
- **WorktreeSyncService.forceClean**: Force clean reports the reaper's own deletion count rather than a before/after difference, since a re-scan cannot tell a deletion from an entry that failed and stayed.
- **WorktreeSyncService.isKeepRefReserved**: A keep ref is reserved when a `.diverged/` directory still depends on it: current entries share the directory's name, while older ones named `diverged-<timestamp>-<sanitized branch>` are matched on the sanitized branch segment. A false positive only retains a ref, while a miss would lose commits.
- **WorktreeSyncService.getDivergedDirectoryNames**: Every entry name under `.diverged/`, including files and symlinks, counts as a keep-ref reservation, because retaining a ref costs disk while dropping one can cost commits; an unreadable directory makes the operation refuse to delete recovery refs.
- **WorktreeSyncService.deleteKeepRefs**: deleteKeepRefs drops many keep refs behind one confirmation, deleting only the names the confirmation listed since a sync during the pause can mint new ones. Deletion is per-ref best effort rather than one `update-ref --stdin` transaction, because one ref locked by another git process aborts the whole transaction (measured on git 2.43.0).
- **WorktreeSyncService.dropKeepRefsUnlocked**: Dropping keep refs intersects the live listing with the selection, so refs minted since the listing are never deleted and selected refs already gone are reported missing.
- **WorktreeSyncService.runTrashMaintenanceUnlocked**: Trash maintenance runs at the end of every sync attempt including failed ones, inside the held lock, and never fails the sync; it runs before gc so freshly released pin refs can be collected in the same maintenance window.
- **WorktreeSyncService.runTrashMaintenanceUnlocked**: The reaper's remoteRefsFresh flag comes from the runner's record of whether the current attempt's pruning fetch completed, because trash maintenance runs in the sync's finally block, failed attempts included, and the caller cannot know.
- **WorktreeSyncService.sync**: sync sets an operationRan flag as the first statement inside the exclusive operation so its outer finally can tell whether the operation ran; the result cannot, because a sync that trashes a worktree and then throws produces no result, and its entries would otherwise stay unmeasured.
- **WorktreeSyncService.sync**: Trash maintenance runs even when the sync failed, because it acts only on local expiry state and a persistently failing fetch must not let .trash/ grow without bound; gc remains success-only.
- **WorktreeSyncService.sync**: Trash payload sizes are measured after the repository lock and mutex are released, because the `du` scan is slow enough that running it under the lock would make MCP calls fail fast and TUI actions queue. It runs in a finally so a sync that trashed then threw still measures, is awaited so it finishes before the next tick or reaper, and never throws so it cannot mask the sync's failure.
- **WorktreeSyncService.measureTrashSizesOffLock**: measureTrashSizesOffLock runs outside the lock and drops failures, since a missing size should not fail a finished sync and the next tick or force-clean preview measures it. As a result the reaper's warnSizeBytes warning lags one tick for newly trashed entries, which only under-states accumulation and cannot raise a false alarm.

### `src/types/index.ts`

- **Config.trash**: With trash enabled, every automatic or manual removal moves the directory to <worktreeDir>/.trash/<id>/ with a manifest and a pin ref (refs/sync-worktrees/trash/<hash>/<id>) that keeps the trashed HEAD alive through git gc for the retention window; a reaper deletes expired items after every sync attempt, failed ones included. It applies to worktree mode only, since clone mode never removes its checkout.
- **KeepRefDropResult**: A batch `--drop-all-keep-refs` run is per-ref best effort like the force-clean loop: a ref that cannot be deleted is reported and the rest still go.
- **KeepRefDropResult.retained**: KeepRefDropResult.retained lists refs left alone because a `.diverged/` directory still relies on them; dropping them would leave that directory's recovery instructions dead.
- **TrashPurgeResult.deleted**: TrashPurgeResult.deleted is false when the container survived; errors explain why and the entry stays listed.
- **TrashPurgeResult.keepRefsMinted**: TrashPurgeResult.keepRefsMinted lists permanent keep refs created before the payload was deleted for entries whose commits were on no remote; empty is normal, and a non-empty list tells the user where the commits went.
- **ForceCleanSelection**: ForceCleanSelection is the exact set a force-clean confirmation refers to: the preview is taken outside the mutex and confirmed an unbounded time later, so on-screen counts only summarize these names and the purge deletes these and nothing else.
- **ForceCleanResult**: ForceCleanResult deliberately does not extend ForceCleanSelection: its counts describe what survives the purge, so inherited ids would name the survivors, and `forceClean(lastResult)` would type-check and destroy exactly what the run spared.
- **ForceCleanResult.gcSkipped**: ForceCleanResult.gcSkipped is true when gc was deliberately not run because a git command was in flight or an operation was half-finished in a checkout sharing the object store; it is distinct from gcSucceeded false, which means gc ran and failed.

### `src/utils/detach-git-link.ts`

- **detachGitLink**: A moved-aside worktree's .git file still points at <bare>/worktrees/<name>, which the replacement worktree re-registers, so running git inside the copy would act on the live branch. detachGitLink renames that gitlink file to cut the link; a real .git directory is its own repository and is left alone.
- **dropDetachedGitLink**: On restore the directory is re-linked to the repository afresh, so the detached gitlink saved by detachGitLink is deleted rather than renamed back.

### `src/utils/git-validation.ts`

- **isGitCreatableBranchName**: Branch names read back from trash manifests are checked against git's own check_refname_format rules plus git branch's leading-dash rule, not the stricter isValidGitBranchName used for names users ask the tool to create. A stricter check would make entries for git-valid names like v1./x unlistable, unrestorable and unreapable. It deliberately does not delegate to the stricter validator, accepts @ like git, and leaves HEAD allowed because erring wide only costs a clearer git error (verified against git 2.43.0).

### `src/utils/preserving-copy.ts`

- **copyTreePreservingSymlinks**: When a trash payload must be copied instead of renamed (different filesystem), the source is deleted afterwards, so the copy must be faithful. fs.cp by default rewrites relative symlinks as absolute paths into the source, which breaks pnpm-style node_modules once the source is gone, so verbatimSymlinks: true copies link targets byte for byte, matching what a rename would leave. Dangling absolute or tree-escaping links are deliberately not rewritten so the fallback behaves like the rename it replaces; dereference is not used because it would multiply size and lose the links, and hard links cannot be preserved by fs.cp.

### `src/utils/trash-container.ts`

- **removeTrashContainer**: A trash container must at every instant either have a valid manifest (listed, reapable, restorable) or be fully gone. A single recursive rm can unlink manifest.json before failing deep in payload/, leaving an unrecognized container never listed or reaped and its pin ref never released. So the payload is first renamed aside atomically and then deleted, leaving a payload-less entry the pipeline already understands, and only then is the manifest and container removed.
- **removeTrashPayload**: removeTrashPayload sets the payload aside under payload.deleting-<ts> and deletes it without touching manifest.json; if anything resists deletion it rejects with the failing path and the container remains a valid trash entry.
- **removeTrashPayload**: Only ENOENT is tolerated when renaming the payload aside (already set aside, or never moved in). ENOTDIR means the destination is a regular file and payload/ stayed put (verified on Linux); swallowing it would hand a container still holding payload/ to the recursive delete, the manifest-first deletion the ordering exists to prevent.
- **removeTrashPayload**: Every payload.deleting-* directory in the container is removed, not only the one just renamed, because an interrupted or refused earlier run may have left one behind and nothing else would ever clean it up.
- **removeEmptiedTrashContainer**: removeEmptiedTrashContainer is called only after removeTrashPayload reports the payload gone, so an interruption while removing the manifest and container can strand nothing but an empty directory.

### Tests

Why the tests that pin these decisions are built the way they are.

#### `src/__tests__/e2e/diverged-branch-reservation.e2e.test.ts`

- **diverged branch reservation**: An interrupted diverged replacement reserves the branch's original path for restore. Once replacement creation is recorded (manifest replacedAt), removing the replacement later must not re-arm the reservation, or the branch would stay unsynced forever.

#### `src/__tests__/e2e/diverged-copy-detached.e2e.test.ts`

- **diverged worktree move-aside**: A diverged worktree moved aside (to trash, or to .diverged/ with trash off) must not stay linked to the admin dir its replacement re-registers, or git run inside the copy would act on the live branch; its .git link is detached. Recovery text must not point the user into the live worktree, and restoring the copy must give a clean tree.

#### `src/__tests__/e2e/trash-unsynced-repo.e2e.test.ts`

- **trash command**: For a configured repository whose bare clone does not exist yet, `trash` answers with an empty listing in one line rather than an 'Unhandled error' stack from simple-git.

#### `src/__tests__/integration.test.ts`

- **trash root listing**: The trash root is read with readdir withFileTypes, and a failing trash listing aborts the sync rather than being swallowed, so test fakes must return Dirent-compatible entries (here an empty list) for the .trash directory.
- **RemovalAuditService**: Removal audit records gate destructive operations and are written as durable appends via fs.open, appendFile and handle.sync(), not fs.appendFile, so tests mock fs.open.

#### `src/__tests__/integration/force-clean-object-reclaim.test.ts`

- **force clean**: Force clean is the only operation meant to be irreversible and runs three steps that only make sense together: purge the selected trash entries (releasing their pin refs), delete the selected keep refs except those a .diverged/ directory still needs, then run gc. Only a real object store can show which commits are gone and which survive on purpose, so the test uses real git.
- **force clean purge**: When force clean purges a trash entry it deletes the entry's pin ref and deliberately mints no replacement keep ref, so the entry's commits become collectable.
- **force clean keep-ref sweep**: Force clean keeps a keep ref whose .diverged/ directory is still on disk, because the files and the commits they were made on are two halves of one backup.

#### `src/__tests__/integration/force-clean-snapshot.test.ts`

- **WorktreeSyncService.forceClean selection snapshot**: The force-clean modal takes its preview outside the repo mutex and then waits for a keypress, during which a cron tick can trash more worktrees. forceClean purges only the entry ids captured in the preview; purging everything present at run time destroyed entries the user never saw, including a pushed-then-deleted branch whose pin ref was the last thing keeping its commits from gc.
- **WorktreeSyncService.forceClean gc step**: Every worktree writes into the bare repository's object store, so gc is the step that can reach in-flight work; force clean skips gc (reporting index.lock) while a worktree has an index.lock from a running git add/commit or IDE staging.
- **WorktreeSyncService.forceClean gc step**: When gc is skipped because a worktree command is in flight, force clean still purges the selected trash entries: the purge is not the risky half, so it does not wait.

#### `src/__tests__/integration/git-maintenance.test.ts`

- **GitMaintenanceService forced run**: git measures prune expiry from an object's mtime, not from when it became unreachable, so a forced maintenance run can keep a short (one-hour) grace window: commits a just-deleted recovery ref held are collected on the same run, and only objects a concurrent `git commit` could still be writing are left for next time.
- **GitMaintenanceService forced run**: Prune expiry reads the mtime of the file holding the object, so old commits inside a recently written pack read as new and survive a forced gc; reclamation is deferred to the next run past the window, which is why the docs do not promise same-run reclamation unconditionally.

#### `src/__tests__/integration/no-upstream-worktree-update.test.ts`

- **TrashService.restore upstream**: A trash restore can only give the recreated branch an upstream when origin/<branch> is already fetched; if the branch reappeared on origin but nothing has fetched it, the restored branch has no upstream and must still be updated by comparing against origin/<branch>.

#### `src/__tests__/integration/stale-directory-quarantine.test.ts`

- **stale directory handling**: An unregistered directory already sitting at a managed branch's worktree path holds content sync did not create and cannot inspect. With trash disabled it is quarantined under `.removed/` rather than deleted; only an empty directory, which holds nothing to lose, is removed outright.

#### `src/__tests__/integration/trash-restore-after-gc.test.ts`

- **TrashService pin ref**: Once the removal pipeline deletes a trashed worktree's branch ref and `fetch --prune` drops the remote-tracking ref, the trashed HEAD commit is reachable from nothing else, so a trash pin ref is what keeps it alive through garbage collection and makes restore possible. The gc restore test is the only one exercising the pin against a collected repository.
- **trash payload**: Ignored build output such as node_modules does not make a worktree unsafe to prune, but it must travel with the trash payload and come back on restore, because it is the part a `git checkout` could never reproduce.
- **TrashService.restoreAsWorktree**: Restore registers the worktree with a no-checkout add and moves the payload in, then runs `git reset` so the index matches HEAD; without the reset the restored checkout would read as a tree full of untracked files.
- **TrashService.restoreAsWorktree**: Restore recreates the branch before registering the worktree or moving the payload, so when the pinned commit is missing nothing is moved or registered and the trash entry stays intact.

#### `src/__tests__/trash-cli.test.ts`

- **TrashManifest.keepPinOnReap**: The keep-on-reap marker means the entry's commits were on no remote when the worktree was pruned, so reaping the entry converts its pin into a permanent keep ref instead of dropping it.
- **trash command listing**: Trash entry sizes are measured off the repository lock, so a just-trashed entry is genuinely unmeasured; the listing shows it as unknown (null in JSON) rather than 0 B, which would misstate what deleting it frees.
- **trash command listing**: The trash reaper only runs at the tail of a sync, so entries past their expiry remain on disk; the listing marks them as overdue so users know they are only waiting for the next reap.
- **trash drop-all-keep-refs**: A squash-merging team accumulates one keep ref per pruned branch, and dropping them one typed confirmation at a time does not scale, so a batch drop-all-keep-refs command exists behind the same interactive-TTY gate.
- **trash drop-all-keep-refs**: The batch keep-ref drop deletes exactly the refs listed to the person who confirmed, not whatever keep refs exist when the lock is finally held.
- **trash purge**: A keep-on-reap entry's commits reached no remote, so its payload and pin may be the only copy; purging it mints a permanent keep ref first, and both the prompt and the result name that ref and commit.

#### `src/services/__tests__/bare-repo.interrupted-clone.test.ts`

- **BareRepoService interrupted clone recovery**: git clone --bare creates HEAD within milliseconds, so a HEAD-less bareRepoDir comes from a half-finished cleanup or external damage rather than a killed clone; since bare repo existence is decided by bare/HEAD, every later initialize would retry the clone and fail on the non-empty destination. A pending marker is written only for a destination verified absent or empty, which makes a marked HEAD-less directory provably one sync-worktrees made and the only kind that may be deleted and recloned; anything else is left untouched and named in an error.
- **BareRepoService interrupted clone recovery**: After a successful reclone the pending marker is removed (settled), so the next initialize adopts the repository instead of deleting it again.
- **BareRepoService interrupted clone recovery**: A bareRepoDir destination that cannot be listed, including one that is a regular file, is never claimed with a pending marker, so no run is ever authorized to delete what is actually there.

#### `src/services/__tests__/bare-repo.service.test.ts`

- **BareRepoService interrupted clone recovery**: A HEAD-less bareRepoDir is a leftover of a half-finished cleanup or external damage, and because bare repo existence is decided by bare/HEAD, initialize would otherwise retry the clone into it forever. A pending marker records that such a leftover was made by sync-worktrees, and it is written only for a destination verified absent or empty, so nothing else is ever deleted.
- **BareRepoService interrupted clone recovery**: A recovery reclone re-arms the pending marker before cloning and settles it after, so a kill during the retry is recoverable too and a later initialize adopts the result.
- **BareRepoService interrupted clone recovery**: The pending marker authorizes a deletion, so it is written only for a positively verified destination. A destination that exists but cannot be listed (a transient EMFILE, or a regular file) is neither claimed nor cloned into, because claiming it would license deleting whatever is there on the next run.
- **BareRepoService interrupted clone recovery**: An unclaimed destination stays unclaimed across runs, so a subsequent initialize must also refuse to delete it.
- **BareRepoService interrupted clone recovery**: When the clone itself fails (auth, network) on a claimed destination, git removes the directory it created, so the pending marker authorizing deletion is removed with it.
- **BareRepoService interrupted clone recovery**: When a failed clone leaves a partial directory, the pending marker stays so the next run recovers it instead of erroring out.

#### `src/services/__tests__/branch-ref.commit-count-parse.test.ts`

- **GitService.countCommitsNotOnAnyRemote**: git rev-list --count either prints a number or exits non-zero, so parse tests use mocks for output real git never produces. Two callers, the trash bundle and the reaper's permanent keep ref, read zero as nothing worth preserving, so a count that could not be read must never become zero.
- **GitService.countCommitsNotOnAnyRemote**: The commits-not-on-remote count excludes only refs/remotes/origin, not all remotes, because a ref under a removed remote survives every fetch --all --prune and would make the count read zero for commits no remote has.
- **GitService.countCommitsNotOnAnyRemote**: A 400-digit string passes a digits-only check but parseInt returns Infinity, so the count parser also requires Number.isInteger; otherwise it would return a non-zero count that fails closed only by accident.

#### `src/services/__tests__/branch-ref.commits-not-on-remote.test.ts`

- **GitService.countCommitsNotOnAnyRemote**: countCommitsNotOnAnyRemote decides whether a trash entry gets a bundle and whether a reaped entry gets a permanent keep ref, so its answers for a squash merge, a re-push and an unpruned remote-tracking ref are pinned with real git rather than assumed.
- **TrashReaper keep refs**: A squash merge puts a branch's content on main as one new commit, so the original commits are reachable from no remote-tracking ref and still need an anchor, which is why the reap-time re-check does not stop keep refs from accumulating.
- **TrashReaper keep refs**: When the same commits reach the remote again under another branch name, the count reads zero and the reap-time re-check correctly skips creating a permanent keep ref.
- **GitService.countCommitsNotOnAnyRemote**: A remote-tracking ref that git has not pruned yet keeps its commits reachable, so the count reads zero for a branch the remote already dropped; callers may only act on a zero when they can vouch that the ref set is fresh.

#### `src/services/__tests__/branch-ref.ref-argument-separator.test.ts`

- **GitService.updateRef**: The reaper promotes a trash pin to a permanent keep ref through updateRef with the manifest's headOid as value, and git update-ref ref -d exits 0 after deleting the ref, so without a separator the call meant to create the keep ref would remove it on the entries whose commits may exist nowhere else.

#### `src/services/__tests__/branch-ref.service.test.ts`

- **GitService.countCommitsNotOnAnyRemote**: The commit count excludes only origin's refs, not every remote-tracking ref present, because a ref left behind by a removed remote survives fetch --all --prune and would make the count zero for commits no remote has.

#### `src/services/__tests__/git.service.client-cache.test.ts`

- **GitService.addWorktree**: When addWorktree finds a directory at the target path that is registered to no worktree, it hands the directory to the stale-directory trasher and recreates the worktree at the same path; the clients cached for the old directory must be dropped so the recreated worktree uses freshly built ones.

#### `src/services/__tests__/git.service.initialize.test.ts`

- **GitService.initialize**: A directory at the default branch's worktree path that is not a registered worktree (for example a checkout left after the user deleted .bare/) is never adopted as the main worktree, because every later fetch would run inside a non-repository. It is trashed or quarantined like any other stale directory and the default-branch worktree is recreated and registered.
- **TrashService**: When a worktree directory is moved to trash, its .git link is renamed to .git.detached so git no longer resolves a repository inside the trashed payload.
- **GitService.initialize**: With trash disabled, a stale directory containing a .git is never deleted; it is quarantined under the .removed/ directory instead.

#### `src/services/__tests__/git.service.test.ts`

- **GitService.ensureMainWorktree**: A directory at the default-branch worktree path is either the registered worktree, which is reused, or stale (left after .bare/ was deleted, or unrelated). A stale one goes through the same trash/quarantine handling as other stale directories and is never adopted, since the primary git client would point at a non-repository and every fetch would fail.

#### `src/services/__tests__/removal-audit.service.test.ts`

- **RemovalAuditService.record**: RemovalAuditService opens the log file and fsyncs each line instead of using appendFile, because 'attempt' entries gate destructive operations and must be durable before the operation proceeds.

#### `src/services/__tests__/trash-migration.service.test.ts`

- **TrashMigrationService.migrateLegacyUnlocked**: When a legacy .removed/ quarantine is adopted into trash, retention counts from the adoption time; the original quarantine timestamp is kept only as a forensic legacyQuarantinedAt field.
- **TrashMigrationService.migrateLegacyUnlocked**: After adopting its contents, the emptied legacy .removed/ directory is deleted so the migration converges and does not run again.
- **TrashMigrationService.migrateLegacyUnlocked**: Adopted entries are never backdated to the legacy quarantine time, because an old entry would then be expired on arrival and a same-tick reap would delete it with zero grace.
- **TrashMigrationService adoption of .diverged/**: .diverged-info.json is user-editable and its originalBranch/localCommit become the adopted manifest's branch/headOid, which readManifest validates against git's rules. Entries with values readManifest would refuse are left in .diverged/, where their legacy keep ref still protects them, instead of being moved into a trash entry nothing would ever list, restore or reap.
- **TrashMigrationService adoption of .diverged/**: Adoption deletes the legacy keep ref exactly once, rather than leaving it for the reaper, which would shadow it with a second permanent keep/<trashId> ref.
- **TrashMigrationService adoption of .diverged/**: The legacy keep ref, which protects never-pushed commits from gc, is released only after the replacement pin ref and bundle are in place.
- **TrashMigrationService adoption of .diverged/**: The adopted entry's manifest records the pin ref and bundle file before the legacy keep ref is released, so a crash at any point leaves a manifest that knows where the commits are held.
- **TrashMigrationService adoption of .diverged/**: If deleting the legacy keep ref is refused, the ref may still exist, so the adopted payload's info file continues to point at it.
- **TrashMigrationService adoption of .diverged/**: After adoption the payload's info instruction points at sync-worktrees trash restore, not the TUI view that lists only .diverged/ directories, since the payload has left .diverged/.
- **TrashMigrationService adoption of .diverged/**: A trashed copy is detached from git, so the recovery instruction recreates the branch against the bare repository with git -C rather than suggesting git diff or push inside the payload.
- **TrashMigrationService adoption of .diverged/**: Adopted backups are keepPinOnReap: on expiry the reaper mints a permanent keep/<id> ref for their never-pushed commits and only the files age out, so the instruction tells users to run trash drop-keep-ref to discard rather than saying nothing needs doing.

#### `src/services/__tests__/trash-reaper.service.test.ts`

- **makeGitStub**: The git stub reports a non-zero count of commits on no remote by default, because entries are pinned for keep-on-reap precisely when their trashed commits exist on no remote.
- **TrashReaperService.purgeAllUnlocked**: Force clean purges only the entries its confirmation preview named; anything trashed after the preview was never shown, so it is kept. The result reports how many were skipped, because a purge that silently leaves entries behind is its own surprise.
- **TrashReaperService.purgeAllUnlocked**: During force clean, the pin ref of an entry that was not in the confirmed set must survive, including the orphaned-pin sweep, because force clean runs git gc next and the pin is what keeps that entry's commits reachable.
- **TrashReaperService.purgeAllUnlocked**: Between the force-clean preview and the purge, a named entry can disappear (the expiry reaper on an intervening sync took it) or be half-deleted with an unparseable manifest. Neither case fails the purge run.
- **TrashReaperService.purgeAllUnlocked**: A trash entry whose manifest is unreadable keeps its payload: the reaper cannot prove what it would delete, so the invalid-entry rule leaves it untouched.
- **TrashReaperService orphan pin sweep**: The orphan pin-ref sweep never deletes legacy flat refs, since it cannot tell its own from those of another config sharing the bare repo. Legacy entries therefore release their pin through the manifest, which names the exact ref the entry owns; otherwise the pin would outlive the payload forever.
- **TrashReaperService.reapExpiredUnlocked**: For a legacy flat-pinned keepPinOnReap entry with unpushed commits, reaping must create the permanent keep ref from the entry id before releasing the flat pin named in the manifest; getting that order wrong loses the only copy of the commits.
- **TrashReaperService warnings**: Warnings about unrecognized trash content and legacy flat pin refs are emitted once per process and again only when the set changes, because both are steady states the reaper never acts on and repeating them every hourly tick buries warnings that need attention.
- **TrashReaperService warnings test**: The warning-dedup test writes a file into each manually placed directory because the reaper removes empty invalid containers instead of warning about them.
- **TrashReaperService warnings**: Warning deduplication for unrecognized trash entries resets when the entry disappears, so content that is removed and later reappears is warned about again as a new situation.
- **TrashReaperService.reapExpiredUnlocked**: When the trash root is missing, the reaper leaves all pin refs alone: worktreeDir may be an unmounted volume that sync recreated empty, and sweeping pins would let gc collect objects whose manifests reappear on remount.
- **TrashService.listEntriesWithSizes**: Trashing writes the manifest with sizeBytes null; the size is measured later by listEntriesWithSizes, off the repository lock. The size warning totals manifest sizes, so the test runs listEntriesWithSizes first to emulate the pass a previous tick would have made.
- **TrashReaperService size warning**: Freshly trashed entries have sizeBytes null until sizing runs off the repository lock, so the trash size total is only a lower bound. The warning says 'at least' and names unmeasured entries, otherwise a 40 GB accumulation could read as 4 GB.
- **TrashReaperService.commitsReachedARemote**: When re-checking whether trashed commits reached a remote fails, the reaper fails closed and mints the keep ref, because the commits may be the only copy left anywhere.
- **TrashReaperService.commitsReachedARemote**: A remote-tracking ref that fetch --prune has not removed yet still makes its commits look reachable, so a zero count against stale refs could release the anchor for commits the remote no longer has. Unless the current tick's pruning fetch completed, the reaper does not ask at all and mints the keep ref.
- **TrashReaperService.purgeEntryUnlocked**: The CLI 'trash --purge <id>' path creates the permanent keep ref for a keepPinOnReap entry before deleting anything, following the expiry reaper's ordering rather than purgeAllUnlocked, whose confirmation covered recovery refs. Because a CLI purge has fetched nothing, remote-tracking refs may be stale, so it never consults the commits-on-remote count and always mints the ref.
- **TrashReaperService.purgeEntryUnlocked**: Setting the payload aside by rename is the first irreversible step of a purge, so the keep ref must be created before that rename.
- **TrashReaperService.purgeEntryUnlocked**: When a purged entry's keep ref cannot be created, its pin ref is also kept, because the pin is then the only thing holding the commits.
- **TrashReaperService.reapExpiredUnlocked**: Diverged-replace removals also set keepPinOnReap, because the trashed commits may exist nowhere else and must never silently become gc-eligible.
- **TrashReaperService.reapExpiredUnlocked**: A recursive fs.rm of a trash container reaches manifest.json before a deep payload file it cannot unlink, leaving a container that is neither listed nor deleted, never retried, and holding its disk and pin forever. The reaper therefore removes the payload before the manifest so a failed delete leaves a listed, retryable entry.
- **TrashReaperService.reapExpiredUnlocked**: A run killed between renaming the payload aside and deleting it leaves the payload under its set-aside name. Nothing else returns for it, so the next reap must delete it, and before the manifest, or the stuck container just moves one step later.
- **TrashReaperService.reapExpiredUnlocked**: Once the payload is deleted the pin protects nothing restorable, so it is released even if the container itself cannot be deleted (read-only trash root, immutable manifest). The orphan sweep keys on the still-present container name, so otherwise nothing would ever release the ref.
- **TrashReaperService set-aside rename**: A regular file on the set-aside name makes rename(dir, file) fail with ENOTDIR while payload/ stays in place. Tolerating that errno would unlink the file, report the payload gone, and send a container still holding payload/ to the recursive delete, the manifest-first delete the ordering exists to prevent.

#### `src/services/__tests__/trash.service.branch-config.test.ts`

- **TrashService.deleteTrashedBranchRef**: git branch -D removes the branch's config section along with the ref, but the compare-and-swap delete the trash pipeline uses (update-ref -d refs/heads/<b> <oid>) removes only the ref; measured on git 2.43, branch.<b>.remote and .merge stay in the bare repo config. The trash pipeline therefore removes the section itself after a successful CAS delete, and never when the CAS delete was refused, so the config file does not grow without bound.
- **TrashService.deleteTrashedBranchRef**: Moving the branch ref away from the verified oid models a commit landing between HEAD verification and the delete; the manifest oid no longer matches, git refuses the CAS delete, and the branch config section must be kept because the branch is still live.
- **TrashService.deleteTrashedBranchRef**: git config --remove-section on an absent section exits 128 with stderr, which simple-git rejects. The trash pipeline tolerates that failure so a branch deletion that succeeded is not reported as failed.
- **TrashService.deleteTrashedBranchRef**: git branch -D drops the entire [branch "<name>"] section, including keys it never wrote (measured on git 2.43 with .description and .rebase). The trash pipeline matches that by removing the whole section, since unsetting remote and merge one at a time would leave an empty header and other keys behind.
- **TrashService.deleteTrashedBranchRef**: Git config subsections are case-sensitive: --remove-section branch.feature-x against [branch "Feature-X"] fails with 'no such section', and that error is swallowed. The branch name is therefore passed with its exact case, otherwise every non-lowercase branch (JIRA-123, Release/2.0) would silently leak its section.
- **TrashService.deleteTrashedBranchRef**: git config --remove-section branch.v1.2 splits at the first dot and treats v1.2 as the whole subsection name (verified on git 2.43), so removing a dotted branch's section leaves a sibling branch.v1 section untouched.

#### `src/services/__tests__/trash.service.payload-size.test.ts`

- **TrashService.trashDirectory**: Trashing a worktree holds the repository lock from end to end, so it never runs du over the worktree; the manifest is written with sizeBytes null and sized later.
- **TrashService.listEntriesWithSizes**: Payload sizing deliberately runs without the repository lock, so a restore or reap holding the lock can remove the container mid-scan; writing the size back must not recreate it.
- **TrashService.listEntriesWithSizes**: If a container disappears during sizing, the size write-back must leave nothing behind: neither a listed entry nor an unrecognized container the reaper would warn about forever.
- **TrashService.measurePayload**: Sizing runs off the repository lock while the diverged-replace flow can call markReplacementCreated under it. The measured size is merged into the manifest as it reads at write time, not the copy the scan started from, so concurrent updates such as replacedAt are not erased.
- **summarizeTrashEntries**: An unsized trash entry is counted as unknown size rather than zero, because the force-clean confirmation shows it next to its byte total and the reaper warning threshold must ignore it; counting it as zero would silently understate both.
- **TrashService.listEntriesWithSizes**: Payload sizing runs up to maxWorktreeRemoval scans at once. Running them serially would multiply the wall clock of a large prune by that factor, since sizing still runs inside the sync waiting on it, even though it is off the repository lock.

#### `src/services/__tests__/trash.service.restore-rename.test.ts`

- **TrashService.restore**: Restore registers the worktree with git worktree add --no-checkout and then renames the trashed payload over the directory git just created. Whether git tolerates the replaced directory is verified against a real repository (worktree list, status and reset must keep working) rather than reasoned about.
- **TrashService.trashAndUnregisterWorktree**: Trashing renames the payload's .git link to .git.detached, so git commands run inside a trashed payload resolve no repository.
- **TrashService.restore**: Restore moves the payload directory back into place with a rename rather than copying file by file, so the restored directory keeps the payload's inode.
- **TrashService.restore**: When restore fails after the move, rollback renames the payload back into the container, so git worktree remove --force runs against a missing path. Measured on git 2.43 that still succeeds and clears the registration, letting the next attempt register the path again instead of hitting 'missing but already registered'.

#### `src/services/__tests__/trash.service.test.ts`

- **TrashService.trashDirectory**: Rolling back a half-made trash entry is a delete like any other; when it is refused, what remains must be something the pipeline can still see and finish, namely a payload-less entry that lists and ages out with the retention window.
- **TrashService.trashDirectory**: trashDirectory resolves HEAD to pin it and re-checks HEAD just before moving the payload; a commit made by the user in between aborts the trash and rolls back the pin.
- **TrashService.trashDirectory**: For keep-on-reap entries the first manifest is written before the bundle is created, so a process killed during bundle creation leaves an entry that still lists and ages out rather than landing in invalid.
- **TrashService.trashAndUnregisterWorktree**: Removal deletes the branch ref conditionally, only while it still points at the verified HEAD, so a commit racing the removal keeps its branch.
- **TrashService.trashAndUnregisterWorktree**: When unregistering fails and the source directory is restored, the .git link that trashing renamed to .git.detached is put back too, so the worktree is usable again.
- **TrashService.readManifest**: The manifest branch check must accept every name git itself creates; any stricter check would make such entries unlistable, unrestorable and unreapable. In particular '@' is accepted by git branch and git check-ref-format --branch (git 2.43) even though sync-worktrees never creates one.
- **isGitObjectId**: Manifest headOid values shorter than four characters are rejected because git's shortest usable abbreviation is 4, so such an oid was never written by sync-worktrees.
- **TrashService.readManifest**: JSON.stringify drops undefined values, so a hand-edited manifest loses a field by omitting the key. null is meaningful for branch and headOid, and isWorktreeRestorable tests !== null, so an absent branch would reach git branch undefined <oid>; absent keys are therefore rejected rather than read as null.
- **TrashService.readManifest**: Early releases wrote flat pin refs (<prefix><id>) before refs were namespaced per trash root. The validator accepts that layout, since refusing it would strand every pre-upgrade entry: unlisted, unrestorable, never reaped, and pinned through every gc.
- **TrashService.readManifest**: Every optional manifest field was added after the manifest itself, and JSON.stringify writes no key for undefined, so older entries lack them entirely. Absence must read as not set, otherwise upgraded entries become unrecognized content that is never listed, restored or reaped while their pins hold objects forever. replacedAt is not tested by deletion because trashDirectory never writes it, so removing it would not change the JSON.
- **TrashService.restore**: A manifest written by a pre-namespacing release, with a flat pin and none of the later optional keys, must still be restorable, since the payload is the user's only copy of the files and the flat pin is the only thing holding the commit.
- **TrashService.listEntries**: Relocating worktreeDir moves .trash with it, and the entries inside must still be recognized and age out; an entry read as invalid is never reaped and its pin ref never released, leaking disk and object store permanently.
- **TrashService.movePayloadInto**: Restore moves the payload into the recreated worktree with a single rename, mirroring trashing. The alternative is O(payload) work under the repository lock: copying the sync-worktrees repository's own node_modules (282 MB, 23k entries) and deleting the source took 13s versus about 2ms for the rename.
- **TrashService.movePayloadInto**: When a payload's own .git is a directory rather than a link, restore must still replace it with the link the fresh registration wrote; a plain file overwrite cannot replace a directory, so it is removed first.
- **TrashService.movePayloadInto**: The trash root lives under worktreeDir so payload and destination are normally on one filesystem, but a bind mount or symlinked worktreeDir can split them; on EXDEV, restore falls back to copying the payload.
- **TrashService.restoreAsWorktree**: After the payload moves, the recreated worktree holds the only copy, and a failed restore's rollback deletes that directory. The move is therefore undone first, otherwise a restore failing halfway would destroy the files it exists to preserve.
- **TrashService.restoreAsWorktree**: Restore corrects the payload's .git link before moving it, so a failed write happens while the container still holds everything. Writing it after the rename meant a crash in between stranded a worktree pointing at a pruned admin dir and a payload-less trash entry whose retry reported the payload missing.
- **TrashService.movePayloadInto**: movePayloadInto recursively deletes the destination before renaming the payload over it, which is safe only because worktree add --no-checkout just created it holding the .git link alone. restore() refusing existing destinations enforces that elsewhere, so movePayloadInto also refuses any destination holding more than that link, to avoid a silent recursive delete of live data if the invariant slips.
- **TrashService.movePayloadInto**: The copy fallback applies to EXDEV only. Letting any other rename failure silently become a copy would turn the O(1) move back into an O(payload) copy under the repository lock with no visible error.
- **TrashService.restoreAsWorktree**: The cross-device path never reports the payload as moved, because the container still holds it. A later failure rolls back the ordinary way by removing the half-built worktree, rather than renaming the payload back over itself, which fails with ENOTEMPTY and would leave a registered worktree and stray branch.
- **TrashService.restoreAsWorktree**: If the payload has moved and cannot be renamed back, restore rolls nothing back: git worktree remove --force would delete the user's only copy, and a half-finished worktree with an explanatory error is far cheaper.
- **TrashService.restoreAsWorktree**: git branch <name> <sha> leaves the recreated branch without an upstream; sync fast-forwards it regardless, but pull and status in the worktree need branch.<name>.merge pointing at origin/<name>, so restore sets the upstream after registering the worktree.
- **TrashService.restore**: A files-only restore leaves an unregistered directory where a synced branch's worktree belongs, which the stale-directory path trashes again as an orphan on the next sync. The warning states that consequence, not just the shape, so the user knows to act.
- **TrashService.restore**: When worktree recreation fails, the pin ref is not released, because the manifest still names pinRef and headOid and releasing it would leave a listable entry whose commit git gc may collect. The pin release must come after restoreAsWorktree succeeds.
- **TrashService.restoreAsWorktree**: Branch creation during restore can be refused by git, for example 'cannot lock ref' when refs/heads/topic/sub exists and the entry's branch is topic; such failures are wrapped in TrashOperationError and the payload kept.
- **TrashService.restore**: An entry whose payload a reap has already set aside is committed to deletion; restore reports it as already being deleted, because 'payload missing' reads like corruption to a user who can still see the files under the container.
- **TrashService.restore**: A worktree restore normally leaves only the manifest in the container, but after the cross-device copy fallback the cleanup is a recursive delete over the user's files. It follows the reaper's ordering, so anything it cannot delete stays a listed entry the reaper will finish, never unrecognized content.
- **TrashService.releaseAdoptedKeepRef**: Releasing the keep ref that held a .diverged backup is the one destructive ref operation driven by a field from unvalidated JSON.parse, so its guards are tested directly rather than only through the adoption path, which can never present a wrong-shaped entry.
- **TrashService.releaseAdoptedKeepRef**: createBundleFromRef reports nothing to bundle exactly when the commits are already on a remote, so an adopted entry with bundleFile null may still release its legacy keep ref.
- **TrashService.releaseAdoptedKeepRef**: legacyOriginalName is string or null, so an unguarded template would build refs/sync-worktrees/keep/null and match it; releaseAdoptedKeepRef rejects entries without a legacy name before deriving the ref.

#### `src/services/__tests__/worktree-creation.stale-directory.test.ts`

- **WorktreeCreationService.clearStaleWorktreeDirectory**: A non-empty directory found at a managed worktree path is unknown content someone may have left by hand, so it is moved aside (trash or .removed quarantine) and never deleted permanently.

#### `src/services/__tests__/worktree-mode-sync-runner.lfs.test.ts`

- **WorktreeModeSyncRunner.didPruneAllRemoteRefs**: The trash reaper releases a permanent recovery ref only when remote-tracking refs are current, and only a completed fetch --all --prune makes them so; didPruneAllRemoteRefs reports whether the current attempt achieved that.

#### `src/services/__tests__/worktree-sync.repo-mutex.test.ts`

- **WorktreeSyncService.purgeTrashEntry**: purgeAllUnlocked mints no keep refs because force clean's confirmation covered recovery refs; a --purge confirmation covers one entry, so single-entry purge goes through purgeEntryUnlocked, which still mints them.
- **WorktreeSyncService.purgeTrashEntry**: A purge whose reap deleted nothing reports failure, because the CLI prints 'Purged <id>' from that boolean; a zero-count case keeps a comparison widened to >= 0 from reporting success while the entry remains on disk.

#### `src/services/__tests__/worktree-sync.service.test.ts`

- **WorktreeSyncService.deleteKeepRef**: git update-ref -d exits 0 for a ref that does not exist, so deleteKeepRef checks the ref exists first; otherwise a typo would print success and audit a deletion that never happened.
- **WorktreeSyncService.deleteKeepRefs**: Batch keep-ref deletion is per-ref best effort like the force-clean loop, so one ref locked by another git process does not fail the rest; that is why deletions are not a single update-ref --stdin transaction.
- **WorktreeSyncService.deleteKeepRefs**: A .diverged/<name> directory and keep/<name> are two halves of one preserved worktree, so a keep ref whose directory still exists is retained; dropping it would leave the directory with dead recovery instructions.
- **WorktreeSyncService.deleteKeepRefs**: The listing a keep-ref confirmation is built from is taken outside the repository mutex, and a concurrent sync can reap an entry and mint a keep ref before the answer arrives; refs the user was never shown are left alone.
- **WorktreeSyncService force clean**: A .diverged/<name> directory and keep/<name> are the files and the commits of one preserved worktree. Force clean deletes neither or both, because dropping only the ref and then running gc would leave a directory whose own recovery instructions no longer work.
- **WorktreeSyncService force clean**: A recovery ref minted between the force-clean preview and the keypress (for example by a diverged-replace during a cron tick) holds commits on no remote and was never shown, so force clean leaves it and the gc cannot reach behind it.
- **WorktreeSyncService force clean**: A keep ref named in the confirmation may be gone by purge time (explicit deleteKeepRef, or its diverged directory discarded); force clean intersects the live ref listing with the selection so nothing is attempted and no error reported for it.
- **WorktreeSyncService force clean**: The gc at the end of force clean rewrites the object store every worktree shares, so it is the one step that can reach work outside the confirmed trash. If any checkout has a git command in flight (index.lock) or a half-finished operation, the gc is skipped while the purge itself still runs.
- **WorktreeSyncService force clean**: Older releases minted keep/diverged-<ts>-<branch> without recording it in the .diverged directory's metadata, so the ref name does not match the directory name. Force clean must still recognise such pre-upgrade refs as backing an on-disk .diverged copy, or it would purge the commits behind it.
- **WorktreeModeSyncRunner trash reservations**: A trash entry reserves its original path so trash --restore can put the payload back, which stops sync from recreating a worktree there meanwhile. Reservations only exist for repositories with trash enabled, whose pipeline can eventually release them.
- **WorktreeModeSyncRunner trash reservations**: If a reserved branch's original path cannot be verified, sync does not treat it as reserved: reserving on an unverifiable probe would stop the branch from ever syncing again, while a restore that later fails with a clear message is the better failure.
- **WorktreeModeSyncRunner trash reservations**: listEntries returns an empty list when the trash root is absent, so a rejection means the root exists but could not be read. Sync aborts rather than treating that as no reservations, which would let it take a path whose payload awaits restore and make that restore fail with the only copy of the work inside.
- **WorktreeModeSyncRunner trash reservations**: Once a diverged entry's replacement worktree has been created the reservation is spent; otherwise removing that replacement later (branch deleted and re-pushed) would re-arm the reservation and strand the branch until expiry.
- **WorktreeModeSyncRunner trash reservations**: The reaper can leave an expired entry listed (keep-ref mint failure, refused payload delete), so the path reservation ends at expiresAt regardless, otherwise the branch would never get a worktree again.
- **WorktreeModeSyncRunner trash reservations**: With trash disabled the reaper never touches existing entries, so a reservation taken from them could never expire; sync therefore does not reserve branches from trash entries when trash is off.
- **WorktreeModeSyncRunner trash reservations**: Nothing restores from .diverged/ and those directories are never cleaned up, so a leftover .diverged copy never reserves its branch; such a reservation would block the branch forever.
- **TrashService.trashAndUnregisterWorktree**: The trash path checks git's lock state and refuses before renaming anything, as a second line of defense for callers that do not consult the plan and for a lock taken between listing and removal.
- **WorktreeModeSyncRunner prune phase**: Trash is on by default: prune removals move data into .trash/ instead of deleting it, and a trash failure leaves the worktree in place.
- **TrashService.trashAndUnregisterWorktree**: The local branch is deleted only if it still points at the verified HEAD, so a commit racing the removal keeps its ref.
- **TrashService.trashDirectory**: Trashing writes a placeholder manifest first with pinRef and bundleFile null, then a final manifest carrying the pin ref and the self-contained bundle backup.
- **WorktreeSyncService trash maintenance**: Trash migration and reaping act only on local expiry state, so they run even when the sync fails; a persistently failing fetch must not let .trash/ grow without bound.
- **WorktreeSyncService trash maintenance**: The reaper may release a permanent recovery ref only against a ref set the current tick's fetch --all --prune refreshed. Since maintenance runs in the sync's finally block, including after failed attempts, that freshness answer comes from the runner per tick.
- **WorktreeSyncService trash maintenance**: The sync passes the reaper the actual current time, because every expiry comparison the reaper makes is against it; a frozen clock would silently stop reaping.
- **WorktreeModeSyncRunner diverged handling**: Diverged-replace trashes the only copy of never-pushed commits, so its entry is marked keepPinOnReap so the pin outlives trash expiry, and it is backed by a bundle.
- **TrashService.markReplacementCreated**: Once the replacement worktree exists, the diverged-replace manifest records replacedAt so the entry stops reserving the branch path.
- **WorktreeModeSyncRunner diverged info file**: The .diverged-info metadata is what a user reads to recover work. With trash on there is no keep ref, so the instructions point at the trash restore flow rather than a keep-ref flow that was never created.
- **WorktreeModeSyncRunner diverged info file**: With trash off the keep ref is the only thing holding a .diverged copy's commits and releasing it by hand loses them, so the info file points at the keep-ref release flow.
- **ForceCleanResult**: A force-clean result reports counts and must never be usable as a selection: its entry ids would be the survivors of that purge, so passing it as a selection would aim the next purge at exactly what the last one spared. A compile-time type assertion fails pnpm typecheck if ForceCleanResult becomes assignable to ForceCleanSelection.

#### `src/services/__tests__/worktree-sync.trash-size-off-lock.test.ts`

- **WorktreeSyncService.sync trash sizing**: A sync tick can move a worktree to trash and then fail in a later phase; the sync still runs the trash size pass on that path, because nothing else measures it until the next tick, and a repository that keeps failing would otherwise leave its growing trash unmeasured forever.

#### `src/utils/__tests__/git-validation.test.ts`

- **isGitCreatableBranchName**: Branch names read back from trash manifests must accept every name git can create, because a rejected manifest is never listed, restored or reaped again. The test verdicts were measured against git check-ref-format --branch and git branch on git 2.43.0.
- **isGitCreatableBranchName**: @ is accepted for manifest branch names because git branch creates it, even though the tool refuses to create one, so an entry trashed from such a branch stays restorable.
- **isGitCreatableBranchName**: Names such as v1./x are created by git branch and approved by git check-ref-format. Delegating to the stricter creation-time validator, which rejects components ending in a dot, would make trash entries for such remote branches permanently unlistable, unrestorable and unreapable.

#### `src/utils/__tests__/preserving-copy.test.ts`

- **copyTreePreservingSymlinks**: The symlink-preservation test deletes the source before asserting anything, because a link wrongly rewritten to an absolute path under the source still resolves while the source exists and would pass against the very bug it guards.
- **copyTreePreservingSymlinks**: Option forwarding is tested through filter rather than force, because fs.cp defaults force to true so dropping it would change nothing observable, whereas filter only works if the caller's options reach fs.cp.

## Consequences

Changing code covered by an entry here means updating the entry in the same pull request. An entry that no longer holds is deleted, or superseded by a new numbered ADR when the reversal is itself a decision worth keeping.

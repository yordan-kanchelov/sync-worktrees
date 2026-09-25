# Clone mode: implementation notes

Measurements and history behind the clone-mode code in `src/services/clone-sync.service.ts` and
`src/services/clone-sync/`. They used to live as comments in `clone-sync.service.ts`; they moved here when that file
was split into modules, and the code keeps a short pointer where each one applies. The user-facing measurements for
`depth` are in [docs/clone-mode.md](../clone-mode.md); this file does not repeat them. All git measurements are on git
2.43 unless stated otherwise.

## Module map

| Module                                  | What it holds                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `clone-sync.service.ts`                 | `CloneSyncService`: per-repository state, the public API, and the order a sync tick runs in                     |
| `clone-sync/types.ts`                   | `CloneSkipReason`, `CloneSkipListener`, and the `CloneSyncContext` the modules work through                     |
| `clone-sync/phases.ts`                  | `CLONE_SYNC_PHASES` and `timePhase`, the tick's `--debug` timing                                                |
| `clone-sync/git-clients.ts`             | `CloneGitClients`: every git client, their timeouts and environment, and the primary-checkout guard             |
| `clone-sync/git-helpers.ts`             | Small pure helpers and read-only git probes shared by the modules                                               |
| `clone-sync/clone-bootstrap.ts`         | Init: adopting an existing clone, the fresh clone, failed-clone settlement and partial-clone cleanup            |
| `clone-sync/clone-markers.ts`           | The init, init-pending and incomplete-clone markers, and the initial file copy                                  |
| `clone-sync/fetch.ts`                   | The sync fetch and its shallow-depth ratchet, the LFS fetch retry, unshallow, and deepen-then-classify          |
| `clone-sync/remote-config.ts`           | Single-branch remote convergence, the stale remote-tracking ref sweep, and the origin URL check                 |
| `clone-sync/sparse.ts`                  | Sparse-checkout application after a clone and its reconciliation on each tick                                   |
| `clone-sync/fast-forward-undo.ts`       | Undoing the half-applied checkout a rejected `merge --ff-only` leaves behind                                    |
| `clone-sync/branch-operations.ts`       | The TUI branch switch (`checkoutBranch`) and the branch wizard's create-and-push                                |

## The sync fetch's depth ratchet (`fetch.ts`, `buildSyncFetchArgs`)

Why the cap stays: on a 199-commit remote of empty commits force-pushed with `reset --hard HEAD~3` plus one commit (a
197-commit tip), a `depth: 1` clone's capped fetch took 1 commit in a 3-object pack against all 197 in a 201-object
pack uncapped — and both classified `indeterminate_shallow`, so the uncapped download bought nothing and the deepen
budget ran anyway.

Why the configured depth is not re-sent verbatim: after a deepen-to-50 and a fast-forward, the next tick's `--depth 1`
cut the clone back to one commit; `merge-base HEAD origin/<branch>` then had nothing to walk even for a one-commit
advance, the tick reported `indeterminate_shallow`, and the budget bought the same 50 commits again — every tick,
discarded every time.

The unit, which was got wrong first. `--depth N` counts N ancestry levels from the fetched tip, not N commits: a
`--depth 50` fetch of a remote of merged two-commit pull requests produced a 147-commit clone. Ratcheting on
`rev-list --count HEAD` fed git a number in the wrong unit, always larger than the depth it came from, so the boundary
went deeper every tick: 1 -> 147 -> 438 -> 610 commits in three ticks of a 601-commit remote, after which the clone
held everything, was no longer shallow, and `--depth` was never sent again. `--count --first-parent HEAD` is closer and
still not the unit — a history whose branches fork below the tip shortcuts the walk, and the same run grew a
495-commit clone to the whole 1201-commit remote in one tick.

The ref, which was got wrong second. On a 120-commit remote advancing three commits a tick, `depth: 1`, worktree left
dirty after the first deepen: measuring HEAD sent 50, 47, 41, 32, 20, 5 and the window the deepen paid for was gone in
five ticks, with the first clean tick paying for a second deepen; measuring `origin/main` sent 50 every tick, held the
window at 50, and fast-forwarded with no deepen at all. The union of the two (`rev-list HEAD origin/<branch>`) is not
enough either: a union walk gives each commit its shortest distance from either tip, which under-reports once HEAD
sits off to the side of the fetched tip. Over a 400-commit remote force-pushed at the second tick, the union sent 50,
50, 49, 45, 38 and let the window shrink to 28 in five ticks, where the fetched ref alone sent 50 every time and held
it.

The non-shallow edge: `--depth 5` on a full 199-commit clone left 5 commits and `--is-shallow-repository` true, which
is why a clone that is not shallow gets no `--depth` at all.

## The branch-switch and base-branch fetch (`fetch.ts`, `buildUntrackedBranchFetchArgs`)

On a `depth: 1` clone the deepen budget had grown to 50 commits, a `--depth 1` fetch of the tracked branch put it back
to 1, and with `depth` raised to 10 the same fetch took a one-commit clone to 10. Whether it shortens the tracked branch
when the ref named is a different one depends on what the two share: a side branch with a tip of its own left a
20-commit clone at 20, a `release` ref pointing at `main~5` took it to 6.

## The unshallow fetch (`git-clients.ts`, `fetch.ts`)

The unshallow runs on the clone timeout rather than the fetch timeout because the silent phases at either end of it —
the server computing the shallow boundary before the first progress byte, and the connectivity check after the last —
scale with total history. That is reasoning about what those phases do, not a measurement: an unshallow big enough to
spend minutes in them is not something a local `file://` remote can stage (one over 1200 commits was done in 176 ms).

`--progress` is what keeps simple-git's inactivity timer fed during the transfer: the same unshallow wrote 131 stderr
chunks with the flag and zero bytes without it, since with stderr piped git suppresses transfer and delta lines and
asks the server for `no-progress`. simple-git's progress plugin appends the flag to any command whose first token is
`fetch`, so it was already reaching git before it was spelled out.

## The LFS setting every client carries (`git-clients.ts`, `isLfsSkipEnabled`)

The clients read both the configured `skipLfs` and the per-sync override the retry policy installs on `GitService`
after an attempt dies on an LFS error. Only the first used to be read, so every client this service built — the retry
attempt's fetch, its `merge --ff-only` — ran with the identical environment after "Temporarily disabling LFS downloads"
had already been logged, and the retry failed on exactly the object the attempt before it had.

## The stale remote-tracking ref sweep (`remote-config.ts`, `deleteStaleRemoteTrackingRefs`)

The deletion is batched through `git branch -r -D`, not the `update-ref --stdin` that reads like the obvious answer,
for two reasons in this order:

- Semantics. `update-ref --stdin` is one transaction: a single ref whose lock is held (a concurrent git in the same
  clone) ends it with exit 128 and nothing deleted at all, which would turn one unremovable ref into a sweep that
  silently did nothing. `git branch -D` is per-ref best-effort like the loop it replaced — the refs it can remove are
  removed, the ones it cannot are named on stderr, and it exits non-zero — so the batch is never worse than deleting
  one at a time, and over packed refs it is better: the packed-refs entry goes even for the ref whose loose lock is
  held.
- Reach. simple-git 3.36 offers no way to write a child process's stdin: there is no `stdin` option, `outputHandler`
  hands over stdout and stderr only, its plugin list is built internally from known config keys so none of ours can be
  registered, and `spawnOptions` is typed down to `uid`/`gid`, so `stdio` cannot be set either. Feeding `--stdin`
  anything would mean spawning git outside the client factory, past the sanitized environment and past the
  primary-checkout guard every write goes through.

How much of a refused batch git deletes is version-dependent: on git 2.43 a batch holding one locked ref removed all
the others, and on 2.55 it removed none of them. That is why a refused batch is retried one ref at a time.

## Known limit of failed-clone settlement (`clone-bootstrap.ts`, `settleFailedClone`)

Settlement runs only once `git clone` has returned, so a process killed mid-checkout still leaves an unmarked
half-written clone that the next init adopts. Closing that needs the bare-clone shape — a marker written in the parent
before the clone starts (`git clone` refuses a destination holding one) — and then a rule for resolving it afterwards,
where "the clone was interrupted" and "the user edited their tree" look the same on disk. Not worth trading a rare
silent adoption for a possible false hard refusal until that case is shown to matter.

Before the incomplete-clone marker existed, a clone that fetched every object and then failed to check out was adopted
by the next run as a pre-existing clone, and every sync after that recorded `dirty_tree` at info level while the run
exited 0.

## Why a tick classifies before it reads the working tree (`clone-sync.service.ts`)

Cost: classification is ref reads (`rev-parse` twice, `merge-base`), bounded by history; `checkWorktreeStatus` runs
`git status`, which refreshes the index and walks the whole working tree for untracked files, and is therefore the one
command in a tick that scales with how many files the checkout holds — on a monorepo, seconds, and under the repo lock.
The overwhelmingly common daemon tick ends `up_to_date`, where nothing is going to be written and the scan bought
nothing.

Meaning: a clone with uncommitted edits that is already at `origin/<branch>` has nothing to merge, so answering
"dirty" there reported a skip — every tick, in the run summary and the TUI — for a repository that was in fact up to
date. The dirty check belongs where a dirty tree actually changes the decision: the fast-forward path.

Nothing load-bearing is lost by not scanning on the other paths. The tick's own `rev-parse --abbrev-ref HEAD` gate
already refuses a detached HEAD (a rebase or bisect in progress) and a branch switched underneath it, and none of the
paths that return without a scan write to the working tree — a conflicted merge left in progress on the branch (which
does not detach HEAD) is named by its relationship to origin rather than as `dirty_tree` when the tick could not have
merged anyway, and is still caught by the scan on the one path that would have. What the scan never diagnosed in the
first place is the half-written checkout of the known limit above: `git status` reports the missing files as
deletions, which read as an ordinary dirty tree, so losing the scan there loses no diagnosis that existed. The merge
still reads the tree immediately before writing, now with the deepening fetches on the near side of the check rather
than between it and the merge.

What this order does cost: a shallow clone too short to classify spends its deepen budget on a tick whose tree turns
out to be dirty, where the old order returned before asking. That is the same budget a clean tick in the same state
already spent every tick, the history it buys is ratcheted and kept by the next fetch rather than discarded, and it is
what turns "working tree has local changes" — which says nothing about why the clone cannot advance — into the
`indeterminate_shallow` skip that names `depth` as the remedy.

## The branch switch's classification (`branch-operations.ts`, `switchCloneBranch`)

The switch used to have a second, shorter classification of its own that read `merge-base`'s silence on a shallow
clone as "cannot fast-forward": a `depth: N` clone whose remote moved more than N commits ahead refused a switch that
was a plain fast-forward, and said so in terms that named the branch rather than the depth that caused it. It now uses
the tick's `classifyWithDeepening`, asked about `refs/heads/<branch>`.

## Creating and pushing a branch (`branch-operations.ts`, `createAndPushCloneBranch`)

Worktree mode creates a new branch in the bare repository. Before clone mode had its own path, the wizard reached
`GitService`'s `bareRepoPath`, which in clone mode falls back to the relative `.bare/<repo name>`: a directory that
does not exist (simple-git's constructor then reports only "Cannot use simple-git on a directory that does not
exist") or, when the daemon ran from a directory holding a bare store of a repository with the same name, another
repository's refs — which the branch was then created in and pushed to while the wizard reported success.

Verified: a depth-1 clone creates and pushes a branch exactly like a full one, since the new branch points at a tip the
remote already has; and the create-only `--force-with-lease=refs/heads/<name>:` push rejects an existing remote ref
with "stale info" and accepts an absent one.

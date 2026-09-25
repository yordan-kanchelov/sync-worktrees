# Trash and recovery

Every worktree sync-worktrees removes — pruned because its branch is gone upstream or filtered out, replaced because its
branch diverged, or found unregistered at a managed path — goes to `.trash/` first by default, where it can be listed,
restored or purged for 30 days. This page is the full reference; the [README](../README.md#what-it-will-never-do) has
the summary.

**Contents:** [What sync can remove](#what-sync-can-remove) · [Diverged branches](#diverged-branches-force-pushes) ·
[Trash layout and pin refs](#trash-layout-and-pin-refs) · [Force clean from the TUI](#force-clean-from-the-tui-x) · [The
`trash` subcommand](#the-trash-subcommand) · [Permanent keep refs](#permanent-keep-refs) · [Restoring](#restoring) ·
[Notes](#notes)

## What sync can remove

Trash applies to worktree mode only; clone mode never removes its checkout. In worktree mode these are the only paths by
which anything leaves your disk:

| Removal path | Trigger | Gate | Trash on (the default) | With `trash.enabled: false` | Undo |
| --- | --- | --- | --- | --- | --- |
| Prune | The remote branch is gone, or `branchInclude`/`branchExclude`/`branchMaxAge` no longer match it | Clean only: no uncommitted changes, no unpushed commits, no stash, no in-progress operation, no modified submodules, not detached. Re-checked immediately before removal; an audit record is written first, and an unwritable audit log blocks the removal | `.trash/<id>/` as `prune`, 30 days, a pin ref keeps the commits | `git worktree remove` — permanent | `sync-worktrees trash --restore <id>` |
| Fully pushed, then deleted upstream | As above, but the worktree holds commits on no remote *now* that were fully pushed before the remote branch was deleted (a squash merge) | Same gate; this is the one case with unpushed commits that is removable | `.trash/` with the pin promoted to a permanent keep ref on expiry | Kept with a warning, never removed | `--restore`, or the keep ref |
| Stale directory at a managed path | A directory sits at `<worktreeDir>/<sanitized-branch>` for a branch sync is about to create, and git does not list it as a worktree | None is possible — it is not a checkout git can inspect | `.trash/<id>/` as `orphan` | Quarantined in place if it contains `.git`; **deleted outright** otherwise | `--restore` (trash on only) |
| Diverged branch (a force-push, or someone else pushed the branch) | The worktree has commits of its own *and* upstream has commits it lacks | Skipped while a stash is present (dirty worktrees never reach this point); reset in place instead of moved when its content already matches upstream or its HEAD is still the commit the last sync left it at (a reset that would touch ignored files, or a tree that is not clean, falls back to the move) | `.trash/<id>/` as `diverged-replace`, commits pinned, `Keep on reap`; a fresh checkout of upstream takes its place | `.diverged/<date>-<branch>-<id>/`, commit held by a keep ref | Recover the commits from the entry — see [Diverged branches](#diverged-branches-force-pushes) for the two cases (a teammate's push vs a force-push you mean to undo); `--restore` is refused while the fresh checkout occupies the path |
| `d` on a `.diverged/` entry in the TUI status view | You press `d` and confirm `y` | — | n/a (`.diverged/` is only written while trash is disabled) | Deleted | None |
| Trash expiry | An entry passes `retentionDays` | The reaper runs at the tail of every sync attempt, failed ones included; commits on no remote are kept | Entry deleted; never-pushed commits promoted to `refs/sync-worktrees/keep/<id>` | n/a | The keep ref |
| `x` in the TUI (force clean) | You press `x`, type `clean` and press `Enter` | Deletes only what the preview counted; the `gc` is skipped when a lock or an unfinished operation is found | Entries and keep refs deleted, then `git gc` | n/a | None — irreversible |
| `trash --purge <id>` | You type the id back | Interactive TTY; for a `Keep on reap` entry the keep ref is minted first | Entry deleted | n/a | The keep ref |

Sync never infers ownership from a directory's name. The only directories it touches are the worktrees git lists for the
bare repository, the exact path where a managed branch's worktree belongs, and its own `.trash/`, `.removed/` and
`.diverged/` folders; a directory whose name matches no managed branch is never looked at. What it cannot do is tell a
directory someone left at `<worktreeDir>/feature-x` apart from a stale leftover of its own, which is why that path is
swept when the `feature-x` worktree is created — to trash by default; when trash is disabled it is quarantined in place
if it contains a `.git` and deleted otherwise. If the move to trash fails, the worktree creation fails instead of
deleting anything. Keep trash enabled on any `worktreeDir` you also use by hand.

## Diverged branches (force-pushes)

A worktree's branch has diverged when it has commits of its own *and* `origin/<branch>` has commits it lacks. That is
what a force-push produces, and also what a teammate pushing to the same branch produces while you have local commits.
When a sync finds one, it moves the worktree aside before creating a fresh one from the new upstream. With trash
enabled (the default) the copy lands in `.trash/` as a `diverged-replace` entry: it ages out under the retention policy
and its commits stay pinned past expiry (`Keep on reap`, see below). No data loss; the commits are one `git branch`
away, as shown below.

Two cases are reset in place without moving anything: a worktree whose tree content already matches upstream (a clean
rebase), and one whose HEAD is still the commit the last sync left it at — sync records that commit when it creates,
fast-forwards or resets a worktree, so a worktree with no record counts as having local work. The reset itself refuses
when it would touch ignored files that upstream also writes, when the tree is not clean (submodules included), or when
HEAD moved since the probe; a refused reset falls back to the move. A worktree with a stash is skipped with a warning
until the stash is popped or dropped, and a dirty worktree never reaches this point (it is skipped by the update phase
first).

### Recovering the commits

The moved copy is not a working checkout any more: its `.git` link points at a worktree registration the sync removed,
so `git` inside it answers "not a git repository". Recover through the bare repository instead. The entry's
`manifest.json` holds the `branch` and the `headOid`, and the pin ref keeps that commit alive:

```bash
sync-worktrees trash --filter <repository-name>                    # find the entry's id
cat <worktreeDir>/.trash/<id>/manifest.json                        # its branch and headOid
git -C <bare-repo> branch feature-x-recovered <headOid>            # a branch on your old tip
git -C <bare-repo> log --oneline origin/feature-x..feature-x-recovered   # the commits only you had
```

Then, in the fresh checkout of the branch, pick the case that applies:

- **Someone else pushed the branch** while you had local commits: replay yours on top of theirs and push —
  `git cherry-pick origin/feature-x..feature-x-recovered`, then `git push`. A force-push here would erase their commits.
- **A force-push you mean to undo**: put your tip back and overwrite the rewrite —
  `git reset --hard feature-x-recovered`, then `git push --force-with-lease origin feature-x`. Do both before the next
  tick: in between, the worktree is diverged again, and a sync landing in the gap would move it a second time (commits
  pinned again).

`--restore` is refused for a `diverged-replace` entry while the fresh checkout occupies its path, and a restored copy
would still be diverged, so the next sync would move it again; recovering the commits by name is the shorter route.
Delete `feature-x-recovered` once the branch is pushed.

### When trash is disabled

With `trash.enabled: false` the worktree is moved to a hidden `.diverged/` directory instead, and a keep ref
(`refs/sync-worktrees/keep/<name>`) holds its commit:

```
my-repo-worktrees/
├── main/
├── feature-a-0a5491ed/
└── .diverged/
    └── 2024-01-15-feature-x-c791eb83-lq3k9a2/
        ├── .diverged-info.json        # the branch, its commit and the keep ref
        └── [all your local files]
```

Recover the same way, from the keep ref named in `.diverged-info.json`
(`git -C <bare-repo> branch feature-x-recovered refs/sync-worktrees/keep/<name>`); the copy itself is not a git
checkout. The TUI's worktree status view (`w`) lists `.diverged/` directories and offers a guided delete (`d` with
`y`/`n` confirmation) once you've decided.

## Trash layout and pin refs

Every managed-worktree removal — age and filter pruning, the stale-directory sweep and diverged-branch replacement — is
reversible by default:

```
my-repo-worktrees/
├── main/
├── feature-a-0a5491ed/
└── .trash/
    └── 2026-06-06T18-30-00-000Z-feature-x-c791eb83-a1b2c3/
        ├── manifest.json     # branch, reason, original path, HEAD commit, expiry
        └── payload/          # the directory exactly as it was, including uncommitted work
```

When the removed directory was a branch worktree, a pin ref (`refs/sync-worktrees/trash/<workspace-hash>/<id>`) keeps
the trashed HEAD's objects alive through `git gc` for the whole retention window — even though the local branch ref
itself is deleted after trashing. Each entry expires on its own clock; maintenance runs the reaper after every sync
attempt, including failed attempts.

```javascript
defaults: {
  trash: {
    enabled: true,        // default: true — false deletes removals outright (see the table above)
    retentionDays: 30,    // default: 30
    warnSizeBytes: 5e9,   // optional: warn when total trash exceeds this
    migrateLegacy: true,  // default: true — adopt old .removed/ and .diverged/ entries
  },
}
```

Trash entries are deliberately not exposed through the MCP server — listing, restoring, and purging are human
operations.

## Force clean from the TUI (`x`)

In the TUI, press `x` to preview a force clean across every configured repository. Typing `clean` and pressing `Enter`
deletes exactly the trash entries and permanent `refs/sync-worktrees/keep/*` recovery refs that preview counted, then
runs `git gc`; `Esc` cancels. When the preview counts nothing, the modal says "Nothing to clean" and does not ask.
This is irreversible; active worktree files, unrecognized trash content, and anything a sync trashed while the preview
was on screen are left untouched — the last of these is reported in the result line.

The object store is the one thing every worktree does share, so the `gc` is the step that can reach work outside the
trash you confirmed:

- The `gc` prunes on a one-hour grace window, not `--prune=now`, unless `maintenance.aggressive` opts into the latter.
  Prune expiry is measured from the mtime of the file currently holding an object, not from the age of the commit and
  not from when it stopped being reachable. A loose object carries its own mtime, so the commits behind a purged
  recovery ref are normally still collected on the same run; a packed object inherits its pack's mtime, and a repack
  resets that clock for everything in the new pack, so when the store has been repacked inside the window this run
  reclaims nothing and the next one past the hour does it instead. Objects written — or repacked — in the last hour
  wait, which is exactly where a concurrent `git commit` keeps the ones it has not yet anchored to a ref.
- Before the `gc`, each worktree's admin directory is checked for `index.lock` or `HEAD.lock` and for an unfinished
  `merge`, `rebase`, `cherry-pick`, `revert` or `bisect`. If any is found the `gc` is skipped for that repository, the
  result line reads `GC skipped`, and the errors name the worktree and the marker. This is a point-in-time check, not a
  lock: it catches a command or operation that is already in progress, and cannot stop one that starts a moment later.
  Purging the trash and refs still happens either way. A marker left behind by a crashed command — a stale `index.lock`,
  or a `rebase-merge/` from an operation nobody finished — keeps reporting busy until you remove the lock or finish the
  operation in that worktree; the error names both so you can tell which.

## The `trash` subcommand

```bash
sync-worktrees trash --filter <repository-name>                                   # table of entries + keep refs
sync-worktrees trash --filter <repository-name> --json                            # the same listing, machine-readable
sync-worktrees trash --filter <repository-name> --restore <id>
sync-worktrees trash --filter <repository-name> --purge <id>                      # permanent, typed confirmation
sync-worktrees trash --filter <repository-name> --restore <id> --wait             # also valid with --purge
sync-worktrees trash --filter <repository-name> --dropKeepRef <listed-keep-name>
sync-worktrees trash --filter <repository-name> --dropAllKeepRefs
```

Every invocation needs **exactly one** matched repository (`--filter`, alias `-f`, is how you narrow a multi-repo config
down to it; anything else exits 1 with the count it matched), and that repository must be in worktree mode — clone mode
never removes its checkout, so a clone-mode repository is rejected. With no operation flag the command prints the trash
listing and any permanent keep refs.

- `--restore <id>` puts an entry's payload back at its original path.
- `--purge <id>` permanently deletes one entry ahead of its expiry.
- `--dropKeepRef <name>` deletes one listed permanent keep ref; `--dropAllKeepRefs` deletes every listed one behind a
  single confirmation.
- `--json` prints the listing as JSON instead of a table.
- `--wait` applies to `--restore` and `--purge` — the two operations that take the repository lock — and retries a lock
  another process holds for up to two minutes instead of failing immediately.
- `--restore`, `--purge`, `--dropKeepRef` and `--dropAllKeepRefs` are mutually exclusive. `--json` describes the
  listing, so it is rejected alongside any of them, and `--wait` is rejected alongside `--json`, `--dropKeepRef` or
  `--dropAllKeepRefs`.
- `--purge`, `--dropKeepRef` and `--dropAllKeepRefs` each need an interactive TTY and a typed confirmation; `--restore`
  needs neither.

The listing is a table of `Id`, `Branch / path`, `Reason`, `Size`, `Expires`, `Restores as` and `Keep on reap`; an empty
trash says so rather than printing nothing. `Size` reads `—` for a payload nothing has measured yet — sizes are gathered
off the repository lock at the tail of a sync, so an entry trashed moments ago has none, and the listing never waits for
a `du` of its own. `Restores as` is `worktree` when the entry still has its branch, HEAD commit and pin ref, and
`files only` otherwise. `Keep on reap` marks an entry whose commits were on no remote when it was trashed; see
**Permanent keep refs** below.

`--json` prints `{ entries, invalidEntries, keepRefs }`, where each entry carries `id`, `branch`, `reason`,
`originalPath`, `deletedAt`, `expiresAt`, `sizeBytes` (`null` when unmeasured — never `0`), `restoresAsWorktree`,
`keepPinOnReap` and `source`.

Expected failures — no entry with that id, a destination that already exists, a repository lock another process holds —
print one `❌ <message>` line and exit 1; only an unexpected error prints a stack.

`--restore` and `--purge` take the repository lock, which a running interactive UI holds for the length of a sync.
Without `--wait` they fail immediately and say so. With `--wait` they retry the lock for up to two minutes and then give
up with the same message — a bound, not "block until it frees up", so a scripted invocation always terminates. Both
locks a worktree-mode repository takes share that one window rather than getting it each.

`--purge <id>` deletes one entry ahead of its expiry, through the same path the expiry reaper uses: it needs an
interactive TTY, the entry's id typed back, and it writes a `trash_purge` audit record before touching anything. For a
`Keep on reap` entry the permanent `refs/sync-worktrees/keep/<id>` ref is created **first** and the files are deleted
only if that succeeds — those commits are on no remote, so the payload and the pin can be the only copy in existence.
Deleting the whole trash instead is the TUI's `x` (force clean, above), which also drops the recovery refs and runs a
`gc`.

## Permanent keep refs

A worktree whose commits were on no remote when it was pruned keeps them past payload expiry — when the entry is reaped,
its pin is promoted to `refs/sync-worktrees/keep/<id>`, which nothing ages out. At reap time the question is asked
again: if the commits are reachable from a remote-tracking ref by then, and this tick's `fetch --all --prune` completed
so that ref set is current, no keep ref is minted. Anything less than that answer mints one — a failed fetch, a rev-list
that failed, a count that could not be read.

That re-check is narrow, and is not a cure for keep refs accumulating. A squash or rebase merge puts the branch's
*content* on the default branch as a new commit, so the original commits stay reachable from no remote ref and still
earn a permanent ref — one per pruned branch, for as long as the repository lives. `--dropAllKeepRefs` is the way back:
it lists what is there, takes one typed confirmation for the whole set, and deletes the refs it listed. Refs a
`.diverged/` directory still relies on are retained and named, refs minted while the confirmation was on screen are left
alone, and a ref another git process has locked is reported without stopping the rest. The commits behind a dropped ref
become collectable by the next `git gc`.

## Restoring

`sync-worktrees trash --filter <name> --restore <id>` puts the payload back at its original path. An entry the listing
shows as `worktree` is rebuilt as a registered worktree on its branch; one shown as `files only` is restored as a plain
directory, because without a pin ref the trashed commits may already be gone. That second case has a consequence worth
knowing before you use it: if the branch is still in the repository's synced set, the next sync finds an unregistered
directory where its worktree belongs and moves it straight back to trash as a new `orphan` entry. The warning on the
restore says so; copy what you need out of the directory, or exclude the branch, before the next tick. A
`diverged-replace` entry is the exception described under [Diverged branches](#diverged-branches-force-pushes).

If you would rather do it by hand, read `manifest.json` for the entry's `branch`, `headOid`, and `originalPath`, then
either copy `payload/` wherever you need the files, or rebuild the worktree yourself:

```bash
cd my-repo-worktrees/.trash/<id>
cat manifest.json
git -C <bare-repo> branch <branch> <headOid>
git -C <bare-repo> worktree add --no-checkout <originalPath> <branch>
cp -R payload/. <originalPath>/   # then restore the .git link git wrote:
git -C <bare-repo> worktree repair <originalPath>
git -C <originalPath> reset       # index at HEAD, payload shows as unstaged changes
```

Discarding one entry is `--purge <id>` (above), not `rm -rf`: removing the container by hand leaves its pin ref behind
until the reaper's next sweep, and for a `Keep on reap` entry it destroys the only copy of commits that reached no
remote.

## Notes

- Anything in `.trash/` without a valid manifest is left alone by the reaper and reported, never deleted.
- A payload the process cannot delete — build output owned by another uid through a bind mount, a file carrying the
  immutable attribute — does not strand the entry. The payload is renamed to `payload.deleting-<timestamp>` inside the
  container before anything is removed, so the manifest survives a refused delete: the entry stays listed, every later
  run retries it, and the warning names the path that refused. Such an entry can no longer be restored (its payload is
  already on the way out); copy what you need out of the container by hand.
- Pin refs whose trash entry is gone (e.g. a failed cleanup, a manually emptied `.trash/`) are swept by the reaper on
  the next sync, so nothing stays pinned forever. The sweep only touches its own `<workspace-hash>/` namespace. Entries
  made before pins carried that namespace keep a flat `refs/sync-worktrees/trash/<id>` pin, which their own manifest
  still releases when the entry is restored or reaped; a flat pin whose entry was already gone by then is left alone —
  nothing distinguishes it from another workspace's — and has to be dropped by hand with `git update-ref -d`.
- A failure to move a directory into trash (e.g. trash on a different filesystem) skips the removal entirely — the
  worktree stays in place.
- Worktrees containing submodules are preserved byte-for-byte; nested submodule state is restored as-is but submodules
  are not re-registered automatically.

# Previewing a sync (`--dry-run`)

`sync-worktrees --dry-run` prints what the next sync would do to each repository, then exits without doing it. Use it
before a config change lands (a tighter `branchMaxAge`, a new `branchExclude`), in CI to check a config, or to see why a
worktree keeps being skipped.

```bash
sync-worktrees --dry-run                      # every repository in the config
sync-worktrees --dry-run --filter backend     # just the ones the filter matches
sync-worktrees --dry-run --json | jq '.[].plan.counts'
```

A dry run is always one-shot: it needs no terminal, ignores `runOnce` and the schedule, and `--run-once` alongside it
changes nothing.

## What it reports

One block per repository, one line per step, then a summary:

```text
📦 app (worktree mode)
   + create  fresh     /home/me/code/app/fresh-d098ab5e (new branch on origin)
   ✗ remove  excluded  excluded by branchInclude/branchExclude/branchMaxAge; clean, every commit is on a remote; moved to trash
   ✗ remove  gone      fully pushed, remote branch deleted; moved to trash
   ↑ update  behind    fast-forward: 1 commit behind origin/behind
   ⏭ skip    dirty     working tree has local changes
   ⇄ replace diverged  diverged with local changes; moved to trash and recreated from origin/diverged
   ✓ 1 up to date

📊 Dry run of 1 repository: 1 to create, 1 to update, 2 to remove, 1 to replace, 1 skipped.
   Nothing was changed; origin was fetched (remote-tracking refs only) so the plan matches it now.
```

| Step      | Worktree mode                                                                                                                                                                                                                                            | Clone mode                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `clone`   | The bare repository does not exist yet. The branches it would get worktrees for are not listed: that needs the clone.                                                                                                                                    | The clone does not exist yet.                                       |
| `create`  | A worktree for a new branch, one whose directory was deleted (rebuilt), or the default branch's own worktree.                                                                                                                                            | -                                                                   |
| `update`  | A fast-forward (with how far behind), a reset of a diverged worktree that has nothing local to lose, or a sparse-checkout pattern change.                                                                                                                | A fast-forward, or a sparse-checkout pattern change.                |
| `replace` | A diverged worktree with local changes: it goes to [trash](./trash-and-recovery.md) (or `.diverged/` with trash off) and is recreated from `origin/<branch>`.                                                                                             | -                                                                   |
| `remove`  | A worktree whose branch is gone from origin, excluded by the filters, or reserved by a trash entry, with what makes removing it safe (clean and pushed, or fully pushed before the remote branch was deleted) and where it goes (trash, or deleted). | -                                                                   |
| `skip`    | Everything the sync would leave alone, with the same reason code the sync's outcome records: `dirty_worktree`, `local_ahead`, `unsafe_to_remove`, `worktree_locked`, `path_collision`, `external_worktree`, ...                                        | `clone_dirty_tree`, `clone_diverged`, `clone_ahead_unpushed`, ...   |
| `noop`    | Up to date; the text report shows only their count.                                                                                                                                                                                                      | Up to date.                                                         |

Notes (`ℹ`) flag the places where the sync does something first that the plan did not simulate, such as unshallowing a
clone or deepening a shallow one to classify it.

The plan comes from the sync's own checks, run the same way, so the sync that follows does what it says as long as
nothing changes in between. Two decisions are re-checked by the sync at the moment it acts: a removal is re-checked just
before it happens, and a fast-forward that git refuses turns into diverged handling. Either can end differently if a
worktree changed after the dry run.

## What it changes

Nothing on disk, with one exception: **it fetches**, the same `git fetch --all --prune` a sync starts with (in clone
mode, the tracked branch's fetch). That updates the remote-tracking refs (`refs/remotes/origin/*`) and downloads their
objects, exactly as `git fetch` or the next sync would, so the plan is made against origin as it is now rather than as
the last sync saw it. For a shallow clone that fetch can move the shallow boundary the way the sync's own fetch would.

Everything else stays as it was, byte for byte: no worktree is added, removed, moved to trash or fast-forwarded; no
local branch, keep ref, config value or `origin/HEAD` is written; no remote tip is recorded; the removal audit log is
not written; and git runs with `GIT_OPTIONAL_LOCKS=0`, so even `git status` leaves each worktree's index alone. A
repository that has not been cloned yet is planned without touching the disk at all.

A dry run takes the repository lock like a sync, so it never interleaves with one: while a sync holds it, the
repository is reported as `not planned` and the dry run still exits 0.

## `--json`

`--dry-run --json` prints an array on stdout, one entry per repository (the `Using config` line goes to stderr):

```json
[
  {
    "name": "app",
    "status": "planned",
    "plan": {
      "repoName": "app",
      "mode": "worktree",
      "fetched": true,
      "notes": [],
      "steps": [
        { "kind": "create", "branch": "fresh", "path": "/home/me/code/app/fresh-d098ab5e", "reason": "new_branch" },
        {
          "kind": "remove",
          "branch": "gone",
          "path": "/home/me/code/app/gone-283bb9de",
          "reason": "deleted_on_remote",
          "basis": "fully_pushed_remote_deleted",
          "disposal": "trash",
          "message": "fully pushed, remote branch deleted; moved to trash"
        },
        { "kind": "skip", "scope": "worktree", "reason": "dirty_worktree", "branch": "dirty", "path": "/home/me/code/app/dirty-5c1f0a2e" }
      ],
      "counts": { "clone": 0, "create": 1, "update": 0, "replace": 0, "remove": 1, "skip": 1, "noop": 0 }
    }
  },
  { "name": "busy", "status": "not_started", "reason": "locked", "message": "another process holds the repository lock (a sync is running)" },
  { "name": "broken", "status": "failed", "error": "..." }
]
```

`--json` is only accepted with `--dry-run`.

## Exit code

0 when every repository was planned or is busy with a sync; 1 when any could not be planned (a git or config error, or
a lock that could not be taken at all). The plan's contents never change the exit code: a plan full of removals exits
0.

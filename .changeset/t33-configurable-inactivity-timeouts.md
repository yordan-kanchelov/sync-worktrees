---
"sync-worktrees": minor
---

`fetchTimeoutMs` and `cloneTimeoutMs` are real config-file settings now. They can be written on a repository entry or under `defaults` — the entry wins, the same precedence every other merged field has — and they reach the git clients that use them.

They were documented as user knobs on `Config`, down to a "set 0 to disable" gloss, and both `GitService` and `CloneSyncService` read them; the README described them and sent people to the example config for how to set them. But `resolveRepositoryConfig` rebuilds each repository from an explicit list of fields and that list never named these two, so nothing a config file said about them survived into the object the services receive. A repository on a slow self-hosted server that needs more than five minutes of silent server-side pack resolution could be given `fetchTimeoutMs: 1800000` exactly as documented and still have every sync killed at 300 s, with nothing to say the setting had been ignored. The two values were only ever reachable by constructing a `Config` in code, which is how every test of them was written and why no test caught this.

Both are validated as non-negative safe integers at both levels; a negative, a fraction, `NaN`, `Infinity` or a non-number is a `ConfigValidationError` naming the field rather than a value handed to `setTimeout`. `0` disables a timeout: both services install simple-git's timeout plugin only for a positive block, and the plugin itself does the same, so a zero never reaches git as an instant kill. Local git commands still never carry either window — a `git worktree add` that is silent for minutes while it checks out a large repository must not be killed for it.

The two fields join `SyncWorktreesConfig` (on repositories and on `defaults`, in both modes), so a `@ts-check`ed config file type-checks them, and `sync-worktrees.config.example.js` shows both.

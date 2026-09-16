---
"sync-worktrees": patch
---

The README's retry section now states the defaults a sync actually runs with, and the LFS retry-limit error points at a setting that exists.

**The documented defaults were the wrong ones.** README promised `maxAttempts: "unlimited"` ("keep trying forever (default)") and showed `maxDelayMs: 600000` in its multi-repo sample. Both numbers are `retry()`'s own `DEFAULT_OPTIONS`, which never decide an unconfigured sync: `SyncRetryPolicy` supplies all six values from `DEFAULT_CONFIG.RETRY` on every sync path, so leaving `retry` out gives 3 attempts, a 1s initial delay, a 30s cap, multiplier 2, 2 LFS retries and no jitter. Someone who left `retry` unset expecting a daemon to keep trying a flaky remote got three attempts and then a failed tick — exit 1 under `--runOnce`. The section now carries those six numbers in a table, says which errors are retried at all (DNS, refused connections, timeouts, `EBUSY`, `Could not read from remote repository`, `fatal: unable to access`, LFS) and which fail on the first attempt (the credential, ssh key and host key failures git names in its message, `EACCES`, `EPERM`, `EROFS`, `ENOSPC`, anything unrecognized), and records that the three `retry` layers — top level, `defaults`, repository — merge field by field. The multi-repo sample keeps its `"unlimited"` and 10-minute cap, now marked as the overrides they are.

**`--skip-lfs` has not existed since the CLI became config-file-only.** `retry()` still told whoever exhausted `maxLfsRetries` to "Consider using --skip-lfs option", a flag `src/utils/cli.ts` no longer defines, and the shipped defaults reach that message exactly: the third consecutive LFS failure trips the limit as the third attempt runs out. It now names `skipLfs: true`, the config field that does the same job, which the loader validates per repository and under `defaults`.

`patch` rather than `minor`: no config key, CLI flag or exported type is added or removed, no retry behaviour changes, and the only difference at runtime is the wording of one error message.

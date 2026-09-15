---
---

Internal only, no behavior change. Dropped constants nothing read — `GIT_CONSTANTS.HEAD_REF`, `GIT_CONSTANTS.REFS.REMOTES_ORIGIN`, `DEFAULT_CONFIG.UPDATE_EXISTING_WORKTREES`, `PATH_CONSTANTS.README`, `METADATA_CONSTANTS.ACTION_CREATED` / `ACTION_UPDATED` / `ACTION_FETCHED`, `HOOK_CONSTANTS.ENV_PREFIX`, the whole `TEST_TIMEOUT` export and the `CliCommand` type — and gave the two remaining duplications one source of truth: `git.service.ts` configures `remote.origin.fetch` from `GIT_CONSTANTS.FETCH_CONFIG` instead of re-typing the refspec, and `SyncRetryPolicy`'s unconfigured fallbacks read `DEFAULT_CONFIG.RETRY.*` instead of its own copy of the numbers, which is what the config loader's cross-field validator already compared against.

Five of those six retry numbers already agreed. `JITTER_MS` did not: the constant said 500 while the code defaulted to 0, so the constant was lowered to 0 rather than the code raised to 500 — `retry.ts`'s own `DEFAULT_OPTIONS` and its doc comment, the shipped example config's `jitterMs` annotation and the code all say the default is no jitter, and only the never-read constant said otherwise. An unconfigured sync therefore retries with exactly the delays it did before, and a test now pins that 0 so it cannot drift back.

None of the deleted names were reachable from the published entry points: `src/index.ts` re-exports none of them and there is no `dist/constants.js` for a deep import to resolve, so the only trace they left was declarations in the emitted `.d.ts` files.

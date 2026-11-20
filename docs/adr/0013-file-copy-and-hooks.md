# ADR-0013: File copying and hooks

- **Status:** Accepted
- **Date:** 2026-11-20
- **Source:** 62 code comments as of `5f17242`, moved here by [ADR-0001](./0001-record-decisions-in-adrs-not-comments.md)

## Context

New worktrees can be seeded with untracked files (such as .env) from a source worktree, and user-defined hooks run after creation. Globs, symlinks and shell commands all come from user config.

## Decisions

Grouped by the file that implements them, source before tests. Each entry names the symbol it governs.

### `src/services/branch-created-actions.service.ts`

- **BranchCreatedActionsService copy files**: When filesToCopyOnBranchCreate matches zero files, the log names the patterns and the directory they were resolved against, because a misconfigured copy otherwise looks identical to no copy configured. The source directory is the base branch's worktree in worktree mode and the config file's directory in clone mode, which is what users most often get wrong.
- **BranchCreatedActionsService.buildExcludeDirs**: The branch-created file copy must never read from the checkout being filled or from any checkout the config file assigns to a repository. One rule covers clone mode, where the source is the config directory that contains every checkout, and worktree mode, where the source worktree sits inside worktreeDir alongside other repositories' checkouts or nested worktreeDirs that detectPathCollisions allows with a warning. FileCopyOptions.excludeDirs decides what happens to entries outside or containing the source, so the exclude list needs no pre-filtering.
- **BranchCreatedActionsService onBranchCreated hooks**: Hook completion messages name the command rather than counting, because an exit code alone does not tell the user which of several onBranchCreated hooks to fix.

### `src/services/config-schema.ts`

- **fileToCopy**: filesToCopyOnBranchCreate patterns starting with ! are rejected because the copy expands globs with negation off, so ! is a literal filename character, unlike in sparseCheckout, and carrying the idiom over would silently match nothing; extglobs like !(dist)/x are allowed since glob reads them as one pattern.
- **hooksSchema**: Hook timeouts are capped at setTimeout's 2^31-1 limit because larger delays do not fit Node's 32-bit field and are replaced with 1 ms, which would SIGTERM the hook immediately; 0 is available for no timeout.

### `src/services/file-copy.service.ts`

- **DEFAULT_IGNORE_DIR_NAMES**: File copy never reads build output, dependency trees or the tool's own bookkeeping directories (.bare, .trash, .removed, .diverged, .sync-worktrees-state, .sync-worktrees-locks), because the copy source is normally the config directory, the parent of every checkout, so a recursive pattern would reach object stores, trashed worktrees, audit logs and locks. They are matched by name, not path, so the rule holds even for callers that cannot see the config.
- **MAGIC_UNDER_GLOBS_PARSE**: Whether a copy pattern has glob magic is judged with nonegate and nocomment, the options glob itself forces when expanding, because a bare hasMagic disagrees exactly where it matters: !(dist)/.env looks like a negated literal to the bare call but glob treats it as an extglob that walks every directory, node_modules included. magicalBraces is deliberately off.
- **wandersBeyondWhatItSpells**: Brace patterns such as {build,dist}/x.json count as spelling their paths, so the default ignored directory names do not apply to them; brace expansion yields a fixed list of literal paths, and silencing one because a directory is named build is the defect the distinction exists to fix. hasMagic judges each alternative, so any alternative with its own magic makes the whole pattern wandering.
- **CopyIgnore**: Excluded checkouts are passed to glob as an ignore object comparing path segments rather than as ignore patterns, because glob's Ignore class rebuilds each pattern from parsed globParts and turns an escaped brace back into a live one, so a checkout named {a,b} would expand into a and b however it was escaped.
- **CopyIgnore.ignored**: CopyIgnore.ignored rejects candidate matches under an excluded directory and is load-bearing for literal patterns like api/.env, because glob resolves a literal segment without reading api, so childrenIgnored never sees that path.
- **CopyIgnore.childrenIgnored**: CopyIgnore.childrenIgnored stops the glob walk at the top of an excluded directory instead of reading and discarding its matches; it gives the same verdict as ignored, so it only changes how much is read, never what is copied.
- **CopyIgnore.resolvesIntoExcluded**: glob only refuses to traverse symlinked directories for **, so literal or single-star segments can reach an excluded checkout through an alias. Every directory reached through a symlink (or of unknown type) is therefore canonicalized and compared against canonical exclusions, covering aliases onto the checkout, any ancestor, or the source itself; path-scurry caches realpaths, and other directories are covered by lexical exclusions.
- **FileCopyOptions.excludeDirs**: FileCopyOptions.excludeDirs lists checkouts the copy must never read and, unlike the default ignored names, applies to every pattern, because a literal path is exactly how a pattern reaches into another repository's working tree. Entries may be absolute or relative to sourceDir in any spelling.
- **FileCopyService.buildExcludedDirs**: Each excluded directory is recorded lexically (as spelled against the source, which holds even when the checkout is a symlink out of the source) and canonically (so relative, absolute and symlinked spellings agree, resolving not-yet-created dirs and using isPathStrictlyInside). An entry that contains the source gets no canonical path, since honouring it would silence the whole copy; worktree mode hits this every run and clone mode can too. Canonical paths are kept for all other entries as the handle for checkouts reached under other names.
- **FileCopyService.expandPatterns**: The default ignored directory names apply only to patterns that wander (recursive or wildcard), judged by glob's own hasMagic under glob's parse options; a pattern with no magic is the one path the config spelled and must not be silenced because a directory on the way is named build. A one-character class like a[1].json counts as not wandering though glob reads it as a class. The caller's excluded checkouts apply to every pattern regardless.
- **FileCopyService.expandPatterns**: A copy pattern that cannot be expanded is reported as an error rather than silently copying nothing, and the magic verdict is taken inside the same try so a pattern minimatch refuses to parse (over its 64 KiB ceiling) is reported instead of ending the whole pass.

### `src/services/hook-execution.service.ts`

- **HOOK_TERMINATION_GRACE_MS**: On quit, hooks get a 250 ms grace after SIGTERM before escalation, because the quit closes the pipes the hook writes to as soon as cleanup resolves and a trap that writes output would otherwise be SIGPIPEd (measured: an echoing trap died part-way while a file-writing one completed). It is small because quit latency is user-visible and only paid when a hook does not exit promptly.
- **HookExecutionService.generation**: HookExecutionService bumps a generation counter in cleanup so a running hook chain does not start its next command.
- **HookExecutionService.executeOnBranchCreated**: The hook timeout travels with each call because one HookExecutionService is shared by every repository, so a repository's hooks.timeoutMs cannot be stored on the instance; ?? is used because 0 means no timeout.
- **HookExecutionService.runSequentially**: onBranchCreated hooks run in array order, each after the previous exits 0, and the first failure stops the rest, so steps like install then build never race.
- **HookExecutionService.cleanup**: cleanup terminates every running hook and returns the commands actually signalled so a quit can name them. Hooks deliberately do not outlive the process because their stdout and stderr are pipes into it, so a survivor would get an uncatchable SIGPIPE on its next write instead of a trappable SIGTERM.
- **HookExecutionService.cleanup**: A hook is named as ended only once SIGTERM was delivered; a hook that exited just before is still in the map with its close event queued, and killing its group returns ESRCH, so listing it would claim a kill that never happened.
- **HookExecutionService.cleanup**: cleanup waits for each child's streams to close rather than its exit status, because the spawned shell dies on the first SIGTERM while a grandchild ignoring the signal can still hold the pipes; the pipes stay open exactly as long as something in the group can still write.
- **HookExecutionService.cleanup**: Close listeners can be attached after signalling because every child is still in activeProcesses and runCommand's removal handler runs on the same close event, so neither can have fired yet.
- **HookExecutionService.buildEnvironment**: Hooks run with the new worktree as working directory, and inherited git repository-selection variables would outrank that for every git the hook runs, so they are stripped (stripGitRepositorySelection); nothing else is changed, since editors, pagers and terminal prompts are legitimate for hooks.
- **HookExecutionService.runCommand**: A hook timeout of 0 or less means no timer at all, letting long install steps run as long as needed, at the cost that a wedged hook runs until quit.
- **HookExecutionService.forwardLines**: Hook output is decoded as UTF-8 by the stream so characters split across writes survive, and is forwarded one whole line at a time.
- **HookExecutionService.terminateChild**: terminateChild returns true only when the signal was delivered; the group kill raises ESRCH for an already exited child, distinguishing a hook the quit ended from one that ended on its own.

### `src/types/index.ts`

- **Config.__configuredRepoDirs**: Config.__configuredRepoDirs is populated by ConfigLoaderService with the resolved directories of every repository in the same config file. Its only consumer is the filesToCopyOnBranchCreate expansion, which must never read out of another repository's checkout, notably in clone mode where the config directory is the parent of every checkout; without it the copy excludes only the destination, the repository's own directories and name-based defaults.

### Tests

Why the tests that pin these decisions are built the way they are.

#### `src/services/__tests__/branch-created-actions.service.test.ts`

- **BranchCreatedActionsService.copyFiles**: The clone-mode copy fixture uses the documented quick-start layout, in which the config file's directory is the parent of every clone-mode checkout, so copying from it must exclude sibling checkouts.
- **BranchCreatedActionsService.copyFiles**: A sibling's worktreeDir may be a symlink onto another disk, with a further alias symlink next to it; the copy exclusion must resolve through both so a single-star pattern does not pull the sibling's files in.
- **BranchCreatedActionsService.copyFiles**: A convenience symlink can alias the parent of the checkouts rather than a checkout, so a sibling appears as an ordinary directory under a name the config never spelled; the copy exclusion must still recognize it.
- **BranchCreatedActionsService.copyFiles**: In worktree mode the copy source sits inside the repository's own worktreeDir, which the exclusion list names, so the walk must not treat that entry as making everything under the source foreign.
- **BranchCreatedActionsService.copyFiles**: detectPathCollisions allows, with a warning, a worktreeDir nested inside another repository's worktreeDir, which is the one configuration that puts a foreign checkout under a worktree-mode copy source; the copy must exclude it.

#### `src/services/__tests__/file-copy.glob-error.test.ts`

- **FileCopyService.copyFiles**: glob 13 returns an empty list instead of rejecting for a missing, unreadable or non-directory cwd, so an expansion failure cannot be produced through the filesystem and the test stubs glob. The contract under test is that a pattern that fails to expand is reported in result.errors rather than silently dropped.

#### `src/services/__tests__/file-copy.service.test.ts`

- **FileCopyService.copyFiles**: The default ignored directory names (build, dist, node_modules and similar) exist to stop wandering glob patterns. A path spelled out in full in the config cannot wander, so it is copied even from inside an ignored directory; skipping it silently would override the only person who knows what the file is.
- **FileCopyService pattern classification**: Whether a filesToCopyOnBranchCreate pattern is magic-free is decided by glob's own hasMagic, i.e. by what the expansion will do with the string, not by whether it contains a potentially magic character. `a[1].json` can only produce `a1.json`, so it counts as magic-free even though glob still reads it as a character class.
- **MAGIC_UNDER_GLOBS_PARSE**: The magic-free verdict must be taken under the same options glob expands with (nonegate, nocomment). Otherwise a leading extglob such as `!(dist)/.env` reads as a negated literal, receives the empty ignore set, and walks node_modules and the bare repository despite naming no concrete path.
- **MAGIC_UNDER_GLOBS_PARSE**: glob expands with comments disabled, so a pattern starting with `#` is a directory name rather than a comment. The magic verdict uses the same parse; read as a comment the pattern would look magic-free while glob still walked it without the default ignored names.
- **FileCopyService pattern classification**: Brace expansion turns one pattern into a fixed list of strings, each as spelled-out as a brace-free path, so a brace pattern whose alternatives are all literal is treated as literal paths and bypasses the default ignored names; if any alternative wanders, the defaults apply.
- **fileToCopy schema**: glob expands filesToCopyOnBranchCreate with nonegate, so a leading `!` is a filename character, unlike in sparseCheckout.exclude. The config loader still rejects an unescaped leading `!` because in a config file it far more often means negation; an escaped `\!` names a file starting with `!`.
- **FileCopyService.copyFiles**: The magic verdict is computed on the way into glob expansion, and minimatch refuses patterns over 64 KiB. Both happen inside the per-pattern error reporting, so an unexpandable pattern becomes a named entry in result.errors and the remaining patterns are still expanded.
- **FileCopyService.buildExcludedDirs**: Every path under the copy source resolves into the source, so honouring an exclusion equal to the source would prune every alias inside it; buildExcludedDirs drops such exclusions.
- **FileCopyService.buildExcludedDirs**: An excludeDirs entry that names no directory the walk can reach (a worktreeDir outside the config directory, a nonexistent directory, or the source directory itself) must not remove anything from the copy.
- **FileCopyService.buildExcludedDirs**: Excluded directories are matched segment-exactly rather than by string prefix; a prefix comparison would also drop siblings whose names merely start with an excluded name (api-v2, api.old), silently losing files the user asked for.
- **FileCopyService excluded-directory walk**: glob refuses to traverse a symlinked directory only for `**`; a literal or single-star segment resolves straight through it, so excluded checkouts must also be caught when reached through an alias symlink.
- **FileCopyService.buildExcludedDirs**: An excluded worktreeDir may itself be a symlink pointing outside the source (for example onto another disk). Canonicalizing it alone would place it outside the source and lose the exclusion, while the walk still reaches it under the name the config spelled, so the lexical spelling is excluded too.
- **FileCopyService.buildExcludedDirs**: A checkout named through a symlinked parent is reachable by the walk under both the configured name and its real path, so both are excluded: canonicalizing alone misses the link spelling and the configured string alone misses the real one. The parent alias itself stays readable because it holds more than the excluded checkout.
- **FileCopyService excluded-directory walk**: An alias onto a checkout's parent or onto the source leaves the checkout itself an ordinary directory under a name the config never spelled, so exclusion must be decided by which directory a node really is, not by whether the walk stepped through a link to reach it.
- **FileCopyService.copyFiles**: Exclusions remove only the excluded checkouts; aliases that also expose non-excluded content stay readable for that content, and files reached back through a self-referencing alias (such as self/self/.env) are legitimately copied because the patterns ask for them.
- **FileCopyService.buildExcludedDirs**: In worktree mode the copy source is a worktree inside the repository's worktreeDir and the caller passes that worktreeDir in excludeDirs on every run. An exclusion that contains the source is therefore ignored, keeping the source readable, since every path in it resolves into the excluded directory.
- **FileCopyService.buildExcludedDirs**: When an excluded name is spelled inside the source but resolves to an ancestor of it, its canonical form contains the source and buildExcludedDirs deliberately drops it (honouring it would silence the whole copy). The lexical spelling is then the only thing keeping the walk out of that alias, so it is retained.

#### `src/services/__tests__/hook-execution.service.test.ts`

- **HookExecutionService.cleanup tests**: The hook cleanup tests spawn real children and probe the pid the hook reports, because the service kills a process group through a shell it does not own; asserting that kill was called proves nothing, only asking the OS whether the hook's own pid is gone proves the signal reached the work.
- **HookExecutionService (stripGitRepositorySelection)**: Hook commands rely on the new worktree as their cwd to know which repository they are in. A run started from a git hook inherits GIT_DIR, and shells or CI can export other repository-selection variables, so these are stripped from the hook environment or every git command in a hook would target the wrong repository.
- **HookExecutionService.cleanup**: cleanup() returns the commands it killed rather than a count, so the user can read which of their hook commands the quit ended.
- **HookExecutionService.cleanup**: The quit calls exitProcess right after cleanup() resolves, which closes the pipes a hook uses for stdout and stderr, so a SIGTERM trap that prints anything would be SIGPIPEd part-way. cleanup() therefore holds the process open until trapping hooks finish (bounded by a grace period); measured against the real quit path, a trap with an echo otherwise died mid-way.
- **HookExecutionService.cleanup**: The wait for hooks to finish their SIGTERM traps is bounded by HOOK_TERMINATION_GRACE_MS so quitting stays fast even when a hook misbehaves.
- **HookExecutionService.waitForExit**: The termination grace is an upper bound, not a sleep: a hook killed by SIGTERM's default action closes its pipes at once and the quit proceeds immediately.
- **HookExecutionService.cleanup**: The process exits in the statement after cleanup() returns, so a delayed SIGKILL timer could never fire and a hook ignoring SIGTERM would be orphaned. cleanup() itself escalates to SIGKILL for any hook still alive after the grace period.
- **HookExecutionService.waitForExit**: The spawned shell dies on the first SIGTERM while a grandchild that ignores it keeps holding the pipes, so the shell's exitCode would report the hook dead. The wait watches the child's streams closing instead; the test appends '; true' so the shell does not exec into node and reproduces that shape.
- **HookExecutionService.cleanup**: A hook that exited just before quit is still in the active map because its close event is queued, and killing its group returns ESRCH. cleanup() names a command only after the signal was actually delivered, so the quit never claims a kill that did not happen.

#### `src/utils/__tests__/git-env.test.ts`

- **stripGitRepositorySelection**: Unlike sanitizeGitEnv, stripGitRepositorySelection adds and strips nothing beyond selection variables because it is also used for user hook commands, where an editor, pager and terminal prompt are legitimate.

## Consequences

Changing code covered by an entry here means updating the entry in the same pull request. An entry that no longer holds is deleted, or superseded by a new numbered ADR when the reversal is itself a decision worth keeping.

# sync-worktrees

## 7.1.0

### Minor Changes

- e53cf71: CLI ergonomics:

  - Flags are kebab-case in `--help` and the docs (`--run-once`, `--drop-keep-ref`, `--drop-all-keep-refs`); the camelCase
    spellings keep working.
  - `sync-worktrees --filter <pattern>` (`-f`) syncs only the repositories the pattern matches, with the same matching as
    `list`, and exits 1 when nothing matches. The interactive UI keeps the filter across config reloads.
  - `-q`/`--quiet` limits a one-shot run to warnings, errors and the final summary line, so a clean run prints one line
    instead of a few dozen. Warnings and errors go to stderr, so `--run-once --quiet >/dev/null` in cron mails only when
    something needs attention.
  - `sync-worktrees completion` prints a bash/zsh completion script.
  - A mistyped command or flag gets a "did you mean" hint, `sync` is an explicit name for the default command, and
    `--help` now carries examples and a link to the docs.

- 68f8526: CLI fixes and output polish:

  - `--version` (now also `-V`) prints the build's own version. It used to print `unknown`, or another package's version,
    from a pnpm-installed copy.
  - Without a terminal (systemd, docker, CI, `< /dev/null`), `sync-worktrees` without `--run-once` exits 1 and says to use
    `--run-once`. It used to print Ink's "Raw mode is not supported" stack trace and exit 0. `sync-worktrees init` also
    exits 1 with a message instead of hanging.
  - A failed git command in `--run-once` is reported as its one `fatal:` line, not about 30 lines of stack and
    `task.commands`. After any failure the run prints a hint that points to `--debug`. The new `--debug` flag turns on
    debug logging and full error details for every repository, overriding the config's `debug`, and keeps doing so after
    the dashboard reloads the config with `r`. A typed failure such as "Cannot fast-forward branch" also carries git's
    one-line reason.
  - The bin shim's last-resort error handler now redacts credentials in repository URLs.
  - `--run-once` output: "1 repository" instead of "1 repositories", no empty `[name]` line before each repository header,
    and "Fetching latest data from remote..." printed once per sync instead of twice. Zero skip counts are left out of
    the summary, which also shows the total elapsed time. The "Failed to load config file:" prefix is no longer printed
    twice.
  - Colour honours `NO_COLOR` and `FORCE_COLOR`. Log lines have ANSI sequences stripped when stdout is not a terminal.

- f5b7aa1: Packaging: an explicit `exports` map, one shared bundle chunk, and fewer dependencies. The tarball drops from 91 files and ~1.51 MB unpacked to 14 files and ~0.85 MB.

  - **`exports` map.** `package.json` now has `exports` with `.` and `./package.json`. `import("sync-worktrees")` still resolves, and its types are the `SyncWorktreesConfig` family that the README tells you to use in `@satisfies {import("sync-worktrees").SyncWorktreesConfig}`. Those types now also work under `moduleResolution: "nodenext"`: the published `.d.ts` files use explicit `.js` import paths, where before they had none and the types quietly became `any` under `skipLibCheck`. Deep imports such as `sync-worktrees/dist/services/...` are now refused with `ERR_PACKAGE_PATH_NOT_EXPORTED`. They were never documented, but every `dist/` file used to be reachable. Only the declarations the public types need are published now (5 instead of about 80).
  - **One build, shared chunk.** The CLI and the MCP server are built in one esbuild pass with code splitting, so the code they share (`src/utils`, `src/services`, ...) ships once in `dist/chunk-*.js` instead of twice. `pnpm build` now empties `dist/` before building, and `pnpm watch` runs esbuild in watch mode. It used to run `tsc --watch`, which wrote unbundled JavaScript over `dist/`.
  - **`sync-worktrees-mcp` bin shim.** The MCP binary is now `bin/sync-worktrees-mcp.js`, which works like `bin/sync-worktrees.js` (`NODE_ENV` defaults to `production`) and then loads `dist/mcp-server.js`. MCP client configs keep working unchanged, because they run the `sync-worktrees-mcp` command.
  - **Node version warning.** Both binaries print a one-line warning on stderr when Node is older than the `engines` floor (24), because npm only warns about `engines` at install time. The command still runs, and the README now says so.
  - **Disk usage without `fast-folder-size`.** Directory sizes (TUI status bar, trash sizes, MCP `includeSize`) come from `du -sk`, run without a shell. This drops a dependency whose install script downloads a Windows binary on a package that only supports macOS and Linux. On Linux, sizes now count allocated blocks, as macOS already did, rather than apparent bytes, so small files round up to their block size.
  - **Dev dependencies removed:** `react-devtools-core` (and its dead esbuild alias and `devtools-stub.js`), `ts-node`, `happy-dom` and `@types/node-cron` (node-cron ships its own types). `packageManager` pins pnpm 10.33.0, and CI's setup action reads it.

- 0a877e2: TUI: log lines are batched into one render every 50ms instead of one render (and a copy of the whole log buffer) per
  line, and the status bar and log panel no longer re-render for updates that do not concern them. Modals size themselves
  to the terminal: they are never wider than the window, their lists use the rows the window has instead of a fixed
  eight, and the help screen compacts and then scrolls on short terminals. Deleting a `.diverged/` entry in the status
  view is now `Ctrl-D` (was `d`), so `d` can be typed into the filter; lists also accept `Ctrl-N`/`Ctrl-P`. The unused
  `LogViewer` component is removed.

### Patch Changes

- 41bdb86: Internal cleanup with a few visible effects:

  - MCP `list_worktrees` now says why a worktree's status could not be read (`safeToRemove.reason: "status unavailable: <cause>"`, credentials scrubbed), and `detect_context` with `includeStatus: true` adds a `statusError` field to a worktree whose status probe failed, instead of a bare `unknown` label.
  - Worktree-creation failures that roll the worktree back (metadata could not be written, upstream could not be set) are now typed errors, so MCP reports them with their own error codes (`WORKTREE_METADATA_FAILED`, `WORKTREE_UPSTREAM_SETUP_FAILED`) instead of `INTERNAL_ERROR`. Messages are unchanged.
  - An invalid `branchMaxAge` and a failed disk-usage total are reported through the repository's logger (the TUI log pane in interactive mode) instead of bare console output written over the interface, and a throwing TUI event listener is reported through the credential-scrubbing logger.

- 940076b: Make git invocations more robust:

  - Every git client now runs under the C locale (`LC_ALL=C`, `LANG=C`), not only the sync clients, so the status view, metadata, sparse-checkout, maintenance and MCP paths that match git's English messages keep working under a non-English locale.
  - `fetchTimeoutMs` / `cloneTimeoutMs` must be `0` or a whole number of milliseconds from 1000 to 2147483647. Larger values used to overflow Node's timer and kill every git command after 1 ms; sub-second values killed nearly every fetch.
  - `git worktree list` is read NUL-terminated (`-z`, git 2.36+, with a fallback for older git), so a worktree path containing a newline is no longer split into two bogus entries.
  - `git branch -D` calls now pass `--` before branch names.
  - A pin or keep ref that cannot be removed while rolling back a failed trash or diverged-worktree preservation is now logged as a warning instead of being silently ignored.

- 719ce44: Stashes are now attributed to the worktree they were made in. git keeps one stash list for every worktree of a repository, so a single stash anywhere used to make every worktree report "stashed changes": no worktree could be pruned, every diverged replace was skipped, and MCP labelled every worktree dirty. A stash now counts only for the worktree whose branch it was made on (a detached-HEAD stash counts where its base commit is in the worktree's history).

  With trash disabled, a stale directory at a managed worktree path that has no `.git` is no longer deleted outright: it is quarantined under a sibling `.removed/` folder like one that has a `.git`. Only an empty directory is removed.

- 751e65a: TUI fixes:

  - The status bar says `Idle` instead of `Running`, and shows how the last sync went next to its time: `✓ OK`, `✗ 2 failed` or `⚠ 1 skipped`.
  - `Next Sync` is shown when repositories use different cron schedules (the earliest next run across all of them).
  - `s`, `r` and `x` during a sync briefly say a sync is in progress instead of doing nothing.
  - `q` while a sync, hook or worktree creation is running asks for a second `q` before quitting.
  - `r` and `s` after `q` no longer restart the cron jobs or start a new sync during shutdown.
  - Force clean (`x`) says "Nothing to clean" when there is nothing to delete, and otherwise asks you to type `clean` and press Enter instead of a single `y`.
  - A failed delete of a `.diverged/` directory in the worktree status view is now shown instead of disappearing silently.
  - Pressing down on an empty filtered list no longer leaves the selection at -1; a single configured repository is loaded by its own index.

## 7.0.0

### Major Changes

- 4a455fb: **Breaking: the MCP server no longer reads the `SYNC_WORKTREES_CONFIG` environment variable.** Auto-detect is now the only way a config reaches the server at startup: it walks up from the client's working directory and loads the first `sync-worktrees.config.{js,mjs,cjs,ts}` it finds, which is exactly what it already did whenever the variable was unset. A config the walk-up cannot reach is loaded at runtime with `load_config {configPath}`, as before.

  **If your MCP client config sets `SYNC_WORKTREES_CONFIG`:** remove the `env` entry (or the `-e` flag on `claude mcp add`). When the config file sits in the client's working directory or one of its parents, nothing else changes. When it lives elsewhere, call `load_config` with its path once per server session; until then `sync` and `initialize` report the repository as unconfigured, as they always have without a loaded config.

  **Why major.** The README's standard config block told every client to set the variable, so installs that followed it exist, and after this change the setting is ignored without a warning. For a config outside the walk-up path, `sync` and `initialize` go from available at startup to unavailable. Withdrawing a documented setting that working installs rely on is what a major is for, so this releases as 7.0.0 rather than 6.1.0.

  **What moved with it.** The `load_config` tool description and its `configPath` fallback chain (explicit path, then an already detected config, then a launch-CWD walk-up), the "no repository selected" recovery hint, the README's Getting started section and the site's client hints no longer name the variable. The server now logs `Auto-loaded config: <path>` to stderr at startup in place of the old `Loaded config:` line, so whoever is tailing it still sees which file was picked up.

## 6.0.0

### Major Changes

- cf3dfe0: **Breaking: the supported Node floor is now 24.** `engines.node` moves from `>=22.0.0` to `>=24.0.0`, and the PR test matrix drops its Node 22 leg. In exchange, `sync-worktrees.config.ts` is a real config format rather than a claim: the MCP server has advertised auto-loading `sync-worktrees.config.{js,mjs,cjs,ts}` — in its instructions and again in the `detect_context` description — while `CONFIG_FILE_NAMES` listed only js/mjs/cjs, so the walk-up never looked for a `.ts` file and `detect_context` reported `configPath: null` for one sitting next to the caller. The CLI's own `findConfigInCwd` shares that list and had the same blind spot.

  Nothing but the name list was missing. The loader already runs a config through `import()`, and Node has stripped type annotations by default since 22.18, so `.ts` was one array entry away from working end to end — measured here on Node 22.22.2 and pinned by tests that drive the bundled loader from a child `node` process rather than from vitest. That distinction is the whole reason the new suite is shaped the way it is: under vitest a dynamic `import()` is served by Vite, which _compiles_ TypeScript with esbuild and would happily load an `enum` or a `namespace`. Node does not compile. A test that stayed in-process would pass on exactly the inputs a user's `node` run rejects.

  **If you are on Node 22:** upgrade to Node 24 or newer, or pin `sync-worktrees@5` — 5.3.1 remains installable and supported on Node 22. Nothing in a config file or on the command line has to change.

  **Why major rather than minor.** Raising a floor removes support. On a Node 22 runtime that installs 5.3.1 today, `>=24.0.0` is a hard `EBADENGINE` install failure wherever `engine-strict=true` is configured; with npm's default it is an `EBADENGINE` _warning_ and the install still proceeds, so the honest claim is that it breaks some installs outright and silently un-supports the rest. The guarantee is what changes: 5.3.1 is tested on Node 22 on every PR, 6.0.0 is tested on no Node 22 at all, because this change removes the matrix leg that did it. A Node 22 user tracking `^5` would be carried onto a release with zero coverage on their runtime by the next dependency bump — which is precisely the failure mode that put the Node 22 leg in the matrix in the first place. Withdrawing a runtime a currently-supported release works on is what a major is for; it releases as 6.0.0, not 5.4.0. The `.ts` support riding along would have been a minor on its own.

  **Non-erasable syntax gets an explanation.** Node erases types, it does not compile them, so `enum`, `namespace`, parameter properties and decorators are refused outright — on Node 24 as much as on 22 — with `code: "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX"` and a message about "strip-only mode" that tells a config author neither why nor what to do. `typeStrippingHint` appends the missing half, keyed on the code rather than on Node's wording, and reaches the reload path too because `workerEvalError` already carries `code` across the worker boundary. A config author now sees:

  ```
  Failed to load config file: TypeScript enum is not supported in strip-only mode
    (/path/sync-worktrees.config.ts:1) (hint: Node runs TypeScript by erasing type
    annotations, so syntax that emits code cannot run. Rewrite it in erasable syntax
    — a plain object, a union of string literals, 'as const' — or use a .js/.mjs config)
  ```

  It is not restricted to `.ts` paths: a `.js` config that imports a `.ts` sibling raises the same code from the sibling, and the same advice holds.

  **`.mts` and `.cts` are deliberately left out.** Node loads a `.mts` config fine — that was checked, not assumed — but every extra name costs another stat per directory on every level of the walk-up, and adding `.mts` without `.cts` is arbitrary while adding `.cts` needs loader work (the require/import split keys off `endsWith(".cjs")`). The one case `.mts` would buy is ESM-TypeScript under a `"type": "commonjs"` package.json, where a `.ts` file is parsed as CommonJS and `export default` is a hard `SyntaxError`; the existing `moduleSyntaxHint` already fires there and names the fix, which a new test pins. Four names is also exactly what the MCP instructions and `detect_context` advertise — a fifth would be a fifth claim to keep true.

  **`init` keeps writing `.js`, on purpose.** The generated file already carries `// @ts-check` and a `/** @satisfies {import("sync-worktrees").SyncWorktreesConfig} */` annotation, so it is type-checked in an editor without being TypeScript; `.ts` would buy the wizard's output nothing and would cost it a second module-system branch. `.ts` is for a hand-written config in a project that is already TypeScript. Discovery order is unchanged with `.ts` appended last, so a directory holding both a `.js` and a `.ts` config still loads the `.js` one — pinned by a test, along with the exact four-name list. The CLI's own "no config file found" message is now built from that list instead of restating it: it named `sync-worktrees.config.{js,mjs,cjs}` while `findConfigInCwd`, which reads the same constant, already searched for `.ts` — so the one place a user is told what to create disagreed with what the CLI would find. Deriving it is the same fix as pinning the list.

  **Everything else that stated a Node version moved with the floor**, because leaving one behind is the same class of bug this fixes: `README.md`'s Requirements section, the site's Quick Start card and `llms.txt`. The esbuild target stays `node22` — a downlevel target below the floor runs fine on 24 and says nothing about what the package supports, while raising it would emit syntax that could not be verified on the container this was written on. `tsconfig.json` stays at `target`/`lib` `ES2022` for the same reason in reverse: it gates which language and library features the _type checker_ permits, nothing in the codebase needs an ES2023+ builtin, and raising it is a licence to use APIs no test exercises.

  ***

  Two unrelated documentation fixes ride along.

  `list_worktrees` had a fallback error that hid its own cause. When a configured repository has never been cloned, `git worktree list` runs against a bare directory that is not there and simple-git rejects with "Cannot use simple-git on a directory that does not exist"; with nothing detected on disk to fall back to, the handler threw `Cannot list worktrees - service not initialized and no detected context` — the two things that did not work, and neither the cause nor the remedy. In a multi-repo listing that string is what lands in `repositories[name].error`, sitting next to repositories that listed fine. It now names the repository, quotes the underlying failure and points at `initialize`. The `catch` had discarded its error binding entirely, so this was not a wording change.

  That path was also untested, and not by omission: `makeCtx` in `handlers.test.ts` resolved its discovered context with `opts.discovered ?? makeDiscovered()`, so the one test that passed `discovered: null` to reach the throw was silently handed a full context and asserted the _other_ branch. Fixed to `=== undefined`, and the test rewritten to assert what it always meant to.

  Finally, the README's MCP section said an omitted `repoName` falls back to "the first entry in the config". It has not since repository selection was reworked: a config with several repositories leaves `currentRepo` null, and the call fails with the ambiguity error listing the names to choose from. Only a config with exactly one repository auto-selects. The line now says so.

### Minor Changes

- cf3dfe0: `detect_context` now answers with the enclosing worktree when the path it is given sits inside a nested repository — a vendored `git init`, a submodule, a `git clone` someone dropped into a package directory — instead of reporting `unsupported`.

  Detection walked up from the probed path and answered with the **first** `.git` it met, whatever that turned out to be. A nested `.git` directory produced "Directory has .git folder (regular repo, not a sync-worktrees worktree)" and a submodule's `.git` file produced "gitdir does not follow worktree structure", and in both cases the walk stopped there. An agent whose cwd was `<worktreeDir>/feature-x/packages/vendored-lib` got `isWorktree: false`, `kind: 'unsupported'`, every capability unavailable and no `currentRepo`, and concluded the project was unmanaged although its parent was a managed worktree. The walk now steps over anything it cannot act on and stops only at a shape it can: a worktree whose gitdir points into `<bare>/worktrees/<name>`, or a configured clone-mode root.

  Measured against real git before the change, not assumed. The submodule pointer is not the `gitdir: ../.git/modules/<name>` the report quoted: inside a linked worktree git writes `gitdir: <bare>/worktrees/<wt>/modules/<name>`, which fails the same regex by a different route, so both fixtures are built with a real `git submodule add` rather than a hand-written file.

  **A configured clone-mode root is looked up wherever the walk would otherwise not answer**, not only where its `.git` is a folder. That is the one place the old early stop was hiding something: a checkout made with `git clone --separate-git-dir` has a `.git` _file_ whose gitdir points nowhere near `<bare>/worktrees/<name>`, and a checkout whose `.git` cannot be read at all is still the repository the config names. Both used to answer `unsupported` at the checkout itself — measured — and resuming the walk would have stepped over them entirely. They now name the configured repository, with the branch reported as unknown when it cannot be read. The lookup is an exact path match against each clone-mode `worktreeDir`, folded the same way `pathsEqual` folds, so a configured root never captures a sibling whose path merely starts with it, and the deeper of two nested configured roots wins because the walk reaches it first. The worktree shape is still ruled out first, so a directory that is both a real linked worktree and a configured clone root answers as the worktree, exactly as before.

  **A shape that resolves today is still terminal.** A configured clone-mode root ends the walk even when a managed worktree encloses it — resuming past it would trade a real configured repository for whatever sits further up. So does a worktree pointer that belongs to a _different_ bare repository from the one enclosing it, and the inner of two nested worktrees of one repository. The walk cannot change any answer that was not `unsupported`, by construction: the two terminal tests run at the first candidate exactly as they did before, so an input that used to resolve returns at iteration one with the same directory, the same bare repo, the same admin dir and an empty skip list. That was checked against 33 fixture shapes built with real git — managed worktree, clone-mode root, bare repository, `<bare>/worktrees/<name>`, `.git` symlinks to a directory, to a file, dangling and self-referential, a submodule in a plain clone and in a worktree, two levels of nesting, a nested worktree of a foreign repository and one of the same repository, a `--separate-git-dir` checkout, a directory that is both a worktree and a configured clone root — and every currently non-`unsupported` answer came back byte-identical.

  **The nested repository's identity does not leak.** `currentWorktreePath`, `currentBranch` and the `isCurrent` flag in `allWorktrees` all describe the enclosing worktree; the path handed to the worktree-list parser is the enclosing one, so the current row is the one git registered, not the vendored checkout the agent happens to be standing in.

  **An unreadable `.git` stops the walk, and now says so.** `findWorktreeRoot` returned `null` on any errno that was not `ENOENT`/`EISDIR`, so one `EACCES` on a locked-down vendored repo, or one `ELOOP` on a `.git` symlink cycle, gave up on the whole tree and then reported "No .git file found in path or any parent directory" — which is false. The answer is now `Cannot determine whether <dir> is a sync-worktrees worktree: an unreadable .git (ELOOP). Detection stopped there rather than answer with an enclosing repository`.

  It is the one thing the walk may not step over. A `.git` folder and a gitdir line pointing somewhere other than `<bare>/worktrees/<name>` are positive identifications — git itself would not call either one a linked worktree — but an errno says only that this process could not look. Stepping over it answers with whatever encloses that directory, and what encloses a linked worktree is very often a _different_ repository: a worktree of repo B sitting inside a worktree of repo A, with B's `.git` transiently unreadable, would come back `isWorktree: true` naming A's bare repo, A's branch, A's `worktreeDir` and `createWorktree` available — measured, and worse than the refusal it replaced, because every capability in that answer is one a mutating tool acts on. The single exception is a directory the config names as a clone-mode `worktreeDir`: that identifies the repository without reading anything, so it still answers as that repository with its branch reported as unknown.

  **The notes say what was passed.** Each skipped repository adds `Walked past <what> at <path>`, deepest first. When the walk reaches the filesystem root the single reason enumerates them rather than describing only the last thing seen, and a path with no `.git` above it anywhere keeps the original "No .git file found in path or any parent directory". The enumeration stops after the five deepest and counts the rest: every clause carries a whole absolute path and the reason is repeated once per capability plus once in the notes, so listing one clause per level grew the answer with the square of the depth — a probe under thirty nested repositories produced a 16 KB reason and a 116 KB tool result.

  A deep path costs more `readFile` calls than before only when something was skipped — the walk used to stop early there and now continues to the root, bounded by the path's depth. A probe inside an ordinary worktree still stops at the first `.git`, for the same one call it always made.

  Called `minor` rather than `patch`: nothing that loads today stops loading and nothing is refused, but this is not a warning either — it changes what `detect_context` _returns_ for a set of inputs, from `{isWorktree: false, kind: 'unsupported'}` with no repository to a fully populated context that registers an auto-detected repository and bootstraps `currentRepo`. A client that branched on `isWorktree` sees different behaviour in those cases, which is more than the repo's patch line ("warning while refusing nothing") covers.

- cf3dfe0: `onBranchCreated` hooks now have a configurable timeout (`hooks.timeoutMs`), name themselves in their completion logs, and are terminated out loud rather than in silence when the interactive UI quits.

  **The measurement that decided T110.** The item offered two options: let detached hooks outlive the TUI, or warn on quit and still kill. Option A looked free — the spawn is already `detached` and the README already called hooks fire-and-forget, so the kill looked like the anomaly. It is not achievable, and measuring it is the only way to see that. Spawning a real child exactly as `executeCommandInBackground` does (`shell: true`, `detached: true`, `stdio: ["ignore", "pipe", "pipe"]`) and then exiting the parent without signalling anything: the child stops working at the instant the parent exits and is dead within ~1.5s, with a recorded wait status of 141 — 128 + 13, SIGPIPE. The parent's exit closes the read end of the pipes the child holds as stdout and stderr, and the child dies at its next write. `child.unref()` changes nothing about this; the same run with `stdio: "ignore"` instead survives indefinitely, with or without `unref()`, which locates the cause in the pipes rather than in the handle reference.

  So the choice was never "kill the hook or let it live". It was "SIGTERM the hook, or let SIGPIPE kill it at an unpredictable point with no handler". A child that traps SIGTERM was measured under both: under the signal the service sends today its trap runs and it exits cleanly; under a bare parent exit the trap never runs, because SIGPIPE's default action terminates it outright. Option A as written would have made the failure the item is about — `npm ci` cut off mid-extraction — strictly worse, and silent as well. **Option B**, then, on the same principle that motivated A: the tool must not silently destroy in-flight work, so it now says exactly what it destroyed.

  Genuine survival would need the output pipes gone, and those pipes are what put `[hook]` lines in the log panel. That is a different feature, not this fix, and the README now says so along with the `nohup`/`setsid` escape hatch for a hook that really must outlive the quit.

  **The SIGTERM has to be worth sending.** The argument above is only true if the trap actually runs, and measured through the real quit path it did not: `handleQuit` calls `exitProcess(0)` in the statement after `cleanup()` returns, so the hook's pipes close within about a millisecond of the signal and a trap is SIGPIPEd the moment it prints anything. A trap writing only to files completed; the same trap with one `echo` in it died between its first line and its second. So `cleanup()` is now async and waits for the hooks it signalled — up to 250 ms, ending the instant their streams close, which for a hook with no trap (killed by SIGTERM's default action) is a millisecond or two. Quit latency is user-visible, so the wait is small, bounded, and not entered at all when no hook is running.

  Whatever is still there when the grace runs out is SIGKILLed. The 5-second escalation `cleanup()` used to arm could never fire — the process exited in the next statement — which was not merely dead code: a hook that traps or ignores SIGTERM was orphaned permanently, and had to be killed by hand. The wait watches each child's streams rather than its exit status, and the difference is measurable: with `sh -c` holding a grandchild that ignores SIGTERM, the shell dies on the first signal and reports `signalCode: "SIGTERM"` while the grandchild goes on holding the pipes. Escalating on the shell's exit status would have called that hook dead and orphaned exactly the work the escalation exists for.

  **What the quit names is what it signalled.** The list used to be built by pushing each command _before_ the kill, with `terminateChild` swallowing every failure, so the quit could name a hook it had never touched — a message added specifically so the tool would not lie about destroying work. `terminateChild` now reports whether the signal was delivered, and only a delivered signal puts the command on the list. The evidence is the kernel's: a hook that exits just before the quit is still in `activeProcesses` — its close event is queued behind the keystroke — and killing its group answers `ESRCH`. A hook found dead that way is not named at all, because the quit did not end it; a quit that finds every hook already finished is silent, like a quit with no hooks.

  `HookExecutionService.cleanup()` therefore returns the commands it signalled instead of returning nothing, and the quit path logs `Terminating N hook(s) still running; hooks do not outlive the interface:` followed by one `[hook] terminated on exit: <command>` per hook. The lines go to the log panel _before_ `isDestroyed` silences `addLog`, and to the stream _after_ Ink unmounts — on a plain `q` the panel is torn down a few statements later and never read, so a line that only reached `addLog` would have been another silent kill. The test asserts the position of both lines relative to the alternate-screen exit, and asserts the hook is really gone by probing the pid the hook itself reported rather than by observing that `kill` was called: the service kills a process _group_ through a shell it does not own, so only the OS can confirm the signal reached the work. (A killed orphan is reparented to pid 1 and lingers as a zombie wherever nothing reaps it, so the probe reads `/proc/<pid>/stat` rather than trusting ESRCH.)

  **T114.** `hooks.timeoutMs` is a new field on `HooksConfig`, accepted on a repository entry and under `defaults`, inheriting through the existing per-field hooks merge. `validateHooksConfig` requires a whole number from 0 to 2147483647 and otherwise throws `'hooks.timeoutMs' in <context> must be a whole number of milliseconds from 0 to 2147483647 (0 disables the timeout)`. The ceiling is `setTimeout`'s, not an arbitrary one: a delay above 2^31-1 does not fit its 32-bit field, and `timeoutMs: 31536000000` was measured emitting a `TimeoutOverflowWarning` over the alternate screen, being clamped to 1 ms, and SIGTERMing the hook about six milliseconds after it spawned while `onError` reported the year that had been asked for — the exact inverse of the request. Refusing it at load is what keeps the config file and the runtime agreeing; anyone who meant "no timeout" has `0`. `0` means no timer is armed at all — the hook runs unbounded, which is what an install step on a large repository needs, at the price that nothing reclaims it if it wedges short of quitting. The example config now sets `timeoutMs: 600000` beside the `pnpm install` hook it suggests, which routinely outran the undocumented 60s default it was shipped with.

  The value is threaded **per call**, not through `setTimeoutMs`. One `HookExecutionService` is shared by every repository the interface holds, so an instance field could not have expressed a per-repository setting — a second repository's hooks would have silently inherited the first's timeout. `setTimeoutMs` had no caller outside tests and is removed rather than left as a second, unreachable way to set the same thing; the tests that used it now go through `hooks.timeoutMs`, which is the path users have. The class is not part of the published type surface (`dist/index.d.ts` does not re-export it), so this is not a breaking change.

  Completion logs now name their command: `[hook] Command completed successfully: <command>` and `[hook] Command exited with code N: <command>`. With several hooks configured, the previous lines said only that _a_ command had finished.

  The example config no longer opens its hooks block by calling them "fire-and-forget" a dozen lines above the note that they never outlive the UI. And the two guarded stream writes teardown does — the shutdown notice and the hook lines — are now one `writeLines`, with a comment that says what the guard is actually for: a stream that refuses the write, since stdout is injected and is not always a live tty. It is not for EPIPE, which a stream reports through an `error` event that no synchronous `catch` could ever see. A test drives it with a stream that says no and pins what the guard buys — the quit still reaches `exitProcess(0)` instead of abandoning the statements that restore the terminal.

  **Why minor rather than patch.** Two reasons, and the repo's line (t92) makes the second decisive. It adds a config field, which is a feature. More to the point, the new validation refuses input that previously loaded: `hooks: { timeoutMs: "600000" }` or `timeoutMs: -1` used to load — `validateHooksConfig` inspected only `onBranchCreated`, and an unrecognised nested key merely produced an unknown-key warning — and now fails the load outright. A configuration that works today can stop working on upgrade, which is the case t92 reserves `minor` for. Verified against the pre-change loader rather than assumed.

  Config-loader coverage for the new field runs in a real `node` child process against an esbuild bundle of the loader, alongside the existing ESM-reload tests: under vitest the first load of a config goes through Vite's module runner and only a second through Node's own registry, so an in-process assertion can agree with a resolution the user's `node` run never produces. `0` surviving the load as `0` rather than being dropped as falsy is pinned there specifically.

- cf3dfe0: A `parallelism` block on a repository entry is now validated like the global and `defaults` ones. The example config documents a per-repository override, and nothing checked it: `maxStatusChecks: '50'` from a copy-paste, a `Number(process.env.…)` that came out `NaN`, a `0`, a `1.5` or a negative all loaded clean — `sync-worktrees list` reported the file as valid — and then reached `pLimit()` at the start of a sync phase, which throws `TypeError: Expected \`concurrency\` to be a number from 1 and up`. Verified end to end before the fix: `--runOnce`created the worktrees, failed the repository in the phase after the fetch, and exited 1, on every run, for each of those values. Each is now an`Invalid configuration for 'Repository 'x' parallelism.maxStatusChecks': must be a positive integer`at load, before any git runs. The rule is the one the other two levels already use — a positive safe integer — and a valid override still merges over`defaults` and the global block exactly as before.

  The safe-total guard (`MAX_SAFE_TOTAL_CONCURRENT_OPS`) now weighs the limits a repository will really run, rather than one level at a time against the built-in defaults for whatever that level leaves out. At most `maxRepositories` repositories sync at once and each runs its own widest phase, so the peak it checks is the sum of the widest phases of the `maxRepositories` widest repositories — not `maxRepositories` × the single widest one, which would reject a wide entry that only ever syncs beside narrow ones. A config with no per-repository overrides therefore gets exactly the verdict it got before, because that sum collapses to `maxRepositories` × the widest phase; the shipped example config's documented override (50 status checks on one of sixteen repositories, two at a time) comes to 70 of the 100 allowed and loads unchanged. The message names the repositories filling the slots and what each one runs.

  **Upgrading:** a config file that loaded before can now be refused at load, in four shapes, every one of them a repository entry or two levels weighed together. A file whose `parallelism` lives only in the global block, or only in `defaults`, keeps the verdict it had, message included.

  - A repository override that pushes the run past the safe total (`maxRepositories` × the widest phase was under 100 at each level on its own, the merged sum is over). Lower the override, or lower `maxRepositories`; the error prints both numbers and names the setting to change.
  - A global `maxRepositories` meeting a `defaults` phase limit — neither level is over the limit alone, and nothing weighed them against each other before. Same fix.
  - `parallelism: null` on a repository entry, which used to be ignored silently. Delete the key, or make it an object.
  - A repository-level value p-limit itself would take but this rule never has: `Infinity`, or an integer past `Number.MAX_SAFE_INTEGER`. `Infinity` stays rejected on purpose — an unbounded phase has no peak to weigh against the safe total, and bounding git processes is what these settings are for. Pick a finite limit.

- cf3dfe0: `fetchTimeoutMs` and `cloneTimeoutMs` are real config-file settings now. They can be written on a repository entry or under `defaults` — the entry wins, the same precedence every other merged field has — and they reach the git clients that use them.

  They were documented as user knobs on `Config`, down to a "set 0 to disable" gloss, and both `GitService` and `CloneSyncService` read them; the README described them and sent people to the example config for how to set them. But `resolveRepositoryConfig` rebuilds each repository from an explicit list of fields and that list never named these two, so nothing a config file said about them survived into the object the services receive. A repository on a slow self-hosted server that needs more than five minutes of silent server-side pack resolution could be given `fetchTimeoutMs: 1800000` exactly as documented and still have every sync killed at 300 s, with nothing to say the setting had been ignored. The two values were only ever reachable by constructing a `Config` in code, which is how every test of them was written and why no test caught this.

  Both are validated as non-negative safe integers at both levels; a negative, a fraction, `NaN`, `Infinity` or a non-number is a `ConfigValidationError` naming the field rather than a value handed to `setTimeout`. `0` disables a timeout: both services install simple-git's timeout plugin only for a positive block, and the plugin itself does the same, so a zero never reaches git as an instant kill. Local git commands still never carry either window — a `git worktree add` that is silent for minutes while it checks out a large repository must not be killed for it.

  The two fields join `SyncWorktreesConfig` (on repositories and on `defaults`, in both modes), so a `@ts-check`ed config file type-checks them, and `sync-worktrees.config.example.js` shows both.

- cf3dfe0: `sync-worktrees init` no longer reports success for a config file that cannot be loaded. Three ways it could write one, each of which printed `✅ Configuration saved`, offered MCP registration and exited 0, leaving the failure to surface on the next run:

  - `--config x.cjs` got `export default config;`, which the loader reads with `require()`: `Failed to load config file: Unexpected token 'export'`.
  - The default `.js` target inside a package whose nearest `package.json` declares `"type": "commonjs"` failed identically — verified on Node 22 and 24, an explicit `type` turns off the module-syntax detection that otherwise re-parses such a file as ESM.
  - Answering the worktree-directory prompt with the config file's own directory wrote `worktreeDir: "./"`; the default `bareRepoDir` `.bare/<name>` then sat inside `worktreeDir` and the next run died on `bareRepoDir/worktreeDir must not overlap`.

  The generator now emits `module.exports = config;` when Node will parse the target as CommonJS (a `.cjs` extension, or any other extension whose nearest `package.json` says `"type": "commonjs"`) and keeps `export default config;` otherwise, so the file it writes is the path the user asked for rather than a substitute with a different extension. The wizard rejects a worktree-mode directory equal to the config's own directory and warns for clone mode, where `git clone` refuses a destination that exists and is not empty. `init` then loads the file it just wrote through the same `ConfigLoaderService.buildRepositories` entry point a sync run uses: if it does not load, the command prints the loader's error and exits 1, and the file is left on disk to inspect or fix rather than deleted. Finally, a `SyntaxError: Unexpected token 'export'` from any config now carries a hint naming the file and the fix (`add "type": "module" … or use .mjs/.cjs`), appended to the original message rather than replacing it.

  Upgrading: `init` can now fail where it used to succeed — the wizard refuses a worktree directory it previously accepted, and the command exits 1 instead of 0 when the file it wrote does not load. Both only ever fire on a config that would have failed on the next run anyway; nothing else about `init`'s output, or about the contents of a config it already wrote correctly, changes. Verified by reproducing all three failures against the built CLI in real temp directories on Node 22 and Node 24 and re-running the same three afterwards, and by generator tests that load each generated file in a real `node` child process — Vitest resolves `import()` through its own pipeline, so an in-process load alone would not prove Node accepts the file.

- cf3dfe0: Reloading a config now re-reads the modules the config imports, not just the config file. Splitting a config across files is documented and supported, but a reload — `r` in the interactive UI, the MCP `load_config` tool — only appended `?t=<now>` to the config file's own URL. That busts one module. Anything the config pulled in with `import { repos } from "./repos.mjs"`, `await import(…)` or `createRequire(…)` kept its original specifier, stayed in Node's module registry, and handed back the exports it was first evaluated with: adding a repository to `repos.mjs` and pressing `r` logged "Reloading configuration..." and re-synced the old list, until the process was restarted. Verified against real `node` 22 and 24 before the fix, for a `.mjs` config, a `.js` config in a `"type": "module"` package, and children reached by static import, dynamic import and `createRequire` — all six shapes stale, the `.cjs` path (fixed earlier by clearing the require-cache subtree) fresh.

  Found while verifying it: a `.js` config that resolves as **CommonJS** — no `package.json` beside it, or one saying `"type": "commonjs"` — did not reload _at all_, not even the config file itself. Those are loaded through `import()` too, and Node's ESM→CommonJS bridge ignores the query string the cache-busting relied on. Editing such a config and reloading changed nothing. It reloads now.

  A reload re-evaluates the config on a worker thread, which starts with an empty module registry, so the whole transitive graph is read from disk again. The first load of a config in a process still runs in-process exactly as before, so one-shot CLI commands, daemon start-up and MCP start-up are unchanged and cost nothing extra; a reload costs one worker start, measured at ~46 ms on Node 22 and ~37 ms on Node 24.

  Two things a user could notice:

  - The exported config value now crosses a thread boundary on a reload, so it has to be structured-cloneable. Plain data is — including `undefined` (kept distinct from an absent key, which decides whether a repository inherits a `defaults` value), `NaN`, `Infinity`, `Date`, `RegExp`, `Map`, `Set` and `BigInt`. A **function** is not, and neither is a symbol, a `WeakMap` or a `Proxy`. No setting takes any of those (`hooks.onBranchCreated`, `branchInclude` and `branchExclude` are all arrays of strings), so this only affects a config carrying such a value in a field nothing reads; a reload that finds one now fails naming the value, rather than dropping it silently. To adapt, export the function's result instead of the function. Class instances arrive as plain objects, losing their methods — again, no setting takes one. The first load is unaffected either way.
  - An error thrown by the config file itself is rebuilt on the main thread from its name, message and stack rather than re-thrown as the same object, so on a reload a custom error class becomes a plain `Error`. The message, the error name and the "uses ESM syntax but Node parsed it as CommonJS" hint are all preserved, and validation errors are unchanged — validation still runs on the main thread.

  `minor` rather than `patch`: reload gains behaviour the documentation already promised, and the two notes above are visible changes to what a config file may export and to how an error thrown inside one is surfaced.

- cf3dfe0: The daemon syncs once at startup again, controlled by a new `defaults.syncOnStart` (default `true`).

  Bare `sync-worktrees` built its services, wired the TUI, scheduled the cron jobs and then did nothing until the first tick. With the `0 * * * *` schedule `sync-worktrees init` writes, running `sync-worktrees` at 10:05 printed `📋 1 repositories configured` and sat there — no bare repo, no worktrees — until 11:00, unless you knew to press `s`. The README has said the bare command "starts syncing" throughout. A daemon restarted after a config change had the same hole: the new config was loaded but nothing acted on it for a full schedule period.

  An initial sync existed in 3.x, became opt-in behind `--sync-on-start`, and 4.0.0 removed that flag with the rest of the CLI surface without naming a config replacement. `defaults.syncOnStart` is that replacement, and it is on by default rather than opt-in: waiting is the surprising behaviour, not the sync.

  **This changes what an existing daemon does on restart.** A restart now runs one sync immediately instead of waiting for the next tick. Set `defaults.syncOnStart: false` to keep the old behaviour — the cron schedule is untouched either way, and `--runOnce` is unaffected (it already syncs once and exits, and never builds the UI the startup sync goes through).

  The startup cycle is exactly what the first cron tick would have run: the same services, the same lazy initialize, the same parallelism limit. The one difference is that a failure is written to the log panel, which a cron tick does not do — on the first sync of a run "why are there no worktrees" deserves an answer, while a tick stays quiet and retries. It runs after the interface is on screen and after the `📋`/`⏰` summary lines, and is not awaited, so a slow first fetch never holds up startup.

  `syncOnStart` is a whole-file setting like `runOnce`: one process runs every repository in the config, so it cannot be scheduled for some and skipped for others, and setting it on a repository entry is a validation error pointing at `defaults.syncOnStart`. It is a boolean, validated at load, included in the exported config types (so a `@ts-check`ed config file completes it), and registered with the unknown-key scan so a valid `defaults.syncOnStart` does not warn.

  Because the startup cycle and the cron jobs are armed in the same breath, a tick landing inside the startup sync went from a rare `s`-during-a-sync to something every run can meet. The per-repository lock always stopped the second cycle doing any real work, but not before it had cleared each service's recorded clone-mode skips out from under the running one and driven the status bar back to idle mid-sync. So a cycle now claims a repository for as long as it is syncing it: an overlapping tick, or an `s`, leaves the repositories another cycle holds to that cycle and reports them as `Sync skipped for '<repo>': sync skipped: in_progress`, while the repositories nobody holds are synced. The status bar follows the number of cycles in flight rather than whichever one finishes first, so it stays on `Syncing...` until the last one is out.

  `minor` rather than `patch`: a new public config key, and default behaviour changes for daemons that already exist. The only config that loaded before and fails now is one that already carried a stray `syncOnStart` on a repository entry, where the unknown-key scan warned about it and the loader dropped it; it is now a load error naming `defaults.syncOnStart`.

- cf3dfe0: MCP `create_worktree` now refuses a branch the repository's own filters exclude, and says when a new worktree is one the next sync will take away again.

  `handleCreateWorktree` never read `branchInclude`, `branchExclude` or `branchMaxAge`; those lived only in the sync runner. The planner prunes every registered worktree whose branch is missing from the _filtered_ remote branch list, and a worktree created seconds ago is clean, has nothing unpushed (`rev-list <branch> --not --remotes` is 0, because HEAD is the base tip) and no gone upstream — so `canRemove` is true and `trashAndUnregisterWorktree` moves the directory into `.trash` and deletes the local branch ref. Under `{branchInclude: ['main', 'release/*']}` with the hourly daemon running, `create_worktree {branchName: 'feature/x'}` returned `success: true` and the agent's next `get_worktree_status` on that path failed with "not a registered worktree". `create_worktree {branchName: 'exp', baseBranch: 'main', push: false}` went the same way: the branch exists nowhere on origin, so the checkout and the branch ref were both gone an hour later, recoverable only through trash restore, which the MCP surface does not expose. Uncommitted or unpushed work was protected by `canRemove` the whole time; the checkout itself was not. Measured against real git: force-create an excluded branch, run one sync, and the worktree is in `.trash` with `refs/heads/feature/x` deleted — the new suite asserts exactly that.

  The branch is now measured against the same filters the runner applies, before anything is written. A branch excluded by name errors with code `BRANCH_FILTERED` naming the filter and its patterns; a branch older than `branchMaxAge` errors the same way. `force: true` proceeds anyway and still reports the filter in the response's new `warning` field, so the escape hatch is not a mute button. The default branch is exempt for as long as origin carries it, because `resolveSyncBranches` puts it back into the inventory whatever the filters say — its worktree is where every fetch runs — and refusing it would refuse a worktree sync never prunes. `branchMaxAge` costs one `for-each-ref` over `refs/remotes` in the local ref store — the same read the runner does, no extra network — and only when `branchMaxAge` is set _and_ origin carries the branch.

  A branch with no `origin/<branch>` cannot be refused on that basis (`baseBranch` + `push: false` is a legitimate request), so it is warned about instead: the response carries a `warning` saying the next sync removes the worktree and deletes the branch ref until it is pushed. The same warning covers a push that failed and a pre-existing local-only branch, and the `push` parameter's own description now says so. `createWorktreeOutputSchema` gains `warning?: string`; the object is loose, so nothing on the wire breaks.

  Worktree mode only: `create_worktree` already errors for clone-mode repositories, and clone mode rejects these three keys at load time.

  This is a minor rather than a patch because of what it refuses. A call that returns `success: true` today — `create_worktree` for a branch the filters exclude — now returns an error. Most of the time the result it produced was short-lived, and that is the point of the fix. But not always: the branch is pushed before the worktree is handed over, so commits made in the window survive on origin whatever the next tick does to the checkout, and a repository whose daemon is not running and whose `sync` is never called keeps that worktree indefinitely. `branchInclude` in a config file is not proof that anything is pruning. Those are working setups, and they now have to pass `force: true`.

  `t39` scored the same shape — an MCP call that appeared to succeed and now errors — as a minor, and `t91` did the same for config that used to load; `t92` stayed a patch precisely because it refuses nothing. `t40`'s `TARGET_EXISTS` is a patch because the call it refuses used to move the caller's directory to trash, which is not an outcome anyone was relying on. The `push: false` half only adds a `warning`, and `createWorktreeOutputSchema` is a `looseObject`, so the new field is not a wire break.

- cf3dfe0: Every MCP tool input schema is now a `z.strictObject`, so an argument key no tool declares is refused by name instead of being dropped in silence.

  All nine tools declared `inputSchema: z.object({...})`. A plain `z.object` strips unknown keys, and the SDK's `validateToolInput` passes the stripped `parseResult.data` to the handler, so a misspelled or snake_case argument simply ceased to exist and the handler ran on its defaults. Measured against the built `dist/mcp-server.js` over stdio before the change: `detect_context {path, include_status: true}` returned the full context with no status labels and `isError` unset — indistinguishable from a caller that never asked for them — and `list_worktrees {repo_name: 'b'}` listed every configured repo. The one that costs something is `create_worktree {branchName, baseBranch, repo_name: 'b'}` under a multi-repo config: `repoName` never reaches the handler, so the branch is created, pushed and given a worktree in whatever repository is current, and the response says `success: true`. snake_case argument names are a routine LLM failure mode, so none of this is hypothetical.

  Strict turns each of these into an InvalidParams error, and the offending key survives all the way to the client. zod puts it in the issue message (`Unrecognized key: "repo_name"`), not only in the structured `keys` array that Standard Schema drops on the way to the SDK, so what a client now receives for the case above is an error result reading `Input validation error: Invalid arguments for tool create_worktree: Unrecognized key: "repo_name"` — quoted from a real stdio round trip against the built bundle, on both the 2026-07-28 and the legacy 2025-11-25 protocol paths.

  The advertised tool listing changes with them: every `tools/list` input schema now carries `additionalProperties: false`, which is the only difference in the JSON Schema a client sees. That is the half of the fix that works before a bad call is made — a client whose model decodes against the advertised schema is now steered away from `repo_name` rather than only corrected after the fact.

  Nothing else about the schemas changes. `.optional()` and `.default()` behave exactly as before, no tool relied on `.passthrough()` or a catchall, and every input is flat — strings and booleans only, no nested object or array-of-objects — so the shallowness of `z.strictObject` has nothing to reach past. The inferred TypeScript types are identical, and the handlers declare their own parameter types rather than inferring them from the schemas.

  This is a minor rather than a patch because it is a visible behaviour change for every MCP client: a call that today sends an extra key and appears to succeed will start returning an error. That cost is accepted deliberately. A call that appears to succeed while acting on the wrong repository is worse than one that fails with the reason printed.

- cf3dfe0: `repoUrl` validation and the `.bare/<name>` derivation now read one Git URL grammar instead of two sets of regexes that had drifted apart. A `repoUrl` the config loader accepted could still die moments later in `getDefaultBareRepoDir` with `Invalid Git URL format` — a message contradicting the validation that had just passed — because the extractor had no `git://` branch and its path pattern could not match a trailing slash: `https://github.com/acme/app.git/` (a URL copied out of a browser) and `git://git.example.com/app.git` both loaded and then failed whenever `bareRepoDir` was not pinned explicitly. The converse held too: `deploy@host:org/repo.git` — git's scp form with a user other than `git`, ordinary on self-hosted Gitea and Gerrit — was refused although git takes it and the origin-comparison helper already handled it.

  Newly accepted: `git://` URLs; a trailing slash (or several) on any http(s)/ssh/git/file/scp URL; the scp form with any `[\w.-]+` user; and an upper- or mixed-case scheme, which RFC 3986 and git both treat as equivalent.

  Newly refused, at load time and with a message naming the entry:

  - a `repoUrl` with no repository path segment that git cannot dial either — `git://host`, `ssh://git@host`, `git@host:`, `git@host:/`, `file://`, `/`, and now `https://` with no host at all. git answers `fatal: no path specified` for these itself; there is nothing to load.
  - a `repoUrl` padded with leading or trailing whitespace. Leading padding was already refused by the loader's anchored regexes; trailing padding was accepted and handed to git as-is, which rejects it outright for an http(s) URL (`URL rejected: Malformed input to a URL function`) and otherwise asks the far side for a path ending in a space — so it could only ever have resolved for a local or scp path whose last component genuinely ends in one. It is refused rather than trimmed because the config file must hold the exact string git is given; `extractRepoNameFromUrl` still trims, since the init wizard calls it with raw keystrokes.
  - a `repoUrl` with an embedded newline or carriage return. The old extractor matched one and named a directory `re\npo` after it; git warns `url contains a newline in its path component` on the same remote.
  - the scp form with a `/` or a second `@` before the colon — `git@ho/st:repo.git`, `git@@host:repo.git` — both of which the old extractor split at the first colon and named `.bare/repo`. The first is not an scp URL at all: git reads a slash before a colon as a local path, so that name was being derived for a remote git was never going to dial. The second git does take, reading `git@` as the username; the grammar's `[\w.-]+` user class stops short of it, and no ssh account name contains an `@`.

  A `repoUrl` that stops at an http(s) host — `https://git.example.com`, a repository published at a web root — is **not** refused. git clones one, so refusing it would have hard-blocked a working configuration with no other spelling to move to. It simply has no path segment to name `.bare/<name>` after, which is a different question and is asked in a different place: such an entry loads when it carries an explicit `bareRepoDir`, and without one it is refused by a message that names the entry and says exactly that. Validation answers "can git use this?"; only an entry that needs a derived directory name has to answer "can one be derived?".

  One extracted name changes for a remote that does work: git's bracketed IPv6 literal in scp form. `git@[2001:db8::1]:repo.git` is now split at the host rather than at the first colon, so its bare repo is `.bare/repo` instead of `.bare/db8::1]:repo`. That directory name is legal on both supported platforms, so this is not hypothetical — **anyone syncing a bracketed-IPv6 remote without an explicit `bareRepoDir` will have the tool look at the new path, not find a repository, and clone again.** The old name was wrong and every other spelling of the same remote already produced `repo`; set `bareRepoDir` to the old path if you would rather keep the clone.

  Credential redaction in logs and errors is byte-for-byte unchanged for every shape, new and old, and so is `normalizeRepoUrlForComparison`, which means duplicate-`repoUrl` detection and the "checked-out origin does not match the configured repoUrl" check behave exactly as before. `minor` rather than `patch`, as for the other changes in this line that started refusing config the loader used to wave through: a configuration that loaded can now fail to load, and a bare repository that resolved can now resolve elsewhere.

- cf3dfe0: Cone-mode `sparseCheckout.include` entries are now checked at config load against the rules `git sparse-checkout set --cone` actually enforces, instead of being discovered one worktree at a time for the life of the daemon. Cone is the default mode, and the field's name invites gitignore syntax: `include: ['/apps/web']` loaded clean, `sync-worktrees list` called the file valid, and then the first sync added a worktree per branch with `--no-checkout`, failed the sparse step, rolled each one back, and recorded a `create_failed` per branch — and did it again on the next tick, and every tick after, forever. Step 5 repeated the same failure for every worktree that already existed. The message it failed with, `Sparse-checkout setup failed for '<branch>'`, named neither the offending entry nor the rule it broke. The load-time error names all three: the repository, the entry as written, and what to change.

  The four rules are git's own, read out of `sanitize_paths()` and `strbuf_to_cone_pattern()` and confirmed by running every shape below through real `git sparse-checkout set --cone`: no leading `/`, no leading `!`, none of `*`, `?`, `[` or `]` anywhere, and nothing that normalizes above the repository root. Entries are judged in the form git receives them — after the trimming, trailing-slash, `./`, `..` and repeated-slash normalization the tool has always applied, and after an entry an included parent already covers is dropped — so the check refuses exactly the argv that would have failed and nothing else. `apps/web/`, `./apps/web`, `apps//web`, `apps/web/.` and `apps/../docs` all still load, as do the directory names that merely look like patterns: a backslash (named in git's own error message but absent from its check), a space, a tab, braces, `#`, `~`, a Windows-style path, a non-ASCII name, a directory that does not exist yet, and `.`, which git takes and matches nothing with.

  Two refusals git makes are deliberately not mirrored. `'<path>' is not a directory` depends on what the index holds when the patterns are applied, which a config load cannot know, so it is still reported by the sync — the clone-mode end-to-end test that used to prove a git-rejected sparse config fails the run rather than warning now uses that shape. And `--skip-checks`, which is how git lets a directory genuinely named `apps/*` through, is never passed here, so the rules hold unconditionally.

  Separately, the patterns are now passed after a `--`, so git reads every one of them as a path. Without it a directory whose name begins with a dash is read as an option, in cone and no-cone mode alike: git 2.43 passed `PARSE_OPT_KEEP_UNKNOWN_OPT` to `sparse-checkout set` and let `include: ['-apps']` through, git 2.55 dropped that flag and dies on the same config with ``error: unknown switch `a' `` — per branch, per tick, naming neither the entry nor the reason. Both versions also read a directory named `--skip-checks` as the flag, which turns off the sanity checks this change validates against and leaves the pattern list silently empty, and one named `--cone` or `--no-cone` as the mode. The `--` costs nothing otherwise: over the same differential corpus, both git versions answer identically with and without it on every config that does not start an entry with a dash.

  Nothing changes for `no-cone`, where a leading slash, a glob and a `!` are the point: the check asks which mode the config resolves to first, and answers nothing outside cone. That includes the configs that reach `no-cone` without saying so — any `exclude`, or any `include` entry starting with `!`, still auto-promotes exactly as before, which is also why `exclude` needs no rules of its own.

  Checked against real git 2.43.0 and real git 2.55.0 (built from source here, since the container ships 2.43): the two answer identically on all 53 probed shapes, in cone and no-cone mode, and a differential run of the new validator against both binaries over 67 single- and multi-entry configs agrees on every one, with zero cases refused that git accepts. `git sparse-checkout check-rules` is not usable as the oracle, incidentally — it applies the normalization check but none of the leading-slash, `!` or glob checks, and reports success for `/apps/web`.

  **Upgrading:** a config file that loaded before can now be refused at load, in these shapes and no others. Each is a `sparseCheckout.include` entry, in a block that resolves to cone mode — no `mode: 'no-cone'`, no `exclude`, no `!`-prefixed entry — judged after normalization.

  - An entry that starts with `/`: `'/apps/web'`. Drop the leading slash and write `'apps/web'`, or set `sparseCheckout.mode: 'no-cone'` to keep gitignore-style patterns. This is the common one; it is what a gitignore-minded reader writes first.
  - An entry holding `*`, `?`, `[` or `]`: `'apps/*'`, `'apps/we?'`, `'apps/[a-z]'`. Cone mode already includes everything under a directory, so name the directory — `'apps'` — or move to `'no-cone'`.
  - An entry that climbs above the repository root: `'..'`, `'../x'`, `'apps/../../x'`. Name a directory inside the repository.
  - An entry that normalizes into a leading `!`, such as `'x/../!y'` or `'./!y'`. Rare, and only reachable through a `.` or `..` segment, since a plainly `!`-prefixed entry promotes the whole block to `no-cone` instead. Put negations in `exclude`.
  - Any of the four in `defaults.sparseCheckout`, even where every repository overrides it — `defaults` has always been validated on its own terms, and it is inherited by clone-mode entries too, which run the same `sparse-checkout set --cone`.

  `minor` rather than `patch`, on the precedent of the other changes in this line that started refusing config the loader used to wave through: a file that loaded can now fail to load. Every shape it refuses is one that could not have worked — git fails the same argv on both tested versions — so no working configuration is newly rejected, but the run now stops at load instead of failing per branch per tick.

- cf3dfe0: `sync-worktrees trash` is now readable and survivable from a terminal. The listing was four tab-separated fields — id, reason, expiry, original path — and an empty trash printed nothing at all, which reads the same as a command that did not run. It is now a table of `Id`, `Branch / path`, `Reason`, `Size`, `Expires`, `Restores as` and `Keep on reap`, and an empty trash says "No trash entries.". `Restores as` is the answer to the question the old listing never showed: whether the entry still has the branch, HEAD commit and pin ref that let a restore rebuild a registered worktree, or only files. `Keep on reap` marks the entries whose commits were on no remote when they were trashed. `Size` reads `—` for a payload nothing has measured yet, never `0` — sizes are gathered off the repository lock at the tail of a sync, so an entry trashed moments ago has none, and the listing does not stop to run a `du` of its own. An entry past its expiry is marked, since the reaper only runs at the tail of a sync and such an entry is still on disk. `--json` prints the same listing as `{ entries, invalidEntries, keepRefs }`, with `sizeBytes` null rather than zero when unmeasured.

  The table is what a terminal gets. A pipe still gets exactly the rows this command has printed since 5.2.0 — `id\treason\texpiresAt\toriginalPath`, then `KEEP\t<name>` — because the table library draws box characters and colour with no terminal detection of its own, and sending that down a pipe would hand `sync-worktrees trash | cut -f1` escape sequences where it used to get an id. Nothing that scripts against the old output has to change; `--json` is the shape to build anything new on.

  Expected failures — no entry with that id, a destination that already exists, a repository lock another process holds, a confirmation that was declined — now print one `❌ <message>` line and exit 1. They used to reach the top-level handler as `❌ Unhandled error:` plus a stack trace. The catch is narrow on purpose: anything that is not one of the tool's own typed errors still keeps its stack, because a stack is the only useful thing to say about a bug.

  `--restore` and `--purge` take the repository lock, and a daemon holds it for the length of a sync. The in-process mutex already queued for them, but the cross-process lock was taken with `retries: 0`, so a restore run alongside a daemon failed on the spot for a reason that clears itself in a minute. `--wait` now retries that lock for up to two minutes and then gives up with the same message — a bound, not "block until it frees up", so a scripted or non-interactive invocation always terminates. The two locks a worktree-mode repository takes share one window rather than getting it each, so the worst case is the budget and not twice it. Without `--wait` nothing changes: every caller that does not ask for a budget, every periodic one included, still makes a single attempt, because a cron tick that cannot take the lock is a clean skip.

  `--purge <id>` deletes one entry ahead of its expiry, which previously meant the README's `rm -rf <id>` plus `git update-ref -d` by hand. It carries the same gate as `--dropKeepRef` and `--dropAllKeepRefs`: an interactive TTY, the entry's id typed back, and a `trash_purge` audit record written before anything is touched. It runs through the expiry reaper's own path rather than around it, so a `Keep on reap` entry gets its permanent `refs/sync-worktrees/keep/<id>` ref created **first** and its files deleted only if that succeeds; when the ref cannot be created, nothing is deleted and the pin stays. Those commits are on no remote, so the payload and the pin can be the only copy in existence, and the prompt says so before the confirmation. This is deliberately not force clean's behaviour, which mints no replacement refs — that confirmation covers the recovery refs too, and this one covers a single entry.

  Restoring an entry that has no pin still restores files only, and the warning now says what happens next: if the branch is still in the repository's synced set, the next sync finds an unregistered directory where its worktree belongs and moves it back to trash as a fresh `orphan` entry. The warning named the shape of the restore but not its consequence, so the directory reappearing in the trash looked like a second, unrelated failure.

- cf3dfe0: Three settings that the loader waved through and the sync then read as something the user never wrote are now refused at load, each with a message naming the repository and the field.

  `branchInclude: [""]` used to load. `filterBranchesByName` applies an include list on `length > 0` alone and an empty pattern matches no branch — git refuses a branch name containing a space, so a whitespace-only one matches nothing either — so the filter kept nothing, and the prune phase then saw every worktree but the default branch's as unmanaged. Reproduced against the real planner before the fix: with four branches and four worktrees, `branchInclude: [""]` left `main` in the inventory (the default branch is re-added after filtering) and planned all three feature worktrees for removal in one tick. What each one costs depends on its state — a dirty or unpushed worktree is still skipped by the status check — but a clean, fully pushed one is moved to trash, and removed outright when `trash.enabled` is false. The shape this arrives in is `(process.env.BRANCHES ?? "").split(",")` with the variable unset, which yields `[""]` and not `[]`.

  Every numeric field of `retry` is now checked for finiteness, and the two counts for integrality. The old bounds were all `<`-shaped and `NaN < 1` is false, so `NaN` and `Infinity` passed every one of them. Measured against `retry()` before the fix: `maxAttempts: NaN` made it throw `maxAttempts must be 'unlimited' or a finite positive number` before the first attempt, so every sync failed without trying, while `sync-worktrees list` called the file valid; a NaN `initialDelayMs`, `maxDelayMs` or `backoffMultiplier`, or an `Infinity` `jitterMs`, made the computed delay non-finite, and `setTimeout` floors that to 1 ms — hundreds of attempts per second against the remote in place of the intended 1s/2s/4s backoff, and unbounded when `maxAttempts` is `'unlimited'`; `maxDelayMs: Infinity` instead removed the cap, so the doubling ran away into days between attempts; and a non-finite `maxLfsRetries` never tripped the LFS retry limit, because `lfsAttempt > NaN` is never true. Two non-finite values are harmless on their own and are rejected anyway, so that each field has one rule rather than a list of exceptions: `backoffMultiplier: Infinity` only pins the delay to `maxDelayMs`, and `jitterMs: NaN` is skipped by `NaN > 0`.

  `sparseCheckout.skipUpdateWhenOutsideSparse` is now checked as a boolean. The update phase reads it as `!== false`, which is true for every non-boolean, so the string `"false"` _enabled_ the skipping it was written to disable and HEAD stopped advancing for upstream changes outside the sparse set. Confirmed by driving the update phase with `"false"`: it consulted the diff for all three worktrees and updated none of them.

  **Upgrading:** a config file that loaded before can now be refused at load, in these shapes and no others.

  - `branchInclude` or `branchExclude` holding an empty or whitespace-only pattern, at either level. The message gives the index. Omit the field to sync every branch, or name the branches you want (`branchInclude: ["main", "release/*"]`). An empty _list_ still means "no filter" and is unchanged.
  - `retry.maxAttempts` as `NaN`, `Infinity`, a fraction, or a whole number above `Number.MAX_SAFE_INTEGER`. `Infinity` is not a spelling of unbounded and never was — `retry()` has always thrown on it, on every sync — so write the string `'unlimited'`, which is the only spelling, or a whole number. (What the built-in default is, and what the README says it is, is a separate matter and unchanged here.)
  - `retry.maxLfsRetries` as `NaN`, `Infinity`, a fraction, or a whole number above `Number.MAX_SAFE_INTEGER` — write a whole number; `1.5` only ever meant 1.
  - `retry.initialDelayMs`, `retry.maxDelayMs` or `retry.jitterMs` as `NaN` or `Infinity`. `initialDelayMs: Infinity` was already refused, but only by the unrelated "must not exceed `maxDelayMs`" check — which also means it reported a different message before, and slipped through entirely when `maxDelayMs` was `Infinity` too. Write a finite number of milliseconds.
  - `retry.backoffMultiplier` as `NaN` or `Infinity`. Write a finite multiplier of at least 1.
  - `sparseCheckout.skipUpdateWhenOutsideSparse` as anything but a boolean — `"false"`, `"true"`, `0`, `1`, `null`. Write `false` or `true`.

  Fractions stay legal where they mean something: `initialDelayMs`, `maxDelayMs`, `jitterMs` and `backoffMultiplier` are continuous, and `backoffMultiplier: 1.5` works exactly as written. `trash.retentionDays` keeps its finite-positive rule for the same reason — it is multiplied by 86,400,000, so `0.5` is a twelve-hour retention and a real setting, not a typo. Only `maxAttempts` and `maxLfsRetries` are counts, and only they are required to be whole.

### Patch Changes

- cf3dfe0: Test-suite only: every git the suite runs now sees an empty global config and no system config. The LFS suites stand in for a broken LFS setup by installing a deliberately failing `filter.lfs.smudge`, but `git lfs install` defines `filter.lfs.process`, and git prefers a long-running process filter over `smudge`/`clean` without ever falling back to them. On any machine that has git-lfs — every GitHub Actions runner — the failing smudge was shadowed, the checkout succeeded, and the assertions that expect a failure inverted, so the suite passed locally and failed in CI. Pinning the configuration also stops any other host setting from reaching the tests.
- cf3dfe0: Tooling only: `pnpm smoke`'s unpacked-tarball ceiling moves from 1,250,000 to 1,400,000 bytes. The published bundles are not minified, so every comment in the source ships with them and ordinary work on this codebase walks the tarball up by single-digit kB at a time; the old ceiling had been reached that way and was refusing changes of a few kB, which is not what it is for. It still trips on the step changes it was written for — a dependency that stops being `external` in esbuild, or source maps coming back, each of which adds hundreds of kB at once — and the file-count ceiling is unchanged. The script now carries the current composition of the tarball next to the limits.
- cf3dfe0: The MCP `sync` and `initialize` tools now stay unavailable for auto-detected (unconfigured) repositories even after `create_worktree` or `update_worktree` has run, and their reason says whether no config is loaded or the loaded config simply does not list the repository.
- cf3dfe0: A repository lock that cannot be prepared or taken (unwritable or missing lock directory, `SYNC_WORKTREES_LOCK_DIR` pointing at a file, read-only filesystem, ENOSPC) is now reported as a failure that names the path and errno — `--runOnce` exits 1 and its summary counts the repo as "lock unavailable", the TUI logs an error, and the MCP tools return `LOCK_UNAVAILABLE` — instead of a skip claiming another process holds the lock.
- cf3dfe0: `list_worktrees` and `detect_context` stop spending git processes on work they had already done.

  The worktree status result now carries `divergence {ahead, behind}`, taken from the `## <branch>...<upstream> [ahead N, behind M]` header `git status -b` already prints. The MCP layer used to follow every status probe with a separate `rev-list --left-right --count HEAD...@{upstream}` on a simple-git client it built for that one command — outside the status service's process budget — to learn the same two numbers. It no longer does, and a worktree with no upstream to compare against still reports `null` rather than a fabricated 0/0.

  `detect_context {includeStatus: true, includeAllWorktrees: true}` passed both `allWorktrees` and `allWorktreesByRepo[<current repo>]` through enrichment independently. Those two lists are separate `worktree list --porcelain` reads of the same repository, so every worktree of the current repo was probed twice. Each path is now probed once and both lists report that one answer.

  Measured with a `git` shim on PATH against a 40-worktree repository: `list_worktrees` 321 → 281 git processes, `detect_context` 641 → 281.

  The discovery cache is also bounded now, at 64 probed paths, least-recently-used first out. It was keyed by probed path and entries were only ever marked stale, never removed, so a long-lived MCP server retained a full `allWorktrees` array for every directory it had ever been pointed at. An evicted path is simply re-detected, exactly as a cache-TTL expiry already forces.

- cf3dfe0: MCP `create_worktree` now says when the worktree was already there, and is annotated `idempotentHint: true`.

  When `<worktreeDir>/<sanitized>` was already a registered worktree for the same branch, `addWorktree` logged a line and returned `already_registered`, and the handler answered `{success: true, branchName, worktreePath, created: false, pushed: false}` — byte for byte what "checked an existing remote branch out into a brand new worktree" answers. An agent retrying after a client timeout got back a response indistinguishable from a fresh checkout, so it could assume it was holding a clean tree and skip an `update_worktree`, or tell the user it had created something it had not. The response now carries `worktreeExisted`, computed from the `git.getWorktrees()` listing the handler already fetches for its collision and `TARGET_EXISTS` guards, so it costs no extra git call. `createWorktreeOutputSchema` gains `worktreeExisted: z.boolean()` as a required field — the handler's return type guarantees it on both the success and the push-failure paths — and the object is a `looseObject`, so nothing on the wire breaks.

  The annotation was wrong rather than merely conservative, and the flip was checked case by case against real git rather than argued:

  - **Existing remote branch.** The second call fetches, finds the branch, finds the path registered, and `addWorktree` returns. Nothing is written.
  - **New branch that the first call created and pushed.** The retry is a no-op, and — this is the part that could have made the flag wrong — it does not push again. `created` is gated on the branch existing neither locally nor remotely, and the first call's `createBranch` made it exist locally, so `created` is `false` on every subsequent call and the `created && push` push block is never entered. The branch is pushed exactly once however many times the tool is called. The first call's push is a one-time effect; `idempotentHint` is about the _additional_ effect of repeating, and there is none.
  - **`push: false`.** The retry is a no-op and still does not push, and still carries the same local-only prune warning, so the agent is not told the situation resolved itself.
  - **A push that failed (`success: false`).** The retry also does not reattempt the push, for the same reason, and answers `success: true, pushed: false`. That is not an additional effect, so the annotation holds — but it is a response an agent could badly misread, and `worktreeExisted: true` is now the only thing in it that says "this call did nothing; your branch is still unpushed". A test pins that behaviour against a remote with a rejecting `pre-receive` hook.
  - **`BRANCH_FILTERED`.** The verdict is a function of the config and the branch, not of call history, so the refusal is identical every time and nothing is written on any of them.
  - **A sync that trashes the worktree between two calls.** The second call rebuilds it and reports `worktreeExisted: false`. This is convergence rather than a strict no-op, and it is still what the hint describes: the target path is a pure function of the branch name, so a repeat call can never add a _second_ worktree or a _second_ branch — it can only restore the state the first call left. That is the PUT-shaped idempotency the annotation models, and the hint would only be wrong if repeating accumulated something.

  - **A registration whose directory was destroyed out-of-band.** `rm -rf` on the checkout leaves the registration in `git worktree list` as prunable, so the pre-call listing reports `worktreeExisted: true` while `addWorktree` clears the stale registration and rebuilds the checkout. `true` therefore means "a registration was already here", not "your uncommitted work survived" — the field's `describe` names that case rather than claiming an unconditional no-op, and a real-git test pins it. Reading the more precise `addWorktree` status instead would answer `false` here, but the pre-call listing is what T104 specifies and it errs toward telling the agent to look rather than to trust.

  `sync` stays `idempotentHint: false` and the same listing now asserts that, because what it does depends on what origin has done since. The README tool table gains `worktreeExisted` alongside the response fields it already documents for `update_worktree` and `sync`.

  The double-call path had no coverage. `handleCreateWorktree` had a test that registered a worktree at the sanitized path for the same branch, but only to assert that the disk probe was skipped; nothing asserted what the response looked like, and no test called the tool twice. A new real-git suite does: it calls `create_worktree` twice with identical arguments for each case above and pins both responses and the state git holds afterwards — one registration, an unchanged local branch set, unchanged refs on origin, and an uncommitted file written into the checkout between the calls still there, which is the direct evidence that the second response is not describing a fresh checkout.

  Patch rather than minor. Nothing that used to succeed now errors and nothing that used to error now succeeds; no field changed meaning, none was removed, and `t37` already settled that a new field on this `looseObject` is not a wire break. The `idempotentHint` flip is the only part a client acts on, and it acts in the permissive direction — a client that gated re-execution on the hint stops prompting for a call that was always a safe no-op, which is a correction of a misannotation, not a behaviour change in the tool. `t37` was a minor because it refused calls that used to succeed; `t39` and `t91` the same; `t92` stayed a patch precisely because it refuses nothing, and neither does this.

- cf3dfe0: The MCP handler suite now drives the real `RepositoryContext` end to end, and two shapes that only existed for its mocks are gone.

  Every handler test but the capability gate handed the handlers a hand-written `ctx`: `getDiscoveredContext` returned a constant, capabilities were literals and `invalidateDiscovered` was a spy that did nothing. Detection, the discovery cache, repository selection and capability derivation were therefore unreachable from the handler side, so a regression in any of them passed the whole suite. A new suite runs five flows against the real context and the real `WorktreeSyncService` over a temporary bare/worktree fixture, faking only simple-git, `sync` and `getGitService`: auto-detect then a mutating tool then a denied `sync`; `load_config` for a single- and a multi-repo config and the selection that follows; a `sync` whose outcome carries failed actions; `list_worktrees` for a configured repository that was never cloned; and `update_worktree` for a worktree that disappeared after detection. Each flow also parses the tool's advertised output schema, because the SDK validates `structuredContent` on the wire and a response missing a required field is an `isError` result for every real client while still satisfying assertions written against the fields a test happens to name.

  Each flow is measured against the defect it exists for. Reintroducing the capability bypass (a cleared discovery cache reading as "allowed"), making `invalidateDiscovered` a no-op, dropping `update_worktree`'s fresh listing, letting `getService` fall back to the current repository for a name the config does not list, widening the single-repo auto-selection, reporting `success: true` for a sync with failed actions, inverting the `failures` filter, dropping `divergence` from `get_worktree_status` and trimming the never-cloned listing error each fail this suite; an inert control change does not. Each of those is also caught by a handler test that was already there, so the new suite is a second, end-to-end reading of them rather than the only one.

  One path had no reading at all: `update_worktree` clones a configured repository that is not on disk yet before it reads the listing it resolves the path against, and every double that reaches that handler — including this suite, which spies the real service's `isInitialized` so nothing clones over the network — reported the repository as already initialized. Deleting the guard, running it unconditionally and moving it after the listing all passed the whole suite; two tests now pin it.

  `getReadyService`'s `ensureInitialized` option is removed: it was declared and read but passed by no caller. `isCloneModeService` and the worktree listing now go through `WorktreeSyncService`'s real type instead of `service as RepoService & { isCloneMode?: ... }` and `service as RepoService & { getWorktrees?: ... }`, casts that existed so test doubles missing those methods would still work — the doubles implement them now. Behaviour is unchanged: the real service always defines both, so the duck-type probes always took the first branch, and with the fallback gone `ensureRepoWorktree` no longer needs the git service passed alongside. None of this reaches a `.d.ts`; `dist/mcp/handlers.d.ts` is byte-identical and `dist/mcp-server.js` is 482 bytes smaller.

- cf3dfe0: In the interactive UI, a reload now shows the progress of the repositories it is initializing, and names the one whose initialization failed. `initialize()` — a bare clone for a repository just added to the config, and the longest thing a reload ever waits on — reports through the progress emitter rather than the logger, and the reloaded services were subscribed to it only once every `initialize()` had already resolved; the progress pane stayed empty for the whole of it. Each service is now watched from the moment it is built until its own `initialize()` settles. The failure line, which read `Failed to initialize repository: <git error>`, now carries the repository name taken from the index into the configured list, matching what the run-once path already prints: with several repositories initializing at once a git error such as `Permission denied (publickey)` names nothing the user can find in the config.
- cf3dfe0: `Esc` is documented as what it is — the back-out key — and no longer advertised as a second way to quit the TUI.

  The README keybindings table and the help screen both listed `` `q` / `Esc` `` against "Gracefully quit", and the main screen never honoured it: `App`'s `useInput` has a `key.escape` branch only while the help screen is open, and its main-screen chain tests `q`, `?`/`h`, `c`, `o`, `w`, `x`, `s` and `r` by `input` alone. Writing a lone `\x1b` to a rendered `App` never called `onQuit`. So a user who read either list and pressed `Esc` got nothing, with no way to tell a key that did not work from a quit that was taking its time.

  Resolved in favour of the code rather than the documentation, because `Esc` already has a job here and it is not this one. It closes the help screen, cancels the open-editor wizard, cancels and un-answers the branch-creation wizard a question at a time, steps the worktree status view back to the project list, and dismisses the force-clean modal. Several of those go back rather than out, so `Esc` is the key a user presses in runs — and quitting is immediate, has no confirmation step, and terminates any hooks still running. Binding an exit to the key that is pressed repeatedly to retreat would turn one `Esc` too many, or a key that repeated under a held finger, into a torn-down daemon and a hook killed mid-work. `q` stays the one deliberate key, alone in the help screen's quit row and alone in the README table, and the keybindings section now says outright what `Esc` does and that `q` is the only key that quits.

  The drift is guarded at the level it drifted at. `HelpModal`'s tests asserted that the help text rendered and that the modal's own keys closed it; nothing asserted that a key the modal advertised did anything on the screen that owns it, which is exactly how a line of documentation and a chain of `else if` came apart. The new pins are in `App`'s suite, where the key is handled: `Esc` on the main screen leaves `onQuit` uncalled and the interface rendering, and — the case that made the decision — a second `Esc` straight after the one that closed the help screen does not quit either. `HelpModal`'s suite gains the one text assertion that is worth making, reading the rendered quit row and requiring that it names `q` and not `Esc`.

  No behaviour changed for anyone: the key did nothing before this and does nothing now. What changed is that the two places that described it now match it.

- cf3dfe0: Symlinks now survive the two copies that exist to preserve files before their source is deleted: the cross-device fallback that sets a diverged worktree aside under `.diverged/`, and `sync-worktrees trash --restore`, which overlays the trashed payload onto the recreated worktree. Both copied with `fs.cp` and no `verbatimSymlinks`, so Node resolved every relative link target against the source directory and wrote the copy's link as an absolute path back into that tree — which each operation then deletes. The preserved or restored worktree was left with links pointing at nothing. Links are a small share of a dependency tree's files but the load-bearing share — in this repository's own `node_modules`, 24 of the 30 top-level entries are links into the pnpm store — so the tree stops resolving; and a symlink committed to the repository came back as a `git status` modification. Ordinary files, permissions and directories are copied exactly as before.
- cf3dfe0: The Open wizard no longer reports success for a launcher that visibly did nothing, and `$TERMINAL` now gets the exec flag its emulator actually accepts.

  Measured first, on Linux with Node 24. `openEditorInWorktree` spawns `$EDITOR` with `{ detached: true, stdio: "ignore" }`, which is what lets a GUI editor outlive the TUI — and is also why a terminal editor gets no TTY. Spawned that way `vim` exits with code 1 after 2027 ms, `vi` after 2026 ms and `nano` after 5 ms, all without drawing anything, while the method returned `{ success: true }` and the wizard closed. A long-lived GUI editor spawned identically was still running after 6 s, so the fix could not simply be to give the editor pipes.

  Editor mode now refuses a terminal editor up front, with `'vim' is a terminal editor and has no TTY here; use Terminal mode, or set EDITOR/VISUAL to a GUI editor` — the wizard shows it instead of closing on a lie. That message names Terminal mode only after asking whether a terminal emulator actually resolves on this host; where none does, it says so and names the GUI editor as the only remedy, rather than sending anyone to a second dead end. Terminal mode is the honest destination: measured, `tmux new-session` does give `vim` a real pty (`pane_tty=/dev/pts/0`, still running at 3.7 s), so the editor a user wants is reachable through the mode the message names. Editor mode does not route there itself, because on a headless or SSH host no emulator resolves at all — measured, the Linux candidate probe finds none here — and the user would get a terminal-flavoured error for an editor request, having just pressed `Tab` to ask for something other than Terminal mode.

  Detection is a heuristic and fails **open**: an editor nobody recognises is launched exactly as before, so nothing that works today starts being refused. A flag beats the basename only for the family whose own option parser defines that flag, because `-g` is not a GUI flag outside vim: measured here, `vim -g` and `vi -g` reach vim's parser and answer `E25: GUI cannot be used`, while `nano -g` and `pico -g` are `--showcursor` (checked against `nano --help`), `helix -g` is `--grammar`, `emacs -g` is `--geometry` and `nvim` has no `-g` at all. An explicit terminal flag also wins over a GUI one, so `emacs -nw` is refused with or without `-g` on the line, and `vim -g` still launches. The blind spot is a wrapper script — a `my-edit-wrapper` that execs vim looks like any other editor — so the reporting, not the list, does the real work: both editor and terminal launchers now observe the child's exit status, which neither did before. A launcher that exits non-zero within five seconds logs `Editor 'X' exited immediately with code N — nothing was opened` plus a hint, and so does one killed by a signal: a signalled child reports **no exit code at all** (`code` is null, the signal is in `signalCode`), measured at 3 ms for a launcher that segfaults or aborts, so a code-only check would drop the crash that matters most and leave `{ success: true }` standing. The hint diagnoses nothing — the same exit arrives from a terminal editor, a GUI editor with no display, a bad flag and a missing library alike — it points at what to check, while the error line above it names the command and the status. Measured, that catches the wrapper (exit 1 at 2027 ms) that the basename list cannot, and stays quiet for a GUI editor handing off to a running instance, which exits **0** in 3 ms — fast exit is not evidence of failure, only a non-zero one is. The observation costs nothing and blocks nothing: the child stays detached and `unref`'d, so it cannot hold the TUI open (measured: Node exits in 40 ms with the listener attached and the child still running), and `addLog` is already a no-op once the service is destroyed, so a late exit cannot reopen a closed wizard. It reports; it never resurrects.

  On the terminal side, the `$TERMINAL` branch always appended `-e sh -c <cmd>` while the candidate probe special-cased `gnome-terminal` to `-- sh -c <cmd>`; the code already knew `-e` was wrong there and applied it on one path only. That drift is now impossible: one lookup keyed on the launcher's basename serves the override, the `$TERMINAL` fallback, the probe and macOS Ghostty. It also stops the override losing the flag altogether: `SYNC_WORKTREES_TERMINAL="gnome-terminal --tab"` used to produce `gnome-terminal --tab sh -c <cmd>` with no exec flag at all, because the table was consulted only for an override that carried no flags of its own. Whatever flags you write are kept and the exec flag is appended — unless you already wrote one, since a second would be read as an argument to the first. Which emulators need what was read out of their own option parsers rather than assumed: `gnome-terminal`'s `-e` is `--command`, one string through `g_shell_parse_argv`, and its only short options are `e p q t v`, so `-c` is an unknown option and the command fails outright; `mate-terminal` shares that parser; `xfce4-terminal` splits the two, `-e` taking a single string and `-x` taking the rest. `konsole` ("will catch all following arguments"), `alacritty` (`allow_hyphen_values`, `num_args = 1..`), `kitty` (`-e` ignored for compatibility) and `xterm` (`-e program [arguments]`) all take `-e` correctly, so `gnome-terminal` was indeed the only one of the five probed candidates that needed `--`.

  `parseCommandString` split on whitespace, so a quoted path with spaces became a broken argv; it now splits the way a shell does, honouring single quotes, double quotes and backslash escapes, and an unterminated quote closes at end of string rather than silently dropping the setting. `$EDITOR` is parsed the same way, so a quoted editor path with spaces works too. A `SYNC_WORKTREES_TERMINAL` that carries no exec flag is now given the right one, which cannot regress anything: handing an emulator a naked `sh` never worked. `EDITOR` set to whitespace only is reported as such instead of quietly editing with `code`; unset and empty are unchanged and still fall back to it.

  This is a patch. The only input now refused is `$EDITOR` naming a terminal editor, and that input never loaded in the sense the rule means — it was accepted and then silently discarded two seconds later. Nothing that actually worked stops working: GUI editors spawn unchanged, unknown editors spawn unchanged, and the `$TERMINAL` and quoting changes only turn previously-broken invocations into working ones. `InteractiveUIService` is not part of the package's public surface — `dist/index.d.ts` exports the config types, `runMultipleRepositories` and `main` — so no published type changes and no consumer can observe the changed return value.

- cf3dfe0: Test-suite only: the cross-process repository lock is now exercised by two real processes at once.

  Nothing in the suite ran two `sync-worktrees` processes against one repository. The unit suite constructs the services in-process, where the lock is deliberately short-circuited; every e2e that spawns the built CLI spawns exactly one at a time; and the closest thing to a contention test held a `proper-lockfile` lock from the vitest worker itself and watched a single child bounce off it. So the lock's whole reason to exist — two independent processes, one of which must stand down — had no reading at all, and a regression in lock-key derivation or in the `proper-lockfile` options could pass the entire suite green.

  A new e2e runs two `dist/index.js --runOnce` processes concurrently over one bare repo and one `worktreeDir`, and asserts that exactly one syncs while the other prints `Another process holds the sync lock` and exits 0 with `0 synced, 1 skipped, 0 failed`. It then asserts where the `worktreeDir`-keyed lock file lands, `<parent-of-worktreeDir>/.sync-worktrees-locks/<hash>.lock`. That is not the file the two contended on — worktree mode takes the bare-repo lock first and returns early when it cannot, so the loser is `ELOCKED` on `<tempDir>/.bare.lock` and never reaches the second lock, and the `stat` is satisfied by the seed run that took and released it on its way through. What those two assertions pin is the derivation: the directory the lock lives in, and a filename keyed on the `worktreeDir` alone, so a pid or any other per-process component creeping into it fails the `stat`, because the path the test computes is the vitest worker's own.

  Contention is arranged rather than raced, so the test neither sleeps nor flakes. A `git` shim first on the children's `PATH` parks every `git fetch` until a gate file appears, and the gate is written only once one of the two processes has exited — so whichever process takes the lock first holds it, parked, for as long as the other is alive. Each process takes the lock twice, at `initialize()` and again at `sync()`, and each acquire is followed by a fetch within the tens of milliseconds that one or two intervening git subprocesses cost, so the release-and-reacquire window between the two cannot be reached while the loser is still alive; which of the two wins is left to the operating system and the assertions do not care. If the lock stops working, neither process parks behind the other, the gate opens on an 8s budget and both processes sync — which is what the assertions catch. The passing run takes about two seconds.

  That arrangement is load-bearing, so the test observes it rather than assuming it. The shim records each fetch that reaches it while the gate is still shut, and the test reads that record before opening the gate and fails if it is empty: a shim that stopped engaging would otherwise turn this back into the plain race it replaced and still pass. For the same reason the shim picks the git SUBCOMMAND out of argv instead of matching argv as a whole — simple-git's `commandConfigPrefixingPlugin` prepends `-c key=value` pairs ahead of the subcommand as soon as a `config` array is passed, and a whole-argv match would stop recognising the fetch the day one is added.

  The children run with `NODE_ENV=production`, and inherit the rest of the vitest worker's environment with two deliberate edits: `SYNC_WORKTREES_LOCK_DIR` is dropped so both derive the lock path asserted above, and `PATH` is prefixed with the shim. That leaves `SYNC_WORKTREES_UNIT_TEST` in place, whose value is the worker's own pid and so never matches either child.

  Stubbing `RepoOperationLock.acquire` to always hand back a release fails this test, and so do returning `true` from `isUnitTestShortcutEnabled`, putting the pid in the lock filename, dropping the `ELOCKED` branch that classifies contention as a skip rather than a failure, and disengaging the shim's subcommand match. An inert comment-only change survives.

  What it still does not reach: `repo-operation-lock.test.ts` mocks both `fs/promises` and `proper-lockfile`, and this test does execute the real lock directory creation, the real `proper-lockfile` acquire and the real `ELOCKED` contention across two processes — but only on the happy path. Stale-lock takeover (`LOCK_STALE_MS`), the mtime refresh timer (`LOCK_UPDATE_MS`), the `onCompromised` callback and the `waitMs` retry budget are still exercised nowhere outside mocks. Worktree mode's two-lock sequence runs for real here, but nothing asserts the ordering or the bare-lock release when the second lock cannot be taken. And because the bare-repo lock is keyed on the bare path rather than on `getWorktreeDirLockTarget`, it serializes the two processes on its own: a `worktreeDir` lock-key regression is caught by this test's path assertion, not by its outcome.

- cf3dfe0: Clone mode now refuses to adopt a directory that is not a primary checkout instead of rewriting the repository that owns it. A `worktreeDir` whose `.git` is a gitdir pointer — a linked worktree from `git worktree add`, or a submodule — passed the existing "has a .git entry" check, and the adopt step then ran `config --replace-all remote.origin.fetch`, `config --replace-all remote.origin.tagOpt` and `update-ref -d` on every other `refs/remotes/origin/*` against the _parent_ repository's common git dir, on the first sync and every tick after it: the parent's fetch refspec was narrowed to the tracked branch and its remaining remote-tracking refs were deleted, which a worktree-mode parent then read as "every other branch is gone". Before any write, clone mode now verifies that `.git` is the checkout's own directory and that `git rev-parse --git-dir --git-common-dir` reports it as both; a linked worktree, a submodule, or a `.git` symlink whose target cannot be shown to be unshared is rejected with `CONFIG_CLONE_DESTINATION_NOT_PRIMARY_CHECKOUT`, naming the shared git directory and leaving it untouched. Read-only paths (listing, `getWorktrees`, status) still report such a directory.
- cf3dfe0: The published package no longer ships JS source maps or `.d.ts.map` declaration maps (156 files / 2.6 MB unpacked down to 80 files / under 1 MB), and `pnpm smoke` now fails if maps come back or the tarball outgrows its file-count and size ceilings.
- cf3dfe0: Clone mode no longer adopts a clone of its own that fetched every object and then failed to check out. Git's "Clone succeeded, but checkout failed" (exit 128 — a missing LFS object is the usual cause) leaves a complete `.git` on the tracked branch next to a half-written working tree, and nothing on disk told that apart from a clone the user made: the run that hit it exited 1, and the next one validated the directory, adopted it as a pre-existing clone — no checkout retry, no sparse setup, no LFS verify, no `filesToCopyOnBranchCreate` — and from then on reported "working tree has local changes" at info level while exiting 0, forever, for a directory nobody had touched. Such a clone is now retried once with LFS smudging disabled when the failure was an LFS error (the working tree is completed with pointer files and both the log and the progress stream say so); when that cannot repair it, the directory is marked `.git/.sync-worktrees-clone-incomplete` and every later run fails with a `clone-init` error quoting the original git failure and naming both ways out — remove the directory, or fix the cause, run `git checkout -f HEAD` and delete the marker. A marker that exists but cannot be read fails the run the same way rather than being read as "no marker". The directory is never deleted, and a genuine pre-existing clone (which never carries the marker) is still adopted as before.

  Known limit: the marker can only be written once `git clone` has returned, so a process killed _during_ the checkout still leaves an unmarked half-written clone that the next run adopts — the case a failed clone no longer produces.

  `sparseCheckout` now applies with the same LFS setting as the checkout around it. `sparse-checkout set` materializes everything its patterns bring into the cone, so it runs the smudge filter too, but its client was built with no environment at all: a repository with `skipLfs: true` (or one whose clone had just been recovered by skipping LFS) cloned fine and then failed at the sparse step with `smudge filter lfs failed`.

- cf3dfe0: A clone-mode fast-forward that dies on an LFS smudge no longer wedges the repository. Git's `merge --ff-only` checks out in path order and stops at the first file it cannot produce — an unreachable LFS server is the usual reason — leaving the paths that sort before it already written or deleted on disk while HEAD and the index stay on the old commit. The next status call therefore reported local changes, so the run soft-skipped with "working tree has local changes" at info level and exited 0, and so did every run after it: git refuses to overwrite the untracked files the first attempt left, which meant even a repaired LFS server could not end the loop. A rejected fast-forward that left HEAD where it was is now undone before the failure is reported, so the retry — and the next tick — can run at all. The `checkout` command's fast-forward is undone the same way; it fails loudly rather than skipping, but the files it strands wedge later ticks through the same door.

  Only paths that merge itself would have written are considered, and each is proved on its own before it is touched. A file still on disk is removed or restored only when its contents are what `origin/<branch>` holds for that path — hashed by git, so the repository's own filters apply, and compared by target rather than by hash for a symlink, whose blob holds the path it points at. A path missing from disk is restored from HEAD only when `origin/<branch>` no longer holds it, the one case where merge is what deleted it; a path origin still carries went missing some other way and stays missing. Everything else — a file edited while the sync was running, a dirty path the incoming commit does not touch, a file git cannot hash — is left exactly as it is and still reports as a local change on the next tick. Content someone else happened to write that is identical to the incoming version counts as merge output and is undone, which costs nothing: the next fast-forward writes that same object back. Empty directories the incoming commit's files would have filled are left behind; git ignores them, so they neither dirty the tree nor block a later merge.

  The per-sync LFS fallback now reaches clone mode's own git clients. When an attempt failed with an LFS error the retry policy logged "Temporarily disabling LFS downloads for this sync" and set the override, but clone mode built its clients from the configured `skipLfs` alone: the retry's fetch and merge ran with the identical environment and failed on the same object. They now carry `GIT_LFS_SKIP_SMUDGE`, so the retry fast-forwards and materializes the LFS paths as pointer files instead of repeating the failure.

- cf3dfe0: Unshallowing a clone-mode repository now runs on the clone inactivity budget instead of the fetch one. Removing `depth` from a repository's config is the documented way to fetch its full history, and the `git fetch --unshallow` that does it transfers every commit the shallow clone skipped — the work the initial clone would have done, reached through a fetch. It was nevertheless bounded by the 5-minute fetch window, while the clone that first created the same repository was allowed the 15-minute one for the very same bytes. The budget is an inactivity window rather than a deadline, and git feeds it continuously while the pack is moving, but the phases at either end are silent — the server computing the shallow boundary and enumerating objects before the first progress byte, and the connectivity check over the newly complete history after the last — and both are sized by total history, not by what changed since the last tick. A repository whose full history took longer than that to enumerate could never unshallow: every tick killed the fetch, discarded the partial pack, and failed the sync outright rather than soft-skipping. The `cloneTimeoutMs` window is what bounds the unshallow now; every other fetch still uses `fetchTimeoutMs`.

  The kill itself is unchanged in kind. A genuinely wedged transfer produces no progress output at all, so raising the budget does not disarm the guard — it still ends the attempt, at the clone-sized limit. The cost of the larger window is that an unshallow which is wedged rather than slow now holds its attempt for 15 minutes instead of 5. On a scheduled sync that is absorbed: a tick that overruns its schedule does not pile up, because the next one finds the repository operation already in progress and skips. The path worth knowing about is the interactive one — switching branches from the TUI unshallows too, and there the wait is not retried and someone is watching it.

  The unshallow also passes `--progress` explicitly, like every other fetch and clone here, and now reports the phase it is entering to the progress emitter, so the interactive display and the MCP notifications show what is happening during the window before the first byte of transfer progress arrives — previously the first blank stretch, since the transfer itself already reported. `--progress` is what keeps the inactivity timer alive across that transfer: the timer resets only on output, and with its stderr piped git suppresses every transfer and delta line and asks the server for `no-progress` — measured on git 2.43, where the same throttled unshallow wrote 131 stderr chunks with the flag and not one byte without it. The flag was already reaching git, appended by simple-git's own progress plugin to any command whose first token is `fetch`; spelling it out makes the argv this project's rather than a third-party plugin's method list.

- cf3dfe0: The TUI branch-creation wizard can now create branches for clone-mode repositories, which makes the clone-mode branch switching shipped in 5.0.0 reachable from the picker. `createAndPushBranch` had no clone-mode path: it always ran `GitService.createBranch` / `pushBranch`, and those run in `bareRepoPath` — which for a clone-mode repo (whose `bareRepoDir` is deliberately undefined) falls back to the _relative_ `.bare/<repo name>`. The wizard therefore either died on the result screen with simple-git's "Cannot use simple-git on a directory that does not exist", naming neither repository nor branch, or — when a bare store of the same repository _name_ happened to sit under the daemon's working directory, which is exactly where a worktree-mode entry of a config in that directory keeps one — silently created and pushed the branch in **that** repository, against its remote, and reported success; the follow-up checkout then failed with `origin/<branch> is missing`. Clone mode now creates the branch inside the clone itself: it refreshes `origin/<base>` with the clone's own narrowed refspec (and its configured shallow depth), runs `git branch --no-track <name> origin/<base>` and publishes it with `git push -u`, before switching the checkout in place as before. Creation is refused up front — with a message naming the repository and the remedy — when the checkout is dirty (the switch could never have carried the changes across), when the name already exists in the clone or on the remote, when the base branch is gone from the remote, when `worktreeDir` is not a primary checkout, and when the clone directory is missing; the push is create-only, so a branch somebody else pushed in the meantime is never fast-forwarded, and a push that fails removes the local branch it created rather than leaving it behind (a leftover that cannot be removed is named in the error).
- cf3dfe0: Worktree mode no longer creates a worktree from the frozen `refs/heads/*` copy that `git clone --bare` leaves behind for every remote branch (those copies were never fetched into again, so a worktree added months later checked out the clone-time tip, was reported as "created with tracking", and was then reset or moved aside as diverged on the next sync). A fresh bare clone now drops the copies of all but the default branch, and when a local branch ref with no worktree is only behind `origin/<branch>` the new worktree is fast-forwarded to the remote tip as soon as it is created; a local ref with commits not on `origin/<branch>` keeps its tip, the log says why, and the sync records a `local_only_commits` skip for that branch next to its "created" action.
- cf3dfe0: Worktree mode now follows a default branch rename on the remote (for example `main` → `trunk` with `main` deleted). The detected default was frozen to `refs/remotes/origin/HEAD`, which `fetch --prune` never updates: the old default stayed a forced update candidate whose upstream was gone, so every sync failed with `diverged_recovery_failed`, its worktree was never pruned, and the new default was created as an ordinary hashed directory. The default is now re-resolved (`git remote set-head origin -a`) whenever `origin/<default>` is gone — at initialization and after each fetch — with a "Default branch changed from X to Y" log line; the new default's worktree is created (or an existing one for that branch adopted) and becomes the worktree fetches run from before the old default's worktree goes through the normal prune checks.
- cf3dfe0: Unpushed commits are no longer hidden by a tag that shares the branch's name: the removal-safety probe now counts from the worktree's `HEAD` (and worktree metadata records the default branch's tip from `refs/heads/<default>`) instead of the bare branch name, which git resolves as a tag first — with only an "ambiguous refname" warning and exit 0 — so a hotfix branch cut from a same-named tag (`git checkout -b 1.4.2 1.4.2`) read as "clean, nothing unpushed" and could be pruned.
- cf3dfe0: A worktree-mode sync where nothing changed upstream no longer spends git processes per worktree. The update phase used to run a full `git status` working-tree walk plus a `merge-base`/`rev-parse` pair and a `rev-list` on every registered worktree on every tick (four git processes each, roughly 4 + 4W per sync attempt), so a few hundred worktrees kept the repository lock held for tens of seconds and the next scheduled tick was skipped with "Another repository operation is already in progress". The phase now compares the HEAD oid git already prints in `worktree list --porcelain` against origin's tip from a single `for-each-ref`, and a worktree whose HEAD is that tip is recorded as `already_up_to_date` without any per-worktree git command. A steady-state _sync attempt_ is a flat four processes (fetch, branch listing, worktree listing, tip listing) no matter how many worktrees are registered; a whole `--runOnce` run shows a few more on top, from the one-off repository setup `initialize()` performs before the first attempt. Worktrees whose tip did move are checked exactly as before, except that one `rev-list --left-right --count` now replaces the two merge-base probes and the behind probe, keeping the same up-to-date / behind / ahead / diverged verdicts and the same "a probe that could not run throws instead of answering" guarantee; `git branch` is no longer spawned before a fast-forward just to re-read the branch name. The remote-branch inventory reads the same `for-each-ref` instead of `git branch -v -r`, which no longer resolves a commit per branch to print a subject line that was thrown away.

  The MCP `update_worktree` tool now reads the worktree's branch from a live `git worktree list` instead of the session's discovery snapshot. That snapshot has no freshness check — a `git checkout` inside a worktree does not invalidate it — so the branch it remembers can be one the worktree has since left, and the tool's fetch and fast-forward now always name the branch that is actually checked out.

  One reporting change comes with the fast path: a worktree that is dirty, but already at origin's tip, is now reported as an `already_up_to_date` noop rather than a `dirty_worktree` skip. Nothing is updated in either case, and an unfinished merge/rebase or an unreachable worktree directory is still reported.

- cf3dfe0: Stop treating an uninitialized submodule as a modified one. `git worktree add` never initializes submodules, so every worktree of a repo with a `.gitmodules` entry reported git's "not initialized" marker and was permanently skipped as "modified submodules": never pruned, never narrowed by sparse-checkout, and always flagged `⊞` in the TUI. Only a submodule whose checked-out commit differs from the index or that has merge conflicts blocks removal now, and the reported list holds submodule paths instead of object ids.
- cf3dfe0: Worktree mode no longer adopts a pre-existing directory at the default branch's worktree path that is not a registered worktree (for example the checkout left behind after deleting `.bare/` to recover from corruption). Initialization now moves it to `.trash/` (or `.removed/` when trash is disabled) like any other stale worktree directory, recreates the default-branch worktree, and fails with `WORKTREE_NOT_REGISTERED` naming the path if the worktree is still not registered afterwards — instead of pointing every later fetch at a non-repository.
- cf3dfe0: Worktree mode now checks that an existing bare repository's `origin` is the configured `repoUrl` (compared ignoring `.git`, a trailing slash and scheme/host case) before fetching from it. On a mismatch — a migrated host, a fork swapped for upstream — initialization fails with `CONFIG_ORIGIN_MISMATCH`, naming both URLs (credentials redacted) and suggesting `git -C <bareRepoDir> remote set-url origin <repoUrl>` or a fresh `bareRepoDir`, instead of silently syncing the old remote; `--runOnce` exits 1.
- cf3dfe0: `fetchTimeoutMs` now only applies to git commands that talk to the remote (fetch, push, ls-remote, `remote set-head`); local commands such as `worktree add`, the fast-forward merge, `checkout` and `status` no longer get killed after five silent minutes, so worktree creation in a large repository can finish.
- cf3dfe0: Worktrees locked with `git worktree lock` are now skipped during pruning (with the lock reason in the log) instead of being size-scanned and moved in and out of `.trash/` on every tick, and git's refusals to remove a locked worktree or one containing initialized submodules are recorded as skips rather than failures that set a non-zero exit code.
- cf3dfe0: The worktree status view stops hiding worktrees it failed to probe, and the disk walks behind it stop being repeated for nothing.

  `getWorktreeStatusForRepo` mapped every worktree straight into `Promise.allSettled` and then kept only the fulfilled results. A probe that rejected — a `git` that could not start, an EMFILE under load — took its worktree out of the list with it, so the view showed a short list as though it were the whole repository and said nothing at all. (A worktree deleted from under the view is not one of those cases and never was: the path probe maps ENOENT and ENOTDIR to "missing" and the status resolves as clean and removable, so that row renders a green tick on both sides of this change.) Every worktree now comes back. One whose probe rejected is marked `!` on its row, counted above the list (`⚠ 2 of 40 worktrees could not be probed`), and carries the reason on its expanded entry; its `WorktreeStatusEntry` gains an `error` and a status whose every flag reads unknown and whose `canRemove` is false, so no reader can mistake "we could not look" for "there is nothing here". The count, the row's `!` and the reason line all test the same thing, so a probe that failed without a message is marked as well as counted rather than counted and then drawn as an ordinary status row.

  The fan-out is bounded at `maxStatusChecks`, the limit the sync path's prune probes already use. What that bounds is worktrees in flight, not git processes: `WorktreeStatusService` has capped its own process budget at that same number since it began sharing one limiter across every worktree, and measured here against a real 200-worktree repository the view peaked at **17 concurrent `git` processes**, not the ~2,000 an unbounded read of the code suggests. Without the outer bound, though, all 200 snapshots open at once and queue on that shared budget: 200 half-finished probes each holding a git client and a status buffer, and no row able to finish until nearly every first-phase command has. With it, rows finish as they go.

  Disk sizes are now measured through a small cache the header total and the status view share. The view used to walk each repository's bare directory and worktree directory again on every single open, duplicating walks the daemon had just done and paying twice for two opens a second apart; `.diverged/` directories were walked per open too, all at once. Measured on this container (ext4, four cores) against a 927 MB, 95,657-path tree, one `du -sb` takes 189 ms warm and 1,654 ms with the page cache dropped. The six walks a three-repository workspace needs, measured over a 197 MB, 50,407-path fixture, take 101 ms in sequence and **48 ms as this ships** — a 2.1x speedup, not the 3.5x that the same six walks reach unbounded, because the bound is `maxRepositories` and that defaults to 2. A walk already in flight is shared rather than started twice.

  The number the header shows is no less fresh than before: the total is rebuilt from walks that ignore the cache, exactly as it was at startup, after every non-skipped cycle and after a force clean, so freed space still appears the moment it is freed — and it appears in the status view too, since the same walk fills the cache the view reads. A refresh joins a walk only while that walk is still queued behind the limiter, never once it has begun reading, so it can never be handed a figure taken before the mutation that prompted it. Deleting a `.diverged/` directory drops the cached size of the directory and of the worktree directory that held it, and a configuration reload drops every repository's, so an operation that shrinks a directory itself is never followed by a stale total. Only the view's own repeat opens are served from cache, for up to a minute. The cache is deliberately not keyed by mtime: a directory's mtime does not move when a file below it changes, so an mtime key returns a stale number while claiming it is current — measured, a write four levels down that tree changed its `du -sb` total and left the top directory's mtime untouched. `du`'s flags are unchanged, so the bytes reported mean what they always did (`-sb` is `--apparent-size --block-size=1`).

  Repository sizes also stop getting stuck at `Size: calculating...`. The view's disk-usage effect depends on `repositories`, and `App` passes a freshly allocated array on every render, so every log line, progress update and disk-space event re-ran it: the cleanup set a per-run `cancelled` flag that discarded the in-flight result, while the re-run skipped the repository because its index was already recorded as requested. Nothing then replaced `calculating...` until the modal was closed and reopened. The flag now tracks the component's lifetime rather than the effect run, so a result that arrives after any number of re-renders is still the one that lands.

- cf3dfe0: Trash entries created before pin refs were namespaced per workspace are recognized again. Those entries recorded a flat pin ref (`refs/sync-worktrees/trash/<id>`); the manifest validator added with the namespacing accepted, for a pinned entry, only `refs/sync-worktrees/trash/<workspace-hash>/<id>` (an entry with no pin at all was always fine), so after upgrading, every one of them read as an invalid manifest — hidden from `sync-worktrees trash`, rejected by `--restore <id>` with "no trash entry with id", never reaped, its payload holding disk and its pin holding objects through every `git gc`, and a warning about it repeated on every sync tick. Both layouts are now accepted, so those entries list, restore and age out normally, and reaping one deletes the flat pin named in its own manifest. The validator still requires the ref to sit under `refs/sync-worktrees/trash/` and to end at the entry's own id, so a hand-edited or corrupted manifest cannot point the reaper's `update-ref -d` at a branch ref or anywhere outside the trash namespace. The orphaned-pin sweep is unchanged — it still leaves flat refs alone, since it cannot tell one of its own from another workspace sharing the same bare repository (see README for what that leaves behind) — and the reaper now reports unrecognized trash content and legacy flat pin refs once per process instead of once per tick.
- cf3dfe0: An expired trash entry whose payload cannot be fully deleted no longer turns into an unrecognized container that holds its disk and its pin ref forever. The reaper, restore's cleanup and the failed-trash rollback each removed a container with a single `fs.rm(<container>, {recursive: true})`. Node's recursive delete is not atomic and walks in readdir order, so one file it cannot unlink — build output owned by another uid through a Docker bind mount, a file carrying the immutable attribute, an EPERM from an overlay or FUSE mount — left `manifest.json` already gone. Nothing needed delete permission to get such a worktree _into_ trash (the payload moves by rename), so it was trashed normally and then, at expiry, reduced to a container with no valid manifest: invisible to `sync-worktrees trash` and to force clean, skipped by every later reap with "leaving unrecognized entry … alone", its disk never reclaimed, and its pin ref — which the orphaned-pin sweep keeps as long as the container name exists — holding the trashed HEAD's objects through every `git gc`. No message said what to do about it.

  The payload is now set aside first and by rename, to `payload.deleting-<timestamp>` inside the same container, then deleted; the manifest and the container go last. Rename is atomic, so `payload/` never exists half-deleted, and at every step in between the container either still reads as a trash entry — listed, reported, expired, retried by the next run — or is gone. A delete that is refused now leaves the manifest intact and logs the path that refused it with what to act on: take ownership of it, clear the immutable attribute, or remove the container by hand. A payload that an interrupted run had already set aside is finished by the next one rather than left behind. The pin ref is released as soon as the payload is gone instead of after the container, so a container that cannot be removed can no longer strand it. Restoring an entry whose payload is already on its way out is refused as "already being deleted" rather than as a missing payload.

  One window remains, and it is bounded: a process killed between the manifest's unlink and the container's `rmdir` leaves an empty directory that is reported as unrecognized content. Its payload is already gone by then and its pin already released, so nothing is stranded but the directory itself.

- cf3dfe0: The TUI force clean (`x`, then `y`) now deletes exactly the trash entries and `refs/sync-worktrees/keep/*` recovery refs its preview counted, instead of everything present when the purge finally runs. The preview is taken outside the repository lock and the purge queues behind whatever sync is in flight, so a cron tick between the two could trash more worktrees — a prune, a diverged replacement, an orphan sweep — and those entries were purged along with their pin refs and then collected by `git gc --prune=now`, without ever appearing on screen. An entry trashed for a branch that was fully pushed before its remote side was deleted holds the only copy of those commits in the repository, so the loss was unrecoverable. The confirmation now carries the entry ids and ref names behind its counts, and the purge takes only those; entries and refs that arrived later are left in place and reported in the result line and the log, and a named entry that is gone by purge time (reaped in between, or a delete already under way) is skipped without failing the run. Syncing is never blocked while the modal is open — it was not before either — so a preview left open indefinitely costs nothing: it simply purges less than the trash holds by then, and says so.
- cf3dfe0: Config loading now rejects two repository entries that resolve to the same `worktreeDir`, or whose `worktreeDir` overlaps another entry's `bareRepoDir`, naming both entries and the path; previously each sync moved the other repository's checkouts to trash while reporting success. A `worktreeDir` nested inside another entry's `worktreeDir` now logs a warning.
- cf3dfe0: Worktree mode now fast-forwards worktrees whose branch has no upstream configured — one restored from trash, one created by the MCP `create_worktree` tool with `push: false` and published later, or one registered through the no-tracking fallback. The update phase read the behind count through `<branch>@{upstream}`, which fails without an upstream, and took the failure as "not behind", so such a worktree was reported as `already_up_to_date` on every sync while `origin/<branch>` moved on. Behind is now derived from `origin/<branch>` explicitly (the same ref the fast-forward check and the merge use), a failed probe is recorded as `update_check_failed` for that worktree instead of passing as up to date, and a trash restore or a no-tracking fallback sets `origin/<branch>` as the branch's upstream when that remote branch exists, so `git pull` and `git status` in the worktree behave normally too.
- cf3dfe0: Cross-process repository locking, git inactivity timeouts, trash reaping and periodic `git gc` are no longer silently disabled when the caller's environment already exports `NODE_ENV=test`; those unit-test shortcuts now hinge on the tool-owned `SYNC_WORKTREES_UNIT_TEST` variable, and the CLI and MCP server print a prominent warning at startup if it is active.
- cf3dfe0: `sync-worktrees.config.example.js` — the file README.md points at for "every knob" — loads again, and a new test loads the real shipped file through `ConfigLoaderService` so it cannot drift back.

  It had stopped loading. The `experimental-features` entry still carried `runOnce: true`, which became a validation error once `runOnce` was restricted to `defaults`, so `buildRepositories()` on the example threw `Invalid configuration for 'Repository 'experimental-features' runOnce': cannot be set; use defaults.runOnce` — anyone who copied the reference file got that on their first run. No test loaded the file, so nothing caught it. The entry now explains that `runOnce` is a whole-file setting and points at `defaults.runOnce` and `--runOnce`.

  The clone-mode section claimed the repository lock lives at `<configDir>/.sync-worktrees-state/<sanitized-name>-<hash>.lock`. It lives next to the checkout, at `<parent of worktreeDir>/.sync-worktrees-locks/<hash>.lock`, where the hash is the first 16 hex characters of sha256 over the symlink-resolved `worktreeDir`, relocatable with `SYNC_WORKTREES_LOCK_DIR` — what `src/utils/lock-path.ts` computes, and what README.md already described.

  Two stale claims in the clone-mode section are corrected too: it listed five fields as conflicting with `mode: "clone"` and had never picked up `trash`, the sixth, so it told clone-mode readers a rejected key was fine; and the trash reaper is described as running at the tail of every sync attempt, failed ones included, which is what `WorktreeSyncService` does deliberately (only the periodic `git gc` is success-only). The new test pins both — the conflicting-field list against `CLONE_MODE_CONFLICTING_FIELDS`, and the defaults the example states in prose against `DEFAULT_CONFIG` — so neither can drift silently again.

  Two knobs the README promises are now shown: `sparseCheckout.skipUpdateWhenOutsideSparse` (default true, cone mode only) and a worktree-mode `trash` block with all four fields and their defaults, noting that `trash` on a clone-mode repository — or under `defaults`, which every clone-mode entry inherits — is a validation error. `fetchTimeoutMs` and `cloneTimeoutMs` are shown as well, commented out under `defaults` with their defaults and the `0`-disables semantics, and set for real on the two repositories that illustrate them. The new test fails on any repository or `defaults` key the loader drops on the floor, so a knob that does not work cannot be documented as one.

- cf3dfe0: The MCP `sync` tool now reports `success: false` whenever the run recorded a failed action (matching the CLI's `--runOnce` exit code 1) and adds top-level `failed` and `failures` fields so agents can see what went wrong without digging through `outcome.actions`.
- cf3dfe0: Retry a worktree checkout that fails its Git LFS smudge filter once with LFS downloads disabled, instead of failing that branch on every sync, and delete the local branch git leaves behind when `worktree add` fails.
- cf3dfe0: The MCP `create_worktree` tool now errors with code `TARGET_EXISTS` when its target directory already exists on disk but is not a registered worktree, instead of silently moving that directory to trash (or deleting it when trash is disabled).
- cf3dfe0: Overlapping sync cycles stop speaking for each other in the TUI, the two modals that load a list stop re-loading it forever when it is empty, and the log panel stops drawing more rows than it was given.

  **Sync status belongs to the set of cycles in flight, not to whichever one finishes first.** `runSyncCycle` set the status to `syncing` on entry and to `idle` in its `finally`, and `App` turns an `idle` into `setSyncProgressEntries([])`. Two cron groups (`frontend` on `*/30 * * * *`, `backend` on `0 * * * *` both fire at the top of the hour) therefore let the five-second one end the two-minute one's progress rows, put the status bar back to `✓ Running` while a fetch was still running, and re-enable the `s`, `x` and `r` keys that are guarded on that status — `x` opening the force-clean modal mid-sync being the one that matters. `InteractiveUIService` now counts active cycles: the first one in reports `syncing`, only the last one out reports `idle`. A configuration reload is one of those cycles — it runs a sync of its own and used to drive the status directly from two unconditional `setStatus("idle")` calls of its own, so a cron tick landing inside a reload had the same effect in both directions. `setStatus` is also the only thing left that ends a sync on screen: `updateLastSyncTime` carries the timestamp and nothing else. It used to end the sync as well, and the service stamps it from inside a cycle — `runSyncCycle` awaits `recordSyncOutcome` before its `finally` — so the count alone changed nothing for the case it was written for. `backend`'s five-second cycle still reached the stamp while `frontend` was fetching, and `App` still turned that into `✓ Running`, an empty progress panel and re-armed `s`, `x` and `r`.

  **A cycle now takes the repositories no other cycle holds, instead of the whole cycle being thrown away.** The guard that shipped with `defaults.syncOnStart` skipped a cycle outright while another was in flight, which is right for the case it was written for (the tick that lands inside the startup sync, over the same repositories) and wrong for two schedules: `backend`'s group was dropped for as long as `frontend`'s fetch ran, and pressing `s` during a cron sync synced nothing at all. The claim is per repository, so the reason that guard exists still holds — a cycle never reaches `clearRecordedSkips()` for a repository another cycle is syncing, so it cannot truncate that cycle's clone-mode skips — while the repositories nobody is syncing are synced. A repository left to the cycle that holds it is reported the way it always was, `Sync skipped for 'frontend': sync skipped: in_progress`, and counts as attempted, so a cycle in which every repository was skipped still does not stamp "Last Sync". The reload takes the same claim over the repositories it syncs: it arms the new cron jobs and only then runs its sync, so a tick landing in that window is routine, and it is the one cycle that always covers every repository.

  **A repository whose `sync()` fail-fasted no longer closes a progress row it does not own.** `runSyncServices` emitted `{completed: true}` for every repository in a `finally`, including one whose `sync()` returned `{started: false, reason: "in_progress"}` because another cycle, another process or an interactive operation holds the repository — and `App` removes a row on `completed`, so the row the _other_ cycle was updating disappeared mid-fetch. The event is now emitted by whoever actually ran, and still by a sync that threw, which does own its row.

  **`OpenEditorWizard` and `WorktreeStatusView` load once per selected repository.** Both effects re-fired whenever `entries.length === 0 && !loading`, which is not "not loaded yet" but "loaded, and empty" — a legitimate answer for a clone-mode repository before its first sync (`getWorktrees()` returns `[]` while `<worktreeDir>/.git` does not exist) or a repository whose every status probe rejected. Each loader round trip committed `loading=false` with the length still 0 and started the next one: measured here with a 20 ms loader, 22 calls in 500 ms, each one a `git worktree list` or a full status fan-out plus a `readdir` of `.diverged`, for as long as the modal stayed open. Both now key the load on the repository index they loaded, the way `BranchCreationWizard` has, so `No worktrees found` is a terminal state; ESC back to the project list clears it, so the same repository can be opened again and is read again.

  **The log panel fits in the height it is handed.** `visibleLines` subtracted the borders and the header but not the `↑ N more above` / `↓ N more below` rows, which render in addition, and an entry containing `\n` renders as several rows (`wrap="truncate"` does not collapse newlines). Measured in a 10-row panel with 40 entries: 11 rows following the tail, 12 parked between both indicators, 12 with a `Synchronization finished.\n` entry and 15 with a 5-line timing table — against an `App` frame sized to `terminalRows`, which is how Ink came to treat every render as overflowing and fall back to `clearTerminal` plus a full repaint, scrolling the panel's top border and its `📋 Logs` header out of view. All four cases are now exactly 10 rows. Both indicator rows are reserved as soon as the log is longer than the panel rather than each one as it appears, so the viewport does not change size with the scroll position — one notch of the wheel up followed by one notch down still lands exactly on the tail — and the panel's outer box has a fixed height with `overflow="hidden"`, so a row the budget cannot predict is clipped rather than drawn over the panel's own border. At the smallest height `App` will hand out there is one row left after the header and a single log line, which is not enough for two indicator rows: drawn anyway they landed on top of the header, which came back as `↑ 33 more aboveries)`, and clipped instead they would cost the reader the `↓ N more below` count. At that height the two counts share one row. `addLog` splits a message on its newlines into one entry per line rather than flattening it, so the timing table `debug` logs stays readable and scrollable instead of being truncated into its first row; a newline at either end is a terminator, not an extra entry — and both multi-line producers open with one, `Logger.table` wrapping its content in newlines on both sides and the sync failure line starting with one.

- cf3dfe0: Ctrl+C now shuts the interactive UI down instead of leaving a headless daemon behind, the terminal's mouse tracking is turned off on every exit path, the shutdown's own progress messages are no longer swallowed, and cron tasks are released rather than just stopped.

  **Ctrl+C left a daemon running.** While Ink holds stdin in raw mode, `\x03` never becomes SIGINT — it arrives as data, and Ink 7 answers it at the root of its own tree: it drops raw mode and unmounts, without calling `process.exit`, without `onQuit`, and without the service's `destroy()`. `waitUntilExit()` was never awaited, so nothing noticed. Measured before the change, against a real Ink render over a fake TTY: one `\x03` moved `stdin.rawMode` from `true` to `false`, resolved Ink's exit promise, and called `onQuit` exactly zero times. The cron tasks kept the event loop alive, so the process went on syncing on schedule against an interface nobody could see, with every log line emitted into a tree that had no listeners left. The escape was a second Ctrl+C, which — raw mode now being off — became a real SIGINT, and `setupSignalHandlers` turned that into `destroy(true)`: a 2s wait, then exit, which is short enough to cut a fetch in half.

  The service now awaits Ink's exit promise and routes it into the same path the `q` key uses. That was chosen over `exitOnCtrlC: false` plus a `useInput` handler, deliberately. In raw mode `\x03` is data, so with Ink's own handling switched off a Ctrl+C that no handler catches is not an escape at all — it is nothing. Seven components call `useInput` (`App`, `BranchCreationWizard`, `OpenEditorWizard`, `WorktreeStatusView`, `ForceCleanModal`, `HelpModal`, `LogPanel`), `App`'s handler returns early while any modal is open, and `LogPanel` is not even mounted then; a handler in `App` alone would have left Ctrl+C dead behind every wizard, which is worse than the behaviour it replaces. Ink's exit promise does not depend on which component owns the keyboard, and it also fires when Ink tears the tree down after a render error. If the continuation somehow never runs, the result is exactly today's behaviour — Ink unmounted, raw mode off, second Ctrl+C still a real SIGINT — so no escape is ever removed.

  **Mouse tracking was never turned off.** `App` wrote the enable sequence from an effect and the disable from its cleanup, but Ink's `unmount()` sets its `isUnmounted` latch _before_ React cleanup runs and `writeToStdout` returns early once it is set, so the disable was discarded on every exit path and the shell inherited DECSET 1000/1006 — every click typing `[<0;12;7M` until `reset`. Measured before the change: on a full render-then-Ctrl+C cycle the enable sequence was present in the stream and the disable was absent entirely, while `\x1b[?1049l` was written. Both halves now live outside React, in the service, so they cannot be split: the enable goes on straight after `render()` returns (Ink has entered the alternate screen by then), gated on `stdout.isTTY` for the same reason Ink gates the alternate screen on it, and the disable goes out after `unmount()` has restored the primary buffer. After, not before: Ink documents alternate-screen teardown output as disposable and drops writes made once it has latched, so the sequence that has to survive belongs on the buffer the shell gets back. A `process` `"exit"` listener carries the same restore for the paths that never reach the service's teardown — an uncaught exception, or a `process.exit` from anywhere else.

  **The shutdown could not report on itself.** `destroy()` set `isDestroyed` as its first statement, before cancelling the cron jobs and before the wait, and `addLog` returns early when that flag is set. Measured before the change, with a sync in progress and the UI listening: `destroy(true)` produced zero log events, so neither the "waiting for N in-progress sync(s)" notice nor the data-loss warning ever rendered and the interface simply froze for up to 30s before exiting mid-sync anyway. The flag now moves to after the wait, which is what it was for, and the notice also goes to the bare terminal when Ink has already gone (the Ctrl+C path), where a silent process just looks hung.

  There is now a force-quit shortcut, which the item asked for and the new Ctrl+C makes necessary: a second `q`, or the real SIGINT a second Ctrl+C becomes, ends the wait instead of starting a second teardown. `destroy()` is idempotent and returns the shutdown already in flight, so the signal handler and the keyboard settle on the same one. A 500ms guard from the start of the shutdown keeps a held key from forcing on its own repeat, and the notice says what the second press does. The two timeouts are unchanged and still split the same way — `WAIT_SYNC_FAST_TIMEOUT_MS` (2s) for signals, which have a watchdog behind them, `WAIT_SYNC_DEFAULT_TIMEOUT_MS` (30s) for `q` and for Ctrl+C, which is now a `q` — and a test pins each.

  **Cron tasks leaked.** `cancelCronJobs` called `stop()`, which clears the runner's timer and nothing else; node-cron 4.6 keeps every task it ever scheduled in a module-level registry released only on `task:destroyed`. Measured before the change: after `destroy()` the registry still held the task with status `"stopped"`. Since the task holds the tick callback and the callback closes over a whole generation of `WorktreeSyncService` objects and their per-worktree git clients, every `r` reload leaked one generation. It now calls `destroy()`, which stops the runner on the way through, so stopping first would be redundant; destroying a task mid-execution does not abort the run in flight, it only stops future ones, which is what the shutdown wants. Both `stop()` and `destroy()` are typed `void | Promise<void>`, and a background task's `destroy()` rejects after its own 5s timeout, so the result is no longer dropped on the floor — it is awaited for its rejection and reported as a warning rather than becoming an unhandled rejection.

  This refuses nothing. No configuration that loaded before stops loading, no argument is rejected, and nothing about how a sync runs changes; what changes is that four interactive defects stop happening, which is why this is a patch and not a minor.

- cf3dfe0: The TUI branch wizard can no longer move a branch that is already on the remote. In worktree mode the collision check was local-only: a branch hidden by `branchMaxAge`/`branchInclude`/`branchExclude`, or pushed by somebody else since the last fetch, has a remote-tracking ref but no local head, so `git branch` collided with nothing and the unleased `git push origin <name>:<name> -u` that followed **fast-forwarded the existing remote branch** whenever its tip was an ancestor of the base — moving a branch nobody asked to move, and with it any open PR or CI run pinned to that ref, while the wizard reported a successful creation.

  - `createBranch` now asks origin directly (`ls-remote --heads origin refs/heads/<name>`) and treats an existing remote ref as a collision, so the suffix logic applies to a remote-only name exactly as it already did to a local one. A remote that cannot be reached is not fatal — creating a branch without pushing it still works offline.
  - `pushBranch` now pushes with `--force-with-lease=refs/heads/<name>:`. An empty expectation leases the ref against "does not exist", so **an existing remote ref is never advanced or force-updated**: git refuses the push with `stale info` instead. (It does not require the ref to be absent — git enforces a lease only on a ref the push would change, so a remote ref already at exactly this commit is `[up to date]` and nothing moves in that case either.)
  - A push that fails now removes the local branch this attempt created, with a compare-and-swap on the commit it was created at, and the message it reports is credential-redacted and carries the auth hint, as clone mode's already was. Previously the orphan stayed in the bare repository, so retrying the same name hit `already exists` and silently produced `<name>-1` while `<name>` was never pushed. A name the lease refuses is reported as the collision it is, so the retry picks the next free suffix — but a leftover that could not be removed stops the retry rather than being suffixed past, and names the branch and the bare repository to delete it from.
  - The wizard now submits exactly the name it displayed, and the service continues that name's suffix instead of restarting under it: a `x` shown as `x-1` that also collides becomes `x-2`, not `x-1-1`. The name reported back is the one actually attempted.
  - GitService now runs git with `LC_ALL=C`/`LANG=C`, as clone mode's clients already did, so the push-status reason a refused lease is recognised by does not stop matching under a non-English locale.

  Clone-mode repositories already behaved this way; worktree mode now matches.

- cf3dfe0: The cross-process repository lock now lives next to the checkout, in `<parent of worktreeDir>/.sync-worktrees-locks/`, instead of under `$XDG_STATE_HOME` or `~/.cache`, so a daemon started by systemd/launchd/cron and a `--runOnce` from an interactive shell (or `sudo` with and without `-E`) always contend for the same lock file; `SYNC_WORKTREES_LOCK_DIR` overrides the directory when that parent is not writable and must be set identically for every process sharing a `worktreeDir`.
- cf3dfe0: `filesToCopyOnBranchCreate` copies a path you spelled in full, says so when a pass matched nothing, and the README describes when it actually runs.

  **A literal path into an ignored directory copied nothing.** Every pattern was expanded against the same ignore list, so `filesToCopyOnBranchCreate: ['build/local.settings.json']` — or `['coverage/.nycrc']`, or anything under `dist/`, `.next/`, `node_modules/` — matched zero files, on a tree where the file was sitting right there. The list exists for the pattern that wanders: `**/.env` reaches whatever happens to be under the source, and reading a dependency tree or a bare repository's object store is never what it was written for. A path with no glob magic in it wanders nowhere. It is the one file the config named, and answering it with silence because a directory on the way is called `build` overrides the only person who knows what that file is. The default names now apply to patterns with magic and not to patterns without it, so `build/local.settings.json` arrives while `**/*.json` still skips `build/`.

  The verdict is glob's own `hasMagic`, taken under the options glob itself parses a pattern with. That part matters: glob forces `nonegate` on when it expands, and a bare `hasMagic(pattern)` does not, so the two disagree about `!(dist)/.env` — a negated literal `(dist)/.env` to the bare call, an extglob across every directory in the source to the expansion. Judged as a path, it would have been handed the empty ignore list and then walked into `node_modules` and `.bare/` on the strength of having named nothing, which is the one case where the list is least optional. The pattern that reaches furthest is now the one measured against it.

  Braces are a decision, and they count as spelling the paths out: `{build,dist}/x.json` is `build/x.json` and `dist/x.json` written on one line, and both are copied. Brace expansion turns one string into a fixed list of strings, each as spelled-out as a pattern with no braces in it, and each is judged on its own — one alternative that wanders (`{a.json,**/b.json}`) makes the whole pattern wandering, so what this admits is only the pattern whose every alternative is a path.

  The verdict still parts company with the look of a pattern over a class that admits a single character. `a[1].json` spells out one name by that test — it can only ever produce `a1.json` — and glob still expands it as a class, so it names `a1.json` and not a file whose name contains the brackets. Escaping them names that file, and the escape has to survive a JavaScript config file too: `"a\\[1\\].json"`, since `"a\[1\].json"` is just `a[1].json` again.

  **A leading `!` is rejected by config validation instead of being copied as a filename.** The expansion runs with negation off, so `!` is an ordinary filename character here, while the neighbouring `sparseCheckout.exclude` does give it the gitignore meaning. Carrying that idiom across bought silence: `['!node_modules/**']` looked inside a directory named `!node_modules`, found nothing, and reported zero matches without saying why. An entry that starts with a bare `!` is now a config error naming the difference and the escape (`"\\!important.json"`) for a file whose name really does start with one. A leading extglob (`!(dist)/.env`) is left alone — glob reads it as an extglob, and it is expanded as the wandering pattern it is.

  The caller's excluded directories are not part of that trade and are still applied to every pattern. Those are the other repositories' checkouts and the worktree being filled, and a literal path is exactly how a pattern reaches into one.

  **A pattern that could not be expanded at all was dropped on the floor.** The expansion caught every failure and moved on, so a pattern that threw was indistinguishable from one that matched nothing — and from the feature not being configured. Each one is now reported in `result.errors` under the pattern that produced it, which the caller already turns into a warning naming both, and the remaining patterns are still expanded.

  **A copy pass that matched nothing now logs at info level.** Copying reported itself only when it copied a file or hit an error, so the common misconfiguration — patterns resolved against a directory that does not hold the file — produced exactly the same silence as never setting the option. The line names the patterns and the directory they were resolved against: `Copy for '<branch>' matched 0 files for patterns [...] in <source directory>`.

  **README's `Hooks and file copying` promised more than the code does.** It said hooks run "after a new branch's worktree is created" and that files are copied "into every newly created worktree", with glob patterns "resolved relative to the config file's directory". Both sentences are wrong in the same direction. `hooks.onBranchCreated` and `filesToCopyOnBranchCreate` fire only from the interactive UI's branch wizard; a worktree the sync creates for a branch that turned up on the remote gets neither, and neither does one the MCP `create_worktree` tool creates. The config file's directory is the copy source in clone mode only — where the copy fires once on the initial clone — while in worktree mode the source is the base branch's worktree, the checkout the new branch was cut from. A reader following the old paragraph kept `.env.local` next to the config file and expected the hourly sync to deliver it; nothing was ever copied, and from the wizard the file was looked for in a checkout that does not have it.

  The documentation is corrected rather than the feature widened, deliberately. A hook is an arbitrary shell command, and running one unattended on every cron tick — or on an agent's say-so through MCP — is a different proposition from running it because a person pressed a key in the branch wizard. The paragraph now states the trigger, both source directories, which patterns the default ignore list applies to — braces and the leading-`!` forms included — the escape that survives a JavaScript config file, and the zero-match log line.

  `patch` rather than `minor`: no option, subcommand or exported type is added. A configuration that copied files before copies the same files, plus any path it spelled out that was silently dropped, with two deliberate exceptions. A pattern that leads with an extglob no longer reads the directories in the default list, which is the defect above rather than anything a config was written for. And an entry that leads with a bare `!` is now a config error instead of a lookup that never matched; a config that meant the literal name keeps it by escaping the `!`.

- cf3dfe0: Every git subprocess now runs with `GIT_TERMINAL_PROMPT=0` unless you set it yourself. An HTTPS remote whose credentials git cannot obtain — no credential helper, no askpass — now fails within a second with git's own message plus a hint naming the fix, instead of a credential prompt written into the TUI that blocked the fetch until the 300 s inactivity timeout and was then retried three times. Credential, ssh key and host-key failures are no longer retried, and each carries a one-line hint (credential helper / ssh-agent / known_hosts). All git clients share one sanitized environment and one set of simple-git unsafe-env allowances, so a shell exporting `PAGER`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_CONFIG_COUNT` or `PREFIX` no longer makes git calls throw. Known limitation: `GIT_TERMINAL_PROMPT=0` covers git's own prompts only; ssh reads a key passphrase or an unknown-host confirmation from the terminal itself, so a passphrase-protected key without an agent or a host missing from `known_hosts` still blocks until the inactivity timeout, as before. `GIT_SSH_COMMAND` is deliberately left unset because git gives it precedence over the `core.sshCommand` config key.
- cf3dfe0: With `skipLfs: true`, worktree status probes (the update gate and prune checks) now run git with the full sanitized process environment instead of only `GIT_LFS_SKIP_SMUDGE`, so the global excludes file (`~/.config/git/ignore`, `core.excludesFile`), `~/.gitconfig` (`safe.directory`) and `PATH` are honoured again; globally-ignored files such as `.DS_Store` no longer mark every worktree as dirty, blocking updates and prunes. The sparse-checkout LFS verification client gets the same unsafe-env allowances as every other git client, so a `GIT_ASKPASS` or `GIT_CONFIG_COUNT` in the environment no longer makes it skip the `lfs ls-files` check.
- cf3dfe0: Repository URLs are now shown with embedded credentials stripped (`https://***@host/repo.git`) in logs, the `list` output, clone and origin-mismatch messages, git error text and MCP responses; git operations and the `SYNC_WORKTREES_REPO_URL` hook variable still receive the working URL.
- cf3dfe0: `pnpm lint` now runs type-aware ESLint rules over all TypeScript sources and tests with typescript-eslint (including `no-floating-promises` and `no-misused-promises`) and eslint-plugin-react-hooks, so the CI lint step covers the whole app instead of six root JavaScript files.
- cf3dfe0: `parallelism.maxStatusChecks` now caps git processes instead of worktrees, and the config loader's safety limit counts the real peak. One status check of a worktree runs up to nine git commands (`status`, `branch`, `branch -r`, `stash list`, `submodule status`, then up to four `rev-parse`/`rev-list` probes), five of them at once — so a prune tick with many stale worktrees peaked at five times the configured number of git processes (200 at the defaults), exhausting file descriptors on smaller machines and leaving worktrees skipped as unverifiable. Every status probe of a repository now shares one `maxStatusChecks`-wide budget, so that setting is the ceiling however many worktrees a tick turns up; the prune phase measured slightly faster at the defaults as a result.

  A `parallelism` block at the top level of the config file — the placement the example config and README show, and the one `retry` already supported — now reaches every repository. Only `defaults.parallelism` and a repository's own block were merged before, so a top-level block silently left every per-repository limit at its default.

  The loader also stopped adding up phases that never run at the same time. Peak concurrent git processes is now `maxRepositories × the widest single phase` rather than `maxRepositories × the sum of all phases`, and the error names the phase to lower and the value to lower it to. Phases whose git command goes through one shared client are counted at what that client's scheduler allows rather than at their configured width: `git worktree add` and `git worktree remove` run at most 5 at a time however high `maxWorktreeCreation` and `maxWorktreeRemoval` are set, so raising those far above 5 mostly does not widen the phase. The per-branch fetch fallback, which only runs when a bulk fetch fails on LFS errors, is left out of the peak altogether. Between them these keep the new rule below the old one for every input, so no config that loads today is rejected after upgrading. The shipped defaults peak at 2 × 20 = 40 of the allowed 100.

- cf3dfe0: A worktree whose check fails during a sync is now named in both the log and the outcome. Both phases' `Error checking worktree ...` lines now carry the worktree path next to the branch, and the prune phase's `prune_status_check_failed` skip records the path alongside the branch it already had — so on a daemon watching hundreds of worktrees, a corrupt index or an unmounted volume points at the directory to look at instead of leaving every tick's `fatal:` unattributable.
- cf3dfe0: In the interactive UI, worktree metadata and status-probe log lines now reach the log panel instead of the terminal underneath it. `GitService.updateLogger` propagates to the metadata and status services it owns, cached git clients read the current logger for each progress event rather than the one they were built with, and a reload builds its services with the UI logger already in the config, so nothing `initialize()` logs escapes to the console.
- cf3dfe0: Cached git clients are now dropped when the worktree they point at goes away, so a long-running daemon no longer grows with the repository's branch churn. `GitService` and `WorktreeStatusService` each cache a simple-git client per worktree path (keyed additionally by the LFS-skip flag and, in `GitService`, by the local/network client kind), and nothing ever removed an entry: every branch that was created and later pruned left its clients behind for the life of the process. Measured on a real repository, 30 create/check/remove cycles behind a single live worktree grew `GitService`'s cache from 5 to 65 entries and the status service's from 0 to 30, at 6.5 KB per client with a typical 35-variable environment (13.8 KB with a 136-variable one — each client keeps its own copy of the sanitized environment) — roughly 20 KB per branch, or ~200 MB of unreclaimable heap after a year of 30 branches a day.

  Every path that unregisters or moves a worktree now forgets both caches' entries for it — `removeWorktree` (and so the trash move and the diverged replacement, which both end there), the rollback of a failed creation, the stale-registration cleanups during creation and at startup, and the stale-directory cleanup that moves a directory to trash, quarantines it under `.removed/` or deletes it — all variants of the path at once, not just the one the caller happened to hold. Both caches are additionally bounded at 512 clients, evicting the least recently used, so a path no removal flow accounts for can no longer be retained forever. Eviction only drops the map entry: an operation already running on a client keeps the instance it was handed and is never interrupted, and the clients a sync phase keeps reaching for (the bare repository's, the anchor worktree's) are the last ones the bound can drop, so at any realistic width the process cap those shared clients provide is unchanged.

- cf3dfe0: Worktree status checks no longer run `git check-ignore` after `git status`. `git status --porcelain -u` never reports an ignored path as untracked, so re-checking each untracked path was a spawn that could not change the answer — and it passed every untracked path on one command line, so a worktree holding a large untracked build directory that nothing gitignores (a few tens of thousands of files is enough to pass the kernel's `ARG_MAX`) made the spawn fail with `E2BIG`: the check threw and the update phase skipped that worktree as `update_check_failed` on every tick instead of reporting the dirty worktree it had. Dropping it also closes a way a dirty worktree could be reported clean: the status parser trims each line, so a filename with a trailing space reached `check-ignore` mangled, and a `.gitignore` rule matching the trimmed name removed a genuinely untracked file from the list. Ignored files are still ignored, exactly as git decides; a status check of a worktree now costs up to nine git commands rather than ten.
- cf3dfe0: Sorting the registered worktrees into "inside worktreeDir" and "external" no longer blocks the event loop. The containment check canonicalizes both the candidate and the base directory, and it did so with `fs.existsSync`/`fs.realpathSync` — synchronously, and re-resolving the same `worktreeDir` for every candidate, so a 400-worktree repository spent 800 `existsSync` calls and 800 realpath walks -- several thousand syscalls, in proportion to how deep `worktreeDir` sits -- in one uninterrupted stretch on every sync attempt. Measured at 400 worktrees on a local filesystem, the partition held the loop for 6.6 ms without yielding once; each realpath is milliseconds rather than microseconds on NFS/SMB or a network home directory, and every configured repository syncs in the same process, so the TUI dropped frames and cron callbacks ran late.

  `worktreeDir` is now canonicalized once for the whole partition and the candidates are probed through `fs.promises`, eight at a time. The same 400-worktree partition yields to the loop 118 times with a longest pause of about 1.3 ms. It costs wall-clock time — roughly 21 ms in place of 6.6 ms, since promise scheduling is what a per-path `stat` mostly pays for — which is the intended trade against a sync attempt that already runs for hundreds of milliseconds while the TUI is trying to render.

  The boundary itself is unchanged. Every candidate is still canonicalized individually, so a worktree that reaches outside `worktreeDir` through a symlink is still classified as external, and a path that does not exist yet is still judged by walking up to its deepest existing ancestor. Resolving the base once is a snapshot for the duration of one partition only: it is not cached across sync attempts, and it removes the case where replacing `worktreeDir` mid-partition had some candidates judged against the old directory and the rest against the new one. Trash restore and the TUI's diverged-directory delete make a single check per user action and keep using the synchronous variant.

- cf3dfe0: Worktree mode no longer treats a fast-forward or local-ahead probe that could not run (a `git merge-base` that failed to spawn under EMFILE/ENOMEM, or exited with a `fatal:` error) as a diverged branch: such a worktree is now recorded as `update_check_failed` and left alone, where before a healthy, fully pushed worktree could be moved to `.trash/` (or `.diverged/`) and recreated from origin on nothing but a probe error. Diverged handling also re-checks with `git rev-list --left-right --count` that HEAD and `origin/<branch>` really have commits on both sides before it resets or moves anything — a probe that cannot answer aborts with `diverged_recovery_failed`, and a worktree that turns out to be at the remote tip, only ahead, or only behind is recorded as `already_up_to_date`, `local_ahead`, or `not_diverged` and left for the next sync.
- cf3dfe0: Sync progress now counts the items each phase finished instead of standing still for the whole phase. A sync attempt used to report five messages — one as each phase opened — so a first run against a 300-branch repository showed "Creating worktrees for new branches" in the TUI status bar for the 30+ minutes the serial, checkout-bound create phase took, and an MCP client watching the same sync saw its progress counter stop at 2 with no way to tell a slow sync from a hung one. The create phase, both stages of the prune phase (the status checks, then the removals that passed them), both stages of the update phase (the candidate checks, then the fast-forwards and diverged handling) and the sparse-checkout reconciliation now each report `Creating worktrees: 'feature-x' (12/300)` with `processed` and `total` attached to the event, and the sparse phase announces itself the way the other four already did.

  The counts follow completions, not dispatch: phases run their items concurrently under `pLimit`, and counting where an item is scheduled would make the reported number jump around and arrive out of order. The counter is incremented where the item settles — created, skipped or failed alike, so the count always reaches its total — with nothing awaited between the increment and the event, which leaves the sequence strictly increasing under any interleaving. Update candidates that the tip comparison settles without spawning a single git process count too: they are part of what the user is waiting on, and leaving them out would give the count a denominator it could never reach.

  Long phases are sampled rather than reported item by item. Every item reports while a stage stays at or below 100 of them, which is what a normal repository hits; past that the stage reports the first item, every step-th item after it and always the last one, so the count starts moving immediately and still ends on `n/n`. The ceiling is what keeps the TUI usable: every progress event re-renders the status bar with no coalescing in between (measured: 5,000 events produce 4,999 Ink frames and about 14 s of render work, against 0.25 s for 100).

  MCP progress notifications now carry the counts a phase reports as `progress`/`total` rather than "the n-th event of this sync". The spec requires a progress token's value to increase with every notification and the SDK does not enforce it, while these counts restart at 1 in every phase and in every stage of a phase, so each counted run is carried on top of everything already reported: `progress` is that offset plus the event's `processed`. Git's transfer events stay one tick each — their percentage is already spelled out in their message, and their object counts are not items this sync is working through, so a 1200-object clone would otherwise add 1200 to a three-branch sync once per transfer stage and leave a client's bar filling and resetting five times over. That also keeps the `0% (0/1200)` line every transfer stage opens on, and the 100% line git prints twice, from reporting a value the client has already seen. A total is sent only when the progress fits inside it, and never below the last total sent, so a stage abandoned part way cannot shrink the denominator under a client mid-sync.

- cf3dfe0: The README's retry section now states the defaults a sync actually runs with, and the LFS retry-limit error points at a setting that exists.

  **The documented defaults were the wrong ones.** README promised `maxAttempts: "unlimited"` ("keep trying forever (default)") and showed `maxDelayMs: 600000` in its multi-repo sample. Both numbers are `retry()`'s own `DEFAULT_OPTIONS`, which never decide an unconfigured sync: `SyncRetryPolicy` supplies all six values from `DEFAULT_CONFIG.RETRY` on every sync path, so leaving `retry` out gives 3 attempts, a 1s initial delay, a 30s cap, multiplier 2, 2 LFS retries and no jitter. Someone who left `retry` unset expecting a daemon to keep trying a flaky remote got three attempts and then a failed tick — exit 1 under `--runOnce`. The section now carries those six numbers in a table, says which errors are retried at all (DNS, refused connections, timeouts, `EBUSY`, `Could not read from remote repository`, `fatal: unable to access`, LFS) and which fail on the first attempt (the credential, ssh key and host key failures git names in its message, `EACCES`, `EPERM`, `EROFS`, `ENOSPC`, anything unrecognized), and records that the three `retry` layers — top level, `defaults`, repository — merge field by field. The multi-repo sample keeps its `"unlimited"` and 10-minute cap, now marked as the overrides they are.

  **`--skip-lfs` has not existed since the CLI became config-file-only.** `retry()` still told whoever exhausted `maxLfsRetries` to "Consider using --skip-lfs option", a flag `src/utils/cli.ts` no longer defines, and the shipped defaults reach that message exactly: the third consecutive LFS failure trips the limit as the third attempt runs out. It now names `skipLfs: true`, the config field that does the same job, which the loader validates per repository and under `defaults`.

  `patch` rather than `minor`: no config key, CLI flag or exported type is added or removed, no retry behaviour changes, and the only difference at runtime is the wording of one error message.

- cf3dfe0: Remote branches whose names end in `/HEAD` (such as `feature/HEAD`) are now kept in the sync inventory — only the real `origin/HEAD` symref is skipped — so their worktrees are created instead of being pruned as stale, and branch listings no longer lose or rename branches when a local branch named `origin/<name>` exists.
- cf3dfe0: Worktree mode no longer reports an update that did not happen. The fast-forward now reports whether HEAD actually moved: when the behind probe saw `origin/<branch>` ahead but the merge had nothing left to bring in (HEAD reached the remote tip in between, say through a `git pull` in the worktree), the sync records `noop already_up_to_date` for that worktree instead of `updated fast_forward`, logs no "Successfully updated" line, and leaves its `lastSyncCommit`, `lastSyncDate` and `syncHistory` untouched. The MCP `update_worktree` tool exposes the same fact as `updated: false` in its response.
- cf3dfe0: Stop re-applying an unchanged cone sparse-checkout on every sync. `git sparse-checkout set --cone` normalizes the directories it is given — resolving `.`, `..` and repeated slashes, dropping a trailing slash, de-duplicating, sorting, and discarding directories an included parent already covers — and `sparse-checkout list` prints back that canonical form, so a config such as `sparseCheckout: { include: ['apps/', 'tools/'] }`, or one whose directories simply are not listed in sorted order, never compared equal to what the worktree already had. Every tick re-ran `sparse-checkout set` plus `checkout HEAD` on every existing worktree, checked each one for unsafe narrowing first, and reported all of them as "updated". Desired cone patterns are now built in that same canonical form before they are compared and applied, so the checkout on disk is unchanged — except that a directory written with a trailing `.` or `..` segment now resolves to the directory itself, as intended, where git had been narrowing the checkout to that directory's direct children. Non-ASCII directory names are also handled: `sparse-checkout list` is now read with `core.quotePath=false`, so a name like `café` is no longer compared against git's escaped `"caf\303\251"` (a name containing a backslash or a quote is still escaped by git, and still re-applies each sync). No-cone patterns, where a trailing slash and pattern order are meaningful, are still passed through and compared verbatim.
- cf3dfe0: Every git subprocess now decides which repository it works on from the directory it was given, never from an inherited environment variable. `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_CEILING_DIRECTORIES`, `GIT_DISCOVERY_ACROSS_FILESYSTEM` and `GIT_CONFIG` are dropped from the environment handed to git, in both worktree and clone mode and in the MCP server.

  Most of them reach a run only from a shell or a CI job that exports one. A few arrive on their own, from git itself, which hands them to its own hooks — and the two hook shapes break a run differently. A hook running inside a linked worktree is handed a `GIT_DIR` naming that worktree, and a `sync-worktrees` run started from one used to aim the whole tick — clone mode's refspec narrowing, its stale remote-tracking sweep, the checkout and the fast-forward merge — at the hook's repository instead of the directory the config named. A bare repository's receive hooks hand over a relative `GIT_DIR` that names no repository at all, so a run started from one used to fail outright. `pre-receive` also hands over the push quarantine object store, into which a fetch would write objects git deletes as soon as the push finishes — the two do not compound, because the relative `GIT_DIR` wins and nothing runs at all; the quarantine only bites a hook that drops `GIT_DIR` first, which the common `unset GIT_DIR` deploy idiom does. Which hooks carry which variable, and what each one does to a command that inherits it, is recorded variable by variable in the `GIT_REPOSITORY_SELECTION_VARS` comment in `src/utils/git-env.ts`.

  Nothing that authenticates or locates git is touched: `PATH`, `HOME`, `SSH_AUTH_SOCK`, `GIT_ASKPASS`, `GIT_SSH_COMMAND`, `GIT_PROXY_COMMAND`, `GIT_EXEC_PATH` and the `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`/`GIT_CONFIG_COUNT` family all still reach git, and a variable the tool passes deliberately still wins.

  `hooks.onBranchCreated` commands get the same treatment — only these variables, nothing else about their environment — so a hook's own `git` sees the worktree it was told it is running in. Two behaviour changes worth knowing: `GIT_CONFIG`, which git documents as historical and which affects only the `git config` command, no longer reaches git at all; and if you were relying on an exported `GIT_DIR` to redirect sync-worktrees, name the repository in the config file instead.

- cf3dfe0: Clone-mode **routine sync fetches now ratchet their `--depth`** instead of re-applying the configured one. Each sync fetches with `--depth max(depth, the window the clone already holds under origin/<branch>)`. `git fetch --depth N` re-applies N to the ref it fetches rather than capping at it, so passing the configured value verbatim re-cut the clone on every tick: a `depth: 1` clone that had been deepened to classify a fast-forward went straight back to one commit, the parent link `merge-base HEAD origin/<branch>` needs was cut, and every remote advance — even a single commit — classified as `indeterminate_shallow` and bought another 50-commit deepen that the next tick discarded again. The ratchet can never ask for a shorter window than the ref it caps already holds, so the deepen happens once and later ticks reach the fast-forward path on the first classification.

  Both numbers are ancestry levels — the unit `--depth` is defined in — counted from the ref the fetch re-applies them to. `--depth N` keeps every commit within N parent steps of the fetched tip, so on a history built from merge commits one level holds several commits (measured on git 2.43, a `--depth 50` fetch of a remote whose pull requests land as two-commit merges produced a 147-commit clone), which is why the clone is measured in levels and not in commits: a count is the larger number and ratcheting on it walks the boundary deeper every tick until the clone holds the whole repository. The measurement is a local `git rev-list --topo-order --parents refs/remotes/origin/<branch>` walk of the remote-tracking tip, not of HEAD: HEAD is the commit `--depth` is re-applied from only on a tick that ends in a fast-forward, and on the ticks that fetch without merging — a dirty worktree, unpushed commits ahead, a divergence — it falls behind the tip, so a cap measured there asks for less than the clone holds and shortens it, further on every tick. Measured on git 2.43 against a 120-commit remote advancing three commits a tick with the worktree left dirty, a HEAD-measured cap sent `--depth` 50, 47, 41, 32, 20 and then 5 on successive ticks and had to buy the window back with a second deepen once the tree was clean; measured from `origin/main` the same run sent `--depth 50` every tick, held the window at 50 levels and fast-forwarded with no second deepen. HEAD is used only as a fallback on a first sync, before the remote-tracking ref exists.

  The cap itself stays, because a shallow clone has no ancestors to offer the server as `have`s: when the remote tip stops being a descendant of the clone's tip — a force-push or a rebase, routine on the branches clone mode tracks — an uncapped fetch has to pack the new tip's whole ancestry. Measured on git 2.43 against a 199-commit remote force-pushed with `reset --hard HEAD~3` plus one commit — a 197-commit tip — a `depth: 1` clone fetched 1 commit in a 3-object pack with the cap and all 197 in a 201-object pack without it, and classified `indeterminate_shallow` either way. That remote is empty commits over a three-file seed, so the 201 is 197 commits, the three trees the clone lacked and the one blob the rewrite added; commits carrying content add a tree and a blob apiece to the uncapped side. In steady state, measured against a 601-commit remote advancing by one merged pull request per tick, a `depth: 1` clone deepened once to 50 levels (147 commits) and then fetched `--depth 50` on every later tick: 6 objects each time, `fast_forward` on the first classification, still 147 commits and still shallow six ticks later.

  A clone does not sit at exactly `depth`: a remote that advanced by k levels pushes the oldest k levels off the bottom, and a local tip a force-push moved off the fetched ref's ancestry cannot be kept inside the window by any depth. A clone that is not shallow gets no `--depth` at all — there the flag would _make_ it shallow (measured on git 2.43, `--depth 5` against a full 199-commit clone left 5 commits). If neither walk yields a depth — a missing remote-tracking ref on a first sync, an unborn HEAD, or the empty string simple-git resolves with when git exits non-zero without writing to stderr — the cap falls back to the configured depth rather than to no cap: a re-truncation is something the deepen budget can undo, an uncapped transfer is not.

  Editing `depth` now reaches an existing clone, asymmetrically. Raising it raises the cap, so the next sync fetch deepens a shorter clone up to the new value — measured on git 2.43, a `depth: 1` clone of a 199-commit remote went from 1 commit to 10 on the first fetch after the value was raised to 10. Raising it also shrinks the in-sync deepen budget, which only uses targets above `depth`: at 1000 or more there is no budget left and an unclassifiable clone can only be skipped. Lowering `depth` cannot shorten an existing clone through the sync fetch. Removing it still unshallows on the next sync.

  Two other fetches keep re-applying the configured value verbatim and can shorten a clone. The deepen budget refetches at `--depth 50`, `200` or `1000`, so a clone grown past the target it picks is cut back to it (measured on git 2.43: 80 commits to 50), and when the budget cannot settle the question either — a force-push that moved the branch off the clone's tip entirely — that repeats every tick until the divergence is resolved. Switching the clone to another branch, and the branch wizard's base-branch fetch, re-apply `depth` to whatever ref they name, and because the shallow boundary is repository-wide they can shorten **or** deepen the clone even when `depth` was never edited — including on the tracked branch itself, which the wizard offers among the bases. That flag stays because dropping it would pull the whole history of a base branch the clone has never seen: measured on git 2.43, fetching a 290-commit branch whose commits each rewrite a file into a `depth: 1` clone cost 288 of them — all but the two hidden below the clone's existing shallow graft — in an 861-object pack without it, against 1 commit and 3 objects with it. The README, the example config and the `depth` type documentation were rewritten to match.

- cf3dfe0: Clone mode now writes the clone-init pending marker the moment `git clone` returns, before it narrows the new clone's remote. That marker is the only record that a finished clone still owes the initial `filesToCopyOnBranchCreate` copy — the existing-clone path runs the copy only for a clone carrying it — and it used to be written after the refspec narrowing, four or more git subprocesses later. A process killed in that window -- SIGKILL or an OOM kill; the marker is not fsynced, so a power loss is no better served than the clone's own writes are -- left a complete clone with no marker: the next run adopted it as one the user had made, re-ran the narrowing, and never copied the files, on that run or any later one, with nothing logged about it.

  The window is narrower, not gone: `git clone` returning and the marker write are two operations and no ordering makes them one, so a kill between them still drops the copy. What is left is a single file write instead of the narrowing's git subprocesses.

  Nothing else moves. The marker write stays best-effort (a failure warns and the init continues), the narrowing it now follows is idempotent and re-run whenever an interrupted init is resumed, and a clone whose checkout never finished is still refused by the separate `.git/.sync-worktrees-clone-incomplete` marker before the pending one is consulted at all.

- cf3dfe0: Clone mode now honors the documented narrowing-safety check before it re-applies sparse-checkout patterns, and records a broken sparse config as a failure instead of a passing warning.

  Two gaps, both only in clone mode — worktree mode has always done this:

  - **A sparse config Git rejects no longer passes silently.** `Failed to reapply sparse-checkout for '<repo>'` was a bare warning; the sync outcome recorded nothing, so the run still reported the repository as synced and `--runOnce` exited 0. Every tick reprinted the warning and nothing watching the run ever learned. The failure is now recorded as a `sparse-checkout` action with reason `sparse_checkout_failed`, which reaches `counts.failed`, the run summary's `N failed`, the MCP `sync` result, and the exit code. It is still not fatal to the sync: the fetch and fast-forward that follow run exactly as before.

  - **A narrowing sparse update is deferred while the checkout is dirty** (behaviour change). Previously clone mode called `sparse-checkout set` whenever the patterns differed. Git itself preserves modified, staged and untracked files that fall outside the new patterns, leaving them on disk and warning about it on its own stderr — which this tool captures and never prints, so the preservation was real but silent — so this was not data loss, but it did not match the narrowing-safety paragraph in the README, which promises the tool skips instead. Now, when the new pattern list drops a path that the current one included, the checkout is checked first and a dirty one is skipped with a `sparse_narrowing_unsafe` action in the outcome. The narrowing is only deferred: it applies on the first sync that finds the tree clean.

  Scope of the clean check, stated plainly: clone mode reuses the same uncommitted-and-untracked-changes check that already gates its fast-forward, not worktree mode's fuller probe. Unpushed commits are a clone-mode skip of their own and their content is safe in the object store regardless; an in-progress operation is caught only insofar as it leaves the tree dirty, which in practice it does. Nothing here changes what Git does with files left outside the cone when a narrowing does go ahead.

- cf3dfe0: `filesToCopyOnBranchCreate` no longer reads out of the other repositories the config file manages.

  Patterns are expanded relative to the config file's directory, and the documented layout puts every checkout under that directory — so a recursive pattern matched far more than the file it was written for. Measured by handing the copy service the source and destination a clone-mode initialization gives it, over a config directory holding an `api` checkout, the `web` checkout being initialized, a `.bare/tools` bare repository and a worktree-mode `wt` with a trashed worktree under `.trash/`, each with a `.env.local`, and the pattern `**/.env.local`: `web` received `api/.env.local`, `api/src/.env.local`, `.bare/tools/.env.local` and the trashed worktree's copy, each landing under a path that keeps the directory it came from, plus its own pre-existing `.env.local` one level deeper inside itself. Only the `.env.local` next to the config file was intended. Each of the others lands untracked in a brand-new checkout, which is enough for every later sync to skip the repository as a dirty tree — and the file that travels this way is, by the nature of the setting, usually the one holding credentials.

  The expansion now skips every `worktreeDir` and `bareRepoDir` the config file names, the destination included, and the directories this tool creates for itself: `.bare/`, `.trash/`, `.removed/`, `.diverged/`, `.sync-worktrees-state/` and `.sync-worktrees-locks/`. The existing `node_modules`, `.git`, `dist`, `build`, `.next` and `coverage` exclusions are unchanged. Both modes go through the one rule. Worktree mode copies from an existing worktree rather than from the config directory, so what it keeps out there is the other repositories' checkouts and any `worktreeDir` a config nests inside this one's, which is allowed with a warning; the repository's own `worktreeDir` holds that source rather than anything foreign to it, so it is not one of the directories that copy is kept out of.

  Each excluded directory is recorded both as the config file spells it and canonicalized. The canonical form is what makes a `worktreeDir` written relative, written absolute, or named through a symlinked parent all reach the same checkout; the spelling covers the one case canonicalizing cannot (below). Nested entries each exclude their own subtree.

  Neither spelling is enough on its own, because a pattern can reach a checkout under a name that is not in the config file at all: a glob refuses to traverse a symlinked directory only for `**`, so a literal or single-star segment resolves straight through one. The link need not be the checkout either — with the checkouts under a `repos/` directory and an ordinary `current -> repos` convenience link beside them, `current/api` is a plain directory nobody spelled. Measured with the built CLI over two clone-mode repositories at `./repos/api` and `./repos/web` under one config directory, that link beside them, `api` holding an `.env.local` reading `API_SECRET=leaked`, and the patterns `**/.env.local` and `*/*/.env.local`: initializing `web` against the previous behaviour reported `Copied 3 file(s) to 'main': .env.local, repos/api/.env.local, current/api/.env.local`, `git status` in the new clone showed `?? current/` and `?? repos/`, and both copies of the file carried `API_SECRET=leaked`. So every directory the walk reaches is now canonicalized, whatever chain of names led to it, and matched against the canonical exclusions; the same run reports `Copied 1 file(s) to 'main': .env.local`. A `worktreeDir` that is itself a symlink onto another disk is caught by the same canonical rule — the walk resolves the link and matches the canonical exclusion on the far side of it. The name the config file spelled is kept for a different and narrower case: an excluded name spelled inside the source that resolves to an ancestor of the source. Canonicalizing that entry would name a directory containing the source, which is dropped on purpose because honouring it would silence the whole copy, so there the spelling is the only thing holding the walk out.

  The comparison is over path segments rather than glob patterns, so a checkout whose directory name would otherwise read as a pattern — `{a,b}`, `feature[1]`, `a*b` — excludes exactly itself and no other directory. It is also exact rather than a prefix: excluding `api` leaves `api-v2`, `api.old` and `apiX` readable.

  A `Config` assembled by hand rather than loaded from a config file has no repository list to consult; it falls back to its own `worktreeDir` and `bareRepoDir`, and still excludes the destination and every directory in the name-based list above.

- cf3dfe0: Moving a worktree to trash no longer runs `du` over it while the repository lock is held. `manifest.sizeBytes` was filled by shelling out to `du -sb` across the whole worktree — `node_modules` and all — before anything was created or moved, inside the exclusive repository operation that prune, orphan and diverged-replace removals run in: for as long as that scan took, a scheduled sync or an MCP call was refused with "another repository operation is already in progress" and an interactive action queued behind it. The scan also sat between the HEAD commit the entry records and the re-verification of that HEAD, so every second of it was a second in which an ordinary commit in the worktree would abort the removal.

  Measured on a four-core Linux 6.18 container, ext4, against a tree of four copies of an installed pnpm `node_modules` plus a 2,000-file source tree — 95,654 paths as `find | wc -l` counts them, 77,328 of those regular files, 927,017,592 bytes by `du -sb`. One scan through `fast-folder-size`, which execs `du -sb`, took 808, 826, 895 and 929 ms across four runs with the page cache dropped, and 181–184 ms across three warm runs. The `fs.rename` that actually performs the move took 0.027–0.081 ms on the same tree. Those figures belong to that filesystem and that page cache; a dependency tree of several hundred thousand files, or one on a network volume, scans for correspondingly longer — and a tick that prunes forty such worktrees paid the scan once per worktree, three at a time, with the lock held throughout.

  The size is informational: the accumulated-trash warning (`trash.warnSizeBytes`) and the force-clean confirmation's byte total are its only readers, and no removal, restore or reap consults it. So it is now measured where nothing holds the repository lock — at the tail of a sync, once its exclusive operation has released it, and while the force-clean confirmation is being built, which happens outside the repository mutex — and the move itself writes `sizeBytes: null` without scanning anything. The sync still awaits the measurement rather than detaching it, so it finishes inside the tick it belongs to and before the reaper or the next tick can run; what it no longer delays is any other caller. An entry whose payload cannot be scanned stays `null`, and no consumer counts that as zero: `sync-worktrees trash` has never printed sizes, the force-clean confirmation counts unknown-size entries next to its byte total, and the accumulated-trash warning, the one reader that used to add unmeasured entries in as zero, now reports its total as a floor and names them: `Trash holds at least 4.2 GB across 12 entries, plus 2 not yet measured`. That last line is the one visible consequence of the move. The warning is raised inside the same tick that does the trashing, so the entries that tick added are still unmeasured when it totals them up and only start counting from the next tick; the wording makes that visible rather than silently under-stating the total, and the threshold itself is still compared against measured bytes only, so the lag can delay a warning but never raise a false one.

- cf3dfe0: A clone-mode sync tick now decides what it is going to do before it reads the working tree, which changes both what a tick costs and what it reports. The order used to be fetch, then `git status` over the whole checkout, then the ref comparison that establishes whether there is anything to merge at all — so every tick paid for an index refresh and an untracked-file walk of the entire clone (the one command in a tick whose cost grows with how many files the checkout holds, and it runs while the tick holds the repository lock) before finding out, from two ref reads (`rev-parse HEAD` and `rev-parse refs/remotes/origin/<branch>`), that the clone was already at `origin/<branch>` and nothing was going to be written. The tick now classifies first — including the shallow deepening budget — and reads the tree only on the one path that writes to it, the fast-forward. A repository with `sparseCheckout` configured is the exception: the narrowing-safety check still reads the tree ahead of the classification, and only on a tick where the pattern set both needs updating and the update narrows, because that check has to run whatever the relationship turns out to be. Counted with `GIT_TRACE` over a second `--runOnce` run of a full, non-sparse clone-mode repository against a local `file://` remote with nothing new to fetch, the run's git processes go from 21 to 20 and the one that goes is `git status --porcelain -b -u --null`; the count is a whole run-once process over one repository, so it also carries the init's probes, git's own `maintenance run --auto` and the local remote's `upload-pack`.

  The user-visible half is what a dirty clone is called. A clone with uncommitted or untracked work that is already at `origin/<branch>` has nothing to merge, but the tree was asked first, so it was reported as a `dirty_tree` skip: the run summary listed the repository under `⚠️  Clone-mode skips` with the reason `working tree has local changes` and counted it as "with clone-mode skips" rather than synced, the TUI logged a clone-mode skip, and the MCP `sync` result carried a `clone_dirty_tree` entry — every tick, for a repository that needed nothing done to it. It is now reported as up to date, like the same clone without the edits. A dirty tree that would otherwise fast-forward is still refused, still as `dirty_tree`, and the merge is still gated on a status scan taken immediately before it. A dirty clone that is ahead of, or diverged from, `origin/<branch>` is now reported as `ahead_unpushed` / `diverged`, which is the thing the user has to resolve, instead of having the dirty tree reported over it. Nothing is lost by not scanning on the paths that return early: none of them writes to the working tree, and a detached HEAD or a branch switched underneath the tool is still caught by the branch check the tick opens with. One cost moves the other way: a shallow clone too short to classify now spends its deepening budget on a tick whose tree turns out to be dirty, where before it stopped at the tree — that is the same budget a clean tick in the same state already spent, the history it buys is kept by the ratcheted fetch cap, and it is what turns "working tree has local changes" into the skip that names `depth` as the remedy.

  A sync that performs the clone itself no longer follows it with a sync attempt: the clone came from `origin` at the tracked branch, so the fetch and classification behind it had nothing to add. This applies to the sync that does its own initialization (the MCP `sync` tool on a repository that has not been initialized yet, and any embedder calling `sync()` directly); a standalone `initialize()` followed by a separate `sync()` — the run-once CLI and the TUI — still runs the tick, because a flag carried across that boundary cannot tell a sync a second later from one an hour later, and a sync that silently does nothing is the worse defect. With the reorder above, what those callers pay for that tick is one no-op fetch rather than a full scan of the tree they just checked out.

- cf3dfe0: The TUI branch-creation wizard now pre-selects and labels the branch a clone-mode repository actually tracks, instead of always claiming `main`. The wizard asked `InteractiveUIService.getDefaultBranchForRepo` for the default branch, which read `GitService`'s own default — a constructor constant that clone mode never updates, because `GitService.initialize()` only runs in worktree mode. A clone-mode entry configured with `branch: 'develop'` (or with no branch and a remote whose HEAD is `master`) therefore got `main` pre-selected in the picker and marked `(default)`, so a user who accepted the highlighted entry created the new branch from the wrong base — and the clone-mode fix released alongside this one publishes that branch to the remote, so the wrong base no longer stays local. The accessor now delegates to the clone-aware `WorktreeSyncService.getDefaultBranch()`, which returns the configured branch or resolves the remote's HEAD once and caches it; it is `async` because that resolution can need the network, and the wizard already awaited its branch list in the same place, so nothing new is awaited during a render. A resolution that fails now costs only the pre-selection and the `(default)` marker: it is caught separately from the branch listing, so the list stays on screen with the first entry selected and the reason is logged, instead of the whole picker collapsing to "No branches found".
- cf3dfe0: Switching a shallow clone-mode repository to a branch whose remote counterpart has moved past the configured `depth` no longer fails with "Cannot fast-forward branch". The switch used to run its own shortened relationship check whose only verdicts were "can" and "cannot", so a `depth: N` clone — whose `--depth N` fetch cuts the history under a tip the remote moved more than N commits past — read `merge-base`'s silence as a divergence and refused a switch that was a plain fast-forward, leaving the user to guess that raising or removing `depth` was what would converge it. It now asks the same classifier a sync tick asks (about `refs/heads/<branch>`, since the branch is not checked out yet) and spends the same deepening budget (50/200/1000 commits, stopping at the first decisive answer) before deciding: a real divergence or unpushed local commits still refuse the switch, and a clone still too shallow to tell after the whole budget now says so — naming `depth` as the remedy — instead of blaming the branch.
- cf3dfe0: A clone-mode sync tick no longer rewrites `.git/config` twice and lists every remote-tracking ref on its way past. Every tick converged the remote unconditionally — `git config --replace-all remote.origin.fetch`, `git config --replace-all remote.origin.tagOpt --no-tags`, then `git for-each-ref refs/remotes/origin` — for values that had not moved since the clone. `git config --replace-all` is not a no-op when the value is unchanged: it writes a fresh `config.lock` and renames it over the file, so `.git/config` lands on a new inode with a new mtime every time (git 2.43), which is a file change every backup and file-sync tool watching the repository has to pick up, and a `config.lock` every concurrent `git config` of the user's has to lose a race to. Nothing in the tick needed the write: the sync fetch passes its refspec on the command line, and the one fetch that consults the stored refspec — the `--unshallow` that runs when `depth` is removed from the config — runs before that call, so it reads what the previous tick converged either way. The tick now reads both keys in a single `git config --local -z --get-regexp` and writes only what has drifted.

  Measured over one `--runOnce` process against an already-cloned clone-mode repository on a local `file://` remote with nothing new to fetch — one `initialize` plus one sync tick, with a PATH shim recording each git argv and stat-ing `.git/config` around every command: 17 git processes and 4 config rewrites before, 14 processes and no rewrite after. The tick's own share of that goes from three processes to one, per repository per tick.

  The read is written so that only a positive match may skip a write, because it cannot be told apart from a failure. `git config` reports a key it does not hold with exit code 1 and an empty stderr, and simple-git rejects a command only when the exit code is non-zero _and_ stderr is non-empty — so "the key is unset" arrives as the empty string, exactly as a read that failed silently would. An empty answer, a rejection, a missing key, an unexpected value, and a second value for `remote.origin.fetch` all converge the config; reading wrong costs one redundant write, never a clone left un-narrowed. The check also stays in the tick rather than moving to startup, for the same reason the origin URL is re-checked there: a daemon holds one clone for weeks, and `git remote set-branches --all` or an editor is enough to widen a refspec that was converged at adoption.

  The stale-ref sweep now runs only where it can find something. It runs on the call that narrows the refspec — the refs a wide refspec fetched are precisely what it deletes — and before that call's write rather than after it, so a process killed between the two leaves the wide refspec that makes the next tick redo both. It also runs unconditionally when a clone is adopted at startup, where the directory came from outside and a refspec that already reads narrow says nothing about the refs lying next to it, and the clone-mode branch wizard now deletes the `origin/<base>` ref its own base-branch fetch created, in the call that created it, instead of leaving it for a later tick. What is no longer swept: remote-tracking refs that appear in an already-narrowed clone out of band — a user's own `git fetch` with a wide refspec between two ticks — which now survive until the next adoption, branch switch or refspec drift instead of being deleted within the minute. The tick's own fetch is `--prune` with a single-branch refspec and can neither create nor prune any other `origin/*` ref, so there was nothing else for a per-tick sweep to find.

- cf3dfe0: Clone mode now deletes the remote-tracking refs a wider refspec left behind in batches instead of one `git update-ref -d` process per ref. The sweep runs when a clone is adopted from outside and when the fetch refspec is narrowed to the tracked branch — a legacy all-branches clone (`git clone <url>` without `--single-branch`) therefore starts with one `refs/remotes/origin/*` ref per remote branch, all of which `fetch --prune` is powerless to remove once the refspec no longer matches them. Each deletion was a separate git process, awaited in turn, inside the repository lock, so the cost was a spawn per branch on the first sync and again on every branch switch away from a wide-refspec state. The refs now go out as `git branch -r -D` naming up to 200 of them per process. Measured with a Node script issuing the same `raw()` calls through simple-git 3.36 against a local repository holding 3,000 stale packed remote-tracking refs (git 2.43.0, Node 22, Linux): 3,000 git processes and 168 s before, 15 processes and 0.51 s after. The serial shape is dominated by process startup on that host (~56 ms per delete), so the absolute numbers belong to the harness — what the change removes is the per-ref process, which is what scales with the branch count.

  The sweep stays best-effort, and the deletion command is chosen for that rather than for looking like a batch. `git update-ref --stdin`, the obvious way to pipe deletions into one process, is a single transaction: measured on git 2.43.0, one ref whose lock is held by another git in the same clone ends it with exit 128 and **nothing** deleted, so a single unremovable ref would have turned the whole sweep into a silent no-op — worse than the loop it replaces, which deletes every other ref and leaves that one. `git branch -r -D` was measured on git 2.43.0 to remove what it can and name what it cannot, but that is not portable: on git 2.55.0 the same batch, with the same held lock, removes nothing at all. Rather than depend on either, a batch git refuses is retried one ref at a time, which costs the old per-ref spawns only on the batch that failed and leaves exactly the refs git genuinely refuses, on every version. (simple-git 3.36 cannot write a child process's stdin in any case — no `stdin` option, `outputHandler` exposes stdout and stderr only, plugins are built internally from known config keys, and `spawnOptions` is typed down to `uid`/`gid` — so `--stdin` would have meant spawning git outside the client factory, past the sanitized environment and past the primary-checkout guard every write in clone mode goes through.)

  What the sweep protects is unchanged: `refs/remotes/origin/HEAD` and the tracked branch's own ref are never named in a deletion, refs are only ever shortened from the `refs/remotes/origin/` prefix they were listed under rather than rebuilt from a branch name, a batch git refuses is retried per ref and does not stop the batches after it, and a failed batch is now reported at debug level instead of vanishing silently.

- cf3dfe0: `debug` now breaks a clone-mode sync tick into phases in its "Performance Summary" table. The table was built from a timer that only the worktree-mode runner was ever given, so a clone-mode repository printed a single `Total Sync` row: a tick that took a minute said a minute and nothing about where it went — the fetch, the `git status` scan of the checkout, a deepening fetch on a shallow clone, or the fast-forward merge itself. The tick is now handed the same timer, and prints the same table in the same format worktree mode does: `Phase 1: Validate` (the branch, origin and primary-checkout guards), `Phase 2: Unshallow`, `Phase 3: Remote config` (which is also where a wide refspec's stale remote-tracking refs are swept), `Phase 4: Fetch`, `Phase 5: Verify ref`, `Phase 6: Sparse`, `Phase 7: Classify`, `Phase 8: Status`, `Phase 9: Merge`.

  A phase has a row if and only if it ran on that tick. Because a tick classifies before it reads the working tree, the common up-to-date tick ends at `Phase 7: Classify` and prints no `Phase 8: Status` row at all, and `Phase 6: Sparse` appears only where `sparseCheckout` is configured — the same way worktree mode prints no update phase when `updateExistingWorktrees` is off. The phase numbers are fixed labels rather than positions in the printed table, so a phase that did not run leaves a visible gap instead of renumbering the rows under it; the alternative, a zero-duration row, would read as a scan that happened and cost nothing. Time no phase claims is left unattributed rather than folded into a neighbour: each phase is bracketed so that an early return, a skip or a failure closes it where it ended. The deepening fetches a shallow clone spends before it can classify are counted on the classify row (`Phase 7: Classify (2)`) rather than split off as a phase of their own, because they interleave with the classification reads they exist to feed. One caveat where a sync is more than one tick: a retried sync reuses the one timer, as worktree mode's already does, so a phase reached again shows the last attempt's duration, a phase reached only earlier keeps the duration it had then, and `Total Sync` spans every attempt and the backoff between them — the rows are per-phase bests-effort there, not a partition of the total.

  This is instrumentation and nothing else: the tick runs the same commands in the same order whether or not a timer is passed, and spawns no git process it did not spawn before. What `debug` gates is the rendering, not the measuring. `sync()` builds the timer and hands it to every tick it runs, so each phase a tick reaches costs two `Date.now()` calls and one `Map` entry no matter which caller asked for the sync — the CLI, the MCP server or the TUI — and only under `debug` is the table built and printed. The TUI is included in that: it collects service log output through an output function, and a printed table goes through the same one, so a TUI run with `debug` on shows this table in its log panel. The one caller that can opt out is an embedder calling `CloneSyncService.runSyncAttempt()` directly, where the timer argument is optional and every phase bracket is then a plain call.

- cf3dfe0: A managed worktree left on a detached HEAD (after `git checkout <sha>` inside it) is now reported as a skipped worktree instead of being logged and counted as a freshly created one on every sync.
- cf3dfe0: LFS verification no longer sleeps up to 30 seconds per created worktree: `git worktree add` (and `git clone`) return with their checkout finished, so the files are read once and a single actionable warning names the worktree instead of a wait that could never change the answer — a first sync of 100 branches whose LFS content stayed pointers cost ~50 minutes of sleeping. Verification is also skipped entirely when `GIT_LFS_SKIP_SMUDGE` is exported in the environment (pointers are then expected) and when HEAD's `.gitattributes` declare no `filter=lfs`, and a machine without git-lfs is probed and warned about once per process rather than once per worktree.
- cf3dfe0: Worktree mode now recovers from a `bareRepoDir` left without a HEAD by an interrupted initialization: it is removed and cloned again instead of failing every later run with git's "destination path already exists and is not an empty directory". Only a directory sync-worktrees verified and claimed for its own clone can be removed this way; a destination that already holds something else, or that cannot be inspected, is never touched and is named in an actionable error.
- cf3dfe0: Trashing a branch's worktree no longer leaves the branch's `[branch "<name>"]` section behind in the bare repository's config. Since the removal pipeline started deleting the branch ref with a compare-and-swap — `git update-ref -d refs/heads/<branch> <oid>`, so a commit that lands while the worktree is being trashed keeps its branch instead of being orphaned — the deletion stopped going through `git branch -D`, and with it stopped removing the branch's config. The two are not equivalent, measured on git 2.43.0: after `update-ref -d refs/heads/feat <sha>` succeeds, `branch.feat.remote` and `branch.feat.merge` are still in the config file, while `git branch -D feat2` removes the whole `[branch "feat2"]` section, non-upstream keys (`branch.feat2.description`, `branch.feat2.rebase`) included. Worktrees are created with `git worktree add --track`, which writes those two keys, so every pruned branch worktree stranded a section of at least three lines — four under `branch.autoSetupRebase = always`, more if anything set `branch.<name>.description` — and nothing swept them. A repository that prunes merged branches steadily accumulates them: the sections are only ever reused if the identical branch name comes back, and every git process the tool spawns against the bare repository parses the file. They also made a later restore of the same branch name inherit an upstream from the branch's previous life when `origin/<branch>` is gone and the restore's own `--set-upstream-to` cannot run.

  The compare-and-swap delete now follows a successful deletion with `git config --remove-section branch.<name>`, which is what `git branch -D` does internally. Three things about how it is done:

  - It runs **only after** the delete succeeded. A compare-and-swap that git refuses because the ref moved rejects first, so a branch that is still live keeps its upstream. This is the case the compare-and-swap exists for and it is covered by a test.
  - It **cannot fail the removal**. Git reports `--remove-section` on a section that is not there as a hard failure — exit 128 with `fatal: no such section: …` on stderr, which simple-git rejects rather than resolving — and a branch can legitimately have no section (`--no-track`, or a config that was cleaned by hand). Any failure is swallowed and logged at debug level; a leftover section is untidiness, never a reason to report a branch deletion that did succeed as failed. Nothing parses git's output or exit code, so a git version that words or numbers that failure differently changes nothing.
  - It addresses **exactly one section**. `git config --remove-section` splits its argument at the first dot and treats the entire remainder as the subsection name, so a branch called `v1.2` removes `[branch "v1.2"]` and leaves a sibling `[branch "v1"]` alone — verified on git 2.43.0, and pinned by a test with both branches present.

  Sections already accumulated by earlier versions are not swept retroactively; they are removed the next time a branch of that exact name is trashed, and can be cleared by hand with `git config --remove-section branch.<name>` in the bare repository. The other places the tool deletes a local branch by name — restore rollback, diverged-replace, the rollback of a failed worktree add, and the clone-time copy sweep — go through `git branch -D` and were already removing their config sections. There is one other compare-and-swap delete of a local branch, the rollback of a failed branch-create push in clone mode, and it needs no cleanup for a reason worth stating: that branch is created with `git branch --no-track`, which writes no config at all, and the `-u` on the push that follows only records an upstream when the push succeeds — in which case the rollback never runs.

- cf3dfe0: Adopting a pre-trash `.diverged/` backup into the trash now releases the permanent keep ref that used to hold it, instead of leaving two permanent refs behind for the same commit. When trash is disabled, a diverged worktree is moved to `.diverged/<name>` and its never-pushed HEAD is held by `refs/sync-worktrees/keep/<name>`, recorded in the backup's `.diverged-info.json`. Turning trash on adopted the directory as a keep-on-reap trash entry with its own pin ref and bundle, but never looked at that field: the old keep ref stayed, referenced by nothing, and `sync-worktrees trash` listed both the entry and `KEEP <name>`. At expiry the reaper minted a second permanent ref, `KEEP <trash-id>`, for the same commit — so one preserved worktree ended up needing two `--dropKeepRef` runs, each with its own typed confirmation, to clean up after.

  The legacy ref is released only after the adoption has resolved, which is the first moment the replacement protection is durably on disk: the entry's pin ref, and a bundle of the commits whenever they are not already on a remote. Every failure inside the adoption — the pin ref, the bundle, the manifest, the move into the trash container — puts the backup back in `.diverged/` and leaves its keep ref exactly where it was, so the next sync retries the whole adoption with nothing lost. A deletion that git refuses is reported with the ref name and how to drop it by hand, and does not turn a successful adoption into a failed one.

  `.diverged-info.json` is an unvalidated `JSON.parse` of a file anyone can edit, so its `keepRef` is never the authority for what gets deleted: the ref name is re-derived from the entry's own manifest and the recorded one has to match it exactly. A `keepRef` naming a branch, another entry's keep ref, or a path traversal that merely starts with `refs/sync-worktrees/keep/` is left alone and reported.

  The adopted payload's own copy of `.diverged-info.json` is rewritten to describe where the backup actually went. Its discard step named the TUI worktree status view, which lists `.diverged/` directories only and so no longer showed the entry at all. It now names `sync-worktrees trash --restore <id>` for getting the files back, and says what discarding actually takes: an adopted backup is a keep-on-reap entry, so only its files age out with the retention window — the commit is held by the entry until then and by a permanent `keep/<id>` ref afterwards, which `sync-worktrees trash --dropKeepRef <id>` releases. It also records the trash id and clears the keep ref it no longer has. Only the fields the tool itself wrote are touched — everything preserved from the worktree is left as it is.

  One window remains: a process killed between the adoption and the ref release leaves the old keep ref behind, exactly as before this change. Nothing is lost by it, and `sync-worktrees trash --dropKeepRef <name>` still removes it.

- cf3dfe0: Force clean no longer runs `git gc --prune=now` over the object store every worktree shares. Its confirmation said "Active worktrees are not synced, changed, or removed", which was true about the files and false about the store behind them: `--prune=now` honours no grace window, so objects a concurrent `git commit` had written but not yet anchored to a ref were fair game. Hammering commits in a worktree against a `--prune=now` loop in the bare repo (git 2.43.0) failed 148 of 150 commits, produced `unable to write file .../objects/8c/6cf40…: No such file or directory` when the prune removed a fanout directory mid-`git add`, and left the repository permanently broken — a commit whose tree had been pruned, so `git status` in the worktree answered `bad tree object HEAD` and every later `gc` aborted. The same stress with a grace window corrupted nothing; its only failures were `cannot lock ref 'HEAD'`, a ref-packing race that aborts a commit and loses nothing, and that appears regardless of prune policy — between 0 and 21 of 150 across runs. Two changes: the forced `gc` now prunes on a one-hour grace window unless `maintenance.aggressive` opts into `now`, and each worktree's admin directory is checked for `index.lock` and for an unfinished merge, rebase, cherry-pick, revert or bisect just before the `gc` — if any is found the `gc` is skipped, the result line reads `GC skipped` rather than `GC failed`, and the errors name the worktree. What the window costs in reclamation depends on how the objects are stored, because git measures prune expiry from the mtime of the file currently holding an object — not from the age of the commit, and not from when it stopped being reachable. Loose objects carry their own mtime, so dropping a recovery ref that was pinning three-day-old loose commits still reclaims them on the same run. Packed objects inherit their pack's mtime, and a repack resets that clock for everything in the new pack: with the same three-day-old commits in a pack written half an hour ago, `--prune=now` freed 300 KB where the grace window freed none and the store grew slightly. Force clean packs, and so does `gc.auto` after someone's commit, so a second force clean inside the hour is the realistic case. It is a deferral rather than a forfeit — the next maintenance run past the window collects them, and cruft-pack mtimes are per-object and are not refreshed by repeated gc, so nothing is pinned indefinitely. Purging the trash entries and recovery refs is unchanged and still happens even when the `gc` is held back. The check is a point-in-time probe, not a lock — it catches a command already running or an operation someone walked away from, and cannot stop one that starts a moment later — so the confirmation now asks you to finish any git command running in a worktree first.
- cf3dfe0: A trash manifest whose `branch` or `headOid` has been hand-edited or corrupted into something option-shaped can no longer be handed to git as an option. Both fields reach git as positional arguments during `sync-worktrees trash --restore <id>` — `git branch <branch> <headOid>`, then `git worktree add --no-checkout <path> <branch>` — and git permutes its arguments, so a value that starts with a dash is read as a switch wherever it sits. Measured on git 2.43.0 in a bare repository whose HEAD is `refs/heads/main`: `git branch -m <sha>` and `git branch <name> -m` both run `git branch -m`, renaming `main` to the other argument and taking HEAD with it, after which every sync fails to find the default branch; `git worktree add --no-checkout <path> --force` and `… --lock` succeed on a brand-new branch named after the directory rather than on the branch that was asked for, `… --detach` succeeds with no branch at all, and `git update-ref <keepRef> -d` — the reaper's keep-on-reap promotion — deletes the ref it was asked to create. `git branch` refuses to create a name that starts with a dash, and real object ids are hex, so only a tampered or truncated manifest gets here — though note that git's ref-format rules themselves do not forbid a leading dash, so a remote really can carry `refs/heads/-foo` and a fetch really will bring it across. That is the same threat model the manifest's pin-ref check was already written against.

  Two defences, which overlap rather than each standing alone — the separator covers the wrappers restore and the reaper call, the validation covers every reader of the field:

  - **The manifest is validated when it is read.** `branch` must now be a name git itself would accept and `headOid` must be hexadecimal, alongside the shape checks the other fields already got. The branch rule is deliberately no stricter than git's own, and it is spelled out independently rather than borrowed from the stricter validator this tool applies to names a user asks it to create — reusing that one rejected any component ending in a dot, so `v1./x`, `a./b` and `release-1.0./rc`, all names `git branch` creates and a fetch can carry in from a remote, would have had their entries stranded. Measured against `git check-ref-format --branch` on git 2.43.0 over more than a thousand names — ordinary names, unicode, every ref-format edge case, and random strings built from the characters git treats specially — the rule agrees with git on all of them except `HEAD`, which git refuses and this accepts: erring wide there costs only a clearer error from git itself, while erring narrow costs an entry. `feature/x.y`, `release-1.0`, `v1./x`, deeply nested names, non-ASCII names and very long names all keep restoring.
  - **The git wrappers pass `--` before their positional refs.** `git branch -- <name> <sha>`, `git branch -D -- <name>`, `git worktree add --no-checkout -- <path> <branch>`, `git update-ref -- <ref> <oid>` and `git branch --set-upstream-to=<u> -- <name>` — each verified to accept the separator on git 2.43.0, where it turns each of the cases above into a refusal (`not a valid branch name`, `not a valid object name`, `invalid reference`) with `refs/heads/` untouched. For `git branch -D` this is hardening only: no single option-shaped argument was found that makes it delete anything it was not asked to, and the separator changes only how the failure reads.

  A manifest that fails the new checks is reported as an invalid entry — the same treatment as any other unparseable manifest — which means it is left alone rather than restored, and also means it is never listed or reaped, so its container stays on disk and its pin ref keeps holding objects until someone removes the container by hand. Both `sync-worktrees trash` and the reaper name the container's path when this happens. The tool itself does not write such a manifest, and the writers are now held to the reader's rule rather than merely assumed to agree with it: adoption of a legacy `.diverged/` backup now holds that directory's `.diverged-info.json` — an unvalidated file a user can edit — to the same two rules, and leaves a backup that fails them in `.diverged/`, where its legacy keep ref still protects its commits, instead of adopting it into an entry nothing would ever come back for.

- cf3dfe0: Reaping a trash entry that was pinned to keep its commits now asks once more whether a permanent `refs/sync-worktrees/keep/<id>` ref is still needed, and `sync-worktrees trash` gains `--dropAllKeepRefs` to clear the ones that are.

  The pin is promoted to a keep ref because, when the worktree was pruned, its HEAD commits were on no remote. Thirty days later that can be false — the branch was pushed again, or the commits reached one that was — and the reaper now re-asks with the same primitive the entry's own bundle was decided on (`git rev-list --count <headOid> --not --remotes`, now one `GitService.countCommitsNotOnAnyRemote` shared by both callers). A clean zero skips the ref; everything else mints it, including a rev-list that failed, an oid git cannot resolve, and a count that could not be parsed — the method throws on unparseable output rather than letting it read as zero.

  The re-check is deliberately narrow and **does not stop keep refs accumulating**. A squash or rebase merge puts the branch's content on the default branch as a _new_ commit, so the originals stay reachable from no remote ref: measured against real git, a two-commit branch that is squash-merged, deleted on the remote and then fetched with `--prune` still counts 2, and still earns a permanent ref. What the re-check skips is the entry whose own commits are on a remote again — measured at 0 once the same commits are pushed under another name.

  That question is now asked of `origin`'s remote-tracking refs specifically rather than of every `refs/remotes/*` ref the repository happens to hold. `git fetch --all --prune` only prunes remotes that are still configured, so a `refs/remotes/<name>/*` left behind by a remote the user has since removed survives every fetch and still anchors its commits: measured, the count reads 0 with such a ref present and 2 once it is deleted, which would have released the only anchor for commits no remote actually has. The same narrowing applies to the bundle written for a keep-on-reap entry, where it can only mean bundling more than strictly necessary.

  A zero is only acted on when the remote-tracking refs are current, because a ref `fetch --prune` has not dropped yet keeps its commits reachable: measured, the count reads 0 for a branch already deleted on the remote and flips back to 2 after the next pruning fetch. The sync runner therefore reports whether _this_ attempt's `fetch --all --prune` completed, and the reaper releases nothing without it — a failed fetch, or the LFS fallback that fetches branch by branch and so prunes only the branches it names, mints the ref exactly as before. Called without that signal the reaper behaves as it always did.

  No automatic expiry was added either. A time-to-live on keep refs would make commits that are on no remote gc-eligible on a timer, in the background, with no confirmation — the opposite of how every other destructive path here behaves, and these are the commits the whole mechanism exists to protect.

  `--dropAllKeepRefs` lists the keep refs, takes one typed confirmation naming the count, and deletes the set it listed. Refs a `.diverged/` directory still relies on are retained and named, refs minted while the confirmation was on screen are left alone, and a ref git refuses is reported without stopping the rest. That last point is why the deletions are not one `git update-ref --stdin` batch: `--stdin` is a single transaction, and on git 2.43.0 a stray `.lock` on one ref of a ten-ref batch left all ten in place, which would turn "999 dropped, 1 locked" into "0 dropped". (simple-git 3.36 cannot write a child process's stdin in any case.) What that costs is worth stating exactly, because the shipped path is slower than a raw spawn: simple-git adds a fixed 50 ms wait to every git command that prints nothing, and `update-ref -d` is one. Measured on this container, git 2.43.0, 2,000 loose refs: 55 ms per ref through the git client the tool actually uses (about 111 s for 2,000), against 3 ms per ref for a bare `child_process` spawn and 0.27 s for one `--stdin` batch; the 4,000 fsync'd audit records add roughly 2 s. So this is not a cheap loop — the case for it is that a user with 2,000 refs to drop would rather wait and have 1,999 of them gone than finish instantly with none. The flag's real value is one confirmation instead of 2,000, not speed, and the 50 ms tax is a property of every silent git command this tool runs rather than anything specific to dropping refs.

  Not added: an age-based drop. Nothing records when a keep ref was minted — `for-each-ref`'s `creatordate` is the _commit's_ date, and `git gc` runs `pack-refs`, which deletes the loose ref files, so their mtimes do not survive one maintenance window. An `--older-than` flag would have to invent the age it filters on.

- cf3dfe0: `sync-worktrees trash --restore <id>` now moves the trashed payload back into the recreated worktree instead of copying it there and then deleting it. Restore registered the worktree with `git worktree add --no-checkout`, copied every preserved file into the directory git had just made — `node_modules` and build output included — and then deleted the payload it had just copied from, so a restore did the work twice over and needed free space equal to the payload, all of it under the repository lock that makes concurrent syncs skip. It now takes the `.git` link the registration wrote, corrects the payload's own stale link in place, replaces the fresh directory with the payload in a single `fs.rename`, and resets the index — the effect the README's manual recipe describes, in constant time. Measured on this repository's own `node_modules` (282 MB, 23,412 entries) across several runs on one machine, the copy took 9–13s and deleting the payload afterwards another 0.8–0.9s; on a tree three times the size (70,239 entries), 28–37s and around 2s. The rename is under a millisecond at either size, and git is unbothered that the directory under its registration was replaced, because its admin directory addresses the checkout by path rather than by inode.

  The payload's link is corrected before the move rather than after, which costs the same one rename and removes a window that the copy never had: a process killed between the rename and a later rewrite would have left a worktree describing itself with a link to a pruned admin directory, or with no link at all, and a trash entry whose payload had gone. Now a crash before the rename leaves the payload whole in its container, and a crash after it leaves a complete worktree.

  The copy stays as the fallback for the case that still needs it. The trash root lives under `worktreeDir`, so payload and destination normally share a filesystem, but a bind mount or a symlinked `worktreeDir` can split them; an `EXDEV` rename falls back to the same symlink-preserving copy as before. A restore that fails after the move — the index reset, the sparse profile — returns the payload to its container by the reverse rename, so a failed restore still leaves the trash entry intact and restorable. If that return is impossible too, nothing is rolled back, because removing the worktree would delete the only copy of the files: the error names the directory they are in and the one command that finishes the job.

- cf3dfe0: A long-lived process (cron daemon, TUI, MCP server) now recovers when the default branch's worktree is deleted out-of-band: every sync re-checks that directory and rebuilds it before fetching, instead of failing forever with `spawn git ENOENT`, and a fetch that does hit a deleted working directory now names it.
- cf3dfe0: Cover trash restore and force clean against real git, and pin the manifest fields older releases never wrote.

  Restore and force clean were tested almost entirely through stubs, so the only evidence that either works was the shape of the calls they made. Two new e2e suites now run them against a real repository and a real garbage collector, and a third set of fixtures covers the manifests older releases wrote:

  - `src/__tests__/e2e/trash-restore-after-gc.e2e.test.ts` prunes a worktree into the trash through the real removal pipeline, runs `git gc --prune=now` in the bare repository, and then restores. With the branch ref deleted and the remote-tracking ref pruned, the trash pin is the only thing reaching the trashed commit, so the test fails if the pin is released before the entry is restored (verified: releasing it at the end of `trashDirectory` leaves the commit collected). After the restore it asserts the worktree is registered in `git worktree list`, is on the pinned commit and its own branch, reads as clean (dropping `resetWorktreeIndex` leaves staged deletions, verified), and still holds the gitignored payload git would never have checked out. Swapping `addWorktreeNoCheckout`'s arguments fails the test.
  - A second case covers the other direction: when the pinned commit is gone from the object store, the restore is refused before anything moves — no directory at the destination, no registration, and the payload still whole in the container. A restore that silently degraded to a files-only move in that case fails it.
  - `src/__tests__/e2e/force-clean-object-reclaim.e2e.test.ts` runs the whole force-clean sequence — purge, keep-ref sweep, gc — against a real object store and asserts on the objects as well as the counts — two of the regressions below pass every count and are caught only by the object checks. Under `maintenance.aggressive`, which is what makes the collector prune immediately rather than on the default one-hour grace, the purged entry's commits are gone afterwards, a keep ref with no `.diverged/` directory is deleted and its commits collected, and the keep ref whose `.diverged/` backup is still on disk survives both the sweep and the collector with its commits intact. Losing the `.diverged/` reservation, retaining every keep ref, or minting a replacement keep ref during the purge each fail it.
  - `trash.service.test.ts` gains fixtures for manifests written before `bundleFile`, `legacyQuarantinedAt` and `keepPinOnReap` existed — keys an older release left out of the file entirely — plus one in the full pre-namespacing shape (flat pin ref, and none of those keys nor `replacedAt`) that must still list and still restore. Refusing any of those absences would make every entry inherited across an upgrade unlistable, unrestorable and unreapable while its pin ref held the objects forever; removing any one of the three tolerances now fails exactly these tests and nothing else. Also pinned: a restore that fails partway must leave the pin ref alone, since the entry it leaves behind still names that ref as the way back.

  Tests only; no behaviour change.

- cf3dfe0: Unknown keys in a config file are now reported instead of dropped in silence. `validateConfigFile` only ever inspected keys it recognised and `resolveRepositoryConfig` only ever copies keys it recognises, so a repository carrying `updateExistingWorktree` — the plural dropped — loaded clean, lost the setting, and the reference checkout it was meant to freeze went on being fast-forwarded every tick with nothing said. Measured before the change: the key is absent from the resolved repository and the loader writes nothing to stdout or stderr. The same held for `branchIncludes`, `sparseCheckOut`, `maxAge` and `retries`, for an unknown key under `defaults` or at the top level, and for one inside a nested block — `retry: { maxAttemptz: 5 }` was carried into the merged retry config and then ignored by the retry machinery.

  After the known-key validation the loader now compares every key against an inventory of the real ones and warns per key, naming the repository (or `defaults`, or the top level), the key, and the nearest known name when there is one: `Unknown config key 'updateExistingWorktree' in repository 'reference' is ignored (did you mean 'updateExistingWorktrees'?)`. It reaches one level down, into `retry`, `parallelism`, `sparseCheckout`, `trash`, `maintenance` and `hooks`, which is as deep as the config surface goes. A key that is present with the value `undefined` is a present key, not an unknown one, so the `{ maxStatusChecks: Number(process.env.X) || undefined }` shape is unaffected.

  This warns and refuses nothing: a config carrying a stray field has always loaded, and no config that loads today stops loading. Nothing about how a config resolves changes, and the published type exports are untouched — the only difference is extra lines on stderr, which is why this is a patch rather than a minor. Warnings go to stderr, never stdout, and `RepositoryContext` passes the loader an explicit stderr logger: the same loader runs inside the MCP stdio server, where stdout carries the JSON-RPC stream. They are emitted once per load — once for `list` or a daemon start, again after a genuine reload of an edited file — and nothing is cached between loads.

  The key inventory is pinned to the types rather than hand-maintained: each list is `satisfies readonly (keyof X)[]`, which rejects a name that is not a real key, and an `Exclude<keyof X, listed> extends never` assertion rejects a real key nobody listed, so adding a field to `Config` or to any nested block and stopping there fails `pnpm typecheck` — verified by adding one and watching it fail. A companion test builds the same key sets as `Record<keyof X, true>` maps and compares them against the exported lists, which covers the one step the `satisfies` clauses cannot see: the array spreads that assemble them.

- cf3dfe0: CLI failures now say which repository, which file and which phase they came from. Each item below was measured against the built CLI before and after, with stdout, stderr and the exit code captured separately.

  **A parallel `--runOnce` init failure names its repository.** With three repositories configured and one bad `repoUrl`, the report was `❌ Failed to initialize repository: GitError: fatal: repository '…' does not exist`. The per-repository `📦 Repository: <name>` header is printed whenever that repository's task happens to start, so under parallelism it is nowhere near the failure line and there was nothing tying the two together. `Promise.allSettled` hands results back in the order it was given them, and it was given `repositories.map(...)`, so the index is the answer: the line now reads `❌ Failed to initialize repository 'repo-b': …`. The rejected task never gets far enough to return a name of its own, which is why it has to come from the index.

  **A failure after the config loaded is no longer blamed on the config file.** `runSync` wrapped the load and the run in one catch labelled `Error loading config file`, so a `WorktreeSyncService` constructor rejecting a repository name in daemon mode reported `❌ Error loading config file: Invalid configuration for 'removal audit log name': 'con' is a reserved name on Windows` — for a config file that had loaded without complaint, sending the person to edit a file that was never the problem. Loading and running are now separate: a load failure keeps the old label (and `Config file not found` still keeps its own message and hint), while anything escaping the run says `❌ Error running sync:`. A typed `SyncWorktreesError` is reported as that one line, because its message is the whole story; anything else is a bug in this tool and keeps its stack, which is the only useful thing to say about one. Exit code 1 either way, as before.

  **A config that will not load names the file, and the line when Node has one.** `Failed to load config file: Unexpected token ']'` identified neither, and on an auto-discovered config the person did not even know which file had been picked. Failures from _evaluating_ the file now carry a location: `… (/path/sync-worktrees.config.js:3)` for a CommonJS parse error, `… (/path/config.mjs:3:69)` for a config that throws while it evaluates, and `… (/path/config.mjs, at /path/repositories.mjs:2:9)` when the throw comes from a module the config imports — both files, because the config is the one the person passed. Node's own frames are skipped, the `?t=` cache-buster the loader appends to the import URL does not appear, and a `file://` frame is turned back into an openable path.

  One case gives less, on purpose: a module that fails to _parse_ under the ESM loader carries no position at all once the import is caught. V8 keeps that position on its message object, which Node prints for a fatal exception and discards otherwise, so those report the file alone. Measured byte-identical on Node 20, 22 and 24, so nothing here depends on which of the two supported runtimes is running. Failures raised _after_ the file evaluated — `Config file must export an object`, a missing `repoUrl` — are deliberately not located: their stack starts inside this loader, and pointing at sync-worktrees' own code for a config someone has to fix is worse than saying nothing. The module-system hint added for a `.cjs` config written in ESM is unchanged and still appended after the location.

  **Ctrl+C at a `trash` confirmation prompt is one line, not a stack.** `@inquirer` installs its own SIGINT handler and rejects with an `ExitPromptError` rather than letting the signal through, so declining a destructive prompt the most ordinary way there is printed `❌ Unhandled error: ExitPromptError: User force closed the prompt with SIGINT` and ten frames of readline internals — verified against the real prompt under a pty. It is now reported like every other expected `trash` failure: one line, exit 1. The catch stays a typed test and still lets a genuine bug through with its stack.

  The rest of what this item was filed against turned out to be already fixed and was left alone: `sync-worktrees trash` with a multi-repository config and no `--filter`, with an unknown entry id, and with a missing or unparseable config file each already produced one line and exit 1 with no stack.

  Two credential leaks were closed on the way. `list` and the run command printed a config-load error's message with no scrubbing, so a config whose error text quoted `https://user:token@host/repo.git` printed the token verbatim — measured before the change. Both now go through the same redaction as everywhere else, as do the newly surfaced file paths, the new run-phase line and the stack it may print; `init`'s round-trip failure message joins them. The repository name added to the init-failure line goes out through the logger, which already scrubs.

  `patch` rather than `minor`: this refuses nothing, changes no resolved configuration value, adds no option and touches no exported type. Every difference is text on stderr and one prompt cancellation that stops printing a stack — the same reasoning as the unknown-key warnings released alongside it.

- cf3dfe0: `sync-worktrees init` now trims the answers it stores, and the README documents the `trash` subcommand.

  **The init wizard stored answers it had only validated in trimmed form.** Every validator in the wizard tests `value.trim()`; the raw string is what was saved. `path` never normalizes trailing whitespace away — `path.resolve("./wt ")` is `<cwd>/wt ` — so an answer that validated as `./wt` was stored, written into the generated config and later created on disk as a directory one character away from the one the person typed. `repoUrl`, `worktreeDir`, `bareRepoDir` and `cronSchedule` are now trimmed as they come back, which is what `branch` and `depth` already did at their point of use.

  The cron answer was the one case that failed outright rather than quietly. `cron.validate` accepts a space-padded expression but rejects every other kind of whitespace, while `trim()` removes them all, so an answer carrying a tab or a non-breaking space — what pasting one out of a crontab or a rendered documentation page gives you — passed the prompt and was written into the config. `init`'s own round-trip load then refused the file it had just written with `Invalid cron expression in defaults`, exited 1, and left the broken config on disk.

  Two guards were reading a different string from the one they were protecting. The worktree-mode check that refuses the config file's own directory as `worktreeDir` compared the _trimmed_ answer against the config directory and then stored the untrimmed one, so the path it approved was not the path it saved. The clone-mode warning — the one line telling you `git clone` will refuse a destination that exists and is not empty — compared the untrimmed answer, so it stayed silent for a pasted path carrying a trailing space. Both now see the value that is actually stored.

  The URL prompt also stops rejecting whitespace it would have trimmed: its shape check was the one validator reading the raw value, so a leading space (the usual artefact of pasting) was reported as "Please enter a valid Git URL". Something that is not a URL once trimmed is still rejected with the same message.

  **README's CLI reference lists `trash`.** The Subcommands list has carried `init` and `list` since before the trash CLI existed in 5.2.0, so the reference a reader consults for "what can this command do" did not mention the only way to inspect or recover a reversible removal, and `sync-worktrees --help` was the only place it appeared. The new entry documents every flag the command accepts today — `--config`, `--filter`, `--restore`, `--purge`, `--dropKeepRef`, `--dropAllKeepRefs`, `--json` and `--wait` — along with the constraints that decide whether an invocation is accepted at all: exactly one matched repository, worktree mode only, the four mutually exclusive operations, and the three that need an interactive TTY and a typed confirmation.

  `patch` rather than `minor`: no option, subcommand or exported type is added, and nothing that loaded before loads differently. The behaviour change is confined to `init`, which now saves the string it validated.

- cf3dfe0: MCP auto-detect derives `worktreeDir` from the bare repository's registered worktrees instead of guessing `dirname(<the worktree the probe landed in>)`.

  The guess is only right when the branch name contributed exactly one path component. Every branch worktree does — `getBranchWorktreePath` flattens the name and suffixes a hash of it, so `feature/x` becomes the single component `feature-x-217d2bf5`. The default-branch worktree is the exception: it is anchored at the plain path `join(worktreeDir, defaultBranch)`. Once nested default branch names were supported, standing in the anchor of a repository whose default branch is `release/2024` made detection answer `<wd>/release`.

  Two things followed. `detect_context` reported that directory, so an agent reading it to decide where things live was misinformed. Worse, the value went into the synthetic config, and every worktree `create_worktree` then made landed under `<wd>/release/…`. Reproduced against real git 2.43.0: `create_worktree {branchName: "feature/x"}` from the anchor created `<wd>/release/feature-x-217d2bf5`. A later _configured_ sync — one carrying the correct `worktreeDir` — reads `git worktree list` and sees `feature/x` as already checked out, so it plans nothing and the worktree stays outside `worktreeDir` for good.

  The TODO item's headline symptom — `git worktree add` failing with `fatal: 'release/2024' is already checked out` — no longer happens. `GitService.ensureMainWorktree` detects the default branch registered at a path other than the one it computed, adopts it, and logs so. The crash is handled; the misplacement it used to mask is what was left.

  The derivation inverts the two path shapes rather than assuming they are alike. For each registered worktree a candidate parent is computed — `dirname` when the basename reproduces `sanitizeBranchName(branch)`, otherwise strip as many components as the branch name has segments — and kept only if rebuilding the path from that candidate reproduces the registered path exactly. Comparison goes through `pathsEqual`, so a case-insensitive filesystem is handled the way the rest of the codebase handles it.

  One registered worktree is enough: the shape it matched already fixes how many components its branch name contributed, which is precisely the fact a probe path cannot supply. There is no convention-based fallback, deliberately — the README's layout puts the bare repo at `.bare/<repo>` beside `worktrees/<repo>`, while sibling discovery walks a `<workspace>/<repo>/.bare` layout, so nothing can be inferred from `bareRepoPath`.

  Two independent signals now have to agree before anything is answered.

  The count decides first. Entries matching neither shape — a detached entry whose branch field is the pseudo-name `(detached abc1234)`, a directory named after neither the branch nor its flattening — abstain and do not vote. Only those abstain: the anchor shape is `<dir>/<branch>`, so a hand-run `git worktree add ../hotfix hotfix` outside `worktreeDir` _is_ recognized and votes for `../`, which is the conventional way to place one by hand. The recognized candidates are therefore counted and the parent with the most votes wins, so a minority does not refuse for everyone; a tie at the top leaves no answer to prefer.

  Then the worktree the detection was run from has to corroborate that count. It is the one entry known to be real and relevant, but it is a sample of one, and an agent is most likely to be standing in exactly the hand-placed worktree that disagrees — so it confirms rather than overrides. Preferring it outright was tried and rejected against real git: with five tool-made worktrees under `worktreeDir` and one hand-placed beside them, running `create_worktree` from inside that one stray put the new worktree next to it rather than with the other five. Counting alone fails the mirror image: two strays sharing a parent outvote the single tool-made worktree the call came from, and `create_worktree` writes beside the strays. Neither signal is trusted alone, so neither failure is reachable.

  When the probe is absent from the list — `git worktree add` canonicalizes its target while the current-worktree match is lexical, so a cwd reached through a symlink matches no entry — or when it abstains, the count stands alone. There is nothing to corroborate with, which is not a reason to refuse. One registered worktree still answers on its own: the shape it matched already fixes how many components its branch name contributed, which is the fact a probe path cannot supply.

  Disagreement and ties refuse, and `createWorktree` / `updateWorktree` are marked unavailable rather than run on a guess. The reason now carries the remedy as well as the cause: `cannot determine worktreeDir: the registered worktrees and the worktree this call came from do not agree on where they live; set an explicit worktreeDir in a config for this repository and call load_config`. An adopted anchor is the case this protects: `GitService.ensureMainWorktree` settles on a default-branch checkout found somewhere other than the path it computed, so that entry and the tool-made ones name different parents one-for-one, and standing in either and believing it is right only by luck of which directory the agent happened to be in. Both need it: `create_worktree` resolves its target through `getBranchWorktreePath(worktreeDir, …)`, and `update_worktree` calls `initializeUnlocked()`, which rebuilds the default-branch worktree at `join(worktreeDir, defaultBranch)`. `sync` and `initialize` were already unavailable for an auto-detected repository, and `list_worktrees` / `get_worktree_status` work off the bare repo and are untouched.

  The chosen directory is surfaced in `notes`, and a repository matched to a loaded config now reports that config's `worktreeDir` — the one the tools will actually write under — instead of anything read back from git.

  Keeping the reported value and the resolved one together takes two more things. The detected entry is refreshed on each detection, and the cached service is dropped with it when the directory changes: `getService` builds that service from a spread copy of the config, so refreshing the entry alone left a session reporting the derived directory while `create_worktree` went on writing under the placeholder. And the "cannot determine" verdict is recorded on the entry, not only on the discovery snapshot — `invalidateDiscovered` drops that snapshot while keeping the entry, and `ensureCapability` stops at the base capabilities when there is none, so `load_config` used to re-open `create_worktree` on the placeholder directory.

- cf3dfe0: The MCP `update_worktree` tool now refuses a detached-HEAD worktree with code `DETACHED_HEAD` and a message naming the path and the commit HEAD sits on, instead of claiming the path "is not a registered worktree of the current repository".

  The path is registered — git simply does not list it by default. `git worktree list --porcelain` prints a detached worktree with a `HEAD <oid>` line, a `detached` line and no `branch` line, and `GitService.getWorktrees()` dropped exactly those rows, so the membership check that `update_worktree` runs against a fresh listing found nothing and produced the one error message that is both wrong and impossible to act on: the agent's next move is to go looking for a repository the worktree is supposedly in.

  `getWorktrees()` takes an `includeDetached` option, and `update_worktree` is the only caller that passes it. The flag and the HEAD oid are already in the rows the listing parses, so this is the same single `git worktree list --porcelain` it always ran — nothing is probed twice — and the refusal can quote the sha. Read-only tools are deliberately left on the branch-only listing, and `get_worktree_status` keeps the membership answer it has always given: it already reports "detached HEAD" among its reasons, it discards the branch name, and widening it is a change to which paths a read-only tool accepts rather than part of this fix. That leaves one known seam — its two membership sources disagree about detached entries, so a warm discovery snapshot answers for a detached path and a cold one calls it unregistered — which is pinned by a test so the next change to it is a deliberate one.

  Asking for detached rows also un-hides three entries the branch-only listing had been dropping as a side effect, and none of them reaches the fast-forward. The bare repository's own row has neither a branch nor a detached HEAD, and its empty `branch` would hand `fetchBranch("")` a refspec rather than a branch name; `getWorktrees()` drops it. A registration whose checkout has been deleted is `detached` + `prunable`, and there is no directory in which to act on a "check out a branch" remedy — the rest of `GitService` already treats a prunable registration as absent, and this listing now does too. The third is the same deleted checkout wearing a lock: git does not compute `prunable` for a locked registration, so a locked detached worktree whose directory is gone — `git worktree lock` is for a worktree on media that is not always mounted, which is exactly when the directory is not there — arrives in the listing looking like a live detached checkout. `update_worktree` probes that one path before it answers, and reports it as unregistered rather than prescribing a checkout in a directory that does not exist; a locked detached worktree that is still on disk keeps the `DETACHED_HEAD` answer. Branch-bearing prunable rows are untouched: the default listing has always returned them and still does. All of that is covered by tests, as is the guard itself — against real git, with a real `git checkout --detach`, a real `git worktree lock` and a real deletion, since a mocked listing could only assert the fake.

  Two symptoms the original report listed were already fixed and are not what this changes. The cache-dependent membership answer went when `update_worktree` started resolving against a fresh listing rather than the discovery snapshot; and the pseudo-branch `(detached abc1234)` that the snapshot invents as a display label is not reachable by any code that fetches or merges — `fetchBranch` is called in exactly two places, both fed by branch-only listings.

- cf3dfe0: A config file that MCP auto-discovery _finds_ but cannot _load_ is no longer invisible to the client. `detect_context` walks up from the inspected path looking for `sync-worktrees.config.{js,mjs,cjs,ts}`; when that file had a syntax error the failure went to stderr — which no MCP client shows the model — and the response came back as `configPath: null` with `sync` unavailable "because no config file is loaded", with nothing anywhere in it hinting that a config file exists at all. The reasonable next move from there is to write a _second_ config, or to give up. `notes` now carries `Found config at <path> but it failed to load: <error>. Fix it and call load_config.`, on every shape the call can return — managed, unmanaged, unsupported and clone-mode — and the error is the loader's own, so a parse error arrives with its message and the file it came from.

  The stderr line stays. It is the only channel a human tailing the server in a terminal has, that audience never sees tool output, and stderr is not the JSON-RPC stream so it costs nothing on the wire. It is now written once per broken revision of the file rather than once per attempt.

  **The repeat imports are gone too, and that is a bigger saving than it looks.** The auto-load ran on every _cache-missing_ `detect_context` — which is not every call, because the discovery cache in front of it short-circuits a repeat for the same path within 5 s while the worktree's `HEAD` and the bare repo's `worktrees` directory are unchanged. But a result is only ever cached for a real worktree, so nothing at all is cached for a plain directory, a regular non-worktree repo or a clone-mode checkout; a different path is a different cache key; the four mutating tools call `invalidateDiscovered()`; and server start-up does one of its own. Each of those attempts re-evaluates the broken file, and past the first one that costs a **worker thread**, not just a module import: `ConfigLoaderService` records a path as evaluated before it imports it, so even a failed first import pushes every later attempt onto the reload path added in T35. A broken config in a workspace an agent is actively editing was spawning and tearing down a worker per detect, to produce the same error each time.

  A failed auto-load is now recorded on the context along with the path, the error, the file's `mtimeMs` and a sha256 of its contents, and the same file is not re-imported until one of those two changes.

  **Why a hash and not just mtime.** The gate must never outlive the repair — a config the user has just fixed staying broken in the agent's view is a worse failure than the one being fixed. mtime alone cannot promise that: it is nanosecond-resolution on ext4 and APFS but one second on HFS+ and on most NFS/SMB mounts, and the smallest real syntax repair — one `}` becoming `]` — leaves the byte count identical, so a fix landing in the same second as the failure is invisible to a stat-only check, size included. The hash is exact and reads a file of a few kB, once per auto-load attempt. A config that loads is fingerprinted exactly once in the life of the process — `configPath` is set from then on and the whole path is skipped — so a healthy workspace pays one read of one file, ever, and never a read per `detect_context`. While a config is broken it is computed on each attempt, which is precisely where it replaces spawning a worker. The file is fingerprinted _before_ the load is attempted, never after, so an edit that lands while the import is running is retried rather than mistaken for something already tried.

  **How this sits with T35.** T35 made a reload re-evaluate the config _and everything it imports_ in a worker with an empty module registry, so that a changed config is actually picked up instead of being served from Node's registry. Nothing here touches that: this gate sits above the loader, caches no config and no result, and only suppresses a repeat attempt on a file that is byte-for-byte the one that just failed. Every attempt it does let through still goes through T35's path and still re-reads the whole graph from disk. The two notions of "changed" agree because the gate's is strictly narrower.

  One consequence is worth stating plainly: the fingerprint is of the config file, so a fault that lives in a module the config _imports_ — `./repos.mjs` and friends, the shape T35 exists for — is not re-tried when only that module is fixed. Node reports such a `SyntaxError` with neither file named, in the message or in the stack, so there is nothing else to fingerprint. `touch`ing the config releases the gate (mtime alone is enough), and `load_config` does not come through this path at all — which is exactly what the new note tells the agent to call.

  Patch, not minor: `notes` is an existing `string[]` in `detect_context`'s output schema that already carried free-text lines, no tool, field, input or schema changes, and the skipped re-imports are an internal saving with no observable surface. What changes for a caller is that a defect stops hiding.

## 5.3.1

### Patch Changes

- dc0c39c: Fix sync/delete defects found in code review: forward the full (sanitized) process environment to every clone-mode and LFS-skip git subprocess so authenticated remotes work; stop a stale clone-mode init skip from being silently swallowed by the next sync; recreate the default-branch worktree when its directory was deleted out-of-band instead of failing every sync; keep branches containing `|` (and one literally named `origin`) in the sync inventory so their worktrees are no longer wrongly pruned; classify a deleted tracked branch during an unshallow fetch as the usual soft skip; re-verify HEAD before moving a worktree to trash so a commit made mid-removal is never left unreachable; abort clone init on a transient directory probe failure instead of risking cleanup of a pre-existing directory; resume an interrupted clone init's file copy via a pending marker; validate `.diverged` metadata types before trash adoption; serialize worktree-mode syncs on the worktreeDir (not just the bare repo), canonicalize lock keys through symlinks, and survive a compromised repo lock instead of crashing the whole multi-repo run.

## 5.3.0

### Minor Changes

- 7b01955: Upgrade the MCP server to the 2026-07-28 protocol revision (`@modelcontextprotocol/server` v2). The stdio server now serves the 2026-07-28 revision and keeps serving 2025-era clients from the same tool registry, so existing MCP clients continue to work unchanged.

  Tools now advertise `outputSchema` and return `structuredContent` alongside the existing JSON text block, and `tools/list` / `resources/list` carry cache hints so clients can avoid re-fetching a static tool registry.

## 5.2.0

### Minor Changes

- 4610094: Add reversible worktree trash and restore workflows, an explicit TUI force-clean action, and hardened cleanup for detached or external worktrees, stale registrations, unsafe manifests, and interrupted diverged-branch replacement. Removal safety checks now use `--ignore-submodules=none`, recursively inspecting every submodule and overriding `submodule.<name>.ignore` and `diff.ignoreSubmodules`; this may increase pruning costs. The fast-forward gate still honours the repository's own submodule ignore settings.
- 4610094: Scroll the log panel with the mouse wheel. `j`/`k`, the arrows, `gg` and `G` all still work — the wheel is for people who don't reach for vim motions. Mouse tracking is enabled while the TUI is running and turned back off on exit; hold `Shift` to select text with the mouse as usual. Mouse reports are ignored everywhere else in the UI, so scrolling over a filter box no longer types an escape sequence into it.

### Patch Changes

- 4610094: Fix sync, removal and trash regressions found reviewing the cleanup-hardening work:

  - Rebuild worktrees whose registration points at a directory that was deleted out-of-band. Without the start-of-sync `worktree prune`, git still reported the branch as checked out, so sync silently stopped restoring it.
  - Recreating a worktree for a stale registration no longer fails permanently: the recovery path handed the already-missing directory to the trasher, which failed with `ENOENT`.
  - A diverged branch is only held back from syncing while its trashed replacement was genuinely never created. Previously any later removal of the replacement re-armed the reservation, and `.diverged/` copies (which nothing restores from) or an unverifiable path check could hold a branch back for good.
  - `resetToUpstream` indexes the upstream tree instead of comparing every ignored path against every tracked path, and lets git collapse wholly-ignored directories. The old scan blocked the event loop for minutes on a large ignored tree while holding the repo lock.
  - Relocating `worktreeDir` no longer strands every existing trash entry as unrecognized content that is never reaped and never releases its pin ref. The restore destination is still confined to `worktreeDir`, checked where it is used.
  - Force clean keeps recovery refs that a `.diverged/` directory still depends on, so it can no longer leave preserved files whose commits `git gc --prune=now` has already collected. It reports trash deletions from the reaper's own count and only purges repositories whose preview was shown in the confirmation.
  - The fast-forward gate honours the repository's own `submodule.<name>.ignore` settings again. Overriding them there marked worktrees with vendored build output permanently dirty, so those branches silently stopped updating. Removal checks keep the stricter view: they still pass `--ignore-submodules=none`, which overrides `submodule.<name>.ignore` and `diff.ignoreSubmodules` and recurses into every submodule working tree. A worktree whose submodule is dirty therefore counts as unsafe to remove and is never auto-pruned, and repositories with many or large submodules pay that recursion on each removal check.
  - A sync no longer proceeds when the trash listing fails outright. An unreadable trash root used to read as "nothing is reserved", so sync could create a worktree on a path a trashed payload was still waiting to be restored to, and the later restore failed with the only copy of that work inside the trash entry.
  - The log panel keeps a scrolled-back position in range when the panel grows. Enlarging the terminal lowers the maximum offset, and a position left above it showed a part-empty panel in a window that was now tall enough to show everything below it. Following the tail and sitting at a chosen offset are one piece of state now, so no keystroke can write half of it.
  - `.diverged-info.json` points at the recovery flow that actually applies to it. A trashed copy has no keep ref to release, so sending the reader to the keep-ref flow had them looking for something that was never created.
  - The diverged-directory delete prompt in the TUI ignores further keys while a delete is running. Repeating `y` fired one removal per keypress, and `n`/ESC handed the list back mid-delete so the next confirmation showed "Deleting..." for an entry nothing was deleting.
  - Force clean also keeps `keep/diverged-<timestamp>-<branch>` refs minted before this ref layout, matching them to their `.diverged/` directory by the sanitized branch name both carry. Those refs are the only thing holding the commits behind a preserved copy, and nothing else links them to it.

## 5.1.1

### Patch Changes

- 387b05e: Fix 20 code-review findings across safety, CLI, MCP, and config subsystems (F1–F20 in REVIEW_FINDINGS.md): orphan cleanup can no longer delete a bare repo nested in worktreeDir; `filesToCopyOnBranchCreate` works again (patterns stay relative, absolute/escaping patterns rejected); default branches containing `/` are detected correctly; MCP `create_worktree`/`update_worktree` fetch before acting; runOnce exit codes no longer mask failures (SIGINT exits 130, per-repo `runOnce` rejected in favor of `defaults.runOnce`); diverged-replace preserves stashes; trash pin refs are namespaced per trash root; config validation rejects malformed `branchInclude`/`branchExclude`/`branchMaxAge`/parallelism values; `.cjs` configs hot-reload; plus assorted smaller fixes (retry classification, timing table, init wizard validation, LFS sampling, metadata guard, MCP registration probing).

## 5.1.0

### Minor Changes

- c3ca559: Rework the `init` wizard: multi-repository setup, mode-aware prompts, and a self-documenting generated config.
  - **Multiple repositories in one run.** The wizard now loops with an "Add another repository?" prompt, so a monorepo-sibling setup (the common multi-repo case) can be scaffolded in a single `init` instead of hand-editing the file afterwards.
  - **Mode-first prompts.** Each repository asks `worktree` vs `clone` up front, then only the fields that apply to that mode: `bareRepoDir` for worktree mode; optional `branch` and shallow `depth` for clone mode. Clone-mode entries are emitted with `mode: "clone"` and never leak worktree-only fields.
  - **Removed the run-once question.** The wizard always generates a scheduled config; `runOnce` stays available as a CLI flag / manual config field for one-shot runs.
  - **Self-documenting output.** The generated file appends a commented cheatsheet of the most common advanced options (`branchMaxAge`, `branchInclude`/`branchExclude`, `sparseCheckout`, `updateExistingWorktrees`, clone `branch`/`depth`, `parallelism`, `hooks`, `debug`) with a link to the full reference.
  - **CLI discoverability.** `sync-worktrees --init` / `--list` (flag forms of the subcommands) now fail with a hint pointing to `sync-worktrees init` / `list` instead of a bare "unknown argument" error.
  - **MCP auto-registration.** After writing the config, `init` detects installed AI CLIs (Claude Code, Codex) and, for any that don't already have the server, offers to register it via `<tool> mcp add sync-worktrees -- npx -y -p sync-worktrees sync-worktrees-mcp` (auto-detect mode — no config path is bound). Best-effort: it's TTY-gated, only prompts when it can confirm the server is missing (skips tools that are absent, already registered, or whose state can't be determined), and never fails `init`.

## 5.0.1

### Patch Changes

- 134a41f: Fix "open in editor" failing with ENOENT when `EDITOR`/`VISUAL` contains flags (e.g. `code -w`).

  The TUI passed the whole `EDITOR` string as the binary name to `spawn`, so values like `code -w` were treated as a single executable that does not exist. The editor command is now split into command and arguments before spawning.

- 5cb748f: Document the clone vs worktree repo-mode distinction in the MCP server instructions.

  The two modes previously surfaced only as an output discriminator in `detect_context`'s schema, so agents had to guess what the modes meant and whether tool behavior differed. The server `instructions` string now defines both modes and notes that `create_worktree`/`update_worktree` are worktree-mode only. Those two tool descriptions gain a matching clause, and `sync`'s cross-references are qualified to worktree mode (they pointed at tools that error in clone mode).

## 5.0.0

### Major Changes

- 6bf58b5: Remove all deletion capabilities from the MCP server.

  The agent-facing MCP surface no longer exposes any destructive or trash operations: the `remove_worktree` tool is removed (breaking — it shipped in earlier releases), and the unreleased `list_trash` / `restore_trash` tools and the per-repo trash summary on `list_worktrees` are dropped before ever shipping. The `removeWorktree` capability key disappears from `detect_context` responses.

  Rationale: the MCP server is consumed by AI agents, and an agent-facing API should not carry irreversible affordances — a hallucinated call or prompt-injected instruction must not be able to destroy work. Escalation may bypass preconditions, never recoverability. Worktree removal remains available through sync's safety-gated pruning (trash-backed, restorable) and manual git commands; trash inspection and restore are human operations driven by each entry's `manifest.json`.

### Minor Changes

- 6bf58b5: Support branch switching for clone-mode repositories in the interactive TUI.

  Previously a clone-mode repository tracked one fixed branch with no way to change it from the UI. Now the branch picker (`createWorktreeForBranch`) checks out the selected branch in place when the repository is in clone mode.

  - **`checkoutBranch(branch)`** on clone-mode repos reconfigures the single-branch fetch refspec, fetches the target branch, switches to it, and prunes stale `origin/*` remote-tracking refs left by the previous branch.
  - **`getRemoteBranches()`** now lists remote branches via `git ls-remote --heads` so the picker can show every branch without downloading object closure for each one.
  - **Legacy refspec narrowing:** existing single-branch clones get their refspec narrowed on sync so a fetch no longer pulls unrelated remote branches; shallow clones stay materialized to the tracked branch only.

- 6bf58b5: Add optional periodic Git object-store maintenance (`git gc`).

  Over time a repository accumulates unreachable Git objects — clone mode leaves them behind when single-branch fetches narrow refs, and both modes churn objects as branches come and go. The new `maintenance` config block reclaims that storage and consolidates pack files on a schedule.

  - **New config (both modes):** `maintenance?: { enabled?: boolean; interval?: string; aggressive?: boolean }`, settable per repository or in `defaults`.
  - **Defaults:** `enabled: true`, `interval: "7d"`. With no config, repositories get a safe weekly `git gc`.
  - **When it runs:** at the tail of a _successful_ sync, inside the existing repository operation lock — so it never races a fetch, merge, branch checkout, or worktree add/remove. Throttled by `interval` via a timestamp persisted in the object store (`<bare-repo>/sync-worktrees-maintenance.json`, or `<worktreeDir>/.git/…` in clone mode), so throttling survives daemon restarts and repeated `runOnce` runs.
  - **Targets:** worktree mode runs `git gc` against the shared bare repo; clone mode runs it against the checkout.
  - **Safety:** the default runs plain `git gc`, honoring Git's two-week prune grace — reachable objects (branches, tags, stashes, reflog) are always preserved. `aggressive: true` runs `git gc --prune=now` for explicit immediate reclamation.
  - **Isolation:** a maintenance failure is logged as a warning and never fails the sync; the attempt is still timestamped, so a broken `gc` is throttled instead of retried every tick.

- 6bf58b5: Fail-closed worktree removal pipeline.

  Worktree removal previously had paths where an error or ambiguous probe result could read as "safe to remove". Every check in the removal path now follows one rule: cannot verify → cannot remove.

  - **Status probes fail closed:** a filesystem error (EMFILE/EINTR/EACCES) while checking the worktree path or operation files (`MERGE_HEAD`, rebase state, …) now blocks removal instead of reporting a clean state. Only a genuine `ENOENT` counts as "directory gone".
  - **Unpushed detection checks both conditions:** removal requires `rev-list <branch> --not --remotes` = 0 **and** (when sync metadata exists) `rev-list <lastSyncCommit>..HEAD` = 0. Previously the metadata path silently replaced the any-remote check. Note: a worktree where you ever committed after the last sync stays un-prunable until removed manually — deliberate conservatism.
  - **Detached HEAD is never auto-removed:** it may sit on commits unreachable from any ref.
  - **Non-forced `git worktree remove` by default:** git's own refusal to delete a dirty worktree is kept as the last line of defense and surfaces as a skip, not an error. `--force` is reserved for the diverged-replacement flow (directory already preserved under `.diverged/`).
  - **Orphan-directory cleanup can no longer destroy a live checkout:** a directory containing a `.git` is quarantined to `<worktreeDir>/.removed/<timestamp>-<name>/` (never auto-emptied) instead of deleted; an unverifiable probe skips the directory. The same guard applies when `addWorktree` clears a stale target directory.
  - **Append-only removal audit log:** every prune removal, orphan deletion/quarantine, and diverged replacement writes a JSONL record (timestamp, path, branch, status snapshot, code path) to `<configDir>/.sync-worktrees-state/<name>-<hash>-removals.jsonl` (or `$XDG_STATE_HOME`/`~/.cache/sync-worktrees/removals/` without a config file). For destructive automatic removals the record is written _before_ deletion; if it cannot be written, the removal is skipped.

- 6bf58b5: Reversible removals via a per-workspace trash folder.

  Every removal — age-based prune, orphan cleanup, and diverged-branch replacement — now moves the directory into `<worktreeDir>/.trash/<id>/payload/` instead of deleting it, with a JSON manifest recording the branch, reason, original path, size, and expiry. Each entry is retained 30 days on its own clock (`trash.retentionDays`), then deleted by a reaper that runs at the tail of a successful sync inside the repo lock. The reaper only touches manifested entries whose real path stays under the trash root, and each delete is gated on a durable audit-log record.

  - `trash` config (worktree mode only): `{ enabled: true, retentionDays: 30, warnSizeBytes?, migrateLegacy: true }`. Disabling restores direct deletion and leaves existing trash untouched.
  - A pin ref (`refs/sync-worktrees/trash/<id>`) keeps the trashed HEAD's objects alive through `git gc` for the retention window, so restore can recreate the branch at the exact commit even after the local and remote-tracking refs are gone.
  - Trash is deliberately not exposed over MCP: the agent-facing surface has no removal, listing, restore, or purge tools (the `remove_worktree` MCP tool is removed in the same release). Restore is a manual operation driven by the entry's `manifest.json` — see the README's "Trash and restore" section.
  - Existing `.removed/` quarantines and `.diverged/` backups in their exact shipped formats are adopted into the trash on the next sync (`trash.migrateLegacy`), so they age out under the same retention policy; unrecognized content is warned about and left alone.
  - Failure to move a directory into trash (e.g. a cross-device rename) skips the removal entirely — the worktree stays in place.
  - A leftover local branch ref after a successful trash move is reported as a structured warning (`leftover_branch_ref`) instead of failing the removal — the payload and pin ref already capture everything restore needs. The reaper also sweeps orphaned pin refs whose trash entry no longer exists, so nothing stays pinned through `git gc` forever.

### Patch Changes

- 6bf58b5: Harden trash/removal pipeline and clone-mode checkout against data loss:
  - Legacy `.removed`/`.diverged` adoption now resets `deletedAt` to adoption time (original quarantine time preserved as `legacyQuarantinedAt`), so migrated backups can no longer be reaped in the same tick.
  - Never-pushed commits are pinned: `diverged-replace` trashing and `.diverged` adoptions set `keepPinOnReap`, branch-bearing entries get an objects bundle before the branch ref is deleted, and pin/bundle failure aborts the removal (fail closed).
  - Reaper no longer mass-sweeps `refs/sync-worktrees/trash/*` when the trash root is missing (e.g. unmounted volume); sweep requires a sentinel written at trash-root creation.
  - Clone-mode `checkoutBranch` refuses to run from a detached HEAD and no longer double-reports the missing-ref skip; the TUI branch wizard opts out of the config-drift guard explicitly and warns to update `branch` in the config.
  - Diverged recovery with trash disabled now deletes the stale local branch ref so the worktree is recreated from upstream, not from the stale local branch.
  - Registered-but-missing worktree wedge heals via targeted `git worktree remove --force` plus metadata cleanup and an audit record.
  - `restoreFromTrash()` is lock-coordinated (wait-queue) and reapplies sparse-checkout on restore; `getTrashService()` removed from the public surface.

## 4.2.0

### Minor Changes

- 91157db: Upgrade Ink to v7 and adopt new TUI capabilities:
  - Layout now re-flows live on terminal resize (`useWindowSize`).
  - The interactive UI renders in the terminal's alternate screen buffer, restoring prior scrollback on exit, with incremental rendering to reduce flicker (`alternateScreen` + `incrementalRendering`).
  - Pasting is supported in the branch-creation, open-editor, and worktree-status views, including multi-character branch names that were previously dropped (`usePaste`).

## 4.1.1

### Patch Changes

- 0b590f5: Fix the landing-page hero headline clipping the descenders of its gradient line. The `bg-clip-text` line had an implicit `line-height: 1`, so the gradient box stopped at the baseline and characters like "y"/"g" were cut off; added line-height and bottom padding so descenders render fully.
- 0b590f5: Tidy interactive UI progress and disk usage reporting: drop the StatusBar progress percent suffix that never fired (every git progress message already embeds its percentage) and relied on a fragile substring check, and mark repository disk-usage totals as a lower bound (`≥`) when only some size paths fail — the failed path counts as zero, so the total is a guaranteed undercount rather than a confident exact value.

## 4.1.0

### Minor Changes

- b60acad: Show per-repository sync progress in the interactive UI, add repository disk usage to the worktree status view, and keep git transfer progress out of normal logs by default.

## 4.0.0

### Major Changes

- 497c18e: **Breaking**: collapse the CLI to a config-file-only workflow.

  `sync-worktrees` now does one thing: load a config file and run it. Every knob (`runOnce`, branch filters, LFS, mode, depth, retry, parallelism, debug, `updateExistingWorktrees`, etc.) lives in the config file.

  ### Removed CLI flags

  `--repoUrl` (`-u`), `--worktreeDir` (`-w`), `--cronSchedule` (`-s`), `--bareRepoDir` (`-b`), `--branchMaxAge` (`-a`), `--branchInclude`, `--branchExclude`, `--skipLfs`, `--no-update-existing`, `--mode`, `--branch`, `--runOnce`, `--debug`, `--sync-on-start`, `--filter` (on the default command), `--list`.

  The single-repo flag invocation, the missing-config-file rescue prompt, and the auto-launched interactive setup are all gone.

  ### New surface

  ```text
  sync-worktrees [--config <path>]
  sync-worktrees init [--config <path>] [--force]
  sync-worktrees list [--config <path>] [--filter <pat>]
  ```

  - `init` writes a new config file (`./sync-worktrees.config.js` by default) and exits. Refuses to overwrite an existing target unless `--force` is passed. Atomic write via `flag: "wx"` — no TOCTOU between check and write.
  - `list` is the new home for what used to be `--list`.
  - `--filter` only exists on `list` (it's a list-query parameter, not a sync-run override).
  - yargs is configured with `camel-case-expansion: false` and `strict()` — typos and removed flags fail loudly.

  ### Migration
  - Replace any single-repo CLI invocation with a config file (run `sync-worktrees init` to generate one).
  - Replace `sync-worktrees --list ...` with `sync-worktrees list ...`.
  - Move `--runOnce` to `defaults.runOnce: true` in the config file. (Per-repo `runOnce` only suppresses TUI cron scheduling for that one repo — to run the whole CLI as one-shot, set it under `defaults`.)
  - Move `--no-update-existing` to `updateExistingWorktrees: false` (per-repo or under `defaults`).
  - Move `--debug` to `debug: true` (per-repo or under `defaults`; included in the exported config types).
  - Move `--filter` (sync-run shard targeting) into the config file by maintaining narrower per-environment configs.

  ### Internals
  - New `ConfigFileNotFoundError` typed error in `src/errors`; `loadConfigFile` throws it instead of a stringly-typed `Error`.
  - `runSingleRepository`, `reconstructCliCommand`, `isInteractiveMode`, `CliOptions` extras removed.
  - `InteractiveUIService.ReloadOptions` removed (the TUI no longer carries CLI overrides).
  - `Config` and `RepositoryConfig` gain three optional fields for the new clone-mode surface: `mode?: "clone" | "worktree"`, `branch?: string`, and `depth?: number`. Existing worktree-mode configs do not need to set them (defaults preserve current behavior); integrators with custom `Config` consumers may need to widen their types.

### Minor Changes

- 497c18e: Add `mode: "clone"` repository strategy. When set, the tool runs `git clone --branch <X> --single-branch` directly into `worktreeDir` — no bare repo, no `worktreeDir/<branch>` subfolder — and on each sync tick fetches + fast-forwards if the working tree is clean. Clone-mode initialize/sync operations now also emit structured progress notifications for branch resolution, clone/fetch progress, sparse-checkout, LFS verification, skip reasons, and fast-forward updates. Designed for monorepo sibling dependencies that require fixed relative paths between repos. The default mode remains `worktree` (no behavior change for existing configs).

  Shallow clone-mode repos (`depth: N`) no longer misclassify a fast-forward-able remote as `diverged` when `git merge-base` cannot walk past the shallow boundary. `GitService.classifyRemoteRelationship()` replaces the boolean `canFastForward()` check inside clone-mode and distinguishes `up_to_date`, `fast_forward`, `local_ahead`, `diverged`, and `indeterminate_shallow`. When the relationship is indeterminate, clone-mode now deepens the local view by successive absolute `--depth` targets (50 → 200 → 1000, skipping any target ≤ configured depth) and re-classifies after each step. If the budget exhausts without a verdict the run records a new `indeterminate_shallow` soft skip distinct from `diverged`, including the highest deepen target attempted, so operators can grep logs and choose to remove or raise `depth`.

- 497c18e: Add published config autocomplete types for JavaScript config files. Generated and example configs now use `// @ts-check` plus JSDoc `@satisfies` annotations with zero runtime imports, and the package publishes `dist/index.d.ts` for editors to resolve `SyncWorktreesConfig`.

### Patch Changes

- 497c18e: Internal polish follow-up to the CLI collapse refactor:

  - Extract `fileExists()` helper, dedupe 8 inline `fs.access` existence checks across config + status paths.
  - Replace `InitConfigInput` interface with `Pick<RepositoryConfig, ...>` so init wizard input type auto-tracks `RepositoryConfig`.
  - Add `CLI_COMMANDS` const + discriminated `CliOptions` union; `main()` now uses `switch` with exhaustive `never` guard so future commands fail at compile time.
  - Collapse `runMultipleRepositories` signature — takes the loaded `ConfigFile` directly and derives `runOnce` / `maxParallel` internally.
  - Multi-repo runner already sets `process.exitCode = 1` on any init/sync failure (shipped in the parent PR).

- 497c18e: Discoverability + AI-agent positioning:
  - Updated package description and added `mcp`, `model-context-protocol`, `claude-code`, `claude-desktop`, `cursor`, `ai-agent`, `ai-tools`, `agentic` keywords so the package surfaces in MCP/AI-agent searches on npm.
  - Restructured README: added shields.io badges, a "pick your path" Quickstart with CLI / Claude Code / generic-MCP-client snippets, and a "Why it pairs with AI agents" worked example showing the typical agent tool-call sequence.
  - Reordered the Features list to lead with the MCP server and the interactive TUI.
  - Added top-level `AGENTS.md` with bootstrap order, tool-selection guidance, and safety rules for agents using the MCP server.

## 3.6.3

### Patch Changes

- cf0889c: Make MCP repository discovery config-driven across multi-repo workspaces. `detect_context` now reports configured sibling repositories, including nested worktree directories and missing bare repo presence, can include all configured repo worktrees with `includeAllWorktrees`, and surfaces per-repo worktree enumeration errors. `list_worktrees` without `repoName` now groups worktrees across all configured repositories.
- 972e49a: Push newly created branches to origin by default from `create_worktree`, keep `push=false` as an explicit opt-out, and prevent created branches from inheriting the base branch's upstream.

## 3.6.2

### Patch Changes

- a68bebc: Stabilize the hook-execution test suite by awaiting actual child-process completion via the `onComplete` callback instead of a fixed 500 ms sleep, removing a flake that surfaced under the full parallel test run.
- a68bebc: Serialize MCP repository mutations through the same repo operation lock used by sync and correct the `load_config` tool response description.
- a68bebc: Fix MCP worktree creation for brand-new branches by making missing ref checks observable through simple-git and by accepting remote-qualified base branches.

## 3.6.1

### Patch Changes

- 3cf502b: Treat worktrees with stashed changes as unsafe to remove.

## 3.6.0

### Minor Changes

- 14254e1: feat(progress): emit clone/fetch progress to logger

  Long bitbucket clones and fetches felt like a hang because the TUI showed `Cloning from "..."` and then went silent for minutes while git negotiated the pack and resolved deltas. Output was being captured by simple-git but never surfaced.

  Changes:

  - `GitService` now wires simple-git's `progress` plugin and passes `--progress` to `git clone` and `git fetch`. Per-stage events (`receiving`, `resolving`, `compressing`, `writing`) are throttled to one log line every 25% so the TUI keeps a live "↳ clone receiving: 50% (12345/24690)" trail without flooding the log.
  - Applies to bare clone (`initialize`), the post-init `--all` refresh, `fetchAll`, and `fetchBranch`.
  - Per-call `progressState` reset between fetches so the same stage reports fresh buckets each run.

## 3.5.0

### Minor Changes

- dc4b39c: feat(sparse): skip fast-forward updates when upstream diff is outside sparse cone

  Sparse-checkout users in cone mode now avoid pointless `git merge --ff-only` work when the incoming commits only touch files outside the materialized include set — the working tree wouldn't have changed anyway. Saves LFS smudge, post-checkout hooks, and disk churn in monorepos that fan out one upstream into multiple sparse slices.

  Changes:

  - `SparseCheckoutConfig` gains `skipUpdateWhenOutsideSparse?: boolean` (default `true`). Set to `false` to keep HEAD strictly tracking remote even when no sparse files change.
  - New `SparseCheckoutService.pathsTouchSparse()` mirrors git's cone-mode materialization rules, including direct files in every ancestor of an included directory (e.g. include `tools/build` keeps `tools/foo.txt` checked out, so a change to that file still triggers an update).
  - New `GitService.getChangedPathsInRange()` runs `git -c core.quotePath=false diff --name-only --no-renames` between two refs. Returns `null` on git failure so the caller forces a safe update rather than silently skipping a behind worktree.
  - Wired into Phase 4a of `WorktreeSyncService.updateExistingWorktrees()` after the existing `isWorktreeBehind` check.

  No-cone mode falls through to the existing update path; gitignore-style pattern matching with negation is intentionally out of scope here.

  Trade-off: when an update is skipped, the worktree's local HEAD lags the remote tip. `git status` inside that worktree will show "behind by N commits" until upstream advances into the sparse area or `skipUpdateWhenOutsideSparse: false` is set.

## 3.4.0

### Minor Changes

- 25fcca0: fix(sync): prevent indefinite hang on stalled SSH and concurrent fetches

  Fetch operations (`git fetch`, `git clone`) had no timeout. A stalled SSH connection to the remote would leave the underlying `git`/`ssh` child processes sleeping forever; `pLimit` slots were held, `Promise.allSettled` never resolved, and the TUI status stayed on "Syncing..." indefinitely. If the parent process was killed, those child processes survived (reparented to PID 1) and a fresh process happily started overlapping fetches against the same bare repo.

  Changes:

  - `GitService` now constructs `simple-git` with `timeout: { block: ms }`. Inactivity beyond the window terminates the underlying `git` child via SIGINT (which propagates to its `ssh` transport via git's `cleanup_children_on_signal`).
  - New config knobs `fetchTimeoutMs` (default 5 min) and `cloneTimeoutMs` (default 15 min — clone can be silent longer during server-side pack resolution). Set to `0` to disable.
  - `WorktreeSyncService.sync()` now acquires a `proper-lockfile` lock on the bare repo's `HEAD` file. Concurrent runs from another process return `{ started: false, reason: "locked" }` and surface as a skipped repo in the orchestrator log instead of stomping on each other.
  - `SyncResult` extended with the new `"locked"` skip reason.

## 3.3.1

### Patch Changes

- 7d46873: Fix LFS verify failing on sparse-checkout worktrees when shell `EDITOR` is set. simple-git's argv-parser blocks `EDITOR`/`GIT_EDITOR`/`GIT_SEQUENCE_EDITOR` env vars unless `allowUnsafeEditor` is enabled, causing `git lfs ls-files` to error out and skip verification. The forwarded env now strips these vars before passing to simple-git.

## 3.3.0

### Minor Changes

- 4572011: Add `sparseCheckout` config option for monorepos. Each repo entry can declare `{ include, exclude?, mode? }` to clone only a subset of folders/files. Cone mode is the default; explicit excludes or `!`-negation patterns auto-promote to `no-cone`.

  Same `repoUrl` may now appear under multiple repository entries with different `name`s, sparse patterns, and `worktreeDir`s. The first entry per `repoUrl` keeps the URL-derived bare path (`.bare/<repo-slug>`); subsequent duplicates auto-derive `.bare/<sanitized-name>` so they do not collide. Pin `bareRepoDir` explicitly to make config order irrelevant.

  Sync-time reapply reconciles existing worktrees with the latest sparse config in parallel. Narrowing (removing previously included paths) is skipped with a warning when the worktree has uncommitted changes. Worktree creation now uses `git worktree add --no-checkout` followed by sparse setup and `git checkout HEAD`, with transactional rollback (worktree remove + branch delete for newly created branches) on any post-add failure. LFS verification picks up `GIT_ATTR_SOURCE=HEAD` so `.gitattributes` is honored under sparse on Git ≥ 2.42.

## 3.2.0

### Minor Changes

- 003498d: feat(mcp): inline connect-time worktree context into MCP `instructions`

  When the MCP server starts inside a managed sync-worktrees worktree, the `instructions` field served to the client now includes a `Connect-time context` block with `kind`, `currentWorktreePath`, `currentBranch`, and `configPath`. This lets agents orient without an initial `detect_context` round-trip.

  Snapshot is captured once at server construction. Sibling worktree lists, sibling repository lists, and capability state are intentionally **not** inlined — they belong behind a tool call to avoid prompt staleness and false-authority risk. Base guidance still directs the agent to call `detect_context` for live state.

  Falls back to the original static instructions when started outside a managed worktree.

### Patch Changes

- 003498d: fix(git): skip upstream tracking when remote branch missing in `addWorktree`

  `GitService.addWorktree` previously always attempted upstream tracking against `origin/<branch>`, even when the remote ref didn't exist (e.g. MCP `create_worktree` with `push: false` for a brand-new branch). Tracking failed and the code fell back to a non-tracking worktree add with a noisy warning.

  Now `addWorktree` probes both refs explicitly via `git show-ref --verify` and branches on `(localExists, remoteExists)`:

  - both exist → `worktree add` + `--set-upstream-to`
  - local-only → `worktree add` without upstream (push later via `pushBranch -u` to set tracking)
  - remote-only → `worktree add --track -b`
  - neither → throws a clear `WorktreeError`

  The `branchName.includes("/")` shortcut and the prune-retry path were updated to use the same matrix. No status/metadata service changes needed — `rev-list --not --remotes` already handles no-upstream worktrees correctly.

## 3.1.0

### Minor Changes

- cf558b1: Enrich MCP context discovery and worktree summaries.
  - `detect_context` now walks up from the inspected path to auto-load `sync-worktrees.config.{js,mjs,cjs}`, lists sibling repositories under the workspace root, and exposes `configPath` plus `notes[]` (renamed from `reasons`). The redundant `configLoaded` field is dropped — derive from `configPath !== null`.
  - Capabilities shape changed from `{ canX: boolean }` to `{ x: { available: boolean, reason?: string } }`, so consumers can see exactly why a capability is gated.
  - `detect_context` accepts `includeStatus` to enrich `allWorktrees` with `label`, `divergence`, and `staleHint`.
  - `list_worktrees` accepts `includeSize` (returns `sizeBytes`) and now returns `safeToRemove` as `{ safe, reason }` instead of a raw boolean.
  - New `ConfigLoaderService.findConfigUpward()` helper for upward config discovery.

## 3.0.1

### Patch Changes

- 80cfe1e: Fix bin paths in package.json by removing leading `./` prefix for broader package manager compatibility.

## 3.0.0

### Major Changes

- aa7d22b: Breaking changes in this release:

  **MCP server** — sync-worktrees now ships a Model Context Protocol server as a separate binary `sync-worktrees-mcp`. MCP-compatible clients (Claude Code, Claude Desktop, Cursor, Windsurf, etc.) can initialize repositories, list/create/remove/update worktrees, run syncs, load configuration files, detect repository context, and inspect worktree status directly. See the README for setup.

  **Drop Windows support** — the platform was never exercised in CI and hooks already refused to run there because cmd.exe shell quoting is unsafe. `package.json` now declares `os: ["darwin", "linux"]` so `npm install` warns Windows users. Removes `win32` branches from the terminal launcher, hook execution guard, case-insensitive FS check, and worktree list CRLF stripping.

### Minor Changes

- aa7d22b: New features:
  - **Auto-discover config in CWD** — running `sync-worktrees` in a directory now probes for `sync-worktrees.config.{js,mjs,cjs}` and auto-loads it when no `--config` flag or single-repo CLI args are passed. Interactive wizard now routes the saved config through the same multi-repo pipeline, so first-run and subsequent runs share one execution path.
  - **Worktree status view** — press `w` in the interactive UI to see health/status of all worktrees at a glance, with indicators for uncommitted changes, unpushed commits, stashes, operations in progress, and deleted upstream branches. Press Enter on any worktree to expand detailed file counts and reasons.
  - **Diverged directory management** — inspect and delete `.diverged` directories (worktrees preserved when their remote branch was deleted but local changes existed) directly from the status view. Shows original branch name, size, and divergence date; press `d` to delete with `y/n` confirmation.
  - **Lifecycle hooks** — `onBranchCreated` hook support lets users run commands (open editor, start tmux session, etc.) when a new branch worktree is created via the interactive UI.
  - **Branch creation wizard** — filtering/search for projects and branches, fetch before listing.
  - **InteractiveUIService improvements** — config reload support, parallel execution with p-limit, grouped cron jobs, graceful shutdown via signal handlers.

### Patch Changes

- aa7d22b: Fixes and hardening:
  - Fix branch creation failing on a fresh start: `GitService.initialize()` now always fetches remote refs instead of only fetching during initial clone.
  - Fix path traversal vulnerability in diverged directory deletion: validate that the resolved path stays inside `.diverged` before calling `fs.rm`.
  - Fix destructive initialization behavior: revert `GitService.initialize()` to graceful "already exists" error handling instead of preemptively deleting directories with `fs.rm`.
  - Skip worktree removal on status check failure instead of risking dirty worktree removal.
  - Rollback worktree on metadata creation failure.
  - LFS skip via service method instead of mutating `process.env`.
  - Remove `hasStashedChanges` from worktree removal safety gate: stashes live in the repository, not the worktree directory.
  - Add early return in `getFullWorktreeStatus()` for non-existent worktree paths, preventing cascading status check failures.
  - Metadata service hardening: atomic writes, branch name sanitization in paths, auto-create metadata on update when missing.
  - Path resolution security: use `path.resolve()` to prevent path traversal edge cases.
  - Config loader: resolve `filesToCopyOnBranchCreate` paths relative to config dir, escape special characters in wildcard filters.
  - Keyboard navigation correctly skips the visual separator between worktrees and diverged entries in status view.

## 2.2.0

### Minor Changes

- 345a430: Add interactive UI commands and improvements

  ### New UI Commands
  - Press `c` to open the **Branch Creation Wizard** - create and push new branches with validation
  - Press `o` to open the **Editor Wizard** - quickly open your editor in any worktree
  - Arrow keys to scroll through logs in the new **Log Panel**

  ### New Configuration Option
  - `filesToCopyOnBranchCreate` - specify files to automatically copy from the base branch when creating new branches (e.g., `.env.local`, config files)

  ### CLI Changes
  - Add `--sync-on-start` flag for config mode - UI now starts immediately without initial sync by default
  - Use `--sync-on-start` to restore previous behavior (sync on startup)

  ### New Services
  - `FileCopyService` - handles copying configured files to new branches
  - `triggerInitialSync()` public method on `InteractiveUIService`

  ### Internal Improvements
  - Event-based UI communication via `appEvents` utility
  - Enhanced logger with UI output function support
  - Git service additions: `branchExists`, `createBranch`, `pushBranch`

### Patch Changes

- 345a430: Fix false "diverged branch" detection when local is ahead of remote

  Previously, when a local branch had unpushed commits (ahead of remote), the sync would incorrectly treat it as a diverged branch and move the worktree to `.diverged/`. This happened because `canFastForward` returns false when local is ahead of remote.

  Now, when a branch cannot fast-forward, we check if local is simply ahead of remote (has unpushed commits). If so, we skip the worktree with a message instead of treating it as diverged. Truly diverged branches (where local and remote have different commits not in a linear history) are still handled correctly.

## 2.1.0

### Minor Changes

- f4d7d7f: Add improvements to support parallel operations
  - Add total concurrency validation to prevent resource exhaustion. Configs now validate that total concurrent operations (maxRepositories × per-repo limits) don't exceed safe limit of 100.
  - Add exponential backoff with jitter support to prevent thundering herd problem in concurrent Git operations. Configure via `retry.jitterMs` option.

## 2.0.0

### Major Changes

- d7533c3: # Interactive Terminal UI with ink + Vitest Migration

  ## Breaking Changes

  ### Test Framework: Jest → Vitest
  - Migrated all 31 test files to Vitest for native ESM support
  - Enables React component testing with ink-testing-library
  - **Impact**: CI/CD pipelines must update test commands
  - **Migration**: Replace `jest` with `vitest run`, `jest --watch` with `vitest`

  ### Build System: TypeScript Compiler → esbuild
  - Switched to esbuild for ESM bundling with better performance
  - Output is now single bundled file instead of transpiled modules

  ## New Features

  ### Interactive Terminal UI (ink-based)
  - **Real-time sync status display** with live updates showing idle/syncing state
  - **Keyboard controls**:
    - `?` or `h` - Toggle help modal
    - `s` - Trigger manual sync
    - `r` - Reload configuration
    - `q` or `Ctrl+C` - Graceful quit

## 1.8.0

### Minor Changes

- 4958da3: Smart divergence detection - only move worktrees to `.diverged` when you've made local changes

  Enhanced divergence handling to avoid unnecessary `.diverged` moves. Previously, when someone force-pushed a branch (e.g., after a rebase), sync-worktrees would move your worktree to `.diverged` even if you hadn't made any local changes - it was just a stale snapshot of the old remote state.

  **Changes:**

  - Checks if you've made local commits since last sync using metadata
  - If HEAD == lastSyncCommit: Just resets to new upstream (no local changes)
  - If HEAD != lastSyncCommit: Moves to `.diverged` (preserve your work)
  - If metadata is missing: Safely moves to `.diverged` (conservative default)

  **Result:**
  `.diverged` now only contains worktrees with actual user work that needs review, not stale upstream snapshots.

## 1.7.5

### Patch Changes

- 3f91a81: Fix false positive "unpushed commits" warnings for branches with slashes in names

  Fixed a critical bug where branches with slashes in their names (e.g., `fix/test-branch`, `feature/new-feature`) would incorrectly report "unpushed commits" even when they were cleanly synced and merged.

  **Root Cause:**

  - Git stores worktree metadata using the basename of the worktree path (e.g., `.git/worktrees/test-branch/`)
  - sync-worktrees was using the full branch name with slashes (e.g., `.git/worktrees/fix/test-branch/`)
  - This path mismatch caused metadata loading to fail, triggering false positives

  **Changes:**

  - Added path-based metadata methods that correctly derive the worktree directory name from the worktree path
  - All metadata operations now use `path.basename()` to match Git's internal structure
  - Added automatic migration from old incorrect paths to new correct paths
  - Updated all callsites in GitService to use the new path-based methods

  **Migration:**
  Existing worktrees with metadata in the old (incorrect) path will be automatically migrated to the correct path on first load. The old metadata files will be cleaned up automatically.

- 3f91a81: Fix error when "origin" appears as a branch name causing sync failures. Added early prune at sync start to clean stale worktree registrations, filtered invalid branch names like "origin" from remote branch lists, and improved error handling for "already registered worktree" errors with automatic retry after pruning.
- 3f91a81: fix: correctly detect squash-merged branches with deleted upstreams

  Fixed a bug where worktrees for squash-merged branches (where the remote branch was deleted) were incorrectly flagged as having "unpushed commits" even when they had never been touched locally.

  The issue occurred because `hasUpstreamGone()` returned `false` when Git couldn't resolve `@{upstream}` due to the remote branch being deleted. This caused the metadata-based check to be skipped, falling back to `git rev-list --count <branch> --not --remotes`, which incorrectly counted the original (now-squashed) commits as "unpushed".

  The fix checks the branch's upstream configuration when `@{upstream}` resolution fails, and verifies whether the configured remote branch actually exists. This allows the metadata-based check to run, which correctly reports zero unpushed commits for untouched worktrees.

## 1.7.4

### Patch Changes

- 762daf8: Fix error when "origin" appears as a branch name causing sync failures. Added early prune at sync start to clean stale worktree registrations, filtered invalid branch names like "origin" from remote branch lists, and improved error handling for "already registered worktree" errors with automatic retry after pruning.

## 1.7.3

### Patch Changes

- 8218f24: Fix prettier formatting errors and test issues causing pipeline failures

## 1.7.2

### Patch Changes

- 19f4b8b: Improve core sync robustness and add targeted tests:

  - Fix branch-by-branch fetch to update remote refs (refs/remotes/origin/\*) instead of local branches; respect LFS skip.
  - Resolve actual gitdir in worktrees for operation-in-progress detection (handles .git file case).
  - Fallback to copy+remove when moving diverged worktrees across devices (EXDEV).
  - Ensure parent directories exist before creating nested worktrees.
  - Skip updating worktrees with active operations (merge/rebase/etc.).
  - Always retain default branch even when branchMaxAge filtering is applied.

  Tests added:

  - fetchBranch remote ref behavior and LFS env usage.
  - hasOperationInProgress via .git file gitdir resolution.
  - getRemoteCommit uses bare repo for stability during divergence.
  - Diverged move EXDEV fallback path (cp+rm).
  - Skip updates during active operations.
  - Default branch retention under branchMaxAge.

## 1.7.1

### Patch Changes

- 7086452: Fix diverged branch detection and recovery mechanism

  - Improve `canFastForward` detection using merge-base comparison for more reliable divergence detection
  - Add recovery mechanism for fast-forward failures during updates

  This fixes the issue where branches that cannot be fast-forwarded would fail with an error instead of being properly handled as diverged branches.

## 1.7.0

### Minor Changes

- 22d406d: Add smart handling for rebased and force-pushed branches

  - Automatically detect when branches have been rebased or force-pushed
  - Reset branches to upstream when file content is identical (clean rebase)
  - Move branches with diverged content to `.diverged` directory
  - Preserve local changes while keeping worktrees in sync with upstream
  - Add comprehensive test coverage for all edge cases
  - Prevent race conditions with unique diverged names
  - Support branch names with special characters

  This feature helps developers who work with rebased branches by automatically handling the common case where branches are rebased but have identical content, while safely preserving any local changes that differ from upstream.

## 1.6.3

### Patch Changes

- 5479f0b: fix: handle detached HEAD worktrees and skip metadata for main worktree

  - Add detached HEAD detection to prevent ambiguous argument errors
  - Skip metadata operations for the main worktree (not in worktrees dir)
  - Update worktree parsing to exclude detached HEAD worktrees
  - Add comprehensive tests for all new edge cases

  This fixes the "ambiguous argument" error for worktrees in detached HEAD state
  and removes the unnecessary "No metadata found for worktree main" warning.

## 1.6.2

### Patch Changes

- 01be2e9: Fix orphaned directory cleanup in LFS error fallback path
  - Added orphaned directory cleanup when worktree tracking setup fails
  - Prevents directories from being left behind after LFS errors or other failures during retry
  - Ensures consistent cleanup behavior across all error scenarios

## 1.6.1

### Patch Changes

- a03b565: Fix orphaned directory cleanup when worktree creation fails
  - Clean up orphaned directories before creating worktrees to handle cases where previous attempts failed (e.g., due to LFS errors)
  - Check if a directory is already a valid worktree before attempting to create it
  - Prevent "already exists" errors when retrying after failures

## 1.6.0

### Minor Changes

- 242bcdd: Improve warning messages for branches with deleted upstream

  When a branch's upstream is deleted (e.g., after squash merge), sync-worktrees now shows clearer messages explaining why the worktree cannot be automatically removed. The new messages guide users to manually review and clean up if their changes were already integrated.

  **Example:**

  ```
  ⚠️ Cannot automatically remove 'feat/LCR-5982' - upstream branch was deleted.
     Please review manually: cd worktrees/feat/LCR-5982 && git log
     If changes were squash-merged, you can safely remove with: git worktree remove worktrees/feat/LCR-5982
  ```

- 242bcdd: Add sync metadata tracking to accurately detect unpushed commits

  Sync-worktrees now tracks synchronization metadata for each worktree, storing information about the last synced commit. This enables accurate detection of truly unpushed commits when a branch's upstream has been deleted (e.g., after squash merge).

  **Benefits:**

  - Accurately detects new commits made after the upstream was deleted
  - Allows safe cleanup of worktrees whose changes were already integrated via squash merge
  - Prevents false positives where all commits appeared as "unpushed" after upstream deletion

  **Technical details:**

  - Metadata is stored in Git's worktree directory: `.git/worktrees/[worktree-name]/sync-metadata.json`
  - Automatically created when adding worktrees and updated during sync operations
  - Backward compatible - works seamlessly with existing setups

## 1.5.0

### Minor Changes

- 13d10f8: Add automatic updates for existing worktrees
  - New feature: Automatically update worktrees that are behind their upstream branches during sync
  - Updates are performed using fast-forward merge only (safe, no merge commits)
  - Only clean worktrees (no local changes) are updated
  - Feature is enabled by default but can be disabled via:
    - CLI flag: `--no-update-existing`
    - Config option: `updateExistingWorktrees: false`
  - Improved error handling to skip worktrees with missing directories
  - Suppressed test environment warnings for cleaner test output

## 1.4.0

### Minor Changes

- ee7f2be: feat: add Git LFS error handling and skip option
  - Added `--skip-lfs` CLI option to bypass Git LFS downloads when fetching and creating worktrees
  - Added `skipLfs` configuration option for config files
  - Implemented automatic retry with LFS skipping when LFS errors are detected
  - Added branch-by-branch fetching as fallback when fetch-all fails due to LFS errors
  - Enhanced retry mechanism to detect and handle LFS-specific errors
  - Added `maxLfsRetries` configuration to prevent infinite retry loops on persistent LFS errors
  - Improved error resilience for repositories with missing or corrupted LFS objects
  - Fixed E2E tests to handle different Git default branch configurations

## 1.3.2

### Patch Changes

- d9b1690: Fix: Filter out origin/HEAD from branch synchronization

  Previously, the tool would attempt to create a worktree for the special `origin/HEAD` reference, which would fail with the error "'HEAD' is not a valid branch name". This fix ensures that:

  - `origin/HEAD` is filtered out when listing remote branches
  - No worktree creation is attempted for HEAD references
  - The tool can be run multiple times without errors
  - Any orphaned HEAD directories are cleaned up automatically

  This resolves issues when syncing repositories that have `origin/HEAD` pointing to their default branch.

## 1.3.1

### Patch Changes

- e34624d: Fix branchMaxAge configuration not being applied from config files
  - Fixed issue where `branchMaxAge` setting was not being copied during config resolution
  - The branch age filter now properly works when configured in repository-specific or default settings

## 1.3.0

### Minor Changes

- ad8d5d3: Add branch age filtering feature to only sync recently active branches
  - Added `--branchMaxAge` CLI option to filter branches by last commit activity
  - Support for duration formats: hours (h), days (d), weeks (w), months (m), years (y)
  - Can be configured globally or per-repository in config files
  - Helps reduce clutter and save disk space by ignoring stale branches
  - Example: `--branchMaxAge 30d` only syncs branches active in the last 30 days

## 1.2.3

### Patch Changes

- 4deaa7e: Automatically detect and use the repository's default branch instead of hardcoding "main". The tool now:
  - Detects the default branch from the repository's HEAD reference
  - Falls back to common branch names (main, master, develop, trunk) if detection fails
  - Works correctly with repositories using different default branch names

## 1.2.2

### Patch Changes

- acf60f5: Fix worktrees tracking and creation
  - Added fetch before creating main worktree to ensure remote branches exist
  - Better error handling for cases where worktree directories already exist

## 1.2.1

### Patch Changes

- 95690df: Fix worktrees to properly track remote branches

  Worktrees created by sync-worktrees now have proper upstream tracking configured, allowing `git pull` to work without specifying the remote and branch. This was the expected behavior and improves the Git workflow experience when working with synced worktrees.

  - Worktrees are now created with `--track` flag to automatically set up tracking
  - If a local branch already exists, upstream tracking is configured after worktree creation
  - Fallback to non-tracking worktree creation if remote branch doesn't exist yet

## 1.2.0

### Minor Changes

- 2db3401: feat: add comprehensive safety checks to prevent accidental worktree deletion

  - Added stash detection to preserve worktrees with stashed changes
  - Added submodule modification detection to protect worktrees with dirty submodules
  - Added Git operation detection (merge, rebase, cherry-pick, bisect, revert) to prevent deletion during ongoing operations
  - Enhanced error handling with conservative approach - when in doubt, don't delete
  - Improved logging to clearly indicate why each worktree deletion was skipped

  This ensures that no worktree with any type of changes or ongoing operations will be accidentally deleted, providing robust data protection for developers.

## 1.1.0

### Minor Changes

- 5864b09: Add retry mechanism for network and filesystem operations
  - Added configurable retry mechanism with exponential backoff for handling transient failures
  - Sync operations now automatically retry on network errors (ECONNREFUSED, ENOTFOUND, ETIMEDOUT) and filesystem errors (EBUSY, ENOENT, EACCES)
  - Added retry configuration options:
    - `maxAttempts`: Number of retry attempts or "unlimited" (default: 3)
    - `initialDelayMs`: Initial delay between retries (default: 1000ms)
    - `maxDelayMs`: Maximum delay between retries (default: 30s)
    - `backoffMultiplier`: Exponential backoff multiplier (default: 2)
  - Retry configuration can be set globally, in defaults, or per repository
  - Added logging for retry attempts to help with debugging transient failures

## 1.0.0

### Major Changes

- 8fa5c8b: ## 🎉 sync-worktrees v1.0.0 - Stable Release

  This marks the first stable release of sync-worktrees! The tool is now feature-complete and production-ready.

## 0.6.0

### Minor Changes

- 7c16278: Add default worktree directory based on repository name
  - Interactive setup now suggests `./[repo-name]` as the default worktree directory
  - Users can press Enter to accept the default or provide a custom path
  - Reduces the number of required inputs during setup
  - Creates a cleaner directory structure without unnecessary nesting

### Patch Changes

- 7c16278: Fix bare repository path resolution to prevent deletion during cleanup

  When using the current directory as the worktree directory, the bare repository
  was being created with a relative path that would then be incorrectly identified
  as an orphaned directory and deleted during cleanup. This fix ensures the bare
  repository path is always resolved to an absolute path.

## 0.5.1

### Patch Changes

- 1e0743e: Add support for SSH URLs with ssh:// protocol
  - Updated URL validation in interactive mode to accept ssh:// URLs (e.g., ssh://git@bitbucket.com/user/repo.git)

## 0.5.0

### Minor Changes

- 41eb851: feat: implement space-efficient bare repository storage
  - Changed from regular Git repositories to bare repositories with worktrees
  - Replaced `repoPath` CLI parameter with automatic bare repository management
  - All worktrees now share a single Git object database, significantly reducing disk usage
  - Added utilities for Git URL parsing and improved test structure

## 0.4.1

### Patch Changes

- 8d3a34f: Exclude test files from the npm package by updating TypeScript configuration

## 0.4.1

### Patch Changes

- e4970bd: Fix handling of branch names containing slashes
  - Fixed orphaned directory cleanup to properly handle nested directory structures created by branches with slashes (e.g., `feat/feature-name`)
  - Updated worktree removal to use full paths instead of branch names, ensuring Git can properly locate worktrees in nested directories
  - Parent directories of slash-named branches are no longer incorrectly identified as orphaned and removed
  - Resolves the issue where worktrees were repeatedly created and their parent directories removed in a cycle

## 0.4.0

### Minor Changes

- 8e9ad44: Add config file support for managing multiple repositories

  - Added support for JavaScript configuration files to manage multiple repositories with different settings
  - New CLI options: `--config` to specify config file, `--filter` to select specific repositories, and `--list` to show configured repositories
  - Interactive mode now prompts users to save their configuration to a file for future use
  - When specifying a non-existent config file, users are prompted to create one through interactive setup
  - Config files support environment variables, dynamic paths, and can use relative paths
  - Added comprehensive validation for config files with helpful error messages
  - Maintains full backward compatibility - existing single-repository CLI usage continues to work

  Example config file:

  ```javascript
  module.exports = {
    defaults: {
      cronSchedule: "0 * * * *",
      runOnce: false,
    },
    repositories: [
      {
        name: "my-project",
        repoUrl: "https://github.com/user/repo.git",
        repoPath: "./repos/my-project",
        worktreeDir: "./worktrees/my-project",
      },
    ],
  };
  ```

### Patch Changes

- 8e9ad44: Fix worktree sync failing on restart due to orphaned directories

  - Changed worktree detection to use Git's actual worktree list (`git worktree list`) instead of filesystem directories
  - Added automatic cleanup of orphaned directories that exist on disk but aren't registered Git worktrees
  - Fixed the error "fatal: '/path/to/worktree' already exists" that occurred when restarting after directories were left behind
  - Added comprehensive tests for edge cases including orphaned directory handling

  This ensures the tool works correctly even after system restarts or when directories exist without corresponding Git worktree metadata.

## 0.3.1

### Patch Changes

- 58e9cf1: Fix error when the current branch in base repository conflicts with worktree creation

  Previously, sync-worktrees would fail with a "fatal: 'branch' is already checked out" error when attempting to create a worktree for a branch that was currently checked out in the base repository. This fix now detects the current branch and skips creating a worktree for it, preventing the error while still creating worktrees for all other remote branches.

## 0.3.0

### Minor Changes

- 3d62289: Display CLI command for future reference

  When running sync-worktrees, the tool now displays the exact CLI command that can be used to replicate the current execution. This is shown after configuration is determined (both in interactive and non-interactive modes) and helps users understand how to run the tool directly from the command line with the same parameters.

  The command is displayed in the format:

  ```
  📋 CLI Command (for future reference):
     sync-worktrees --repoPath "/path/to/repo" --worktreeDir "/path/to/worktrees" --runOnce
  ```

- 007d71f: Add initial sync when running in scheduled mode

  When running sync-worktrees in scheduled mode (without --runOnce flag), the tool now performs an initial sync immediately upon startup before waiting for the first scheduled run. This ensures worktrees are synchronized right away instead of waiting for the next cron trigger.

## 0.2.0

### Minor Changes

- 09173a5: Added interactive mode for easier configuration
  - When run without arguments, the tool now launches an interactive setup wizard
  - Prompts users for all required configuration values:
    - Repository path (supports relative paths, automatically converted to absolute)
    - Repository URL (only prompted if the repository doesn't exist)
    - Worktree directory (supports relative paths)
    - Run mode (once or scheduled with cron)
    - Cron schedule (if scheduled mode is selected)
  - Shows a configuration summary before proceeding
  - Makes the tool more user-friendly for first-time users
  - Existing command-line argument usage remains unchanged

## 0.1.1

### Patch Changes

- 941d379: Improved worktree cleanup logic - now checks for unpushed commits before removal to prevent data loss

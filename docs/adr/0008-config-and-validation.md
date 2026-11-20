# ADR-0008: Configuration and validation

- **Status:** Accepted
- **Date:** 2026-11-20
- **Source:** 209 code comments as of `5f17242`, moved here by [ADR-0001](./0001-record-decisions-in-adrs-not-comments.md)

## Context

Configuration is a JavaScript or TypeScript module evaluated at startup and on reload, validated against a zod schema, with defaults inherited by repository entries. Errors must point the person at their own file, and a reload must not keep stale module state.

## Decisions

Grouped by the file that implements them, source before tests. Each entry names the symbol it governs.

### `src/constants.ts`

- **DEFAULT_CONFIG.PARALLELISM.MAX_SAFE_TOTAL_CONCURRENT_OPS**: MAX_SAFE_TOTAL_CONCURRENT_OPS caps concurrent git processes across a run. Config validation checks it as maxRepositories times the widest sync phase, because phases run sequentially so their limits are never summed, and a phase sharing one git client counts only what that client's scheduler allows. The shipped defaults peak at 2 x 20 = 40.
- **CONFIG_FILE_NAMES**: Config discovery includes .ts because Node 24 (the minimum engine) strips erasable TypeScript by default, so a .ts config loads through ordinary import() with no flag or transpiler. .mts and .cts are excluded because each extra name costs a stat per directory during walk-up, the ESM-under-commonjs case already fails with moduleSyntaxHint naming the fix, and the MCP instructions and detect_context advertise exactly these names. The rationale is a line comment because tsc copies JSDoc on exported declarations into the shipped .d.ts.
- **CONFIG_FILE_NAMES**: CONFIG_FILE_NAMES is the auto-discovery order for findConfigUpTree; within a directory the first matching name wins.

### `src/errors/index.ts`

- **ConfigValidationIssue.field**: A config validation issue's field is a path into the config file, such as repositories[1].cronSchedule or defaults.retry.maxAttempts.
- **ConfigValidationIssue.repository**: A config validation issue's repository is the name of the repository entry containing the field, when it has one, and is only used in the formatted message.
- **MAX_LISTED_VALIDATION_ISSUES**: Config validation lists at most ten issues and counts the rest, so one systematic mistake cannot flood the terminal.
- **ConfigValidationError**: ConfigValidationError's field and reason describe the first problem, issues holds every problem found, and the message lists them one per line in the same format.

### `src/index.ts`

- **runMultipleRepositories**: syncOnStart and runOnce are read from the config file defaults, not per repository, because they are whole-process switches and the loader rejects them on repository entries; the daemon runs exactly one startup cycle across all services.

### `src/services/bare-repo.service.ts`

- **BareRepoService.assertBareRepoOriginMatches**: An existing bare repo is found by path alone and the default bareRepoDir is .bare/<repo-name>, shared by different orgs' repos of the same name, so its origin must match the configured repoUrl before anything is fetched. URLs are compared normalized (scheme/host case, trailing slash, forge .git) and shown redacted; an unreadable origin is not a mismatch. The stored remote.origin.url is read rather than remote get-url, which applies insteadOf.

### `src/services/config-loader.service.ts`

- **moduleSyntaxHint**: A config written in ESM but parsed as CommonJS (.cjs, or .js under a type: commonjs package.json) only surfaces as a bare SyntaxError about export, so the loader appends a hint naming the file and fix, never replacing the original message.
- **typeStrippingHint**: A .ts config runs under Node's type stripping, which refuses syntax that emits code (enum, namespace, parameter properties, decorators) with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX and an unhelpful message, so the loader appends a hint. It keys on the error code rather than text, which also survives the reload worker boundary, and is not restricted to .ts paths because a .js config importing a .ts sibling raises the same code.
- **sourcePathFromFrame**: ESM stack frames name modules by URL, so they are converted with fileURLToPath, which unescapes the path and, reading only the pathname, drops the ?t= cache-buster importConfigModule appends; CommonJS frames are already plain paths.
- **CJS_COMPILE_DECORATION**: Node decorates a CommonJS compile failure with the resolved filename and line alone on the first stack line; the pattern anchors on an absolute path (drive letter, separator or UNC root) because module.filename is always absolute and the alternative first line Name: message can also end in :digits, and it takes everything in between as the path so spaces or brackets parse.
- **STACK_FRAME**: Stack frames are parsed by trying the parenthesised form first, opening at the first ( rather than the last, because a path like /home/me/proj (old)/config.cjs contains brackets and a greedy match would return the wrong path; the bare at <location> form, optionally async, is the fallback.
- **FRAME_POSITION**: Frame positions are split at the last two colons so the file part may contain other colons.
- **stackPosition**: Config error positions are read from the stack in two shapes measured identically on Node 20, 22 and 24: a CommonJS compile failure is prefixed with file:line, source line and caret before the SyntaxError header, while errors thrown during evaluation carry an ordinary frame where the first non-internal frame is the location. An ESM parse failure carries neither, because V8 keeps the position on a message object Node discards once caught, so those report the file alone.
- **stackPosition**: Frames from node: (Node internals) and data: (the reload worker bootstrap, a screen-wide percent-encoded URL) are skipped when locating a config error, since pointing the user at either would be worse than saying nothing.
- **configErrorLocation**: Config load failures always name the config path and append the stack position when there is one, because an error thrown by a module the config imports points elsewhere and both halves matter.
- **configPathsEvaluatedInProcess**: The set of config paths already evaluated is module-level, not per ConfigLoaderService instance, because it tracks Node's per-process module registry, and handleReload and every CLI command construct a fresh loader; a per-instance set would always see a first load and reload in-process with stale imports. config-loader.esm-reload.test.ts pins this with a reload through a second ConfigLoaderService.
- **CONFIG_EVAL_WORKER_SOURCE**: Config reloads evaluate in a worker thread because its empty module registry rereads the whole transitive import graph, whereas a ?t= query only busts the config file itself (and Node's ESM-to-CJS bridge ignores it entirely). The bootstrap is passed as a data:text/javascript URL rather than eval: true, because an eval'd worker is classified like node -e and breaks require when started from a type: module directory, while a data URL is always a module.
- **workerEvalError**: The reloaded config crosses back via structured clone, preserving undefined (distinct from absent for resolveRepositoryConfig), NaN, Infinity, -0, Date, RegExp, BigInt, Map and Set, while functions, symbols, WeakMaps and Proxies are refused and class instances become plain objects. No public config field is function-valued, so an uncloneable export is reported as an error rather than silently falling back to the stale config.
- **workerEvalError**: Worker errors are rebuilt rather than rethrown because an Error does not cross a thread boundary as itself; name is carried over because moduleSyntaxHint keys off it.
- **CONFIG_RELOAD_TIMEOUT_MS**: Config reload evaluation is abandoned after 30 seconds, because a config awaiting something that never settles while holding a live handle would hang the reload forever, and both the dashboard's r and MCP load_config wait on it; Node's own detector only catches the handle-free case.
- **reloadTimeoutError**: The reload timeout error is built without stack frames, because the loader's own frames are no place to send someone fixing a config.
- **evaluateConfigInWorker**: process.argv is passed to the reload worker in workerData rather than the Worker argv option, because a config branching on CLI flags must see exactly the argv of its first evaluation, and the option can only append to the worker's own array.
- **evaluateConfigInWorker**: On reload timeout the worker is terminated, which stops the thread even mid-loop and frees whatever the config was holding.
- **ConfigLoaderService.loadConfigFile**: Only failures from evaluating the config file get a stack location; past evaluation the first frame is the loader's own code, and those validation messages already name the offending field.
- **ConfigLoaderService.importConfigModule**: The first evaluation of a config path in a process runs on the main thread, which is free and keeps the exported object exactly as built (every one-shot CLI run, daemon start and MCP start); only a reload (TUI r, repeat load_config) pays for a worker, since only then is there a populated module registry to escape.
- **ConfigLoaderService.resolveRepoDirs**: A repository entry's on-disk directories are resolved by one helper against the config file's directory, so the same derivation, including the .bare/<name> fallback for duplicate repoUrls, serves both the entry being resolved and each sibling.
- **ConfigLoaderService.resolveRepoDirs**: A repoUrl served at a web root (https://git.example.com) is clonable but yields no repository name, so it is refused only where a name is needed (the default bare repo directory), not at the repoUrl check where it would block a working configuration. Unparseable URLs are already refused by the schema, so resolveRepoDirs only checks the parse-without-name case.
- **ConfigLoaderService.collectConfiguredRepoDirs**: Collecting every directory the config hands to repositories skips a sibling whose own resolution throws, because that error still surfaces unchanged on the sibling's turn, and a missing exclusion is safer than misattributing the error to the entry being resolved.
- **ConfigLoaderService sibling directory collection**: When collecting sibling repositories' directories for overlap checks, a sibling whose directories cannot be resolved is skipped; its own resolveRepositoryConfig call reports the error.
- **ConfigLoaderService.resolveRepositoryConfig**: fetchTimeoutMs and cloneTimeoutMs are resolved by testing against undefined rather than truthiness, because 0 is a real setting meaning no inactivity kill and a truthiness test would discard it in favour of the 5/15-minute defaults; both GitService and CloneSyncService read them.
- **ConfigLoaderService.resolveRepositoryConfig**: parallelism resolves top level, then defaults, then the repository, the same precedence as retry, so a parallelism block written at top level as the example config shows actually reaches every repository.
- **ConfigLoaderService.detectPathCollisions**: Config entries are rejected when they share a worktreeDir or bareRepoDir or when one's worktreeDir overlaps another's bareRepoDir; each entry's own separation is checked in resolveRepositoryConfig, and a worktreeDir nested inside another entry's worktreeDir is allowed with a warning.
- **ConfigLoaderService.rejectWorktreeBareOverlap**: One entry's worktreeDir may not sit at or under another's bare repo, where worktrees would land in git's object store, and the bare repo may not sit under the worktreeDir, where sync would treat it as a stale checkout directory.

### `src/services/config-schema.ts`

- **cappedByOneClient / asConfigured**: Parallelism phases whose units each get their own git client run at the configured width, while phases whose git command goes through one cached simple-git client are capped at SIMPLE_GIT_CLIENT_CONCURRENCY (measured: 40 concurrent fetches through one client peak at 5). Creation and removal are capped this way for worktree add/remove, but each unit also runs commands on the new worktree's own client (maxWorktreeCreation 40 measured at 15 processes), so the cap bounds growth rather than pinning it.
- **PARALLELISM_PHASES**: Parallelism phases run sequentially (create, prune, update, with update's probes and fast-forwards also sequential), so a repository's peak is its widest phase, not the sum. Counts are git processes this tool spawns; git's own children are outside the model, and git submodule status was measured on git 2.43 at about three processes per call, so a budget spent on superproject probes costs roughly three times its size.
- **PARALLELISM_PHASES**: The status-check phase runs exactly at its configured width because WorktreeStatusService enforces it with a shared process budget.
- **CLONE_MODE_CONFLICTING_FIELDS**: CLONE_MODE_CONFLICTING_FIELDS is exported so a test can check the shipped example config's clone-mode comment, which enumerates these names, after it silently fell behind once when trash was added.
- **because**: Every schema rule uses one error map giving the rule's reason plus what was found (or is required for an absent key), so each setting has one sentence covering both wrong type and wrong value.
- **numberWhere**: numberWhere builds on z.number, which already refuses NaN and Infinity; that keeps the comparison-based bounds honest, since NaN fails every comparison and a bound alone would let it through.
- **whenClean**: Cross-field config rules run only on a block whose own fields all passed, so they never reason about an invalid value.
- **positiveDuration**: Duration settings such as the gc throttle must be positive: zero parses but would disable throttling entirely and run gc every tick.
- **MAX_AGE**: branchMaxAge must be greater than zero, since zero keeps no branch and prunes every worktree, and under 200000y, since past about 273000 years the cutoff becomes an Invalid Date.
- **BLANK_BRANCH_PATTERN**: Empty or whitespace-only branchInclude/branchExclude patterns are rejected because they match no branch while filterBranchesByName applies an include list on length alone, so branchInclude: [''] keeps nothing and prune sees every non-default worktree as unmanaged. This commonly arrives from splitting an unset environment variable, which yields [''] rather than [].
- **gitTimeoutMs**: fetchTimeoutMs and cloneTimeoutMs admit 0 to mean no inactivity kill, since both services only set the simple-git option when blockMs > 0. Values above setTimeout's 2^31-1 ceiling are rejected because Node would replace them with 1 ms, and a one-second floor catches a window mistakenly given in seconds that would kill nearly every fetch.
- **retrySchema**: retry values were measured against retry(): NaN or Infinity maxAttempts throws before the first attempt (unlimited is spelled as the string), a NaN delay or multiplier or Infinity jitter becomes a 1 ms setTimeout and hundreds of attempts per second, maxDelayMs Infinity lets backoff run into days, and a non-finite maxLfsRetries never trips. Delays and multiplier may be fractional; only the two counts must be whole.
- **parallelismLimit**: Every parallelism number reaches pLimit at the start of a sync phase, and p-limit throws mid-sync, after the fetch and non-retryably, for 0, negatives, fractions, NaN or strings, so they are validated as positive integers. Infinity, which p-limit allows, is excluded because an unbounded phase has no peak to weigh against MAX_SAFE_TOTAL_CONCURRENT_OPS.
- **parallelismSchema.maxBranchFetches**: parallelism.maxBranchFetches is deprecated and has no effect, but is still validated so older configs load unchanged; the loader warns that it should be removed.
- **checkLevelParallelismPeak**: The top-level and defaults parallelism blocks are each checked on their own against built-in defaults for omitted fields, while a repository block, which lacks maxRepositories, is weighed merged in checkMergedParallelismPeak.
- **checkLevelParallelismPeak**: A parallelism peak error offers both remedies, how many repositories fit at the phase width and how wide the phase may be at the repository count, dropping either half that comes out below 1.
- **internalFields**: Loader-set and in-process fields (such as __configFileDir and logger) are declared in the schema so the unknown-key scan does not call them unknown, but they are deliberately unvalidated because resolveRepositoryConfig computes the internal ones itself and reads none from the file.
- **wholeFileSetting**: runOnce and syncOnStart describe the whole process, which runs every repository in the file, so they are refused on a repository entry and must be set in defaults.
- **repositorySchema.name**: A repository name is used as a path segment (lock file, audit log, duplicate-URL bare dir), so it is validated as a safe segment.
- **defaultsSchema**: defaultsSchema omits repoUrl, worktreeDir and bareRepoDir because nothing inherits them, so setting them in defaults warns as unknown keys.
- **configFileBaseSchema.defaults**: defaults: null has always loaded as no defaults and remains accepted.
- **checkModeSpecificFields**: Each repository mode rejects the other's settings whether written on the entry or inherited from defaults: clone mode has no bare repository and no branch set to filter, and only clone mode checks out one fixed branch at a depth.
- **definedOnly**: definedOnly drops undefined-valued keys from a config block so spreading it over an inherited block keeps the inherited value instead of resetting it.
- **checkMergedParallelismPeak**: The merged parallelism ceiling sums the widest phases of the maxRepositories widest repositories, not maxRepositories times the single widest, which would reject a wide entry that only ever syncs beside narrow ones (40/20/20 across two slots peaks at 60, not 120). With no per-repository overrides it reduces to the already-passed per-level check; a repository-level maxRepositories is validated but bounds nothing.
- **CLONE_MODE_PEAK**: Clone mode reads no parallelism field; each repository runs git through its own simple-git clients one sync step at a time, so its peak is SIMPLE_GIT_CLIENT_CONCURRENCY.
- **configFileSchema**: The config schema lets unknown keys through untouched; the loader's unknown-key scan reports them as warnings with suggestions, reading its inventory off the schema via KNOWN_CONFIG_KEYS.
- **configFileSchema**: The per-level parallelism checks weigh worktree-mode phases, so they are skipped when every repository is in clone mode.
- **KNOWN_CONFIG_KEYS**: KNOWN_CONFIG_KEYS is read off the schema level by level so the unknown-key scan accepts exactly what the schema declares; defaults is excluded from the top level's nested blocks because the scan walks it as its own level.
- **validateConfigFile**: validateConfigFile reports every problem at once in one ConfigValidationError keyed by paths into the file, and does not rewrite the config: what the file exported is what the loader resolves.

### `src/services/git-maintenance.service.ts`

- **GitMaintenanceService interval parsing**: A maintenance.interval of zero would disable throttling entirely, so it is treated like any other invalid value and replaced by the default.

### `src/services/sparse-checkout.service.ts`

- **findConeRuleViolations**: Cone rule violations are reported against the canonical directory list the apply step actually passes to git, so an entry removed by normalization or by an included parent is not reported. The result is empty in no-cone mode, where patterns are legal.

### `src/types/index.ts`

- **Config.syncOnStart**: syncOnStart (default true) syncs once at daemon startup; like runOnce it is read off defaults and never resolved onto a repository, and is declared on Config only because ConfigFile.defaults derives from Config and the schema's defaults level is pinned to keyof Config. It is documented with a line comment rather than JSDoc because tsc copies JSDoc into the .d.ts and the public tooltip belongs on SyncWorktreesDefaultsBase.
- **Config.maintenance**: Config.maintenance controls periodic `git gc` in both modes to reclaim unreachable objects from ref narrowing and branch churn and consolidate packs; it is throttled by interval (default 7 days) and runs under the repository lock at the end of a successful sync.
- **Config.__configFileDir**: Config.__configFileDir is an internal field populated by ConfigLoaderService with the loaded config file's directory, used to anchor the lock location for clone-mode repositories; it is not user-facing.
- **InitRepositoryInput.bareRepoDir**: InitRepositoryInput.bareRepoDir applies only to worktree mode.
- **RepositoryOnlyKey**: repoUrl, worktreeDir and bareRepoDir are read only from a repository's own config entry; defaults never carry them.

### `src/utils/config-discovery.ts`

- **CONFIG_PATH_ENV_VAR**: SYNC_WORKTREES_CONFIG names a config file for the CLI when --config is absent; the MCP server deliberately does not read it.
- **ResolvedConfigPath.path**: A resolved config path is absolute, but only a discovered path is known to exist; flag and env paths are returned unchecked so the caller can report which source named a missing file.
- **findConfigUpTree**: Config discovery walks up from the start directory like git's ceiling directories: when starting inside the home directory it stops at home (inclusive), so a config in ~ is found but one in /home or / never is. A start outside home, such as a CI checkout, walks to the filesystem root.
- **resolveConfigPath**: The CLI config is resolved from --config, then SYNC_WORKTREES_CONFIG, then a walk up from the working directory. Flag and env paths are returned whether or not they exist so the caller can say which named a missing file; relative ones resolve against cwd and an empty variable counts as unset.

### `src/utils/git-client.ts`

- **MIN_GIT_TIMEOUT_MS**: The config loader rejects non-zero fetchTimeoutMs/cloneTimeoutMs below 1000 ms because such a value is almost always seconds given by mistake and would kill nearly every git command.

### `src/utils/git-url.ts`

- **ParsedGitUrl.repoName**: repoName is null for a dialable remote with no path segment, such as a repository served at a web root. A local path whose basename is .git still yields an empty name and so an on-disk .bare/ directory; this is kept because changing it would move existing users' bare repositories and force a re-clone.
- **GIT_URL_SCHEMES**: Accepted URL schemes are http, https, ssh, git and file, compared lowercased because RFC 3986 schemes are case-insensitive and git accepts HTTPS://. git+ssh:// and ftp:// are deliberately excluded.
- **WEB_ROOT_SCHEMES**: Only http and https URLs may lack a path, because git can clone a repository published at a web root; for ssh, git and file schemes git answers fatal: no path specified, so a missing path means the URL is not a remote.
- **SCHEME_URL_PATTERN**: The scheme URL pattern uses . rather than [\s\S] so URLs containing a newline or carriage return are refused; git itself warns about newlines in URL paths, so nothing working is lost and directories are never named after such strings.
- **SCP_URL_PATTERN**: The scp-like user@host:path pattern accepts a bracketed IPv6 literal host, which git takes and from which a repository name has always been extracted.
- **repoNameFromLocalPath**: Local paths do not use repoNameFromSegment because a basename of exactly .git must still produce an empty name for local paths, preserving existing users' bare repository locations, even though URL segments keep .git whole.
- **parseGitUrl**: URL validation and repo-name extraction share one grammar because separate implementations drifted, accepting URLs that later failed name derivation and rejecting valid scp remotes. Syntaxes are tried as local path, then scheme://, then scp user@host:path, with the required user@ ensuring Windows paths and ssh:// URLs cannot be mistaken for scp. Dialability (null parse) and nameability (null repoName) are separate questions so path-less web-root https remotes still validate, and surrounding whitespace is refused rather than trimmed so the config string is exactly what git receives.
- **parseGitUrl**: isValidGitUrl and extractRepoNameFromUrl are both built on parseGitUrl so they cannot drift: anything the config loader accepts either yields a repoName or is known to need an explicit bareRepoDir.
- **parseGitUrl**: file:// URLs usually have an empty authority but git also accepts file://host/path; either way the repository is the last path segment, so the whole remainder is treated as the path.
- **parseGitUrl**: Non-file schemes require a non-empty authority, which rejects https:// and https:///acme/repo.git; a path is also required except for http(s), which parse with a null name instead of failing.
- **extractRepoNameFromUrl**: extractRepoNameFromUrl throws different messages for an unrecognised URL and for a valid path-less remote, because calling a web-root https URL malformed would be wrong; it needs an explicit bareRepoDir.
- **extractRepoNameFromUrl**: extractRepoNameFromUrl trims its input, unlike isValidGitUrl, because the init wizard calls it with raw keystrokes before its answer is trimmed and stored.
- **normalizeRepoUrlForComparison**: Remote URL comparison deliberately does not go through parseGitUrl, because it answers whether two strings are the same remote and must work for anything git accepted at clone time, including strings the grammar rejects.
- **normalizeRepoUrlForComparison**: Comparison normalization trims, lowercases scheme://host, and strips a trailing slash and one trailing .git; scp-style and https forms are intentionally not equated. The result is only for equivalence checks, never a canonical URL for git.
- **normalizeRepoUrlForComparison**: A trailing .git is treated as optional only for forge-style remotes (http(s), ssh, git://, scp); for file:// and local paths foo.git and foo can be different directories, so stripping it would hide a real origin mismatch.

### `src/utils/sanitize-name.ts`

- **sanitizeNameForPath**: Trailing dots and spaces are trimmed with a manual loop instead of the regex /[. ]+$/, because that regex rescans a long run of dots from every position and goes quadratic.

### `src/utils/unknown-config-keys.ts`

- **unknown-config-keys**: The config schema lets unknown keys through, so a typo like updateExistingWorktree is silently discarded; the loader therefore warns about unknown keys rather than rejecting them, since user-written JavaScript configs have always tolerated stray fields. The scan runs after validation, once per loadConfigFile, and warns again on reloads because the file was just edited. Known keys come from KNOWN_CONFIG_KEYS derived from the schema, and warnings go to stderr because the MCP stdio server's stdout carries JSON-RPC.
- **KnownConfigKeys.nested**: Nested object blocks in a config (such as retry or parallelism) accept the same keys at every level, so one map of nested known keys serves top level, defaults and repositories.
- **allowedEdits**: A key is treated as a misspelling within one edit for names of four characters or fewer and two edits otherwise, measured on the shorter name. The length gate stops short keys from matching different words (nope two edits from mode) at the cost of some transpositions (anme for name); wrong-word keys like retries for retry get no suggestion, which is honest since the warning itself is what matters.
- **suggestConfigKey**: A key that differs from a known key only by case (sparseCheckOut) is always suggested first, since it is the same word typed wrong.
- **suggestConfigKey**: Ties between equally close suggestions are broken alphabetically so the warning text is stable across runs.
- **collectFrom**: Unknown-key detection decides membership on the key name alone, never the value, so a known key present with value undefined (as Number(process.env.X) || undefined produces) counts as known, matching resolveRepositoryConfig.
- **collectUnknownConfigKeys**: collectUnknownConfigKeys runs only on an already validated config, so every repository is guaranteed a string name for the warning location.

### Tests

Why the tests that pin these decisions are built the way they are.

#### `src/__tests__/e2e/config-file.e2e.test.ts`

- **ConfigLoaderService unknown-key warning**: The config loader warns about unknown keys exactly once per load and only on stderr, because the same loader runs inside the MCP stdio server where stdout carries the JSON-RPC stream and a stray line breaks the protocol. The acceptance test runs the built CLI's `list`, which loads the config exactly once.
- **ConfigLoaderService load error location**: A bare 'Failed to load config file: Unexpected token' named neither file nor line, and with auto-discovery the person may not know which file was used, so load failures name the config file. An ESM parse failure carries no position once caught (V8 keeps it only for fatal exceptions), so only the file is reported; a module that parses then throws has a real frame, giving line and column. The e2e test spawns real node because Vitest resolves import() through its own pipeline.
- **ConfigLoaderService load error location**: For an ESM parse failure every frame is Node's own, so the loader never reports a node:internal frame as the location; pointing the person at node:internal/modules/esm/utils would be worse than the bare message.
- **ConfigLoaderService load error location**: The loader imports the config with a `?t=` cache-buster that travels into stack frames, so the reported location is converted to a plain filesystem path without the query or file:// scheme, a path the person can open.
- **ConfigLoaderService load error location**: A config may import its repository list from another module, in which case the frame points at that module; the error still names the config file, since it is the file the person passed and, when auto-discovered, the only way they learn which one was picked.
- **ConfigLoaderService load error location**: An ESM stack frame names the module by URL and a URL keeps brackets literal, so the frame location must not be parsed by splitting on the last bracket; doing so cut into paths like 'configs (old)' and returned a nonexistent tail still carrying the `?t=` cache-buster.

#### `src/__tests__/e2e/repository-name-path-segment.e2e.test.ts`

- **repository name validation**: A repository name becomes a path segment of lock and audit-log files. Names reserved only on Windows (such as 'aux') must still sync elsewhere, while names that cannot become a path segment are rejected by validation (and reported by doctor) instead of crashing later.

#### `src/__tests__/e2e/sparse-cone-load-validation.e2e.test.ts`

- **sparseCheckout cone validation**: A cone-mode sparseCheckout include that git refuses (such as a leading slash) is rejected when the config loads, because otherwise it cost a `worktree add` plus rollback per branch on every tick forever. The e2e test writes GIT_TRACE to a file so its assertion covers the git processes actually started, not what the logger printed.

#### `src/__tests__/e2e/worktree-dir-collision.e2e.test.ts`

- **worktreeDir collision validation**: Two config entries sharing one worktreeDir made each repo's sync treat the other's checkouts as unregistered and trash them, while reporting success with exit 0. The config is rejected before any git command runs, naming both entries and the shared path.

#### `src/mcp/__tests__/context.broken-config.test.ts`

- **ConfigLoaderService**: A config re-import after a change is evaluated in a worker thread, which uses Node's real module registry rather than vitest's, so the resulting note carries Node's own parse error text.

#### `src/services/__tests__/bare-repo.service.test.ts`

- **BareRepoService origin check**: An existing bare repo is found by path alone, and the default bareRepoDir (.bare/repo-name) is the same for old-org/repo and new-org/repo, so its origin must match the configured repoUrl before anything is fetched from it.

#### `src/services/__tests__/config-loader.deprecated-keys.test.ts`

- **ConfigLoaderService deprecated keys**: parallelism.maxBranchFetches bounded a fallback that could never run, so it has no effect. It is still accepted by the schema so existing configs keep loading, but each load emits a single deprecation warning.

#### `src/services/__tests__/config-loader.esm-reload.test.ts`

- **ConfigLoaderService.loadConfigFile**: A .js config inside a "type": "module" package is the shape `sync-worktrees init` writes there, so reloading its imported sibling modules must work just like for a .mjs config.
- **ConfigLoaderService reload**: A .js config that resolves as CommonJS is still loaded through import(), and Node's ESM-to-CommonJS bridge ignores a ?t= cache-busting query, so a query string alone cannot reload such configs, not even edits to the config file itself. Reloads go through a worker thread with an empty module registry instead.
- **ConfigLoaderService reload worker**: A config is user-supplied JavaScript and may leave handles open (intervals, sockets, watchers). The thread that evaluates a reloaded config must not be left running, otherwise a one-shot sync-worktrees run would hang after finishing and quitting the interactive UI would stop responding.
- **ConfigLoaderService reload**: .cjs configs are reloaded by clearing the require-cache subtree rather than through the ESM reload worker; both mechanisms are tested side by side so they cannot drift apart.
- **configPathsEvaluatedInProcess**: The interactive UI's handleReload and every CLI command construct a new ConfigLoaderService per load, while what makes a second load a reload is Node's module registry, which is per process. The set of already-evaluated config paths must therefore be module-level; moving it onto the instance would make every entry point see a first load forever and serve stale modules.
- **ConfigLoaderService reload worker**: Configs may read CLI flags via process.argv.slice(2), so a reloaded config must see the same argv as the first load. The Worker argv option only appends, and a data: URL worker has no script-path slot, so passing argv that way shifts every flag by one; the worker assigns process.argv from workerData instead.
- **ConfigLoaderService reload worker**: A user config can call process.exit(), which on a worker thread kills only the thread. Without an exit handler the reload promise would never settle and the interactive UI's reload would wedge, so a worker exit is turned into a rejection the caller can report.
- **ConfigLoaderService reload worker**: A reloaded config that never finishes evaluating (a top-level await on a live handle, an infinite loop) would wedge the UI reload and MCP load_config. Reloads are bounded by reloadTimeoutMs: on expiry the worker is stopped, the call rejects with a message naming the file, the previously loaded configuration stays in effect, and nothing is left keeping the process alive.
- **moduleSyntaxHint**: Node strips TypeScript types rather than compiling them, so a config using an enum fails with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX and a 'strip-only mode' message that means nothing to a config author. The loader appends a hint explaining type erasure and suggesting a .js/.mjs config.
- **CONFIG_FILE_NAMES**: A .ts config under a "type": "commonjs" package.json is parsed as CommonJS TypeScript, where `export default` is a SyntaxError. Supporting .mts would solve only that case, and moduleSyntaxHint already tells the user to add "type": "module", so .mts is deliberately not in CONFIG_FILE_NAMES.
- **workerEvalError**: Reloads evaluate the config in a worker thread with its own module registry, so .ts configs must survive that path too. The non-erasable-syntax hint only works on reload because workerEvalError carries the error's code (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX) back across the worker boundary.
- **hooks.timeoutMs schema**: hooks.timeoutMs is capped at 2^31-1, setTimeout's own ceiling. Larger delays overflow the 32-bit field: Node prints a TimeoutOverflowWarning over the alternate screen and substitutes 1 ms, so the hook would be SIGTERMed almost immediately while onError reports the huge timeout requested (observed with 31536000000). Rejecting at load keeps the config and runtime from disagreeing.

#### `src/services/__tests__/config-loader.example-config.test.ts`

- **sync-worktrees.config.example.js tests**: The shipped sync-worktrees.config.example.js is the reference README.md points to for every option and is meant to be copied and run. Nothing else loads it, so new loader validation rules could silently break it (a per-repository runOnce once became a validation error while the example still had one). Tests therefore load the real shipped file, not a fixture.
- **sync-worktrees.config.example.js tests**: runOnce is a whole-file setting that belongs under defaults; a repository entry carrying one is a validation error. The example is checked against its raw entries as well as through the loader so it stays correct even if that validation rule is relaxed.
- **ConfigLoaderService.resolveRepositoryConfig**: The example config must not document settings the loader ignores, because it is meant to be copied and a key that resolveRepositoryConfig does not carry into the resolved repository config never reaches a service (fetchTimeoutMs and cloneTimeoutMs were once dropped in that manner). A guard checks that every key the example sets survives into the resolved config.
- **sync-worktrees.config.example.js tests**: Nested config blocks (parallelism, retry, sparseCheckout, trash) are merged wholesale, so a top-level key-survival check cannot see their contents. Their values are read back from the resolved repository config, the object services actually receive, rather than from the config file.
- **ConfigLoaderService.resolveRepositoryConfig**: fetchTimeoutMs and cloneTimeoutMs are left undefined in the resolved repository config when not set; the built-in defaults are applied in the services that read them, not by the loader.
- **sync-worktrees.config.example.js tests**: Much of the example config is prose stating the defaults a setting falls back to, and a wrong number there misleads the reader the file exists for. Tests pin that prose to the DEFAULT_CONFIG constants so changing a default fails a test instead of silently making the reference wrong.
- **CLONE_MODE_CONFLICTING_FIELDS**: The example config's clone-mode section lists every field in CLONE_MODE_CONFLICTING_FIELDS, and the list once went stale when trash was added to the constant. The test reads only the 'Conflicts with' bullet, because a field name appearing elsewhere in the long file does not mean the list mentions it.

#### `src/services/__tests__/config-loader.service.test.ts`

- **moduleSyntaxHint**: Node reports a config parsed under the wrong module system as a bare `SyntaxError: Unexpected token 'export'` naming neither the file nor the fix, so the loader appends a hint. Only the .cjs case can be exercised under vitest, because it goes through the loader's real require(); the .js-in-a-commonjs-package case cannot be reproduced in-process since Vitest resolves import() through its own pipeline, so it is covered against a real node child process elsewhere.
- **ConfigLoaderService.loadConfigFile**: A config load failure must name the config file and the line, because a bare message such as `Unexpected token ']'` gave neither and auto-discovered configs did not even say which file was loaded. Only .cjs configs can be exercised in-process, since they go through the real require() and Node decorates the stack with the position; the .js/.mjs half is pinned against a real node in the e2e suite.
- **ConfigLoaderService error location**: A config that parses and then throws carries an ordinary stack rather than Node's compile-failure decoration, so its location is taken from the first stack frame outside node: internals.
- **ConfigLoaderService error location**: Stack frames are plain text, and whitespace and the opening bracket of the location both occur in ordinary directory names ("~/My Projects", "proj (old)"). Splitting a frame on either walks past the config's own frame and reports sync-worktrees' own code, which must never be reported as the location because it is not the file the user has to fix.
- **ConfigLoaderService error location**: On a module-resolution failure Node's own internal frames sit on top of the config's frame in the stack; reporting a node:internal location as the place to look would be worse than reporting nothing, so those frames are skipped to reach the config's own line.
- **ConfigLoaderService.resolveRepositoryConfig**: fetchTimeoutMs and cloneTimeoutMs are read by GitService (bare clone, fetch, push, ls-remote, remote set-head) and CloneSyncService (clone, branch fetches, unshallow). resolveRepositoryConfig rebuilds the repository config from an explicit list of keys, so both timeouts must be on that list; when they were missing every config-file run silently used the 5- and 15-minute built-ins.
- **ConfigLoaderService.resolveRepositoryConfig**: A configured timeout must be present as a key in the resolved repository config; an undefined value would make the service fall back to the built-in default, indistinguishable from the key having been dropped.
- **ConfigLoaderService.resolveRepositoryConfig**: A repository's fetchTimeoutMs or cloneTimeoutMs of 0 is a setting (disable the inactivity kill), not an omission, so the merge with defaults must not be truthiness-based; otherwise the repository would inherit the defaults value instead.
- **retry config schema**: Every bound on a retry field is a `<` comparison and NaN fails every comparison, so NaN and non-finite values must be rejected explicitly: a NaN maxAttempts made retry() throw before the first attempt on every sync, and a non-finite delay collapsed backoff to setTimeout's 1 ms floor. The tests assert each field's own message because some cases were already caught by the unrelated 'initialDelayMs must not exceed maxDelayMs' check.
- **retry config schema**: Retry delays, jitter and the backoff multiplier are continuous and may be fractional; only maxAttempts and maxLfsRetries are whole numbers. 'unlimited' is the only spelling of unbounded attempts; Infinity is rejected because retry() has always thrown on it.
- **branchInclude/branchExclude schema**: An empty or whitespace-only branch pattern can never match, since git refuses branch names containing spaces. filterBranchesByName applies an include list based on its length alone, so `branchInclude: [""]` would keep no branch and the prune phase would treat every worktree except the default branch's as unmanaged; such patterns are rejected at load.
- **branchInclude/branchExclude schema**: Blank branch patterns are rejected under defaults as well as on repository entries, because an inherited branchInclude that matches nothing would prune every repository's worktrees.
- **ConfigLoaderService reload worker**: Reloads evaluate the config off the main thread, so the exported value crosses a structured clone. Present-but-undefined keys must survive that transfer, because resolveRepositoryConfig spreads a present-but-undefined key over the inherited value; a JSON round trip would silently change which setting a repository ends up with.
- **ConfigLoaderService reload worker**: Functions cannot cross a thread boundary and no config field is function-valued, so a reloaded config exporting a function fails with an error naming the fix (export plain data) instead of silently dropping the value, which could turn a rejected config into an accepted one. The interactive UI's handleReload keeps the previous config when a reload throws, so the failure costs only the message.
- **ConfigLoaderService reload worker**: An Error does not cross a thread boundary as itself, so the reload worker rebuilds the error it caught. moduleSyntaxHint keys off the error's name, so the rebuild must preserve it for a config that only breaks on reload to keep getting the module-system hint.
- **computeParallelismPeak**: The parallelism safe-limit guard weighs the peak number of concurrent git processes. Sync phases (worktree creation, update, removal, status checks) run one after another and never overlap, so the per-repository peak is the widest single phase rather than the sum of all phases.
- **computeParallelismPeak**: parallelism.maxBranchFetches is deprecated and bounds nothing, so it never counts toward the parallelism peak; rejecting a config because of it would break a working setup.
- **computeParallelismPeak**: `git worktree add` and `git worktree remove` both run on the bare repository's single simple-git client, so maxWorktreeCreation and maxWorktreeRemoval are capped at SIMPLE_GIT_CLIENT_CONCURRENCY when computing the peak; they can never reach a wider configured width.
- **repositorySchema.parallelism**: A repository entry may carry its own parallelism block (the example config documents one). Its merged values reach pLimit() at the start of a sync phase, where an invalid value throws a TypeError mid-sync after the fetch on every run, so repository-level parallelism values are validated as positive integers at load.
- **repositorySchema.parallelism**: Parallelism validation mirrors p-limit's own concurrency rule, and the test checks p-limit directly rather than a believed list of rejected values. Infinity is the one deliberate divergence: p-limit accepts it as unbounded, but an unbounded phase has no peak to weigh against the safe-total limit, so the config rejects it.
- **ConfigLoaderService parallelism safe-total guard**: The parallelism safe-total guard evaluates the merged parallelism each repository actually receives (repository block over defaults over the top-level block), because judging each level alone against built-in defaults let a repository's own block go unweighed even though it is what reaches p-limit.
- **ConfigLoaderService parallelism safe-total guard**: Which repositories sync concurrently is a scheduling matter, not file order, so the safe-total guard fills the maxRepositories slots with the widest repositories wherever they appear in the file.
- **ConfigLoaderService parallelism safe-total guard**: When the file lists more repositories than maxRepositories slots, the safe-total error message counts the slots, so the number matches the breakdown beside it.
- **ConfigLoaderService parallelism safe-total guard**: A repository-level parallelism.maxRepositories is validated and warned about but bounds nothing, because runMultipleRepositories reads only the top-level or defaults value. The safe-total guard ignores it, otherwise it would reject configs that run safely.
- **ConfigLoaderService parallelism safe-total guard**: When there are fewer repositories than maxRepositories slots, the safe-total error message counts the repositories that exist, since only they can occupy slots.
- **ConfigLoaderService parallelism safe-total guard**: defaults.parallelism.maxRepositories overrides the top-level value, as for every other setting, and the safe-total guard reads it the same way the multi-repository runner does.
- **ConfigLoaderService parallelism safe-total guard**: The safe-total peak is the sum of the widest phases of the repositories that can sync at once, not maxRepositories times the single widest repository; one wide repository beside narrow ones never runs its width several times over, and rejecting it would fail working setups.
- **ConfigLoaderService parallelism safe-total guard**: Without per-repository overrides the merged sum equals maxRepositories times the widest phase, so the merged guard gives the same verdict as the per-level check and configs that loaded before keep loading (a peak exactly at the limit is accepted).
- **ConfigLoaderService parallelism safe-total guard**: A repository that overrides nothing runs with the top-level parallelism block's widths, not the built-in defaults, so the guard must include the global layer in the merge. Because the built-in maxStatusChecks equals the commonly used 20, a dedicated case with a different global value is needed to detect a merge that drops the global layer.
- **config-loader process budget test**: The budget test uses 51 + 50 so the total exceeds the limit, while 51 plus the built-in default of 20 would not, proving the configured value is the one counted.
- **ConfigLoaderService parallelism safe-total guard**: The closing advice of the safe-total error names the setting worth lowering, which is the widest repository's peak phase rather than a slot-mate's.
- **ConfigLoaderService parallelism checks**: The per-level parallelism check still runs on the defaults block with its own message, separately from the merged guard: it weighs maxRepositories against the block regardless of how many repositories exist, so it can fire with a single repository where the merged guard sees no problem.
- **ConfigLoaderService.resolveRepositoryConfig**: A top-level parallelism block, the placement the example config and README show, is merged into every repository beneath defaults.parallelism and the repository block; merging only defaults and repository blocks silently left every per-repository limit at its default.
- **fileToCopy schema**: sparseCheckout.exclude gives a leading `!` the gitignore negation meaning, but file copying expands with negation off, so the same entry would look inside a directory literally named `!node_modules` and silently match nothing. The loader rejects a leading `!` in filesToCopyOnBranchCreate and explains how to escape it.
- **ConfigLoaderService.resolveRepositoryConfig**: The hooks block is merged field by field with defaults: a repository's onBranchCreated wins while a timeoutMs it does not mention is still inherited from defaults.
- **ConfigLoaderService.resolveRepositoryConfig**: A repository's hooks.timeoutMs of 0 is a value (disable the timeout), not an absence, so the merge must not treat it as falsy and hand the repository the inherited timeout.
- **getDefaultBareRepoDir**: Config validation and the bare-repository directory extractor must share one URL grammar; when they disagreed, some repoUrls (git://, https with trailing slash, scp form with a non-git user) passed validation and then failed in getDefaultBareRepoDir, or were refused although git accepts them. The test entry is named something other than the repository so that .bare/repo can only come from the URL, not from resolveRepoDirs' name-based fallback for duplicate repoUrls.
- **ConfigLoaderService.resolveRepoDirs**: A repoUrl with no repository path segment is handled by whether git can use it: an https URL at a web root is cloneable, so it loads with an explicit bareRepoDir and without one is refused with a message saying which entry needs bareRepoDir; ssh://, git:// and file:// URLs without a path cannot be dialled by git (`fatal: no path specified`) and are refused as repoUrls.

#### `src/services/__tests__/config-loader.unknown-keys.test.ts`

- **ConfigLoaderService unknown-key warnings**: validateConfigFile inspects only known keys and resolveRepositoryConfig copies only known keys, so a misspelled key such as `updateExistingWorktree` was silently dropped and the setting it meant had no effect; the loader therefore warns about every unknown key. The tests construct a fresh loader per case, as runList, runFromConfigFile and executeTrash do, and give each config its own temporary directory so each load is a first load rather than a worker-backed reload triggered by the module-level path registry.
- **ConfigLoaderService unknown-key warnings**: The unknown-key warning is purely diagnostic: unknown keys are still dropped from the resolved repository config exactly as before, so the warning introduces no new behaviour.
- **ConfigLoaderService unknown-key warnings**: Configs commonly write `{ maxStatusChecks: Number(process.env.X) || undefined }`, which yields a known key present with an undefined value; such keys must not trigger an unknown-key warning.
- **ConfigLoaderService unknown-key warnings**: A second load of the same config path is a reload that the module-level registry routes through the worker, and it repeats unknown-key warnings on purpose because the file was presumably just edited; nothing about warnings is cached between loads.

#### `src/services/__tests__/config-schema.test.ts`

- **configFileSchema**: The handwritten config types remain the source of the public surface because their clone/worktree discriminated unions are not something `z.infer` produces. Type-level equality assertions between the zod schema output and those types keep the two from drifting: a field added to one and not the other fails `pnpm typecheck`.
- **configFileSchema**: The internal keys logger, __configFileDir and __configuredRepoDirs are declared in the schema so they count as known keys, but they are never validated because the loader computes or ignores them; the schema-versus-type value comparison excludes them.
- **repositorySchema**: runOnce and syncOnStart are whole-file settings: booleans accepted under defaults but rejected on a repository entry, so the repository schema's value types for them intentionally differ from RepositoryConfig and are excluded from the type comparison.
- **validateConfigFile clone-mode rules**: No repository inherits defaults.bareRepoDir, so a clone-mode repository beside a defaults.bareRepoDir is not rejected by validation; the stray key only produces an unknown-key warning.
- **validateConfigFile**: Cross-field rules such as clone-mode conflicts are checked only once every individual field is valid, because reporting a mode conflict alongside a type error would reason about a config that is not the one written.

#### `src/services/__tests__/git.service.test.ts`

- **GitService.getFetchTimeoutMs**: A configured fetchTimeoutMs or cloneTimeoutMs of 0 is the documented way to turn the inactivity kill off. Because 0 is falsy, a || fallback would silently restore the 5- and 15-minute built-ins; the value must be kept as 0 and the client built with no timeout option at all, since { block: 0 } would mean an instant abort.

#### `src/services/__tests__/interactive-ui.reload-logging.test.ts`

- **InteractiveUIService reload parallelism**: For parallelism.maxRepositories, the config file's defaults block takes precedence over the top-level parallelism block.

#### `src/services/__tests__/sync-retry-policy.test.ts`

- **SyncRetryPolicy.createOptions**: The unconfigured retry defaults are pinned both as literals and against DEFAULT_CONFIG: the literals are user-facing behaviour (jitterMs 0 in particular, since a non-zero default would add delay to every retry), and the DEFAULT_CONFIG comparison keeps the fallback and the config loader's cross-field validator from drifting apart.

#### `src/services/__tests__/worktree-status.process-budget.test.ts`

- **GitService parallelism wiring**: maxStatusChecks is the knob users actually set, so GitService sizes the status git-process budget from it; without that wiring the budget would silently stay at its default.
- **ConfigLoaderService.resolveRepositoryConfig**: A top-level parallelism block, as the example config documents, must flow through config resolution into the budget that bounds git processes, not only a per-repository parallelism block.

#### `src/types/__tests__/public-config-types.test.ts`

- **Config.fetchTimeoutMs**: Inactivity timeouts are common config fields accepted under defaults and on a repository entry in either mode, and 0 is a real value meaning 'no inactivity kill', not an omission.

#### `src/utils/__tests__/config-discovery.test.ts`

- **CONFIG_FILE_NAMES**: The four config file names the MCP instructions and detect_context advertise are pinned in walk-up order (.js, .mjs, .cjs, .ts) so the advertised claims and the searched constant cannot drift.
- **findConfigUpTree**: Config discovery does not walk past the home directory when it started inside it, like a git ceiling directory, because a config in /home or at the filesystem root is not something a project under ~ meant to use.

#### `src/utils/__tests__/config-generator.test.ts`

- **generateConfigFile**: The generated config omits mode when it is 'worktree', because that is the default.
- **generateConfigFile**: The config generator walks up past directories without a package.json to the nearest one, as Node does, so a config in a monorepo subdirectory under a commonjs root is written as CommonJS; the test checks it under real Node because an ESM file there is a hard SyntaxError.
- **generateConfigFile**: The generator stops at a malformed nearest package.json instead of applying a grandparent's type; Node cannot resolve a module type through it so neither system loads, which is why `init` round-trips the file through the loader before reporting success.
- **generateConfigFile**: A nearest package.json without a type field stops the lookup, as in Node, so a parent's commonjs type does not apply to a nested package.
- **generateConfigFile**: A .js target with no package.json in its chain keeps ESM, because Node's module-syntax detection re-parses it as ESM and loads it.

#### `src/utils/__tests__/git-url.test.ts`

- **parseGitUrl**: The config loader's repoUrl validator and the .bare/<repo> name extractor must answer from the same grammar; when they were separate they disagreed, so some URLs validated and then failed in getDefaultBareRepoDir while valid scp remotes were refused. The suite holds that agreement in place.
- **SCP_URL_PATTERN**: The bracketed-IPv6 scp rows include a one-segment path because that shape proves the brackets are parsed as part of the host; splitting anywhere else yields a name like db8::1]:repo.
- **parseGitUrl**: Path-less http(s) remotes such as a repository at a web root are dialable by git, so refusing them would block a working configuration with no alternative spelling; they parse with no name and only entries without an explicit bareRepoDir care.
- **parseGitUrl**: Path-less ssh://, git:// and file:// URLs (and a path of /) are refused by both validator and extractor because git itself answers fatal: no path specified for them; accepting them would only defer the failure to name derivation.
- **parseGitUrl**: A padded repoUrl is refused rather than trimmed because the config must hold the exact string git receives. Leading-only and trailing-only padded rows are listed separately because a guard checking just one end would still pass a both-ends-padded row.
- **parseGitUrl**: URLs with an embedded newline are refused so a directory is never named after a string containing one.
- **extractRepoNameFromUrl**: For a valid path-less remote, extractRepoNameFromUrl throws a no-path-segment message rather than Invalid Git URL format, because calling the URL malformed would be wrong.
- **parseGitUrl**: Nothing the config loader accepts may fail later for a reason visible at validation: a validated URL either yields a directory name or is known to require an explicit bareRepoDir, and the converse holds for every unpadded URL. Padding is the one deliberate asymmetry, refused at load rather than accepted and dropped later.
- **parseGitUrl**: git://host/ with a trailing space has a one-space path segment, so a grammar not refusing surrounding whitespace would validate it and then find nothing to name once the extractor trimmed.
- **extractRepoNameFromUrl**: extractRepoNameFromUrl still trims its input because the init wizard calls it with raw keystrokes before its own answer is trimmed and stored.
- **parseGitUrl**: ssh:// URLs can never be read as scp form because :// is checked first and the scp user and host classes exclude / and :.
- **extractRepoNameFromUrl**: Repository names derived for odd URL shapes are kept exactly as before because a changed name moves an existing user's .bare/<name> and forces a re-clone.

#### `src/utils/__tests__/sanitize-name.test.ts`

- **sanitizeNameForPath**: A long run of dots in the middle of a name used to make the trailing-trim regex rescan the run from every position; the test pins linear-time behaviour for that input.

#### `src/utils/__tests__/unknown-config-keys.test.ts`

- **editDistance**: Suggestion tests include two-edit typos on long names because one-edit pairs cannot distinguish deletion, insertion and substitution costs; only two-edit cases pin the weights inside the distance function.
- **allowedEdits**: Four-letter keys are allowed only one edit, so nope (two substitutions from mode) gets no suggestion; the price is that the transposition anme gets none for name either. name and mode are three edits apart, separated by distance alone.
- **collectUnknownConfigKeys**: syncOnStart, like runOnce, is a whole-file switch: validateConfigFile rejects it on a repository entry before the unknown-key scan runs, but it is a valid defaults key, so the scan must not warn about it there.
- **collectUnknownConfigKeys**: Each config level is scanned against its own key inventory: a real repository key is still unknown at the top level where nothing reads it, and name is unknown under defaults.
- **collectFrom**: Config files commonly write shapes like { maxStatusChecks: Number(process.env.X) || undefined }, so a known key whose value is undefined is still treated as known.

## Consequences

Changing code covered by an entry here means updating the entry in the same pull request. An entry that no longer holds is deleted, or superseded by a new numbered ADR when the reversal is itself a decision worth keeping.

# ADR-0010: MCP server

- **Status:** Accepted
- **Date:** 2026-11-20
- **Source:** 186 code comments as of `5f17242`, moved here by [ADR-0001](./0001-record-decisions-in-adrs-not-comments.md)

## Context

sync-worktrees-mcp exposes worktree operations to AI clients over the Model Context Protocol on stdio. stdout is the JSON-RPC stream, so nothing else may write to it, and tool output must be useful to a model that cannot see the terminal.

## Decisions

Grouped by the file that implements them, source before tests. Each entry names the symbol it governs.

### `bin/sync-worktrees-mcp.js`

- **bin/sync-worktrees-mcp.js**: The MCP bin shim must write nothing but JSON-RPC to stdout because stdout is the stdio transport; the Node version warning goes to stderr only.
- **bin/sync-worktrees-mcp.js**: The MCP bin shim only imports dist/mcp-server.js: importing the bundle starts the server, which then runs until the client closes stdin.

### `scripts/smoke-test.mjs`

- **scripts/smoke-test.mjs MCP_PROTOCOL_VERSION**: The smoke test handshakes on the legacy `initialize` path with protocol 2025-11-25, the revision the server serves in legacy mode and that src/mcp/__tests__/server.test.ts also pins; the 2026-07-28 revision uses `server/discover` instead.
- **scripts/smoke-test.mjs checkMcpHandshake**: The MCP stdio transport is newline-delimited JSON-RPC, so the smoke test fails on any non-JSON stdout line: anything else on stdout corrupts the transport for clients.
- **scripts/smoke-test.mjs checkMcpHandshake**: MCP tool inputs are strict objects so an undeclared argument key is refused by name. Only the smoke test exercises tools/call through the shipped bundle; if schemas became loose, `repo_name` would be stripped and the call would fail later on the empty sandbox, so the check requires the key name in the error text to tell the two apart.

### `src/mcp/context.ts`

- **RepoEntry.worktreeDirUndetermined**: For auto-detected entries, worktreeDirUndetermined records that the last detection could not agree on a worktreeDir, so config.worktreeDir holds a placeholder no tool may write under. It is stored on the entry rather than only on the discovery snapshot because invalidateDiscovered clears the snapshot while keeping the entry.
- **ConfigFingerprint**: The failed auto-load record keeps the config file's identity (mtime and content hash) as it was at the moment of failure. Both halves are null when the file could not be read, and the gate treats that as unknown, never as unchanged.
- **DISCOVERY_CACHE_LIMIT**: The discovery cache is keyed by probed path and each entry holds a full DiscoveredRepoContext including allWorktrees, so an unbounded map grew quadratically with worktree count over a long MCP session. It is capped at 64 entries, least recently used evicted first; that is far larger than the working set within the 5-second TTL, and eviction cannot change an answer because a dropped entry is simply re-detected.
- **RepositoryContext.configLoader**: The MCP config loader uses an explicitly stderr-bound logger because it runs inside the stdio server, whose stdout is the JSON-RPC stream; the explicit logger makes the destination a property of the call site rather than of console.
- **RepositoryContext.loadConfig**: In RepositoryContext.loadConfig the loaded-config state (configPath, fingerprint, cleared failure) is set only after every throwing step, so it marks a config that genuinely loaded, whether via auto-load or load_config.
- **RepositoryContext.detectFromPath**: A Map iterates in insertion order, so a discovery cache hit is deleted and re-inserted to make it the newest entry, letting rememberDiscovery evict the least recently used one.
- **RepositoryContext.detectFromPath**: The config file is fingerprinted before an auto-load attempt, never after, so an edit landing while the import runs is re-imported next time instead of the repaired bytes being recorded as already tried.
- **RepositoryContext.detectFromPath**: A failed config auto-load is also written to stderr alongside the note returned to the MCP client, because someone tailing the server in a terminal never sees tool output; stderr is not the JSON-RPC stream, and the line is written once per broken revision rather than once per cache miss.
- **RepositoryContext.rememberDiscovery**: rememberDiscovery caches one detection and evicts the oldest entries past DISCOVERY_CACHE_LIMIT. It deletes the key before setting it because a Map keeps a re-set key in its original position, so without the delete re-caching a hot path would leave it first in line for eviction (FIFO rather than LRU).
- **RepositoryContext.dropDetectedEntriesCoveredByConfig**: RepositoryContext keeps one entry, and so one service, per repository: when a config entry covers a detected one, the config entry wins and the detected entry is dropped.
- **RepositoryContext.checkLoadedConfigChanged**: Loaded-config change detection costs one stat per detect; the file is hashed only when its mtime moves, so a bare touch does not raise CONFIG_CHANGED.
- **RepositoryContext.shouldReimportConfig**: The config re-import gate fails open when either fingerprint could not be computed, because mistaking an unreadable file for an unchanged one would pin the config as broken for the life of the process.
- **RepositoryContext.detectFromPathUncached**: The found-but-broken config note is added before any detection branch so it survives every result shape (unmanaged, unsupported, clone-mode). Without it the client sees configPath null with no hint a config exists, and the agent's next move is to write a second one.
- **RepositoryContext.detectFromPathUncached**: When the checkout walk finds nothing, detection reports the deepest .git it stepped over as the worktree root rather than the probed path, since that is the repository the agent is standing in. An unreadable .git is the shallowest of the candidates, so it names the location only when nothing was stepped over.
- **RepositoryContext.detectFromPathUncached**: When the walk passed nested repositories, saying only that no .git was found would be false, so the exhausted answer enumerates what the walk passed; it is the only note in that case, so per-skip notes are not added too.
- **RepositoryContext.detectFromPathUncached**: For a path outside any checkout, detect_context reports the capabilities of the default repository, since tools without repoName still act on it. An unreadable .git stops short of answering for any enclosing repository.
- **RepositoryContext.detectFromPathUncached**: A matching config's worktreeDir is authoritative because it is where tools will actually write; only an auto-detected repository derives worktreeDir from git, and only it reports null when the derivation cannot agree.
- **RepositoryContext.detectFromPathUncached**: Detection reruns on each cache miss and the registered worktree list can change, so the detected entry's worktreeDir is kept in step with the reported value. Because getService builds the service from a copy of the config, an existing service is dropped too, or create_worktree would keep writing under the old directory; repository locks are keyed by path, so a rebuilt service is still serialized against one mid-operation.
- **RepositoryContext.detectFromPathUncached**: When worktreeDir derivation fails, the synthetic config uses a placeholder directory. Read-only tools work off the bare repo and never touch it, and createWorktree and updateWorktree, the only tools that would write under it, are marked unavailable, so nothing is placed on disk from the guess.
- **RepositoryContext.detectFromPathUncached**: The worktreeDir derivation outcome is recorded on the entry because invalidateDiscovered drops the discovery snapshot but keeps the entry, and ensureCapability falls back to base capabilities when there is no snapshot.
- **RepositoryContext.detectFromPathUncached**: Discovered capabilities start from the entry's durable base capabilities so discovery can only narrow them, never widen them. With no entry nothing is registered for the repository, so no tool can select it.
- **RepositoryContext.detectFromPathUncached**: Without an origin URL there is nothing to create from or fast-forward to, so createWorktree and updateWorktree are unavailable even when a loaded config lists the repository.
- **RepositoryContext.detectFromPathUncached**: createWorktree resolves its target under worktreeDir via getBranchWorktreePath, and updateWorktree does so through the initialize() that rebuilds the default-branch worktree, so neither may run when worktreeDir is only a guess.
- **RepositoryContext.getService**: Services built for MCP replace retry maxAttempts unlimited with the default cap, because a tool call has to answer and unlimited retries would retry an unreachable remote forever while holding the repository lock.
- **RepositoryContext.getBaseCapabilities**: Base capabilities are derived from the entry's durable state (source, mode, repoUrl, whether a loaded config lists it) rather than the discovery cache. Handlers gate on them first because every mutating tool clears the cache, and an empty cache must never re-enable a tool detection declared unavailable.
- **RepositoryContext.computeBaseCapabilities**: computeBaseCapabilities is the single source of truth for capability decisions; discovery starts from its result and may only narrow it with facts read from git.
- **RepositoryContext.computeBaseCapabilities**: An auto-detected entry whose worktreeDir could not be derived carries a placeholder directory, so createWorktree and updateWorktree are refused in the base capabilities, durably, rather than only in the discovery snapshot that mutating tools and load_config clear.
- **RepositoryContext repository summaries**: Repository summaries report worktreeDir as null for an entry whose worktreeDir is undetermined, matching detect_context, instead of exposing the internal placeholder.
- **RepositoryContext.getConfiguredRepositorySummaries**: A configured repository counts as locally ready when its bare repo has a HEAD file, not when the directory exists, because the repository lock creates the directory before any clone runs.
- **worktreeDirCandidate**: A branch worktree sits at worktreeDir/name, where name is the flattened branch name or, for older or ambiguous names, the flattened name with a hash suffix; both are accepted because the choice depended on siblings at creation time. The default-branch worktree is anchored at join(worktreeDir, branch), so a nested branch name contributes several components and dirname is wrong. Each candidate parent is rebuilt into a path and kept only if it reproduces the registered one; paths matching neither shape abstain, and hand-placed worktrees that match the anchor shape are outvoted by deriveWorktreeDir.
- **deriveWorktreeDir**: worktreeDir is derived only when two signals agree. First a vote over recognized worktrees decides, with abstaining entries not voting, a minority outvoted rather than allowed to veto, and a tie producing no answer. Then the worktree the detection ran from must corroborate the winner; it confirms rather than overrides because an agent is likely standing in a hand-placed worktree that disagrees, and when it is absent or abstains the count stands alone. A single vote wins because its matched shape already fixes how many path components the branch contributed.
- **configFileFingerprint**: A broken config is re-read on every cache-missing detect, and after the first failure each read costs a worker thread because ConfigLoaderService marks a path evaluated before importing it. The fingerprint lets the gate skip repeats only while the file is byte-for-byte the one that failed; mtime alone is insufficient because it has one-second resolution on HFS+ and many network mounts and the smallest syntax fix keeps the size identical. The hash is cheap and a healthy config is fingerprinted once; touch deliberately releases the gate for faults in modules the config imports.
- **MAX_ENUMERATED_SKIPS**: Each clause of the exhausted-walk reason carries an absolute path and the reason is repeated per capability and in the notes, so enumerating every level grew quadratically with depth (thirty nested repositories produced a 116 KB tool result). Only the deepest few skipped directories are listed and the rest are counted.
- **describeExhaustedWalk**: An unreadable .git produces a cannot-determine answer rather than a no-worktree answer, because answering with the repository that encloses it would name a different repository than the one the agent is in, and every mutating tool would act on that name.
- **classifyGitFile**: classifyGitFile accepts a .git file only when its gitdir points into bare/worktrees/name; a submodule's gitdir resolves to admin/modules/name, which has a path separator after the worktrees segment, so it is classified as a nested repository.
- **findEnclosingCheckout**: The checkout walk climbs from the start path and stops at the first actionable shape: a worktree whose gitdir points into bare/worktrees/name, or a configured clone-mode root, which is terminal. Other .git entries (vendored repos, submodules) are recorded and stepped over so an agent in a nested repository still finds the managed worktree enclosing it. An unreadable .git stops the walk, because an errno only means the server process could not look and stepping past it could answer with a different enclosing repository, unless the config names that directory as a clone-mode root.
- **findEnclosingCheckout**: An unreadable .git ends the checkout walk as its own outcome carrying the errno and directory, so the caller can say which .git it could not read instead of falsely claiming no .git was found.

### `src/mcp/handlers.ts`

- **ensureCapability**: ensureCapability checks the entry's durable base capabilities before consulting the discovery cache, because every mutating tool clears that cache and an empty snapshot must never read as allowed; otherwise sync or initialize could run against an auto-detected repository right after create_worktree or update_worktree.
- **isCheckoutMissing**: Git never marks a locked worktree registration prunable, so a locked row's directory is probed on disk; a path whose existence cannot be verified counts as present.
- **ensureRepoWorktree**: ensureRepoWorktree resolves a path to a registered worktree from git's own listing every time, because the discovery snapshot has no freshness check. Detached worktrees are included and carry detached plus their HEAD oid with an empty branch, so callers acting on the branch must refuse them; a registration whose checkout is gone throws WORKTREE_MISSING.
- **ensureWorktreeTargetAvailable**: addWorktree treats an unregistered directory at the target path as an orphan and trashes or deletes it, which is right for sync. create_worktree is advertised as non-destructive and the MCP surface has no trash access, so the MCP path refuses an unregistered existing directory instead and leaves registered paths to addWorktree's short-circuit.
- **handleDetectContext**: detect_context's configuredRepositories is the server-wide loaded-config inventory and does not depend on the probed path.
- **handleDetectContext**: detect_context uses one status enricher for every list in its response, because allWorktrees and allWorktreesByRepo for the current repo come from separate git reads and contain the same worktrees; sharing it probes each worktree once and both lists report the same answer.
- **createWorktreeEnricher**: The worktree enricher memoizes on both inputs it reads, the worktree path and whether it is current, so listings that disagree about isCurrent each get the label they asked for. It stores the promise rather than the result so concurrent callers join the probe already in flight.
- **createWorktreeEnricher**: The enricher shares one RefScanScope across the whole response, keyed by each worktree's common git dir, so each repository's branch and remote-ref scan runs only once even when lists span several repositories.
- **handleListWorktrees**: The usual cause of a worktree listing failure with no detected fallback is a configured repository that was never cloned, where simple-git rejects because the bare directory does not exist. The error names both the cause and the remedy (run initialize), since in multi-repo listings the message is what appears in the per-repository error field.
- **handleListWorktrees**: list_worktrees marks as current the deepest worktree containing the server's launch cwd, not the snapshot's currentWorktreePath, which mutating tools clear and detect_context moves.
- **handleListWorktrees**: list_worktrees shares one RefScanScope across the whole listing so branch and remote-ref scanning runs once rather than once per worktree.
- **handleGetWorktreeStatus**: get_worktree_status does not compute divergence itself; the field comes from the status result through the spread.
- **branchPrunedBySync**: The sync planner prunes worktrees whose branch is missing from the filtered remote branch list, and a just-created worktree passes every canRemove gate, so the next tick would trash it and delete its branch ref. create_worktree measures the branch against the same filters the runner applies; the branchMaxAge check reads only the local ref store and runs only when origin carries the branch, leaving local-only branches to pruneRiskWarning.
- **branchPrunedBySync**: Most repositories configure no branch filters, in which case sync keeps every remote branch, so the guard returns immediately without reading any git state.
- **branchPrunedBySync**: The sync runner keeps the default branch regardless of filters while origin carries it, because its worktree is where fetches run, so the guard does not refuse it. getDefaultBranch is cached and re-resolved only by sync, so after an origin-side rename the new default is refused until the next sync; that errs closed, names the filter, and force still overrides it.
- **pruneRiskWarning**: force on create_worktree bypasses the filter refusal but still reports the filter that will prune the worktree, and a branch that exists nowhere on origin gets the same warning whether push was declined or failed.
- **handleCreateWorktree**: create_worktree's fetch before checking branch existence is best-effort: when offline, existence is judged from the refs of the last successful fetch and a warning says so.
- **handleCreateWorktree**: Past the collision guard, a registration at the target path belongs to the requested branch, so addWorktree is a no-op and the response would otherwise be identical to a fresh checkout; worktreeExisted lets a retrying agent tell the two apart before trusting the checkout's contents.
- **handleSync**: Per-action sync failures are recorded on the outcome instead of rejecting sync(). Mirroring the CLI's runOnce exit code 1, the sync tool reports success false when any failed, while isError stays false because the call itself completed.
- **handleUpdateWorktree**: update_worktree resolves the worktree's branch from git immediately before fetching and merging, so the branch merged is the one checked out now rather than a stale snapshot value.
- **handleInitialize**: After initialize reports its skips, the one-shot pending init skip token is cleared so a later sync re-detects and re-reports a refused clone.
- **handleLoadConfig**: detectFromPath records only configs that loaded successfully, so load_config falls back to findConfigUpTree to locate a found-but-broken config and surface its real parse error instead of a generic configPath required message.
- **createProgressSequencer**: The MCP spec requires progress to increase with every notification, and the SDK does not enforce it, so the server keeps the promise. Phase item counts restart at 1 in every phase and stage, so each counted run is offset by everything reported before it. Everything else, including git transfer events, counts as one tick, because transfer events carry percentages and object counts that would otherwise inflate progress and reset a client's bar each stage.
- **createProgressSequencer**: In progress events, a defined progress field is a percentage that only git transfer events carry, so such events are treated as single ticks rather than counted runs.
- **createProgressSequencer**: A new counted progress run begins on a restart: a new phase, the next stage of the same phase, or a changed total; the run is stacked on top of the progress already reported.
- **createProgressSequencer**: A progress total smaller than the processed count is omitted from the notification rather than sent as a number already overshot.
- **createProgressSequencer**: The last progress total sent acts as a floor, because a run abandoned before reaching its total (for example a retried attempt) would otherwise make the next run's total shrink under the client mid-sync.

### `src/mcp/index.ts`

- **claimStdoutForTransport**: In the stdio MCP server stdout carries JSON-RPC only, so the transport gets a private handle on the real stdout and every other stdout write (a config's console.log, a dependency banner) is redirected to stderr.
- **claimStdoutForTransport**: A no-op error listener is attached to process.stdout because write errors already reach the transport through the private wire stream; without a listener the same error would also crash the process.
- **main**: The MCP server also serves 2025-era protocol clients from the same factory, tools and instructions, because the 2026-07-28 revision keeps older revisions alive for at least twelve months and most clients have not shipped 2026-07-28 support; rejecting them would strand every install.
- **main**: The stdio transport ignores EOF, so the server shuts down explicitly when stdin ends; otherwise a retry backoff or lock refresh timer would keep a disconnected server alive. Closing aborts in-flight calls.

### `src/mcp/output-schemas.ts`

- **output-schemas module**: Tool output schemas are advertised on tools/list and enforced on tools/call (SEP-2106), and the SDK turns a missing or mismatched structuredContent into an error. A field is required only when the handler's TypeScript return type guarantees it, and every object is loose so adding a response field is never a breaking change. Error results carry no structuredContent and are exempt, so formatErrorResponse stays schema-free.
- **worktreeStatusShape**: worktreeStatusShape is shared between the status member of a listed worktree and the flattened get_worktree_status result so the two cannot diverge.

### `src/mcp/server.ts`

- **TOOL_REGISTRY_TTL_MS**: The MCP tool and resource registry is fixed at construction, so clients may cache the listings for an hour.
- **createServer**: Every MCP tool input is a z.strictObject, because a plain z.object silently strips undeclared keys and the SDK passes the stripped data on, so a caller sending repo_name instead of repoName would act on the current repo and be told it succeeded. Strict schemas make that an InvalidParams error, and since zod puts the offending key in the issue message (Standard Schema drops the structured keys array but keeps the message) the name reaches the client's error result.
- **createServer**: The tool and resource listings are built once and never mutated, so they are cacheable for a long time with public scope; server/discover is private because its instructions embed workspace and config paths captured at connect time.
- **createServer workspace resource**: The workspace context resource reflects live git state served from detect_context's 5-second discovery cache, so it carries a zero-TTL, private cache hint: no client caching and never shared, since the payload contains local paths.
- **create_worktree tool registration**: create_worktree is annotated idempotent because the target path is a pure function of the branch name, a repeated call finds the branch existing so created is false and the push is not reattempted, and addWorktree finds the path registered and returns. sync is not idempotent because its work depends on what origin has done since.

### `src/mcp/utils.ts`

- **formatToolResponse**: Every MCP tool advertises an outputSchema, so each success result carries structuredContent matching it (SEP-2106) because the SDK rejects results that omit it; the JSON text block is kept for clients that only read content.
- **WorktreeDetachedError**: DETACHED_HEAD is for a registered worktree with no branch checked out. It is distinct from TARGET_EXISTS (nothing registered at the path) and from not a registered worktree: the path belongs to the repository, but a fast-forward cannot target it because there is no branch to move.

### `src/services/config-loader.service.ts`

- **evaluateConfigInWorker**: The reload worker's stdout is captured and sent to stderr, because process stdout carries the MCP JSON-RPC stream.

### `src/services/git.service.ts`

- **GitService.didInitializeFetch**: GitService records whether initialize fetched so MCP can skip a second fetch.

### `src/utils/mcp-registration.ts`

- **MCP_SERVER_COMMAND**: The MCP server auto-detects the bare repo and config from its working directory, so one user-level registration works across every repo and worktree.
- **MCP_CLIENTS**: Claude Code's default local MCP scope is per directory, which means per worktree, so registration passes --scope user.
- **probeClient**: execFile errors carry code as a string for spawn errors (ENOENT means the CLI is not installed) or as the numeric exit code otherwise, so probeClient checks both forms.
- **probeClient**: A timeout, unexpected exit code, or an older CLI without mcp get yields unknown rather than unregistered, because the server is not known to be missing and registration should not be offered.
- **maybeRegisterMcpClients**: maybeRegisterMcpClients offers to register the MCP server with detected AI CLIs and never throws, so it cannot fail an otherwise successful init.
- **maybeRegisterMcpClients**: All errors during MCP registration, including an inquirer Ctrl-C rejection, are swallowed because the config has already been written and init must not be reported as failed.

### Tests

Why the tests that pin these decisions are built the way they are.

#### `src/__tests__/e2e/mcp-config-stdout.e2e.test.ts`

- **MCP config loading stdout isolation**: In the MCP server stdout is the JSON-RPC stream, so anything a config prints while evaluated (first load on the main thread, reloads in a worker) is redirected to stderr.

#### `src/__tests__/e2e/mcp-sync-unreachable-remote.e2e.test.ts`

- **MCP sync tool retry handling**: The example config ships retry.maxAttempts 'unlimited', so over MCP a sync against an unreachable remote must still answer (with isError), must release the repository lock afterwards, and closing stdin must end the server even during a retry backoff.

#### `src/mcp/__tests__/context.broken-config.test.ts`

- **RepositoryContext.detectFromPath**: When a discovered config fails to load, the detect_context note carries the loader's own error message verbatim and names the config file, rather than a generic 'could not load'.
- **RepositoryContext.detectFromPath**: A plain directory is never entered into RepositoryContext's discovery cache, so repeated detects from it are real cache misses; only the broken-config failure gate keeps the loader from re-importing an unchanged broken file.
- **RepositoryContext.detectFromPath**: RepositoryContext reports the broken-config note on every detect, even when the unchanged file is not re-read.

#### `src/mcp/__tests__/context.capability-invariant.test.ts`

- **detect_context capabilities**: detect_context's capabilities block promises the agent what will work from its location, so a capability reported as available must never be answered with 'No repository specified' by the tool it names; the test checks this against real git without mocks.

#### `src/mcp/__tests__/context.nested-repo.test.ts`

- **RepositoryContext.detectFromPath**: detectFromPath walks up past any .git it cannot act on (a vendored repository, a submodule) and stops only at a shape it can handle; stopping at the first .git hid an enclosing managed worktree entirely. The tests build fixtures with real git because the walk reads pointer files, and a submodule inside a linked worktree writes 'gitdir: <bare>/worktrees/<wt>/modules/<name>', not '../.git/modules/<name>'.
- **RepositoryContext.detectFromPath**: When detectFromPath walks past a nested repository to an enclosing managed worktree, the answer reports the enclosing worktree's path and branch, never the nested repository's own branch.
- **RepositoryContext.detectFromPath**: detectFromPath never steps over an unreadable .git. A .git folder or a foreign gitdir positively identifies a non-worktree, but an errno is an absence of information, and stepping over it would answer with the enclosing repository, often a different one; a wrong answer is worse than a refusal because mutating tools act on the reported capabilities.
- **RepositoryContext.detectFromPath**: When detection stops at an unreadable .git, the reported current location is still the deepest readable nested repository the walk could name.
- **RepositoryContext.detectFromPath**: A configured clone-mode root is a terminal answer for detectFromPath; resuming the walk past it would return the enclosing worktree of a different repository.
- **RepositoryContext.detectFromPath**: Clone-mode roots are matched even when their .git is a file, because git clone --separate-git-dir leaves a .git file whose gitdir is not under <bare>/worktrees/<name>; once the walk resumed past non-actionable .git entries, looking up clone roots only for .git folders would step over a checkout the config names.
- **RepositoryContext.detectFromPath**: A --separate-git-dir clone root nested inside another repository's worktree must be recognized as the configured clone; without the clone lookup on .git files the walk answered with the enclosing worktree of a different repository.
- **RepositoryContext.detectFromPath**: detectFromPath runs the clone-mode root lookup only after ruling out the linked-worktree shape, so a directory that is both a real linked worktree and a configured clone root answers as the worktree.
- **RepositoryContext.detectFromPath**: When the walk reaches the filesystem root without an actionable answer, detectFromPath reports the deepest repository it passed rather than the probed subdirectory, preserving the answer unmanaged nested checkouts relied on.
- **RepositoryContext.detectFromPath**: The reason listing skipped nested repositories counts the rest beyond a few levels instead of enumerating them, because each clause carries an absolute path and the reason is repeated per capability and in notes; a deep nest turned a ~900-byte answer into 116 KB.

#### `src/mcp/__tests__/context.test.ts`

- **RepositoryContext.getRepositoryList**: load_config and set_current_repository list an auto-detected repository the same way detect_context does, with worktreeDir null, not the internal placeholder directory.
- **RepositoryContext**: An auto-detected entry is created once per bare repository and reused, so when a later detection derives a worktreeDir an earlier one could not, it writes the answer back to the entry; otherwise the reported worktreeDir and the one tools resolve would drift apart.
- **RepositoryContext**: An empty bare repository directory does not count as a ready repository, because the repository lock creates that directory before any clone has happened.
- **RepositoryContext discovery cache**: RepositoryContext's discovery cache is bounded, because each entry holds a full DiscoveredRepoContext including the repository's allWorktrees array, and a session walking a project's subdirectories previously retained one such array per probed path.
- **RepositoryContext discovery cache**: Evicting a path from RepositoryContext's discovery cache is not a correctness change: the evicted path simply re-detects on its next probe.
- **RepositoryContext.loadConfig**: When loadConfig rejects a config during validation, no repository from it is registered and the config path stays unset, so none of its entries can be synced.
- **RepositoryContext.loadConfig**: The stdio MCP server's stdout is the JSON-RPC stream, where any diagnostic is a protocol error, so RepositoryContext gives its ConfigLoaderService a stderr-bound logger for warnings such as unknown config keys.

#### `src/mcp/__tests__/context.worktree-dir.test.ts`

- **RepositoryContext worktreeDir detection**: Auto-detected worktreeDir is not simply the parent of the worktree the probe landed in, because a branch name can contribute several path components; the default-branch worktree sits at join(worktreeDir, defaultBranch), so a nested default branch like release/2024 made detection answer <wd>/release and create_worktree placed worktrees one level too deep.
- **RepositoryContext worktreeDir detection**: A single registered worktree is enough to derive worktreeDir, because the path shape it matches already tells how many components its branch name contributed.
- **RepositoryContext worktreeDir detection**: A wrong auto-detected worktreeDir makes create_worktree place worktrees one directory too deep, and a later configured sync, seeing the branch already checked out, never moves them back.
- **RepositoryContext worktreeDir detection**: When recognized worktrees name different parent directories with no answer to prefer, the auto-detected entry keeps a placeholder worktreeDir that nothing may write under.
- **RepositoryContext.getService**: getService builds the sync service from a spread copy of the entry's config, so refreshing only the entry left a service created with the placeholder worktreeDir; the service must be rebuilt so create_worktree writes under the derived directory detect_context reports.
- **RepositoryContext.ensureCapability**: invalidateDiscovered drops the discovery snapshot but keeps the entry, and ensureCapability falls back to base capabilities without a snapshot; load_config does exactly this, so write tools must stay unavailable for an entry whose worktreeDir is undetermined.
- **RepositoryContext worktreeDir detection**: A worktree placed outside worktreeDir in a directory named after its branch matches the anchor shape and votes for its own parent rather than abstaining; letting it veto removed createWorktree from repositories whose other worktrees agree, so the plurality parent wins.
- **RepositoryContext worktreeDir detection**: A worktree whose directory is named after neither its branch nor the branch's flattened form matches no shape and is not counted in worktreeDir detection.
- **RepositoryContext worktreeDir detection**: worktreeDir detection refuses when two recognized parent directories receive the same number of votes, since there is no answer to prefer.
- **RepositoryContext worktreeDir detection**: GitService.ensureMainWorktree can adopt a default-branch checkout found elsewhere, so one recognized entry names that location and another names the real worktreeDir; with one vote each, detection refuses.
- **RepositoryContext worktreeDir detection**: An adopted anchor exists because of a misplacement, so detecting from inside it must not conclude that its parent is where worktrees live; with one vote each, detection refuses and explains how to fix it.
- **RepositoryContext worktreeDir detection**: When only one recognized worktree exists and detection runs from it, it corroborates itself and its parent is used as worktreeDir; this is what makes a freshly initialized repository usable.
- **RepositoryContext worktreeDir detection**: Plurality alone is not trusted: hand-placed worktrees sharing a parent can outnumber the tool's own, so when the probe's worktree disagrees with the count, detection refuses instead of letting create_worktree write beside the strays.
- **RepositoryContext worktreeDir detection**: The probe corroborates the vote rather than overriding it: an agent is often standing in a stray hand-placed worktree, and preferring the probe put new worktrees beside that stray despite many tool-made worktrees agreeing elsewhere. Neither signal wins alone.
- **RepositoryContext worktreeDir detection**: git worktree add canonicalizes its target, so detection realpaths the probe before matching; a cwd reached through a symlink still matches its worktree entry and corroborates the count.
- **RepositoryContext worktreeDir detection**: A detached worktree probe carries the pseudo-branch '(detached <sha>)', matches no shape and has nothing to corroborate, so detection falls back to the vote count.

#### `src/mcp/__tests__/create-worktree-prune.test.ts`

- **create_worktree**: create_worktree checks the repository's branch filters because the sync planner prunes every worktree whose branch is missing from the filtered remote branch list; a freshly created worktree is clean with no unpushed commits, so the next tick would trash it and delete its branch ref, breaking the path just handed to the agent. The test asserts that sync behaviour against real git so the handler's refusal matches what actually happens.

#### `src/mcp/__tests__/create-worktree-retry.test.ts`

- **create_worktree idempotency tests**: The idempotentHint on create_worktree is verified against real git, not mocks: every case calls create_worktree twice with identical arguments and checks both responses and the resulting repository state. The second response must be distinguishable from the first, and the second call must add no worktree, no branch ref, no push and must not overwrite the existing checkout.
- **createWorktree handler**: Checking out an existing remote branch and then retrying after a client timeout is the acceptance case for worktreeExisted: without that field both create_worktree responses are byte-identical.
- **create_worktree idempotency tests**: An uncommitted file is written into the checkout between the two create_worktree calls so the test can tell a no-op retry (file survives) from a fresh checkout (file gone).
- **createWorktree handler**: On a retry of create_worktree every response field except worktreeExisted is identical to the first call's, so worktreeExisted is the only field that can tell an agent the checkout is a previous call's.
- **createWorktree handler**: create_worktree pushes only when it created the branch; on a retry the branch already exists so created is false, which guarantees the branch is pushed exactly once however often the call is repeated.
- **createWorktree handler**: create_worktree's idempotency is state convergence rather than a strict no-op: if the worktree was removed between two calls, the second call rebuilds it and reports worktreeExisted false, ending in the same state with no second worktree registered.
- **createWorktree handler**: worktreeExisted is computed from the pre-call worktree listing, which still includes a prunable registration whose directory was deleted out of band; addWorktree then clears that registration and rebuilds the checkout. So true means a registration already existed, not that previous work survived, and the output schema describes the stale-registration case explicitly.
- **create_worktree idempotency tests**: The stale-registration case deletes the worktree directory with rm rather than git worktree remove, because only an out-of-band deletion leaves the registration in place.

#### `src/mcp/__tests__/handlers.capability-gate.test.ts`

- **handleUpdateWorktree**: update_worktree resolves the worktree's branch from a live git listing rather than the discovery snapshot, so tests of it must make git report the fixture worktree.
- **ensureCapability**: The MCP capability gate runs before any WorktreeSyncService is constructed for the repository entry, so a refused tool never builds a service.

#### `src/mcp/__tests__/handlers.context-flows.test.ts`

- **RepositoryContext capabilities**: In auto-detect mode there is no config, so the config-driven capabilities (sync, initialize) are unavailable while the worktree-mutating ones (createWorktree, updateWorktree) are available.
- **ensureCapability**: With the discovery snapshot cleared by a mutating tool, the capability gate must still deny sync for an auto-detected, unconfigured repository; falling through to allowed would let sync run against a repository that was never configured.
- **RepositoryContext.invalidateDiscovered**: After invalidateDiscovered, the next detect_context re-reads git rather than replaying a cached result, so it reports the worktree listing git gives at that moment.
- **RepositoryContext.getService**: A repoName the loaded config does not list is refused by RepositoryContext.getService before any service is built and before any fallback to the current repository.
- **ensureRepoWorktree**: A worktree removed out of band leaves the discovery snapshot still listing it, since nothing notifies the context; mutating tools must therefore resolve membership from git rather than trust the snapshot.
- **ensureRepoWorktree**: A refused update_worktree for a vanished worktree is scoped to that path: other worktrees still registered in the same repository continue to update.

#### `src/mcp/__tests__/handlers.test.ts`

- **handleListWorktrees**: Worktree divergence is a field of the status result and a required member of the status object in the advertised schema. list_worktrees must report it both at the top level of each worktree and under status from that same result, and the test parses the schema because no other test pins that wiring.
- **handleCreateWorktree branch-filter guard**: The sync planner prunes every registered worktree outside the filtered remote branch list, and a freshly created worktree passes every canRemove gate, so the next tick would undo it. create_worktree therefore refuses such a branch up front.
- **handleCreateWorktree branch-filter guard**: The sync runner's resolveSyncBranches keeps the default branch in the inventory regardless of branch filters while origin still has it, so the create_worktree filter guard must not refuse the default branch.
- **handleCreateWorktree branch-filter guard**: filterBranchesByName applies an include or exclude list only when it is non-empty, so an empty list means no filter in the sync runner; the create_worktree guard reads filters through the same function so the two agree.
- **handleSync**: When sync completes but some actions failed, the sync tool returns a structured result with success false rather than an isError result, because the call itself completed.
- **createProgressSequencer**: The MCP spec requires progress to increase with each notification even if the total is unknown, while a sync's item counts restart at 1 in every phase and every stage of a phase; the progress reporter must reconcile the two.
- **createProgressSequencer**: Each counted run of sync progress keeps its own denominator, offset by the progress reported before the run started, so the total sent is the offset plus the run's own total.
- **createProgressSequencer**: Git's transfer output has four stages, each opening at 0% (0/n) and printing its 100% line twice. Counting those as items repeated progress values and made a small sync of a 1200-object repository report progress in the thousands, with the client's bar resetting each stage.
- **createProgressSequencer**: A git transfer event counts as one progress tick: its percentage is already in the message, and its object count is not a count of sync items.
- **handleUpdateWorktree**: update_worktree clones a configured repository whose bare clone is not on disk before resolving the path, because both the worktree listing and the following fetch need it. Every other test double reports isInitialized() true, so a dedicated test with an uninitialized double pins the guard.
- **handleUpdateWorktree**: The discovery snapshot has no freshness check, and a git checkout -b inside a worktree changes only that worktree's HEAD. Acting on the snapshot's branch name could merge the old branch into the worktree and fast-forward the new branch to the old tip, a silent branch rewrite, so update_worktree reads the branch from git before fetching and merging.
- **handleUpdateWorktree**: A detached worktree has no branch to fast-forward; git's listing marks it detached with an empty branch name. Without the guard update_worktree would fetch and merge origin/, which git interprets as a refspec of its own.
- **ensureRepoWorktree**: Git omits detached worktrees from its listing unless asked, so the membership listing passes includeDetached; otherwise the detached-HEAD refusal is unreachable against real git and the answer degrades to not a registered worktree.
- **handleGetWorktreeStatus**: get_worktree_status gets divergence from the status result through a spread rather than computing it itself; the advertised schema requires the field, so the test parses the body against it.
- **ensureRepoWorktree**: Worktree membership for MCP tools always comes from git, never from the discovery snapshot, so a detached worktree gets the same answer with a cold or warm cache.
- **handleLoadConfig**: detectFromPath records only configs that loaded successfully, so a found-but-broken config is reachable only through the findConfigUpTree fallback in load_config; without it the user gets a generic configPath required message instead of the parse error.
- **handleListWorktrees**: list_worktrees derives isCurrent from the server's launch cwd rather than the discovery snapshot, so invalidateDiscovered from a mutating tool or a detect_context elsewhere cannot change it.
- **handleListWorktrees**: For a configured repository that was never cloned, git worktree list runs against a missing bare directory and there is no detected context to fall back to; the error must name the underlying git failure and point at initialize rather than only listing what failed.
- **handleCreateWorktree**: Choosing between the plain and hashed worktree directory name belongs to GitService.resolveNewWorktreePath; the create_worktree handler must create the worktree exactly at the path it returns.
- **handleCreateWorktree**: create_worktree refuses an occupied target path before creating the branch, because refusing afterwards would leave an unpushed local branch that a later retry checks out without ever pushing.
- **handleCreateWorktree**: A create_worktree retry after a client timeout must be distinguishable from the first call; without worktreeExisted the second response is byte-identical to checking out an existing remote branch into a new worktree, so an agent cannot tell a no-op from a fresh checkout.
- **handleCreateWorktree**: created and worktreeExisted answer different questions in create_worktree's response: a brand new branch is created true with nothing at the path, so neither field alone tells the agent what it holds.
- **handleCreateWorktree**: worktreeExisted is required by create_worktree's output schema, so the partial-success result returned after a failed push must carry it too, or the SDK turns the whole result into an error.
- **handleDetectContext**: allWorktrees and allWorktreesByRepo for the current repository come from two separate git worktree list reads, so every worktree of the current repo appears in both. Enriching each list independently probed each worktree twice, about 8 git processes each time, so one shared enricher is used.

#### `src/mcp/__tests__/server.test.ts`

- **tool input schemas**: Every MCP tool input is a strict object, because a plain z.object strips undeclared keys and the SDK passes the stripped value on, so a misspelled repo_name would act on the current repo and report success. The tests assert rejection through ~standard.validate, the same entry point the SDK's validateToolInput uses.
- **create_worktree tool registration**: A worktree created with push false is pruned by the next sync, so create_worktree's push and force parameter descriptions must state the pruning consequence where an agent reads the parameter, not only in the response.
- **create_worktree tool registration**: create_worktree's description explains worktreeExisted because the description is where a model learns field meaning; the schema describe text only reaches clients that read outputSchema.
- **createServer cache hints**: server/discover is cacheable but with private scope, because its instructions embed workspace paths captured at connect time.
- **createServer cache hints**: The tools/list response is publicly cacheable because the tool registry is fixed at server construction and carries no user-specific data.
- **create_worktree tool registration**: create_worktree is annotated idempotent because repeating it with the same arguments is a no-op, so clients gating re-execution on idempotentHint need not prompt. sync stays non-idempotent because its effect depends on what origin has done since.
- **createWorktreeOutputSchema**: worktreeExisted ships in create_worktree's advertised output schema as a required field rather than one present only when it applies, so a retry is always legible.
- **tool input schemas**: Strict tool inputs are verified over the wire: an unrecognized key must come back as an error result whose text names the key, because a loose schema would strip repo_name and run create_worktree against the current repository.

#### `src/mcp/__tests__/update-worktree-detached.test.ts`

- **handleUpdateWorktree**: Detached-worktree handling is tested with real git because faking the listing would fake the bug away: git worktree list --porcelain prints a detached entry with a HEAD line, a detached line and no branch line, and the default listing omits it entirely, which made update_worktree call a registered path unregistered.
- **ensureRepoWorktree**: A detached registration whose checkout was deleted is listed as detached and prunable once detached entries are requested. update_worktree treats it as unregistered rather than DETACHED_HEAD, because there is no directory to check a branch out in, consistent with GitService treating prunable registrations as absent.
- **isCheckoutMissing**: Git does not compute prunable for a locked registration, so a locked detached worktree whose directory was deleted looks exactly like a live one in the listing. Locking is git's documented approach for worktrees on removable media, so the directory is probed on disk and a missing one is reported as WORKTREE_MISSING instead of prescribing a branch checkout.
- **isCheckoutMissing**: Because git suppresses prunable on a locked registration, the prunable filter in getWorktrees cannot detect that a locked checkout no longer exists; a separate on-disk probe is required.
- **isCheckoutMissing**: A lock is not by itself a reason to treat a worktree as missing: a locked detached worktree still on disk is an ordinary detached checkout and gets DETACHED_HEAD, whose remedy can be carried out there.
- **ensureRepoWorktree**: Requesting detached entries also includes the bare repository's own row, which has neither a branch nor a detached HEAD; nothing may be fetched or merged for it, because fetchBranch with an empty name would fetch every ref.

#### `src/mcp/__tests__/worktree-shapes.test.ts`

- **isCheckoutMissing**: Git does not mark a locked registration prunable, so nothing in the listing says its directory is gone; without an on-disk probe update_worktree would run git in a missing directory and fail with spawn git ENOENT.

#### `src/utils/__tests__/mcp-registration.test.ts`

- **MCP_CLIENTS**: Claude Code's default local MCP scope is per directory, so a registration without --scope user would not reach other worktrees.

## Consequences

Changing code covered by an entry here means updating the entry in the same pull request. An entry that no longer holds is deleted, or superseded by a new numbered ADR when the reversal is itself a decision worth keeping.

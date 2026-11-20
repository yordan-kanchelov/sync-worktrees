# ADR-0015: Security and redaction

- **Status:** Accepted
- **Date:** 2026-11-20
- **Source:** 55 code comments as of `5f17242`, moved here by [ADR-0001](./0001-record-decisions-in-adrs-not-comments.md)

## Context

Repository URLs can embed credentials, branch names come from remotes, and some values reach a shell. These decisions keep secrets out of output and keep untrusted names from being read as options or commands.

## Decisions

Grouped by the file that implements them, source before tests. Each entry names the symbol it governs.

### `bin/sync-worktrees.js`

- **bin/sync-worktrees.js main catch**: The CLI bin shim reports top-level failures through reportUnhandledError, which redacts credential-bearing URLs; printing the raw error (util.inspect of a simple-git failure) leaks tokens embedded in remote URLs.

### `eslint.config.cjs`

- **eslint.config.cjs no-restricted-syntax**: Repository URLs can carry credentials and output redaction has drifted more than once, so lint bans the shapes that put a raw repoUrl in front of a person (a fallback label, template interpolation, concatenation) outside tests. Code must use repoDisplayLabel or redactRepoUrl from utils/git-url.

### `src/cli/list.ts`

- **ListedRepository.repoUrl**: The repoUrl in list output has any embedded credentials removed when the listing is built, so later formatting can print it directly.

### `src/components/App.tsx`

- **App.addLog**: Every log line (service loggers, reload and sync failures, wizard errors) passes through App.addLog, so secrets are redacted there; a git error that quotes a credential-bearing remote URL is scrubbed before it reaches the log buffer.

### `src/index.ts`

- **runFromConfigFile**: A typed SyncWorktreesError is fully described by its message line; any other error is a bug, so its stack is printed too, passed through secret redaction because git errors quote the remote URL.
- **reportUnhandledError**: reportUnhandledError is the last-resort report for failures escaping main and is shared with bin/sync-worktrees.js, whose handler runs in normal use. It inspects the error first so a git error quoting a credential-bearing remote URL in its message, stack or task commands is redacted.

### `src/mcp/context.ts`

- **DiscoveredRepoContext**: DiscoveredRepoContext is the presentation view returned to MCP clients, and every repoUrl in it and in the sibling and configured-repository summaries is passed through redactRepoUrl. The working URL stays on the entry's config, which is what services use for git operations.

### `src/mcp/handlers.ts`

- **probeWorktreeStatus**: A failed status probe leaves the worktree listed as unknown and not safe to remove, and keeps the error reason so callers do not get a bare status unavailable. The reason is redacted when the probe error is captured as well as in formatToolResponse because git quotes the remote URL in its errors.

### `src/mcp/utils.ts`

- **redactSecretsInPayload**: Every string in an MCP response payload is scrubbed of credential-bearing URLs. Repository URLs are also redacted at their source, but the payload-wide pass catches free text carrying git's own output (per-repository errors, notes, skip messages, outcome failures) without each handler having to remember.
- **formatErrorResponse**: Git quotes the remote URL in its failure messages, so an error's message and its stack, which begins with the message, are redacted before an MCP client sees them.

### `src/services/branch-ref.service.ts`

- **BranchRefService update-ref write**: update-ref is called with -- before its positionals because the reaper promotes trash pins to keep refs using a manifest-sourced oid, and git update-ref <ref> -d deletes the ref it was asked to write (measured, exit 0). With the separator the same input fails with not a valid SHA1 and the ref survives.
- **BranchRefService.createBranchAt**: git branch is called with -- before the name and start point because both come from a trash manifest and git's option parser permutes arguments: an option-shaped value such as -m would rename the branch HEAD points at in the bare repo. With -- (verified on git 2.43.0) option-shaped values are rejected and refs/heads is untouched.

### `src/services/clone-sync.service.ts`

- **CloneSyncService.repoName**: The clone repository display name is used only in log lines and progress messages, so its URL fallback is shown with embedded credentials stripped.

### `src/services/clone-sync/clone-markers.ts`

- **writeIncompleteCloneMarker**: The incomplete-clone marker holds the failure time, the summary line the refusal quotes, and git's untruncated stderr. It is redacted on write like every clone-mode string, because a repoUrl token can appear in git's output and the marker is written to disk and read back into an error on every later run.

### `src/services/config-schema.ts`

- **describeValue**: Rejected config values are redacted before they are shortened, because truncating first could separate a URL's userinfo from the @ that redaction keys on; objects are named by kind only since their contents could be anything.

### `src/services/hook-execution.service.ts`

- **HookExecutionService placeholder substitution**: Hook placeholders are substituted in one pass with a function replacer, so dollar patterns in values are not interpreted and substituted values are never re-expanded.

### `src/services/logger.service.ts`

- **Logger**: Every logger line passes through redactSecretsInText, because repository URLs with embedded credentials are common in CI and appear in clone and fetch messages, git error text and the run banner, so scrubbing is centralized instead of trusting each call site.
- **Logger.error**: Logger.error inspects the error value itself rather than passing it to console.error, because util.inspect output (message, stack, simple-git task.commands) can carry a credential-bearing URL that must be scrubbed; expected git or typed failures are summarized to one line unless debug is on.

### `src/services/repository-dashboard.ts`

- **firstLine**: Dashboard result text keeps only the first non-empty line of an error, because git errors can span several stderr lines and the table has one row per repository; credentials in a quoted remote URL never reach it.

### `src/services/repository-operations.ts`

- **RepositoryOperations.rollbackUnpushedBranch**: Push error text is redacted because git's stderr for an https remote includes the credential-bearing URL and the message is shown in the wizard's result pane, matching clone mode's equivalent.

### `src/services/trash.service.ts`

- **TrashService.restore**: Restore is the only operation that writes to a manifest's originalPath, so it refuses destinations outside the workspace, checked against the current worktreeDir so relocated workspaces work. Listing and reaping are deliberately unaffected.
- **TrashService.releaseAdoptedKeepRef**: Adopting a legacy `.diverged/` backup replaces its permanent keep ref with the entry's pin ref and bundle, so the legacy ref is released, but only after trashDirectory has resolved. The candidate name comes from a user-editable JSON file, so the ref is re-derived from the manifest and must match exactly; a prefix check would accept paths like `refs/sync-worktrees/keep/../../heads/main`.
- **TrashService.isRestorableBranch**: Manifest branch names must pass isGitCreatableBranchName, because branch and headOid reach git as positional arguments and git's permuting option parser reads option-shaped values as options (measured on git 2.43: renaming main or deleting refs); the check complements the `--` separators the git wrappers pass. An invalid manifest is rejected entirely, so such an entry is never listed, restored or reaped and stays until removed by hand. The policy is only safe while isGitCreatableBranchName is no stricter than git, otherwise entries silently become unreachable on upgrade; it must not delegate to the stricter creation-time validator, and a corpus test against `git check-ref-format --branch` enforces the invariant.
- **TrashService.isOwnPinRef**: A manifest's pin ref must belong to its entry so a hand-edited manifest cannot aim the reaper's deleteRef at refs like refs/heads/main. Both the namespaced `<prefix><rootHash>/<id>` and the older flat `<prefix><id>` layouts are accepted so pre-upgrade entries are not stranded, and the root-hash segment is checked only for shape so relocating worktreeDir does not invalidate entries.

### `src/services/worktree-sync.service.ts`

- **WorktreeSyncService.assertKeepRefName**: Keep ref names become a path segment of refs/sync-worktrees/keep/<name>, so anything that could climb out of the namespace or be parsed as an option is rejected before reaching git.

### `src/utils/app-events.ts`

- **scrubPayload**: Every string carried by an app event is headed for the screen, so the event emitter redacts secrets in all string payloads and top-level string fields centrally. A caller that forgot to redact a credential-bearing URL still never gets it rendered; the original payload is returned when nothing changed.

### `src/utils/git-url.ts`

- **URL_USERINFO_PATTERN**: Secret redaction matches only the scheme://userinfo@ prefix so hosts, ports, IPv6 literals and paths are untouched; userinfo cannot contain /, @ or whitespace, which keeps a match inside its own URL. A lookbehind anchors the scheme so long runs of scheme characters without :// stay linear-time.
- **redactRepoUrl**: redactRepoUrl replaces the whole userinfo, including a bare username, with *** because forges accept access tokens in the username position; scp remotes and local paths carry no secret and pass unchanged. The result is for display only and must never be passed to git.
- **repoDisplayLabel**: Every log line, progress row and message naming a repository uses repoDisplayLabel (configured name, else redacted URL); ESLint rules forbid falling back to or interpolating a raw repoUrl because it can leak credentials.
- **redactSecretsInText**: redactSecretsInText scrubs every scheme://userinfo@ occurrence in free text such as git's stderr and log lines, so a credential-bearing remote URL never reaches a terminal or API client.

### `src/utils/git-validation.ts`

- **isGitCreatableBranchName**: git branch refuses a leading dash but check_refname_format does not, so a remote can carry refs/heads/-foo into a manifest. Such names are rejected so they never reach git as a positional argument and get parsed as an option.
- **isGitObjectId**: Object ids read from manifests must be hex so they can never be taken as an option by git commands that accept them positionally (git branch <name> -m is permuted into a rename). Length is deliberately not pinned to 40 or 64 so manifests written under a future hash are not stranded as unrecognized content.

### Tests

Why the tests that pin these decisions are built the way they are.

#### `src/__tests__/cli-sync-errors.test.ts`

- **runSync error reporting**: git quotes the remote it was handed, so a token in the repository URL appears in failure text, and the stack begins with that same text. Both the run-phase error line and its stack are redacted, and tests pin both because dropping either scrub is otherwise invisible.
- **reportUnhandledError**: bin/sync-worktrees.js is what runs in normal use and its last-resort handler printed the raw error; util.inspect of a simple-git failure includes task.commands with the remote URL and any token, so reportUnhandledError scrubs message, stack and inspected properties.

#### `src/__tests__/e2e/bare-origin-mismatch.e2e.test.ts`

- **bare repository origin check**: The origin-mismatch remedy says `remote set-url origin <the repoUrl configured ...>` instead of echoing the URL, because a credential-bearing URL is redacted in the message and pasting the redacted form would set an origin that cannot fetch.

#### `src/mcp/__tests__/context.test.ts`

- **RepositoryContext**: An auto-detected entry keeps the working, credential-bearing repoUrl because git operations need it; only the presentation list and detect_context output show the redacted URL.

#### `src/services/__tests__/bare-repo.service.test.ts`

- **GitService.getRemoteDefaultBranch**: Error messages about the remote redact credentials, but git itself is still handed the working, credential-bearing URL.
- **BareRepoService origin check**: The origin-mismatch remedy must not hand back a redacted URL to paste, because the redaction placeholder replaces the credentials and running that command would set an origin that cannot fetch.

#### `src/services/__tests__/config-loader.service.test.ts`

- **redactSecretsInText**: Any userinfo field in a URL, even a plain `git@`, is treated as a credential position and redacted in error messages.

#### `src/services/__tests__/interactive-ui.reload-logging.test.ts`

- **InteractiveUIService reload**: A repository configured without a name is labelled by its URL, which may contain a token, so every place the reload names it (progress row, clone-skip line) shows the URL redacted.

#### `src/services/__tests__/interactive-ui.service.test.ts`

- **InteractiveUIOperations.createAndPushBranch**: git's stderr for an https remote embeds the credential in the failing URL, and the message is shown in the wizard's result pane, so push failures are redacted (and an auth hint appended) before display.

#### `src/services/__tests__/logger.service.test.ts`

- **Logger.error**: simple-git errors carry the invoked command line, URL and credentials included, in an enumerable task property that util.inspect prints with the stack, so the logger must scrub the inspected error, not only its message.
- **Logger.error**: The logger never passes the raw Error object to console.error; it inspects and scrubs it to text first, so no unredacted field can be printed.

#### `src/services/__tests__/trash.service.test.ts`

- **TrashService.readManifest**: A manifest's pin ref is passed by the reaper and restore to git update-ref -d, so every shape that does not end at the entry's own id under the trash prefix is rejected; otherwise a hand-edited or corrupted manifest could choose the delete target.
- **TrashService.readManifest**: Restore passes branch and headOid to git positionally and git's option parser permutes, so an option-shaped value is read as an option; measured on git 2.43, git branch -m <sha> or git branch <name> -m in a bare repo renames main and breaks every later sync. No real branch name or oid can look like that, so the manifest validator rejects such values before they reach any git wrapper.
- **TrashService.readManifest**: headOid is the start point of git branch and the new value for the reaper's git update-ref <keepRef> <headOid>. Measured on git 2.43, git update-ref <ref> -d permutes into a delete, so an option-shaped headOid would delete the keep ref while reporting commits preserved; the validator therefore requires a real hex object id.

#### `src/services/__tests__/worktree-metadata.service.test.ts`

- **Logger.error**: Logger.error prints a single scrubbed line (message plus inspected error) instead of passing the raw Error to console.error, so credential-bearing URLs in git output never reach the terminal unredacted.

#### `src/services/__tests__/worktree-sync.service.test.ts`

- **WorktreeSyncService.deleteKeepRef**: A keep ref name is one path segment under refs/sync-worktrees/keep/ and reaches git as a positional argument, so any name that could climb out of the namespace, address a nested ref, or be read as an option is rejected by both the single and batch drop.

#### `src/utils/__tests__/app-events.test.ts`

- **AppEventEmitter**: AppEventEmitter is the dashboard's single entry point for text, so it redacts credentials at that boundary: whatever a caller forgot to redact, no credential-bearing URL reaches a log line or progress row.

#### `src/utils/__tests__/disk-space.test.ts`

- **calculateDirectorySize**: A directory name containing a space and `$(...)` proves the path reaches du as one argument with no shell expansion.

#### `src/utils/__tests__/git-url.test.ts`

- **redactRepoUrl**: Widening the URL grammar must not widen what reaches logs, so the newly accepted shapes (git://, uppercase schemes, trailing slashes) are tested with real tokens to confirm redaction.
- **redactRepoUrl**: scp-form remotes carry no password field and their username is not treated as a secret, so redactRepoUrl leaves them unchanged.
- **extractRepoNameFromUrl**: Both extractRepoNameFromUrl error messages embed the URL, so both redact credentials; a credentialed path-less https URL is dialable, so it gets the no-path-segment message, not the invalid-format one.

#### `src/utils/__tests__/git-validation.test.ts`

- **isGitObjectId**: Values like -deadbeef and " deadbeef" are the cases an unanchored hex pattern would accept; the first is exactly the option-shaped value git would permute into a switch, so the pattern must be anchored.
- **isGitCreatableBranchName**: A bare dash is the canonical option-shaped branch name and the main reason the manifest branch-name predicate exists; git branch refuses it too.

## Consequences

Changing code covered by an entry here means updating the entry in the same pull request. An entry that no longer holds is deleted, or superseded by a new numbered ADR when the reversal is itself a decision worth keeping.

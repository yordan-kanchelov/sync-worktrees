import * as fs from "fs/promises";
import * as path from "path";

import { DEFAULT_CONFIG, ENV_CONSTANTS, PATH_CONSTANTS } from "../constants";
import { ConfigError, FastForwardError, GitOperationError, WorktreeNotCleanError } from "../errors";
import { fileExists, probePathExists } from "../utils/file-exists";
import { appendGitAuthHint } from "../utils/git-auth-error";
import { createGitClient } from "../utils/git-client";
import { makeGitProgressHandler } from "../utils/git-progress";
import { normalizeRepoUrlForComparison, redactRepoUrl, redactSecretsInText } from "../utils/git-url";
import { getErrorMessage, isLfsError, isMissingRemoteRefError } from "../utils/lfs-error";
import { isUnitTestShortcutEnabled } from "../utils/unit-test-shortcut";

import { BranchCreatedActionsService } from "./branch-created-actions.service";
import { cloneSkipToOutcomeAction } from "./sync-outcome";

import type { GitService } from "./git.service";
import type { Logger } from "./logger.service";
import type { SyncOutcomeAccumulator } from "./sync-outcome";
import type { Config, RepositoryConfig } from "../types";
import type { GitProgressEmitter, GitProgressEvent } from "../utils/git-progress";
import type { Stats } from "fs";
import type { SimpleGit, SimpleGitOptions } from "simple-git";

const SHALLOW_RELATION_DEEPEN_TARGETS = [50, 200, 1000] as const;

// Longest failure summary kept on the incomplete-clone marker's first content
// line; the untruncated message follows it in the same file.
const CLONE_FAILURE_SUMMARY_LIMIT = 200;

// Paths handed to one `ls-tree` / `hash-object` / `restore` while a rejected
// fast-forward is being undone. The set is usually a handful of files — the
// ones that sort before the path git could not write — but an upstream commit
// whose failing path sorts last leaves every changed file behind, and one
// command line still has to fit the platform's argument limit.
const MERGE_CLEANUP_PATH_BATCH = 200;

// How many of those paths the summary line names before it starts counting.
const MERGE_CLEANUP_LOG_PATH_LIMIT = 5;

// `ls-tree`'s mode for a symlink, whose blob holds the target path rather than
// any file's contents.
const SYMLINK_TREE_MODE = "120000";

// Candidate paths come off `git diff --name-only`, so they are filenames, not
// patterns. Git would read a leading ':' as pathspec magic -- ':userfile.txt'
// matches nothing and `ls-tree` still exits 0, which would turn the deletion
// half's "origin no longer holds it" proof into no proof at all. `:(literal)`
// makes git match the name exactly.
const asLiteralPathspec = (candidate: string): string => `:(literal)${candidate}`;

interface RemoteTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly id: string;
}

function batchPaths(paths: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let start = 0; start < paths.length; start += MERGE_CLEANUP_PATH_BATCH) {
    batches.push(paths.slice(start, start + MERGE_CLEANUP_PATH_BATCH));
  }
  return batches;
}

// git's stderr condensed to the one line that says why. A clone failure
// carries the whole transfer log — progress lines, separated by carriage
// returns, included — and the verdict is its last 'fatal:'/'error:' line.
function summarizeGitFailure(message: string): string {
  const lines = message
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const verdict = [...lines].reverse().find((line) => line.startsWith("fatal:") || line.startsWith("error:"));
  const summary = verdict ?? lines[lines.length - 1] ?? "";
  return summary.length > CLONE_FAILURE_SUMMARY_LIMIT
    ? `${summary.slice(0, CLONE_FAILURE_SUMMARY_LIMIT - 3)}...`
    : summary;
}

// Brand carried by a clients pair whose directory has been verified as a
// primary, non-linked checkout. Only mutatingClientsFor() can produce one, and
// every helper below that writes to the repository takes this type instead of a
// bare SimpleGit — so a mutation added later cannot reach an adopted directory
// without passing the guard first.
const PRIMARY_CHECKOUT_VERIFIED: unique symbol = Symbol("primaryCheckoutVerified");

interface MutatingGitClients {
  readonly [PRIMARY_CHECKOUT_VERIFIED]: true;
  /** Local commands (config, update-ref, switch, merge). */
  readonly git: SimpleGit;
  /** Network commands (fetch) other than the unshallow, killed after fetchTimeoutMs of silence. */
  readonly networkGit: SimpleGit;
  /** The unshallow fetch alone, killed after cloneTimeoutMs of silence — see unshallowClientFor. */
  readonly unshallowGit: SimpleGit;
}

export type CloneSkipReason =
  | { kind: "branch_mismatch"; phase: "init" | "sync"; currentBranch: string; expectedBranch: string }
  | { kind: "head_unreadable"; phase: "init" | "sync"; error: string }
  | { kind: "dirty_tree" }
  | { kind: "diverged"; branch: string }
  | { kind: "ahead_unpushed"; branch: string }
  | { kind: "missing_remote_ref"; branch: string; source: "fetch_error" | "post_fetch_verify" }
  | { kind: "indeterminate_shallow"; branch: string; deepenedTo: number | null }
  | { kind: "origin_mismatch"; actual: string; expected: string };

export type CloneSkipListener = (reason: CloneSkipReason) => void;

export class CloneSyncService {
  private initialized = false;
  private resolvedBranch: string | null = null;
  private branchCreatedActions: BranchCreatedActionsService;
  private progressEmitter?: GitProgressEmitter;
  private onSkip?: CloneSkipListener;
  private outcomeAccumulator?: SyncOutcomeAccumulator;
  // One-shot suppression token. When init records a wrong-branch / unreadable-HEAD
  // skip for an existing clone, it sets this so the immediately following
  // runSyncAttempt (same sync operation) does not record the identical skip again.
  private pendingInitSkip: CloneSkipReason | null = null;

  constructor(
    private config: Config,
    private gitService: GitService,
    private logger: Logger,
    options: {
      branchCreatedActions?: BranchCreatedActionsService;
      progressEmitter?: GitProgressEmitter;
      onSkip?: CloneSkipListener;
    } = {},
  ) {
    this.branchCreatedActions = options.branchCreatedActions ?? new BranchCreatedActionsService();
    this.progressEmitter = options.progressEmitter;
    this.onSkip = options.onSkip;
  }

  updateLogger(logger: Logger): void {
    this.logger = logger;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  clearPendingInitSkip(): void {
    this.pendingInitSkip = null;
  }

  async getWorktrees(): Promise<Array<{ path: string; branch: string }>> {
    const worktreeDir = path.resolve(this.config.worktreeDir);
    if (!(await fileExists(path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR)))) {
      return [];
    }

    const git = this.localClientFor(worktreeDir);
    let branch = (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();

    if (!branch || branch === "HEAD") {
      const head = (await git.raw(["rev-parse", "--short", "HEAD"])).trim();
      branch = head ? `(detached ${head})` : "(detached)";
    }

    return [{ path: worktreeDir, branch }];
  }

  // Display name only (log lines and progress messages), so the URL fallback
  // is shown with any embedded credentials stripped.
  private get repoName(): string {
    return (this.config as RepositoryConfig).name ?? redactRepoUrl(this.config.repoUrl);
  }

  private getCloneTimeoutMs(): number {
    if (isUnitTestShortcutEnabled()) return 0;
    return this.config.cloneTimeoutMs ?? DEFAULT_CONFIG.CLONE_TIMEOUT_MS;
  }

  private getFetchTimeoutMs(): number {
    if (isUnitTestShortcutEnabled()) return 0;
    return this.config.fetchTimeoutMs ?? DEFAULT_CONFIG.FETCH_TIMEOUT_MS;
  }

  // The configured setting plus the per-sync override the retry policy installs
  // on GitService once an attempt has died on an LFS error. Only the first half
  // was read here, so every client this service builds — the retry attempt's
  // fetch, its `merge --ff-only` — ran with the identical environment after
  // "Temporarily disabling LFS downloads" had already been logged, and the
  // retry failed on exactly the object the attempt before it had.
  private isLfsSkipEnabled(): boolean {
    return this.config.skipLfs === true || this.gitService.isLfsSkipEnabled();
  }

  // Progress and inactivity timeout only; createGitClient adds the env and the
  // unsafe-env allowances every client needs.
  private buildGitOptions(blockMs: number): Partial<SimpleGitOptions> {
    const options: Partial<SimpleGitOptions> = {
      progress: makeGitProgressHandler(
        () => this.logger,
        (event) => this.emitProgress(event),
      ),
    };
    if (blockMs > 0) options.timeout = { block: blockMs };
    return options;
  }

  private emitProgress(event: GitProgressEvent): void {
    try {
      this.progressEmitter?.(event);
    } catch {
      // progress listeners must not break sync flow
    }
  }

  private async withOutcome<T>(outcome: SyncOutcomeAccumulator | undefined, operation: () => Promise<T>): Promise<T> {
    const previousOutcome = this.outcomeAccumulator;
    if (outcome) {
      this.outcomeAccumulator = outcome;
    }

    try {
      return await operation();
    } finally {
      if (outcome) {
        this.outcomeAccumulator = previousOutcome;
      }
    }
  }

  private recordSkip(
    reason: CloneSkipReason,
    logMessage: string,
    progressMessage?: string,
    logLevel: "warn" | "info" = "warn",
  ): void {
    if (logLevel === "warn") {
      this.logger.warn(logMessage);
    } else {
      this.logger.info(logMessage);
    }
    this.emitProgress({ phase: "skip", message: progressMessage ?? logMessage });
    try {
      this.onSkip?.(reason);
    } catch {
      // listeners must not break sync flow
    }
    this.outcomeAccumulator?.add(
      cloneSkipToOutcomeAction(reason, {
        branch: this.resolvedBranch ?? this.config.branch,
        path: this.config.worktreeDir,
      }),
    );
  }

  // Client for local commands (rev-parse, config, show-ref, for-each-ref,
  // update-ref, merge, switch, checkout, remote get-url). No inactivity kill:
  // simple-git's block timeout only resets on stdout/stderr data, and git is
  // legitimately silent for minutes while a merge or checkout materializes a
  // large tree — killing it there fails a sync that would have succeeded.
  private localClientFor(dir: string): SimpleGit {
    return createGitClient(dir, this.buildGitEnv(), this.buildGitOptions(0));
  }

  // Client for network commands (fetch, ls-remote). Silence there means a
  // stalled connection or a prompt nobody can answer, so fetchTimeoutMs stays
  // the guard that ends the attempt. `dir` undefined runs without a working
  // directory (ls-remote against a URL).
  private networkClientFor(dir?: string): SimpleGit {
    return createGitClient(dir, this.buildGitEnv(), this.buildGitOptions(this.getFetchTimeoutMs()));
  }

  // Client for the unshallow fetch. Same kind of network command as
  // networkClientFor, on the clone budget instead of the fetch one: it
  // transfers every commit the shallow clone skipped, which is the work the
  // initial clone would have done, not the work of an incremental fetch. The
  // budget is an inactivity window, and `--progress` keeps it fed for the whole
  // streaming phase; what it has to cover are the phases git runs silently at
  // either end — the server computing the shallow boundary and enumerating
  // objects before the first progress byte, and the connectivity check after
  // the last one — and both scale with total history, not with what changed.
  // That last part is reasoning about what those phases do, not a measurement:
  // an unshallow big enough to spend minutes in them is not something a local
  // `file://` remote can stage (one over 1200 commits was done in 176 ms).
  private unshallowClientFor(dir: string): SimpleGit {
    return createGitClient(dir, this.buildGitEnv(), this.buildGitOptions(this.getCloneTimeoutMs()));
  }

  // The single choke point for every write path. `worktreeDir` may be a
  // directory a user pointed us at rather than one we cloned, and a checkout
  // whose `.git` is a gitdir pointer — a linked worktree from `git worktree
  // add`, or a submodule — shares the config and refs of the repository that
  // owns it. Narrowing `remote.origin.fetch`, deleting `refs/remotes/origin/*`
  // and fetching with `--prune` there rewrite THAT repository, not this one,
  // and repeat on every tick. Read paths (getWorktrees, the origin/HEAD
  // probes) keep using localClientFor and still work on such a directory; only
  // writes go through here, and the branded return type is the only thing the
  // write helpers accept, so a mutation added later cannot skip the check.
  private async mutatingClientsFor(worktreeDir: string): Promise<MutatingGitClients> {
    await this.assertPrimaryCheckout(worktreeDir);
    return {
      [PRIMARY_CHECKOUT_VERIFIED]: true,
      git: this.localClientFor(worktreeDir),
      networkGit: this.networkClientFor(worktreeDir),
      unshallowGit: this.unshallowClientFor(worktreeDir),
    };
  }

  private async assertPrimaryCheckout(worktreeDir: string): Promise<void> {
    const resolvedDir = path.resolve(worktreeDir);
    const ownGitDir = path.join(resolvedDir, PATH_CONSTANTS.GIT_DIR);

    let output: string;
    try {
      output = await this.localClientFor(resolvedDir).raw(["rev-parse", "--git-dir", "--git-common-dir"]);
    } catch (error) {
      // Fail closed: this guard exists to protect a repository we may not own,
      // so "cannot tell" must never be treated as "safe to mutate". Every call
      // site has already run a read probe here, so a failure now means the
      // checkout changed or broke under us.
      throw this.notPrimaryCheckoutError(
        resolvedDir,
        `its git directory could not be read (${getErrorMessage(error)})`,
        null,
      );
    }

    // git prints both paths relative to the directory it ran in when they sit
    // inside it (a plain clone prints ".git" twice) and absolute otherwise, so
    // resolve against the checkout rather than the process cwd.
    const [gitDirOutput, commonDirOutput] = output.split(/\r?\n/).map((line) => line.trim());
    if (!gitDirOutput || !commonDirOutput) {
      throw this.notPrimaryCheckoutError(resolvedDir, "'git rev-parse' did not report its git directory", null);
    }
    const gitDir = path.resolve(resolvedDir, gitDirOutput);
    const commonDir = path.resolve(resolvedDir, commonDirOutput);

    // `.git` must be a real directory belonging to this checkout. `git
    // worktree add` and `git submodule add` leave a FILE ('gitdir: ...') there,
    // which is the shape that makes the mutations below land in another
    // repository. A symlink is refused too: git reports a symlinked `.git`
    // exactly like a primary one, so a link that relocates this repo's own git
    // directory cannot be told apart from one aimed at a checkout that is
    // still using it — and only the second is safe to be wrong about.
    const gitEntry = await this.lstatOrNull(ownGitDir);
    if (gitEntry === null || !gitEntry.isDirectory()) {
      throw this.notPrimaryCheckoutError(
        resolvedDir,
        await this.describeGitEntry(ownGitDir, gitEntry),
        // git printed the symlink's own path for a symlinked `.git`; the
        // target is the directory the user has to reason about.
        (await this.realPathOrNull(commonDir)) ?? commonDir,
      );
    }

    if (gitDir === ownGitDir && commonDir === ownGitDir) return;

    // Same directory reached by a different path spelling (a symlinked parent
    // such as macOS '/tmp' -> '/private/tmp') — compare resolved paths before
    // refusing. The lstat above already established `.git` is this checkout's
    // own directory, so this only forgives path normalization.
    const [realOwnGitDir, realGitDir, realCommonDir] = await Promise.all([
      this.realPathOrNull(ownGitDir),
      this.realPathOrNull(gitDir),
      this.realPathOrNull(commonDir),
    ]);
    if (realOwnGitDir !== null && realGitDir === realOwnGitDir && realCommonDir === realOwnGitDir) return;

    // Say which half failed. A relocated linked worktree has a real `.git`
    // directory of its own and is caught only by the common dir, so naming
    // this checkout's own git directory there would read as a non sequitur.
    const detail =
      gitDir === ownGitDir
        ? `its git directory is shared with another repository`
        : `git reports its git directory as '${gitDir}'`;
    throw this.notPrimaryCheckoutError(resolvedDir, detail, commonDir);
  }

  // Both probes normalize an unusable answer to null rather than passing it
  // on: "could not resolve" must never compare equal to another "could not
  // resolve" and read as proof that two paths are the same directory.
  private async lstatOrNull(target: string): Promise<Stats | null> {
    try {
      const stats: Stats | undefined = await fs.lstat(target);
      return stats ?? null;
    } catch {
      return null;
    }
  }

  private async realPathOrNull(target: string): Promise<string | null> {
    try {
      const resolved: string | undefined = await fs.realpath(target);
      return typeof resolved === "string" ? resolved : null;
    } catch {
      return null;
    }
  }

  // `.git` as a file is how `git worktree add` and `git submodule` mark a
  // checkout owned by another repository; quoting the pointer makes the error
  // recognizable without the user having to go look.
  private async describeGitEntry(ownGitDir: string, entry: Stats | null): Promise<string> {
    if (entry === null) return `'${ownGitDir}' could not be read`;
    if (entry.isSymbolicLink()) {
      const target = (await this.realPathOrNull(ownGitDir)) ?? "another location";
      return `'${ownGitDir}' is a symlink to '${target}', so another checkout could be using that git directory too`;
    }
    if (!entry.isFile()) return `'${ownGitDir}' is not a directory`;
    const pointer = await this.readGitDirPointer(ownGitDir);
    return pointer
      ? `'${ownGitDir}' is a gitdir pointer to '${pointer}'`
      : `'${ownGitDir}' is a file, not this checkout's own git directory`;
  }

  private async readGitDirPointer(ownGitDir: string): Promise<string | null> {
    try {
      const contents = await fs.readFile(ownGitDir, "utf-8");
      return /^gitdir:\s*(.+)$/m.exec(contents)?.[1]?.trim() ?? null;
    } catch {
      return null;
    }
  }

  private notPrimaryCheckoutError(worktreeDir: string, detail: string, commonDir: string | null): ConfigError {
    const owner = commonDir === null ? "" : ` Its shared git directory is '${commonDir}'.`;
    return new ConfigError(
      `Cannot manage '${worktreeDir}' as a clone-mode repository for '${this.repoName}': it is not a primary ` +
        `checkout — ${detail}.${owner} Clone mode would narrow 'remote.origin.fetch', delete ` +
        `'refs/remotes/origin/*' and fetch with --prune there — in the repository that owns that git directory, ` +
        `not in this one — on every sync. Point 'worktreeDir' at a path this tool owns: an empty directory it ` +
        `can clone into, or a standalone clone of '${redactRepoUrl(this.config.repoUrl)}' whose '.git' is a ` +
        `directory in the checkout itself. A checkout whose git directory lives elsewhere — cloned with ` +
        `--separate-git-dir, or with '.git' symlinked away — is refused as well, because nothing distinguishes ` +
        `it from a checkout sharing a git directory that is still in use.`,
      "CLONE_DESTINATION_NOT_PRIMARY_CHECKOUT",
    );
  }

  // Per-client additions layered over the sanitized process environment by
  // createGitClient. Force a stable C locale so git's stderr is deterministic
  // English: the missing-remote-ref and LFS error classification matches on
  // those strings and would otherwise misfire under a non-English LANG/LC_ALL.
  private buildGitEnv(opts: { forceLfsSkip?: boolean } = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { LC_ALL: "C", LANG: "C" };
    if (opts.forceLfsSkip || this.isLfsSkipEnabled()) {
      env[ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE] = "1";
    }
    return env;
  }

  private buildCloneArgs(branch: string): string[] {
    const args = ["--branch", branch, "--single-branch", "--no-tags", "--progress"];
    if (this.config.depth !== undefined) {
      args.push("--depth", String(this.config.depth));
    }
    return args;
  }

  private getBranchRefspec(branch: string): string {
    return `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
  }

  private async buildFetchArgs(git: SimpleGit, branch: string): Promise<string[]> {
    const args = ["origin", "--prune", "--no-tags", "--progress"];
    if (this.config.depth !== undefined && (await this.isShallowRepository(git))) {
      args.push("--depth", String(this.config.depth));
    }
    args.push(this.getBranchRefspec(branch));
    return args;
  }

  private async configureSingleBranchRemote(clients: MutatingGitClients, branch: string): Promise<void> {
    await clients.git.raw(["config", "--replace-all", "remote.origin.fetch", this.getBranchRefspec(branch)]);
    await clients.git.raw(["config", "--replace-all", "remote.origin.tagOpt", "--no-tags"]);
    await this.deleteStaleRemoteTrackingRefs(clients, branch);
  }

  private recordMissingRemoteRefSkip(branch: string): void {
    this.recordSkip(
      { kind: "missing_remote_ref", branch, source: "fetch_error" },
      `Tracked branch '${branch}' is missing on remote for '${this.repoName}'. Skipping sync.`,
      `Skipping '${this.repoName}': origin/${branch} is missing`,
    );
  }

  private async fetchWithRecovery(
    clients: MutatingGitClients,
    fetchArgs: string[],
    worktreeDir: string,
    branch: string,
    // checkoutBranch reports its own hard error — recording a "Skipping sync"
    // skip there would double-report a user-initiated action as a sync skip.
    recordSkip = true,
  ): Promise<{ skipped: boolean }> {
    const recordMissing = (): void => {
      if (recordSkip) this.recordMissingRemoteRefSkip(branch);
    };
    try {
      await clients.networkGit.fetch(fetchArgs);
      return { skipped: false };
    } catch (fetchError) {
      const message = getErrorMessage(fetchError);
      if (isLfsError(message)) {
        this.logger.info(`⚠️  LFS error during fetch for '${this.repoName}'; retrying with LFS disabled.`);
        this.emitProgress({ phase: "fetch", message: `Retrying fetch for '${this.repoName}' with LFS disabled` });
        // Same kind of client as the one that just failed (a network fetch),
        // only with LFS smudging disabled. It is built here rather than taken
        // from `clients`, but it runs in the same directory that pair already
        // proved is a primary checkout.
        const lfsSkipGit = createGitClient(
          worktreeDir,
          this.buildGitEnv({ forceLfsSkip: true }),
          this.buildGitOptions(this.getFetchTimeoutMs()),
        );
        try {
          await lfsSkipGit.fetch(fetchArgs);
          return { skipped: false };
        } catch (retryError) {
          // The LFS-disabled retry can itself hit a deleted remote branch —
          // classify it as a soft skip too, instead of letting it escape as a
          // hard failure.
          if (isMissingRemoteRefError(getErrorMessage(retryError))) {
            recordMissing();
            return { skipped: true };
          }
          // Otherwise propagate the retry error unchanged so the outer retry
          // policy's LFS handling still sees an accurate error.
          throw retryError;
        }
      }
      if (isMissingRemoteRefError(message)) {
        recordMissing();
        return { skipped: true };
      }
      throw fetchError;
    }
  }

  private async hasRemoteBranch(git: SimpleGit, branch: string): Promise<boolean> {
    try {
      // simple-git resolves `show-ref --quiet` even when git exits 1, so keep
      // stdout enabled (no --quiet) to get a real reject on a missing ref —
      // otherwise the post-fetch missing_remote_ref skip would never fire.
      await git.raw(["show-ref", "--verify", `refs/remotes/origin/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async isShallowRepository(git: SimpleGit): Promise<boolean> {
    try {
      const output = await git.raw(["rev-parse", "--is-shallow-repository"]);
      return output.trim() === "true";
    } catch {
      return false;
    }
  }

  private async unshallowIfDepthRemoved(clients: MutatingGitClients): Promise<void> {
    if (this.config.depth !== undefined) return;

    if (!(await this.isShallowRepository(clients.git))) return;

    this.logger.info(
      `[deepen] Existing shallow clone for '${this.repoName}' has no configured depth; fetching full history...`,
    );
    this.emitProgress({ phase: "fetch", message: `Fetching full history for '${this.repoName}'` });
    // `--progress` is what keeps simple-git's inactivity timer alive across the
    // transfer: it only resets on stdout/stderr data, and with stderr piped git
    // suppresses every transfer and delta line and asks the server for
    // `no-progress` — verified on git 2.43, where the same unshallow wrote 131
    // stderr chunks with the flag and zero bytes without it. simple-git's own
    // progress plugin appends the flag to any command whose first token is
    // `fetch`, so it was already reaching git; spelling it out keeps the argv
    // ours rather than the plugin's, and matches every other fetch here.
    await clients.unshallowGit.fetch(["--unshallow", "--no-tags", "--progress"]);
  }

  private getDeepenTargets(): readonly number[] {
    const configuredDepth = this.config.depth;
    if (configuredDepth === undefined) return [];
    // `git fetch --depth N` can shorten a shallow repo if N is below current depth.
    // Skip targets at or below the configured depth — they would never widen history.
    return SHALLOW_RELATION_DEEPEN_TARGETS.filter((target) => target > configuredDepth);
  }

  private async deepenShallowHistoryToDepth(
    clients: MutatingGitClients,
    branch: string,
    targetDepth: number,
  ): Promise<void> {
    this.logger.info(
      `[deepen] Shallow clone for '${this.repoName}' lacks enough history to classify origin/${branch}; ` +
        `refetching to depth ${targetDepth} before deciding.`,
    );
    this.emitProgress({
      phase: "fetch",
      message: `Deepening '${this.repoName}' to depth ${targetDepth} before classifying origin/${branch}`,
    });
    await clients.networkGit.fetch([
      "origin",
      "--depth",
      String(targetDepth),
      "--prune",
      "--no-tags",
      "--progress",
      this.getBranchRefspec(branch),
    ]);
  }

  async resolveBranch(): Promise<string> {
    if (this.resolvedBranch) return this.resolvedBranch;
    if (this.config.branch) {
      this.resolvedBranch = this.config.branch;
      this.emitProgress({ phase: "branch", message: `Using configured branch '${this.resolvedBranch}'` });
      return this.resolvedBranch;
    }
    this.logger.info(`No branch configured for '${this.repoName}', detecting remote default branch...`);
    this.emitProgress({ phase: "branch", message: `Resolving remote default branch for '${this.repoName}'` });
    this.resolvedBranch = await this.gitService.getRemoteDefaultBranch(this.config.repoUrl);
    this.logger.info(`  ↳ resolved default branch: ${this.resolvedBranch}`);
    this.emitProgress({ phase: "branch", message: `Resolved default branch '${this.resolvedBranch}'` });
    return this.resolvedBranch;
  }

  private parseLsRemoteHeads(output: string): string[] {
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[1] ?? "")
      .filter((ref) => ref.startsWith("refs/heads/"))
      .map((ref) => ref.slice("refs/heads/".length))
      .filter((branch) => branch.length > 0);
  }

  async getRemoteBranches(): Promise<string[]> {
    const worktreeDir = path.resolve(this.config.worktreeDir);
    const repoArg = (await fileExists(path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR))) ? "origin" : this.config.repoUrl;
    const git = repoArg === "origin" ? this.networkClientFor(worktreeDir) : this.networkClientFor();
    const output = await git.raw(["ls-remote", "--heads", repoArg]);
    return this.parseLsRemoteHeads(output);
  }

  private async localBranchExists(git: SimpleGit, branch: string): Promise<boolean> {
    try {
      await git.raw(["show-ref", "--verify", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async localBranchCanFastForward(git: SimpleGit, branch: string): Promise<boolean> {
    const localRef = `refs/heads/${branch}`;
    const remoteRef = `refs/remotes/origin/${branch}`;
    let localSha: string;
    let remoteSha: string;
    try {
      localSha = (await git.raw(["rev-parse", localRef])).trim();
      remoteSha = (await git.raw(["rev-parse", remoteRef])).trim();
    } catch {
      return false;
    }

    if (localSha === remoteSha) return true;

    try {
      const mergeBase = (await git.raw(["merge-base", localRef, remoteRef])).trim();
      return mergeBase === localSha;
    } catch {
      return false;
    }
  }

  private async deleteRemoteTrackingRef(clients: MutatingGitClients, refName: string): Promise<void> {
    try {
      await clients.git.raw(["update-ref", "-d", refName]);
    } catch {
      // Stale remote refs are best-effort cleanup; sync correctness comes from the narrowed refspec.
    }
  }

  private async deleteStaleRemoteTrackingRefs(clients: MutatingGitClients, branch: string): Promise<void> {
    let refsOutput: string;
    try {
      refsOutput = await clients.git.raw(["for-each-ref", "--format=%(refname)", "refs/remotes/origin"]);
    } catch {
      return;
    }

    const keepRef = `refs/remotes/origin/${branch}`;
    const refsToDelete = refsOutput
      .split(/\r?\n/)
      .map((ref) => ref.trim())
      .filter((ref) => ref && ref !== keepRef && ref !== "refs/remotes/origin/HEAD");

    for (const ref of refsToDelete) {
      await this.deleteRemoteTrackingRef(clients, ref);
    }
  }

  private async restoreBranchAfterCheckoutFailure(
    clients: MutatingGitClients,
    previousBranch: string,
    attemptedBranch: string,
  ): Promise<void> {
    if (!previousBranch || previousBranch === "HEAD" || previousBranch === attemptedBranch) return;

    try {
      await clients.git.raw(["switch", previousBranch]);
    } catch (error) {
      this.logger.warn(
        `Failed to restore '${this.repoName}' to '${previousBranch}' after checkout failure: ${getErrorMessage(error)}`,
      );
    }
  }

  async checkoutBranch(branch: string, options: { allowConfigDrift?: boolean } = {}): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Checkout is a convergence action by default: it brings an existing clone
    // in line with the configured branch. Arbitrary targets would leave
    // config.branch stale, so every later sync (and every restart) soft-skips
    // with branch_mismatch after the refspec was already narrowed.
    // allowConfigDrift is the TUI's explicit opt-out for branches it just
    // created and pushed — the drift is then intentional and warned about.
    const targetBranch = await this.resolveBranch();
    if (branch !== targetBranch && !options.allowConfigDrift) {
      throw new ConfigError(
        this.config.branch
          ? `Cannot switch '${this.repoName}' to '${branch}': clone mode tracks the configured branch '${targetBranch}'. Update 'branch' in the config file first, then run checkout to converge.`
          : `Cannot switch '${this.repoName}' to '${branch}': no 'branch' is configured, so this clone tracks the remote default branch '${targetBranch}'. Set branch: "${branch}" in the config file first.`,
        "CLONE_BRANCH_MISMATCH",
      );
    }

    const worktreeDir = this.config.worktreeDir;
    const readGit = this.localClientFor(worktreeDir);
    const originMismatch = await this.evaluateOriginMatch(readGit, worktreeDir);
    if (originMismatch) {
      throw new ConfigError(
        `Cannot switch '${this.repoName}' to '${branch}': ${originMismatch.progressDetail}.`,
        "ORIGIN_MISMATCH",
      );
    }

    const currentBranch = (await readGit.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    // On a detached HEAD `git switch` only warns about leaving commits behind,
    // and the restore path below cannot return to "HEAD" — refuse instead of
    // stranding commits in the reflog.
    if (currentBranch === "HEAD") {
      throw new GitOperationError(
        "checkout",
        `'${this.repoName}' is on a detached HEAD; check out a branch manually (preserving any local commits) before switching the tracked branch`,
      );
    }
    // Nothing above this line writes; everything below does. Refuse a linked
    // worktree or submodule here, before the first mutation reaches the
    // repository that actually owns this directory's git dir.
    const clients = await this.mutatingClientsFor(worktreeDir);

    if (currentBranch === branch) {
      await this.configureSingleBranchRemote(clients, branch);
      this.resolvedBranch = branch;
      this.pendingInitSkip = null;
      this.warnConfigDriftAfterCheckout(branch, targetBranch);
      return;
    }

    const isClean = await this.gitService.checkWorktreeStatus(worktreeDir);
    if (!isClean) {
      throw new WorktreeNotCleanError(worktreeDir, ["working tree has local changes"]);
    }

    // Converge shallow state like runSyncAttempt does: with no configured depth an
    // existing shallow clone is unshallowed before the branch fetch, so switching
    // branches doesn't leave the new branch shallow while the rest is full.
    try {
      await this.unshallowIfDepthRemoved(clients);
    } catch (error) {
      // Same classification as the branch fetch below: a deleted tracked
      // branch fails the narrowed-refspec unshallow with the same error.
      if (isMissingRemoteRefError(getErrorMessage(error))) {
        throw new GitOperationError("checkout", `origin/${branch} is missing for '${this.repoName}'`);
      }
      throw error;
    }

    const fetchArgs = await this.buildFetchArgs(clients.git, branch);
    if ((await this.fetchWithRecovery(clients, fetchArgs, worktreeDir, branch, false)).skipped) {
      throw new GitOperationError("checkout", `origin/${branch} is missing for '${this.repoName}'`);
    }
    // Same post-fetch verify as runSyncAttempt: a fetch can succeed without
    // materializing the ref, which would otherwise surface downstream as a
    // misleading FastForwardError.
    if (!(await this.hasRemoteBranch(clients.git, branch))) {
      throw new GitOperationError(
        "checkout",
        `origin/${branch} did not materialize after fetch for '${this.repoName}'`,
      );
    }

    if (await this.localBranchExists(clients.git, branch)) {
      if (!(await this.localBranchCanFastForward(clients.git, branch))) {
        throw new FastForwardError(branch);
      }

      let switched = false;
      let headBeforeMerge: string | null = null;
      try {
        await clients.git.raw(["switch", branch]);
        switched = true;
        headBeforeMerge = await this.readHeadCommit(clients.git);
        await clients.git.merge([`origin/${branch}`, "--ff-only"]);
      } catch (error) {
        if (switched) {
          // This merge rejects the same way a sync's does, and leaves the same
          // half-applied checkout behind. It is reported loudly rather than
          // skipped, but the stray files would still wedge every later tick
          // with dirty_tree — and `git switch` back would have to carry them
          // across — so they are undone first.
          await this.undoRejectedFastForward(clients, worktreeDir, branch, headBeforeMerge);
          await this.restoreBranchAfterCheckoutFailure(clients, currentBranch, branch);
        }
        throw error;
      }
    } else {
      await clients.git.raw(["switch", "-c", branch, "--track", `origin/${branch}`]);
    }

    await this.configureSingleBranchRemote(clients, branch);
    this.resolvedBranch = branch;
    this.pendingInitSkip = null;
    this.warnConfigDriftAfterCheckout(branch, targetBranch);
  }

  // resolvedBranch keeps in-session syncs on the new branch, but the config
  // file still names the old one: the next process start will soft-skip with
  // branch_mismatch on every tick until the config is updated.
  private warnConfigDriftAfterCheckout(branch: string, targetBranch: string): void {
    if (branch === targetBranch) return;
    this.logger.warn(
      `⚠️ '${this.repoName}' now tracks '${branch}', but the config ${
        this.config.branch ? `still says branch '${targetBranch}'` : `resolves the remote default '${targetBranch}'`
      }. Set branch: "${branch}" in the config file — after a restart every sync will soft-skip with branch_mismatch until it matches.`,
    );
  }

  async initialize(outcome?: SyncOutcomeAccumulator): Promise<void> {
    return this.withOutcome(outcome, () => this.initializeInternal());
  }

  private async initializeInternal(): Promise<void> {
    this.pendingInitSkip = null;
    const branch = await this.resolveBranch();
    const worktreeDir = this.config.worktreeDir;

    let entries: string[] | null;
    try {
      entries = await fs.readdir(worktreeDir);
    } catch (error) {
      // Only a definitively missing directory may proceed as a fresh clone:
      // cloneCreatedDir below authorizes maybeCleanupPartialClone to rm -rf
      // the directory after a failed clone, so a transient probe failure
      // (EMFILE, EACCES) must never read as "the directory did not exist" —
      // that would delete a pre-existing directory the tool never created.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new GitOperationError(
          "clone-init",
          `Cannot inspect '${worktreeDir}' before cloning: ${getErrorMessage(error)}`,
          error instanceof Error ? error : undefined,
        );
      }
      entries = null;
    }

    if (entries?.includes(PATH_CONSTANTS.GIT_DIR)) {
      // Before anything treats this directory as a clone somebody else made:
      // one of ours that never finished checking out must never be adopted.
      // First, and not after validateExistingClone, because that path answers
      // with soft skips — a wrong branch or a changed origin would return
      // early and the real problem would never be reported at all.
      await this.assertPreviousCloneCompleted(worktreeDir);
      this.emitProgress({ phase: "clone", message: `Validating existing clone for '${this.repoName}'` });
      const result = await this.validateExistingClone(branch);
      if (!result.valid) {
        this.recordSkip(result.skip, result.warnMessage, `Skipping '${this.repoName}': ${result.progressDetail}`);
        this.pendingInitSkip = result.skip;
        this.initialized = true;
        return;
      }
      // validateExistingClone only reads. Adopting the directory — narrowing
      // its refspec, deleting its stale remote-tracking refs — starts here, so
      // this is where a non-primary checkout has to be refused.
      const clients = await this.mutatingClientsFor(worktreeDir);
      await this.configureSingleBranchRemote(clients, branch);
      // A pending marker means this clone was created by an init of ours that
      // was interrupted after the clone — finish the post-clone steps now.
      // Sparse setup is re-run too (idempotent), so an init that died inside
      // it does not leave the clone permanently un-narrowed. The marker is
      // deliberately written BEFORE the sparse step: written after it, a
      // sparse failure would leave no marker and the file copy would be
      // silently dropped forever. Pre-existing user clones never carry the
      // marker and are left alone.
      if (await fileExists(this.getInitPendingMarkerPath(worktreeDir))) {
        this.logger.info(`Completing interrupted initialization for '${this.repoName}'...`);
        if (this.config.sparseCheckout) {
          await this.gitService.getSparseCheckoutService().applyToWorktree(worktreeDir, this.config.sparseCheckout);
          await clients.git.raw(["checkout", "HEAD"]);
        }
        await this.runInitialFileCopy(worktreeDir, branch);
      }
      this.initialized = true;
      this.emitProgress({ phase: "clone", message: `Existing clone validated for '${this.repoName}'` });
      return;
    }

    if (entries && entries.length > 0) {
      throw new ConfigError(
        `Cannot clone into '${worktreeDir}': directory exists and is not empty. ` +
          `Remove existing contents or point worktreeDir at an empty path.`,
        "CLONE_DESTINATION_NOT_EMPTY",
      );
    }

    const cloneCreatedDir = entries === null;
    await fs.mkdir(worktreeDir, { recursive: true });

    this.logger.info(`Cloning '${redactRepoUrl(this.config.repoUrl)}' (${branch}) into '${worktreeDir}'...`);
    this.emitProgress({ phase: "clone", message: `Cloning '${this.repoName}' (${branch})` });

    const cloneClient = createGitClient(undefined, this.buildGitEnv(), this.buildGitOptions(this.getCloneTimeoutMs()));

    let checkoutRecovered = false;
    try {
      await cloneClient.clone(this.config.repoUrl, worktreeDir, this.buildCloneArgs(branch));
    } catch (error) {
      checkoutRecovered = await this.settleFailedClone(worktreeDir, cloneCreatedDir, error);
      if (!checkoutRecovered) {
        // The outcome is what the MCP `sync` result and the run summary show, so
        // carry the credential hint there too (the thrown error gets it at the
        // WorktreeSyncService funnel).
        this.outcomeAccumulator?.recordFailed("repo", appendGitAuthHint(getErrorMessage(error)), {
          reason: "clone_failed",
          branch,
          path: worktreeDir,
        });
        throw error;
      }
    }

    const freshClients = await this.mutatingClientsFor(worktreeDir);
    await this.configureSingleBranchRemote(freshClients, branch);

    // The progress stream carries the same nuance as the log: a TUI showing
    // "Clone successful" for a tree that holds pointer files is not the truth.
    this.logger.info(checkoutRecovered ? `✅ Clone completed (LFS content skipped).` : `✅ Clone successful.`);
    this.emitProgress({
      phase: "clone",
      message: checkoutRecovered
        ? `Clone completed for '${this.repoName}' with LFS content skipped`
        : `Clone successful for '${this.repoName}'`,
    });

    // From here to the end of runInitialFileCopy any failure or kill leaves a
    // valid-looking clone that the next init adopts via the existing-clone
    // path, which never runs the file copy. The pending marker records the
    // debt so that path can settle it.
    try {
      await fs.writeFile(this.getInitPendingMarkerPath(worktreeDir), new Date().toISOString());
    } catch (error) {
      this.logger.warn(`Could not write clone-init pending marker: ${getErrorMessage(error)}`);
    }

    if (this.config.sparseCheckout) {
      this.logger.info(`Applying sparse-checkout patterns to '${worktreeDir}'...`);
      this.emitProgress({ phase: "sparse_checkout", message: `Applying sparse-checkout for '${this.repoName}'` });
      const sparseService = this.gitService.getSparseCheckoutService();
      // Both halves of the narrowing run with the environment the clone's own
      // checkout finally needed. `sparse-checkout set` materializes everything
      // the cone brings in, so after an LFS-skipped recovery it smudges the
      // objects the retry skipped and dies exactly as the clone did — leaving
      // a half-narrowed tree that `git status` calls clean and the next run
      // adopts. The trailing checkout follows for the same reason.
      // Only a recovered clone needs a client of its own; otherwise the sparse
      // service keeps its own factory, whose clients already carry the
      // configured LFS setting.
      const recoveredGit = checkoutRecovered ? this.lfsSkipCheckoutClient(freshClients, worktreeDir) : undefined;
      await sparseService.applyToWorktree(worktreeDir, this.config.sparseCheckout, recoveredGit);
      await (recoveredGit ?? freshClients.git).raw(["checkout", "HEAD"]);
      this.emitProgress({ phase: "sparse_checkout", message: `Sparse-checkout applied for '${this.repoName}'` });
    }

    this.emitProgress({ phase: "lfs", message: `Verifying LFS for '${this.repoName}'` });
    await this.gitService.verifyLfs(worktreeDir, branch);
    this.emitProgress({ phase: "lfs", message: `LFS verified for '${this.repoName}'` });

    await this.runInitialFileCopy(worktreeDir, branch);

    // Only record `created` once init is fully complete; otherwise an aborted
    // post-clone step would leave the outcome reporting both created and failed.
    this.outcomeAccumulator?.recordCreated(branch, worktreeDir);
    this.initialized = true;
  }

  // Detects an on-disk clone whose `origin` no longer matches the configured
  // repoUrl (e.g. repoUrl was repointed in config). Returns a skip descriptor so
  // we never fetch/ff-merge from the wrong remote; null when origin matches or
  // can't be read. Comparison is normalized so https/.git/trailing-slash
  // variants don't false-positive; the URLs are kept in the message and skip
  // descriptor with any embedded credentials stripped (both can carry one).
  private async evaluateOriginMatch(
    git: SimpleGit,
    worktreeDir: string,
  ): Promise<{ skip: CloneSkipReason; warnMessage: string; progressDetail: string } | null> {
    let originUrl: string;
    try {
      originUrl = (await git.raw(["remote", "get-url", "origin"])).trim();
    } catch {
      this.logger.warn(`Could not read 'origin' remote URL from existing clone at '${worktreeDir}'.`);
      return null;
    }

    if (!originUrl || normalizeRepoUrlForComparison(originUrl) === normalizeRepoUrlForComparison(this.config.repoUrl)) {
      return null;
    }

    const actual = redactRepoUrl(originUrl);
    const expected = redactRepoUrl(this.config.repoUrl);
    return {
      skip: { kind: "origin_mismatch", actual, expected },
      warnMessage:
        `Existing clone at '${worktreeDir}' has origin '${actual}', expected '${expected}'. ` +
        `Update the remote ('git remote set-url origin <url>') or point worktreeDir at a fresh path.`,
      progressDetail: `origin '${actual}' is not '${expected}'`,
    };
  }

  private async validateExistingClone(
    expectedBranch: string,
  ): Promise<{ valid: true } | { valid: false; skip: CloneSkipReason; warnMessage: string; progressDetail: string }> {
    const worktreeDir = this.config.worktreeDir;
    const git = this.localClientFor(worktreeDir);

    const originMismatch = await this.evaluateOriginMatch(git, worktreeDir);
    if (originMismatch) {
      return { valid: false, ...originMismatch };
    }

    let currentBranch: string;
    try {
      currentBranch = (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      return {
        valid: false,
        skip: { kind: "head_unreadable", phase: "init", error: errorMessage },
        warnMessage: `Existing clone at '${worktreeDir}' has a .git folder but reading HEAD failed: ${errorMessage}`,
        progressDetail: `could not read HEAD (${errorMessage})`,
      };
    }

    if (currentBranch !== expectedBranch) {
      return {
        valid: false,
        skip: {
          kind: "branch_mismatch",
          phase: "init",
          currentBranch,
          expectedBranch,
        },
        warnMessage:
          `Existing clone at '${worktreeDir}' is on branch '${currentBranch}', expected '${expectedBranch}'. ` +
          `Switch the working tree to '${expectedBranch}' or update the config.`,
        progressDetail: `current branch '${currentBranch}' is not '${expectedBranch}'`,
      };
    }

    return { valid: true };
  }

  // A failed clone leaves the destination in one of two shapes, and each has
  // its own settlement. A clone that never got as far as writing HEAD leaves
  // rubbish maybeCleanupPartialClone removes when we created the directory. A
  // clone that fetched every object and then failed to check out ("Clone
  // succeeded, but checkout failed", exit 128 — a missing LFS object is the
  // usual cause) leaves a complete `.git` on the tracked branch next to a
  // half-written tree, and nothing on disk tells that apart from a clone the
  // user made: validateExistingClone passes it, so the next run adopted it as
  // a pre-existing clone — no checkout retry, no sparse setup, no LFS verify,
  // no file copy — and every sync after that recorded `dirty_tree` at info
  // level while the run exited 0.
  //
  // Everything under that path is this clone's own work: the destination was
  // verified absent or empty before it started (a directory that is neither
  // never reaches the clone). So the checkout may be retried in place, and
  // when it cannot be, the directory is marked as ours-and-unfinished so the
  // next init refuses to adopt it. Returns true when the working tree was
  // repaired and the caller may continue with the post-clone steps.
  //
  // Known limit: this runs only once `git clone` has returned, so a process
  // killed mid-checkout still leaves an unmarked half-written clone that the
  // next init adopts. Closing that needs the bare-clone shape — a marker
  // written in the PARENT before the clone starts (`git clone` refuses a
  // destination holding one) — and then a rule for resolving it afterwards,
  // where "the clone was interrupted" and "the user edited their tree" look
  // the same on disk. Not worth trading a rare silent adoption for a possible
  // false hard refusal until that case is shown to matter.
  private async settleFailedClone(worktreeDir: string, cloneCreatedDir: boolean, cause: unknown): Promise<boolean> {
    // Only a definitively absent HEAD may reach maybeCleanupPartialClone: its
    // rm -rf arm is live for a directory this init created, and a probe that
    // merely failed (EACCES on the destination, EMFILE under load) must never
    // read as "nothing was fetched here". An unverifiable one is marked like a
    // fetched clone instead — marking deletes nothing, and refusing to adopt a
    // directory that turns out to be fine costs an error the user can clear.
    const headProbe = await probePathExists(path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR, "HEAD"));
    if (headProbe === "missing") {
      await this.maybeCleanupPartialClone(worktreeDir, cloneCreatedDir);
      return false;
    }

    const message = getErrorMessage(cause);
    // Marked before the retry, never after: a process killed in the middle of
    // the retry must still leave a directory the next run refuses to adopt.
    await this.writeIncompleteCloneMarker(worktreeDir, message);

    if (headProbe !== "exists" || !isLfsError(message) || !(await this.retryCheckoutWithLfsSkipped(worktreeDir))) {
      this.logger.warn(
        `Clone of '${this.repoName}' fetched its objects but left the working tree unfinished; leaving ` +
          `'${worktreeDir}' for manual inspection. The next run will refuse to adopt it until it is removed.`,
      );
      return false;
    }

    await this.clearIncompleteCloneMarker(worktreeDir);
    this.logger.warn(
      `⚠️  '${this.repoName}' was checked out with LFS smudging disabled: its LFS paths hold pointer files ` +
        `until 'git lfs pull' succeeds there.`,
    );
    return true;
  }

  // Retries only the checkout half of a clone whose objects already landed,
  // with LFS smudging forced off — the same recovery fetchWithRecovery applies
  // to a fetch, and the same one worktree mode applies to a `worktree add`.
  // Reports success rather than throwing: the caller is already holding the
  // clone's failure and must report that one, not this one.
  private async retryCheckoutWithLfsSkipped(worktreeDir: string): Promise<boolean> {
    this.logger.info(`⚠️  LFS error during clone of '${this.repoName}'; retrying the checkout with LFS disabled.`);
    this.emitProgress({ phase: "clone", message: `Retrying checkout for '${this.repoName}' with LFS disabled` });
    try {
      // `checkout -f HEAD` is a write, so it goes through the primary-checkout
      // guard like every other one — even here, where the directory is one
      // this init just cloned into.
      const clients = await this.mutatingClientsFor(worktreeDir);
      await this.lfsSkipCheckoutClient(clients, worktreeDir).raw(["checkout", "-f", "HEAD"]);
      return true;
    } catch (error) {
      this.logger.warn(`Checkout retry with LFS disabled failed for '${this.repoName}': ${getErrorMessage(error)}`);
      return false;
    }
  }

  // The client for a checkout this init must run with LFS smudging forced off.
  // Built here rather than taken from the branded pair, whose clients carry
  // the configured environment; it runs in the directory that pair has already
  // proved is a primary checkout, the arrangement fetchWithRecovery's LFS
  // retry uses. No inactivity timeout, for the reason localClientFor gives:
  // git is legitimately silent while it materializes a tree.
  //
  // `_clients` is unused on purpose and must stay: requiring the brand is what
  // keeps the writes this client performs behind the primary-checkout guard,
  // exactly like the helpers that do use their pair. Deleting the parameter
  // would let a future caller reach a checkout this tool must not touch.
  private lfsSkipCheckoutClient(_clients: MutatingGitClients, worktreeDir: string): SimpleGit {
    return createGitClient(worktreeDir, this.buildGitEnv({ forceLfsSkip: true }), this.buildGitOptions(0));
  }

  private async maybeCleanupPartialClone(worktreeDir: string, cloneCreatedDir: boolean): Promise<void> {
    if (!cloneCreatedDir) {
      this.logger.warn(
        `Clone failed; leaving '${worktreeDir}' for manual inspection (directory existed before clone attempt).`,
      );
      return;
    }

    let entries: string[];
    try {
      entries = await fs.readdir(worktreeDir);
    } catch {
      return;
    }

    const looksIncomplete = entries.every((e) => e.startsWith("."));
    const hasUsableGit =
      entries.includes(PATH_CONSTANTS.GIT_DIR) &&
      (await fileExists(path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR, "HEAD")));

    if (looksIncomplete && !hasUsableGit) {
      try {
        await fs.rm(worktreeDir, { recursive: true, force: true });
        this.logger.info(`Cleaned up incomplete clone at '${worktreeDir}'.`);
      } catch (rmError) {
        this.logger.warn(`Failed to clean up incomplete clone at '${worktreeDir}': ${getErrorMessage(rmError)}`);
      }
    } else {
      this.logger.warn(
        `Clone failed; leaving '${worktreeDir}' for manual inspection (post-failure contents do not look like an empty incomplete clone).`,
      );
    }
  }

  private getInitMarkerPath(worktreeDir: string): string {
    return path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR, PATH_CONSTANTS.CLONE_INIT_MARKER);
  }

  private getInitPendingMarkerPath(worktreeDir: string): string {
    return path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR, PATH_CONSTANTS.CLONE_INIT_PENDING_MARKER);
  }

  // Inside `.git`, like the init markers: a marker in the working tree would
  // show up as an untracked file in every status this tool takes.
  private getIncompleteCloneMarkerPath(worktreeDir: string): string {
    return path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR, PATH_CONSTANTS.CLONE_INCOMPLETE_MARKER);
  }

  private async writeIncompleteCloneMarker(worktreeDir: string, failure: string): Promise<void> {
    // Line 1 when the clone failed, line 2 what the refusal quotes, then git's
    // untruncated stderr for whoever opens the file. Redacted on the way in
    // like every other string this file surfaces: a repoUrl carrying a token
    // reaches git's own output, and this one is written to disk and read back
    // into an error message on every later run.
    const recorded = redactSecretsInText(failure);
    const contents = `${new Date().toISOString()}\n${summarizeGitFailure(recorded)}\n${recorded}\n`;
    try {
      await fs.writeFile(this.getIncompleteCloneMarkerPath(worktreeDir), contents);
    } catch (error) {
      // Best effort, like the init pending marker: without it the next run
      // falls back to the old behaviour of adopting the unfinished clone.
      this.logger.warn(`Could not write the incomplete-clone marker: ${getErrorMessage(error)}`);
    }
  }

  private async clearIncompleteCloneMarker(worktreeDir: string): Promise<void> {
    try {
      await fs.rm(this.getIncompleteCloneMarkerPath(worktreeDir), { force: true });
    } catch (error) {
      // A marker left behind on a repaired clone costs a hard error on the
      // next run, which names the file and how to remove it.
      this.logger.warn(`Could not remove the incomplete-clone marker: ${getErrorMessage(error)}`);
    }
  }

  // Read rather than probed for existence: the marker's second line is why the
  // clone failed, and that is what the refusal quotes.
  //
  // Three answers, never two. This marker is the only thing that tells a clone
  // of ours that never finished from a clone the user made, so "the file could
  // not be read" must not collapse into "there is no such file" — the same
  // rule probePathExists states for removal decisions. Only ENOENT (and
  // ENOTDIR, a `.git` that is not a directory) prove absence; EACCES, EIO or
  // an EISDIR marker leave the question open, and the caller fails closed.
  private async readIncompleteCloneMarker(
    worktreeDir: string,
  ): Promise<{ status: "absent" } | { status: "present"; cause: string } | { status: "unreadable"; detail: string }> {
    let contents: string | undefined;
    try {
      contents = await fs.readFile(this.getIncompleteCloneMarkerPath(worktreeDir), "utf-8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { status: "absent" };
      return { status: "unreadable", detail: getErrorMessage(error) };
    }
    // Same normalization lstatOrNull and realPathOrNull apply: an answer that
    // is not the shape the API promises is not passed on as a verdict.
    if (typeof contents !== "string") return { status: "absent" };
    const cause = contents.split(/\r?\n/)[1]?.trim();
    return { status: "present", cause: cause && cause.length > 0 ? cause : "reason not recorded" };
  }

  // A clone this tool started and could not finish is not a clone it may
  // adopt: its working tree was never fully written, so every sync would find
  // staged deletions plus untracked files and soft-skip with `dirty_tree` — an
  // info-level line and exit 0 — for a directory the user never touched.
  //
  // A GitOperationError rather than the ConfigError the primary-checkout guard
  // raises: nothing is wrong with the configuration — worktreeDir is a path
  // this tool owns and may clone into — what failed is a git operation on it,
  // and the remedy is on disk. It also matches the GitOperationError this same
  // init throws when it cannot inspect the destination.
  private async assertPreviousCloneCompleted(worktreeDir: string): Promise<void> {
    const marker = await this.readIncompleteCloneMarker(worktreeDir);
    if (marker.status === "absent") return;

    if (marker.status === "unreadable") {
      throw new GitOperationError(
        "clone-init",
        `cannot tell whether the clone of '${worktreeDir}' completed: its incomplete-clone marker ` +
          `'${this.getIncompleteCloneMarkerPath(worktreeDir)}' could not be read (${marker.detail}). Adopting the ` +
          `clone without that answer would sync a working tree that may never have been checked out; make the ` +
          `file readable, or remove the directory and let the next run clone again.`,
      );
    }

    throw new GitOperationError(
      "clone-init",
      `previous clone of '${worktreeDir}' did not complete (${marker.cause}); its working tree was never fully checked ` +
        `out, so syncing it would report local changes on every run. Remove the directory and let the next run ` +
        `clone again, or fix the cause, run 'git -C ${worktreeDir} checkout -f HEAD' and delete ` +
        `'${this.getIncompleteCloneMarkerPath(worktreeDir)}'.`,
    );
  }

  private async runInitialFileCopy(worktreeDir: string, branch: string): Promise<void> {
    const marker = this.getInitMarkerPath(worktreeDir);
    const pendingMarker = this.getInitPendingMarkerPath(worktreeDir);
    if (await fileExists(marker)) {
      try {
        await fs.rm(pendingMarker, { force: true });
      } catch {
        // A stale pending marker is harmless; the final marker wins.
      }
      return;
    }

    const sourceDir = this.config.__configFileDir ?? worktreeDir;

    await this.branchCreatedActions.copyFiles({
      config: this.config,
      branchName: branch,
      worktreePath: worktreeDir,
      sourceDir,
      logger: this.logger,
    });

    try {
      await fs.writeFile(marker, new Date().toISOString());
      await fs.rm(pendingMarker, { force: true });
    } catch (error) {
      this.logger.warn(`Could not write clone-init marker: ${getErrorMessage(error)}`);
    }
  }

  async runSyncAttempt(outcome?: SyncOutcomeAccumulator): Promise<void> {
    return this.withOutcome(outcome, () => this.runSyncAttemptInternal());
  }

  private async runSyncAttemptInternal(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
      // init ran here and recorded any skip itself; no duplicate to suppress.
      this.pendingInitSkip = null;
      return;
    }

    // If init already recorded a wrong-branch / unreadable-HEAD skip for the
    // current clone state during this same sync operation, don't record it a
    // second time. Consume the one-shot token; later ticks re-evaluate fresh.
    if (this.pendingInitSkip) {
      this.pendingInitSkip = null;
      return;
    }

    const branch = await this.resolveBranch();
    const worktreeDir = this.config.worktreeDir;
    const readGit = this.localClientFor(worktreeDir);

    let currentBranch: string;
    try {
      currentBranch = (await readGit.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.recordSkip(
        { kind: "head_unreadable", phase: "sync", error: errorMessage },
        `Could not read current branch from '${worktreeDir}': ${errorMessage}`,
        `Skipping '${this.repoName}': could not read current branch`,
      );
      return;
    }

    if (currentBranch !== branch) {
      this.recordSkip(
        { kind: "branch_mismatch", phase: "sync", currentBranch, expectedBranch: branch },
        `Clone at '${worktreeDir}' is on '${currentBranch}', expected '${branch}'. Skipping fetch+merge. ` +
          `Update 'branch' in the config or switch the clone back.`,
        `Skipping '${this.repoName}': current branch '${currentBranch}' is not '${branch}'`,
      );
      return;
    }

    // Re-check every tick (not just at init): the daemon reuses this service, so
    // a clone whose origin no longer matches repoUrl must keep being skipped
    // rather than fetching from the wrong remote.
    const originMismatch = await this.evaluateOriginMatch(readGit, worktreeDir);
    if (originMismatch) {
      this.recordSkip(
        originMismatch.skip,
        originMismatch.warnMessage,
        `Skipping '${this.repoName}': ${originMismatch.progressDetail}`,
      );
      return;
    }

    // Every step from here on writes to the repository, and this runs again on
    // every tick — so the primary-checkout guard has to be inside the tick, not
    // only in initialize().
    const clients = await this.mutatingClientsFor(worktreeDir);

    // The unshallow fetch uses the already-narrowed refspec, so a deleted
    // tracked branch fails it exactly like the branch fetch below — classify
    // it into the same soft skip instead of letting it escape as a hard
    // failure that only shallow clones would hit.
    try {
      await this.unshallowIfDepthRemoved(clients);
    } catch (error) {
      if (isMissingRemoteRefError(getErrorMessage(error))) {
        this.recordMissingRemoteRefSkip(branch);
        return;
      }
      throw error;
    }

    await this.configureSingleBranchRemote(clients, branch);

    const fetchArgs = await this.buildFetchArgs(clients.git, branch);
    this.emitProgress({ phase: "fetch", message: `Fetching origin/${branch} for '${this.repoName}'` });
    if ((await this.fetchWithRecovery(clients, fetchArgs, worktreeDir, branch)).skipped) {
      return;
    }
    this.emitProgress({ phase: "fetch", message: `Fetched origin/${branch} for '${this.repoName}'` });

    if (!(await this.hasRemoteBranch(clients.git, branch))) {
      this.recordSkip(
        { kind: "missing_remote_ref", branch, source: "post_fetch_verify" },
        `Tracked branch '${branch}' is missing on remote for '${this.repoName}'. Skipping sync.`,
        `Skipping '${this.repoName}': origin/${branch} is missing`,
      );
      return;
    }

    // `sparse-checkout set` writes core.sparseCheckout to the repository
    // config, so it is a mutation too — it takes a path, not a client, and
    // stays correct only because the primary-checkout guard above already ran.
    if (this.config.sparseCheckout) {
      const sparseService = this.gitService.getSparseCheckoutService();
      try {
        if (await sparseService.needsUpdate(worktreeDir, this.config.sparseCheckout)) {
          this.emitProgress({ phase: "sparse_checkout", message: `Updating sparse-checkout for '${this.repoName}'` });
          await sparseService.applyToWorktree(worktreeDir, this.config.sparseCheckout);
          this.emitProgress({ phase: "sparse_checkout", message: `Sparse-checkout updated for '${this.repoName}'` });
        }
      } catch (error) {
        this.logger.warn(`Failed to reapply sparse-checkout for '${this.repoName}': ${getErrorMessage(error)}`);
      }
    }

    const isClean = await this.gitService.checkWorktreeStatus(worktreeDir);
    if (!isClean) {
      this.recordSkip(
        { kind: "dirty_tree" },
        `⏭️  Skipping ff-merge for '${this.repoName}' — working tree has local changes.`,
        `Skipping merge for '${this.repoName}': working tree has local changes`,
        "info",
      );
      return;
    }

    let relationship = await this.gitService.classifyRemoteRelationship(worktreeDir, branch);
    let lastDeepenedTo: number | null = null;
    if (relationship === "indeterminate_shallow") {
      for (const target of this.getDeepenTargets()) {
        await this.deepenShallowHistoryToDepth(clients, branch, target);
        lastDeepenedTo = target;
        relationship = await this.gitService.classifyRemoteRelationship(worktreeDir, branch);
        if (relationship !== "indeterminate_shallow") break;
      }
    }

    if (relationship === "up_to_date") {
      this.logger.info(`'${this.repoName}' already up to date with origin/${branch}.`);
      this.emitProgress({
        phase: "skip",
        message: `'${this.repoName}' already up to date with origin/${branch}`,
      });
      this.outcomeAccumulator?.recordNoop("repo", "already_up_to_date", {
        branch,
        path: worktreeDir,
        message: `Already up to date with origin/${branch}`,
      });
      return;
    }

    if (relationship !== "fast_forward") {
      if (relationship === "local_ahead") {
        this.recordSkip(
          { kind: "ahead_unpushed", branch },
          `⏭️  '${this.repoName}' has unpushed commits ahead of origin/${branch}. Skipping merge.`,
          `Skipping merge for '${this.repoName}': unpushed commits ahead of origin/${branch}`,
          "info",
        );
      } else if (relationship === "indeterminate_shallow") {
        const detail =
          lastDeepenedTo === null
            ? `no deepening attempted (configured depth already at or above all deepen targets)`
            : `deepening to ${lastDeepenedTo} commits`;
        const progressDetail =
          lastDeepenedTo === null
            ? `no deepening attempted (configured depth at/above limits)`
            : `shallow depth budget exhausted at ${lastDeepenedTo}`;
        this.recordSkip(
          { kind: "indeterminate_shallow", branch, deepenedTo: lastDeepenedTo },
          `⏭️  '${this.repoName}' could not classify origin/${branch} after ${detail}. ` +
            `Skipping merge — consider removing or raising 'depth' to unshallow.`,
          `Skipping merge for '${this.repoName}': ${progressDetail}`,
          "info",
        );
      } else {
        this.recordSkip(
          { kind: "diverged", branch },
          `⏭️  '${this.repoName}' has diverged from origin/${branch}. Skipping merge (no auto-reset).`,
          `Skipping merge for '${this.repoName}': diverged from origin/${branch}`,
          "info",
        );
      }
      return;
    }

    this.logger.info(`Fast-forwarding '${this.repoName}' to origin/${branch}...`);
    this.emitProgress({ phase: "merge", message: `Fast-forwarding '${this.repoName}' to origin/${branch}` });
    // Read before the merge rather than derived from it afterwards: the
    // cleanup below only runs on a commit that provably did not move, and
    // "could not read HEAD" must not pass for that proof.
    const headBeforeMerge = await this.readHeadCommit(clients.git);
    try {
      await clients.git.merge([`origin/${branch}`, "--ff-only"]);
    } catch (mergeError) {
      await this.undoRejectedFastForward(clients, worktreeDir, branch, headBeforeMerge);
      throw mergeError;
    }
    this.logger.info(`✅ Updated '${this.repoName}' to origin/${branch}.`);
    this.emitProgress({ phase: "merge", message: `Updated '${this.repoName}' to origin/${branch}` });
    this.outcomeAccumulator?.recordUpdated(branch, worktreeDir, "fast_forward");
  }

  private async readHeadCommit(git: SimpleGit): Promise<string | null> {
    try {
      const head = (await git.raw(["rev-parse", "HEAD"])).trim();
      return head.length > 0 ? head : null;
    } catch {
      return null;
    }
  }

  // A `merge --ff-only` git rejects is not a no-op. Its checkout half walks the
  // index in path order and stops at the first entry it cannot write — a
  // missing LFS object is the usual reason — with everything that sorts before
  // that path already updated on disk and the index and HEAD still describing
  // the old commit. `git status` then reports those paths, so the next tick
  // soft-skips with dirty_tree at info level and exits 0, and so does every
  // tick after it: git refuses to overwrite the untracked files the first
  // attempt left, which makes even a fixed LFS server unable to end the loop.
  // Undoing the half-applied checkout is what keeps the next attempt — and the
  // next tick — able to run at all.
  //
  // What makes that safe is not that the tree was clean a moment earlier: the
  // relationship classification, up to three deepening fetches and the merge
  // itself sit between that check and this point, and together they can run
  // for minutes. Each path is proved on its own instead, against what
  // origin/<branch> holds for it:
  //
  //   present on disk — removed or restored only when its contents are what
  //     that ref holds for that path. Whoever put them there, they are the
  //     incoming version, and the next successful fast-forward writes that
  //     same object back — so undoing it loses nothing origin does not hold.
  //   missing from disk — restored only when that ref does NOT hold the path,
  //     the one case where the merge is what deleted it. A path origin still
  //     carries went missing some other way, and stays missing.
  //   anything else — left exactly as it is, dirty_tree and all.
  //
  // Deliberately not gated on the failure being a checkout failure: a merge
  // can also fail on `index.lock` while somebody's own git command dirties the
  // tree, and the per-path proof above is what decides there too — their work
  // does not match the incoming version, so none of it is touched.
  private async undoRejectedFastForward(
    clients: MutatingGitClients,
    worktreeDir: string,
    branch: string,
    headBeforeMerge: string | null,
  ): Promise<void> {
    // Both halves fail closed. Without a before-and-after commit there is no
    // proof the merge left HEAD alone, and a merge that did move HEAD wrote
    // those files on purpose — undoing them would delete the update.
    if (headBeforeMerge === null) return;
    const headAfterMerge = await this.readHeadCommit(clients.git);
    if (headAfterMerge === null || headAfterMerge !== headBeforeMerge) return;

    const deviations = await this.readWorktreeDeviations(clients.git);
    if (deviations === null) return;
    const dirtyPaths = new Set([...deviations.untracked, ...deviations.modified, ...deviations.missing]);
    if (dirtyPaths.size === 0) return;

    // Only paths this merge would have written are candidates; a dirty path
    // outside that set is somebody's own work and is never touched.
    let mergePaths: string[];
    try {
      const output = await clients.git.raw(["diff", "--name-only", "-z", "HEAD", `refs/remotes/origin/${branch}`]);
      mergePaths = output.split("\0").filter((mergePath) => mergePath.length > 0);
    } catch (error) {
      this.logger.warn(
        `Could not list what the rejected fast-forward of '${this.repoName}' would have written ` +
          `(${getErrorMessage(error)}); leaving the working tree as it is.`,
      );
      return;
    }

    const candidates = mergePaths.filter((mergePath) => dirtyPaths.has(mergePath));
    if (candidates.length === 0) return;

    // Read for every candidate, not just the ones still on disk: a path's
    // ABSENCE from this map is the proof that lets a missing file be restored,
    // so a lookup that failed must abort the whole cleanup rather than read as
    // "origin does not have it".
    const entries = await this.readRemoteTreeEntries(clients.git, branch, candidates);
    if (entries === null) return;

    // git writes a regular file or a symlink and nothing else, and the two are
    // proved differently — `hash-object` follows a symlink and hashes whatever
    // is at the other end, which never equals the blob git stores for it (the
    // target path) and would read a file outside the repository besides.
    const regularFiles: string[] = [];
    const symlinks: string[] = [];
    const toRemove: string[] = [];
    const toRestore: string[] = [];
    const recordProven = (candidate: string): void => {
      if (deviations.untracked.has(candidate)) {
        toRemove.push(candidate);
      } else {
        toRestore.push(candidate);
      }
    };

    for (const candidate of candidates) {
      if (deviations.missing.has(candidate)) {
        if (!entries.has(candidate)) toRestore.push(candidate);
        continue;
      }
      const kind = await this.classifyWorktreeEntry(worktreeDir, candidate);
      if (kind === "file") regularFiles.push(candidate);
      else if (kind === "symlink") symlinks.push(candidate);
    }

    const hashes = await this.hashWorktreeFiles(clients.git, regularFiles);
    for (const candidate of regularFiles) {
      const entry = entries.get(candidate);
      // A symlink is a blob as well, so the mode has to be excluded here: a
      // regular file whose content happens to be the link target string would
      // otherwise prove equal to a symlink origin holds at that path.
      if (entry?.type !== "blob" || entry.mode === SYMLINK_TREE_MODE) continue;
      if (hashes.get(candidate) !== entry.id) continue;
      recordProven(candidate);
    }

    for (const candidate of symlinks) {
      const entry = entries.get(candidate);
      if (entry?.mode !== SYMLINK_TREE_MODE) continue;
      if (!(await this.symlinkTargetMatchesBlob(clients.git, worktreeDir, candidate, entry.id))) continue;
      recordProven(candidate);
    }

    const removed = await this.removeWrittenFiles(clients, worktreeDir, toRemove);
    const restored = await this.restoreFilesFromHead(clients, toRestore);
    this.reportUndoneFastForward(branch, removed, restored);
  }

  // What is at `target` right now, without following it: a symlink git wrote
  // must be recognized as one, and a path that turned into a directory or
  // vanished under us is left alone.
  private async classifyWorktreeEntry(worktreeDir: string, target: string): Promise<"file" | "symlink" | "other"> {
    const stats = await this.lstatOrNull(path.join(worktreeDir, target));
    if (stats === null) return "other";
    if (stats.isSymbolicLink()) return "symlink";
    return stats.isFile() ? "file" : "other";
  }

  // git stores a symlink as a blob holding the target path, so that string is
  // what has to match — `cat-file` gives it verbatim, with no trailing newline
  // for `readlink` to differ by.
  private async symlinkTargetMatchesBlob(
    git: SimpleGit,
    worktreeDir: string,
    target: string,
    objectId: string,
  ): Promise<boolean> {
    let linkTarget: string | Buffer;
    try {
      linkTarget = await fs.readlink(path.join(worktreeDir, target));
    } catch {
      return false;
    }
    if (typeof linkTarget !== "string") return false;
    try {
      return (await git.raw(["cat-file", "blob", objectId])) === linkTarget;
    } catch {
      return false;
    }
  }

  // Every working-tree deviation git reports, split the way the cleanup has to
  // treat them. Paths a sparse checkout leaves out never appear here — git
  // does not report a skip-worktree entry as deleted — so the cleanup cannot
  // try to materialize a path outside the cone.
  private async readWorktreeDeviations(
    git: SimpleGit,
  ): Promise<{ untracked: Set<string>; modified: Set<string>; missing: Set<string> } | null> {
    try {
      const status = await git.status();
      return {
        untracked: new Set(status.not_added),
        modified: new Set(status.modified),
        missing: new Set(status.deleted),
      };
    } catch (error) {
      this.logger.warn(
        `Could not read the working tree of '${this.repoName}' after the rejected fast-forward ` +
          `(${getErrorMessage(error)}); leaving it as it is.`,
      );
      return null;
    }
  }

  // What origin/<branch> holds for each path — mode, type and object id.
  // `ls-tree` reports only the paths that exist in that tree and skips the
  // rest, which is exactly the answer the deletion half needs.
  private async readRemoteTreeEntries(
    git: SimpleGit,
    branch: string,
    paths: string[],
  ): Promise<Map<string, RemoteTreeEntry> | null> {
    const entries = new Map<string, RemoteTreeEntry>();
    for (const batch of batchPaths(paths)) {
      let output: string;
      try {
        output = await git.raw([
          "ls-tree",
          "-z",
          `refs/remotes/origin/${branch}`,
          "--",
          ...batch.map(asLiteralPathspec),
        ]);
      } catch (error) {
        this.logger.warn(
          `Could not read origin/${branch}'s objects for '${this.repoName}' after the rejected fast-forward ` +
            `(${getErrorMessage(error)}); leaving the working tree as it is.`,
        );
        return null;
      }
      for (const entry of output.split("\0")) {
        const separator = entry.indexOf("\t");
        if (separator < 0) continue;
        const [mode, type, id] = entry.slice(0, separator).split(" ");
        if (!mode || !type || !id) continue;
        entries.set(entry.slice(separator + 1), { mode, type, id });
      }
    }
    return entries;
  }

  // What each regular file currently holds, hashed by git itself so the
  // repository's filters (LFS's clean filter, CRLF conversion) are applied the
  // way they were when the blob was made. A path missing from the result is
  // one nothing may be concluded about, so it is simply never acted on.
  private async hashWorktreeFiles(git: SimpleGit, paths: string[]): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    for (const batch of batchPaths(paths)) {
      const batched = await this.hashFileBatch(git, batch);
      if (batched !== null) {
        batch.forEach((batchPath, index) => hashes.set(batchPath, batched[index]));
        continue;
      }
      // One unreadable path fails the whole invocation, and failing the run
      // over it would leave the wedge this cleanup exists to remove. Ask again
      // per path so a file that cannot be hashed disqualifies itself and
      // nothing else.
      for (const single of batch) {
        const one = await this.hashFileBatch(git, [single]);
        if (one !== null) hashes.set(single, one[0]);
      }
    }
    return hashes;
  }

  // `hash-object` prints one line per input, in order; anything else means the
  // mapping cannot be trusted and the caller falls back to asking one at a
  // time. Only the summary line of a failure is logged: simple-git puts the
  // command's stdout in the error, which here is the hashes it did print.
  private async hashFileBatch(git: SimpleGit, batch: string[]): Promise<string[] | null> {
    let output: string;
    try {
      output = await git.raw(["hash-object", "--", ...batch]);
    } catch (error) {
      this.logger.warn(
        `Could not hash ${batch.length} file(s) in '${this.repoName}' after the rejected fast-forward: ` +
          `${summarizeGitFailure(getErrorMessage(error))}`,
      );
      return null;
    }
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length !== batch.length) {
      this.logger.warn(
        `'git hash-object' answered for ${lines.length} of ${batch.length} files in '${this.repoName}'; ` +
          `leaving those files as they are.`,
      );
      return null;
    }
    return lines;
  }

  // `_clients` is unused on purpose and must stay, for the reason
  // lfsSkipCheckoutClient gives: this deletes files from the working tree, and
  // requiring the brand is what keeps that behind the primary-checkout guard.
  private async removeWrittenFiles(
    _clients: MutatingGitClients,
    worktreeDir: string,
    paths: string[],
  ): Promise<string[]> {
    const removed: string[] = [];
    for (const target of paths) {
      try {
        await fs.rm(path.join(worktreeDir, target), { force: true });
        removed.push(target);
      } catch (error) {
        this.logger.warn(`Could not remove '${target}' from '${this.repoName}': ${getErrorMessage(error)}`);
      }
    }
    return removed;
  }

  // `restore --worktree` rather than `checkout HEAD --`: the rejected merge
  // left the index alone, so putting these files back is a working-tree edit
  // and nothing else. It also keeps the pathspec clear of simple-git's
  // progress plugin, which appends `--progress` to every `checkout` — after a
  // `--` git reads that as one more path to restore.
  private async restoreFilesFromHead(clients: MutatingGitClients, paths: string[]): Promise<string[]> {
    const restored: string[] = [];
    for (const batch of batchPaths(paths)) {
      try {
        await clients.git.raw(["restore", "--source=HEAD", "--worktree", "--", ...batch.map(asLiteralPathspec)]);
        restored.push(...batch);
      } catch (error) {
        // A restore can fail for the same reason the merge did — HEAD's own
        // version of the path may need the smudge filter that is down. The
        // tree is then no worse than it was, and the next tick reports it.
        this.logger.warn(
          `Could not restore ${batch.length} file(s) in '${this.repoName}' from HEAD: ${getErrorMessage(error)}`,
        );
      }
    }
    return restored;
  }

  private reportUndoneFastForward(branch: string, removed: string[], restored: string[]): void {
    const parts = [
      this.describeCleanedPaths("removed", removed),
      this.describeCleanedPaths("restored", restored),
    ].filter((part): part is string => part !== null);
    if (parts.length === 0) return;

    const message =
      `↩️  Undid the half-applied fast-forward of '${this.repoName}' to origin/${branch}: ${parts.join(", ")}. ` +
      `Each held what origin/${branch} has for that path, or was a path it no longer has.`;
    this.logger.info(message);
    this.emitProgress({ phase: "merge", message });
  }

  private describeCleanedPaths(label: string, paths: string[]): string | null {
    if (paths.length === 0) return null;
    const shown = paths.slice(0, MERGE_CLEANUP_LOG_PATH_LIMIT);
    const remaining = paths.length - shown.length;
    const names = remaining > 0 ? `${shown.join(", ")}, +${remaining} more` : shown.join(", ");
    return `${label} ${paths.length} (${names})`;
  }
}

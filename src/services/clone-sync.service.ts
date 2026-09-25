import * as path from "path";

import { PATH_CONSTANTS } from "../constants";
import { fileExists } from "../utils/file-exists";
import { redactRepoUrl } from "../utils/git-url";
import { getErrorMessage } from "../utils/errors";
import { isMissingRemoteRefError } from "../utils/lfs-error";

import { BranchCreatedActionsService } from "./branch-created-actions.service";
import {
  createAndPushCloneBranch,
  switchCloneBranch,
  warnConfigDriftAfterCheckout,
} from "./clone-sync/branch-operations";
import { initializeClone } from "./clone-sync/clone-bootstrap";
import { undoRejectedFastForward } from "./clone-sync/fast-forward-undo";
import {
  buildSyncFetchArgs,
  classifyWithDeepening,
  describeDeepenAttempt,
  fetchWithRecovery,
  recordMissingRemoteRefSkip,
  unshallowIfDepthRemoved,
} from "./clone-sync/fetch";
import { CloneGitClients } from "./clone-sync/git-clients";
import { hasRemoteBranch, parseLsRemoteHeads, readHeadCommit } from "./clone-sync/git-helpers";
import { CLONE_SYNC_PHASES, timePhase } from "./clone-sync/phases";
import { configureSingleBranchRemote, evaluateOriginMatch } from "./clone-sync/remote-config";
import { reapplySparseCheckout } from "./clone-sync/sparse";
import { cloneSkipToOutcomeAction } from "./sync-outcome";

import type { GitService } from "./git.service";
import type { Logger } from "./logger.service";
import type { SyncOutcomeAccumulator } from "./sync-outcome";
import type { MutatingGitClients } from "./clone-sync/git-clients";
import type { CloneSkipListener, CloneSkipReason, CloneSyncContext } from "./clone-sync/types";
import type { Config, RepositoryConfig } from "../types";
import type { GitProgressEmitter, GitProgressEvent } from "../utils/git-progress";
import type { PhaseTimer } from "../utils/timing";

export { CLONE_SYNC_PHASES } from "./clone-sync/phases";
export type { CloneSkipListener, CloneSkipReason } from "./clone-sync/types";

// Clone mode: one standalone clone per repository, held on one branch and
// fast-forwarded to origin on every sync. This class owns the per-repository
// state (initialized, the resolved branch, the one-shot init skip) and the
// order a sync tick runs in; the git work itself lives in ./clone-sync/.
// docs/internal/clone-mode-notes.md carries the measurements and history
// behind the choices made there.
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
  private readonly clients: CloneGitClients;
  private readonly ctx: CloneSyncContext;

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
    this.ctx = CloneSyncService.createContext(this);
    this.clients = new CloneGitClients(this.ctx);
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

    const git = this.clients.localClientFor(worktreeDir);
    let branch = (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();

    if (!branch || branch === "HEAD") {
      const head = (await git.raw(["rev-parse", "--short", "HEAD"])).trim();
      branch = head ? `(detached ${head})` : "(detached)";
    }

    return [{ path: worktreeDir, branch }];
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

  async getRemoteBranches(): Promise<string[]> {
    const worktreeDir = path.resolve(this.config.worktreeDir);
    const repoArg = (await fileExists(path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR))) ? "origin" : this.config.repoUrl;
    const git = repoArg === "origin" ? this.clients.networkClientFor(worktreeDir) : this.clients.networkClientFor();
    const output = await git.raw(["ls-remote", "--heads", repoArg]);
    return parseLsRemoteHeads(output);
  }

  async checkoutBranch(branch: string, options: { allowConfigDrift?: boolean } = {}): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    const targetBranch = await this.resolveBranch();
    await switchCloneBranch(this.ctx, branch, targetBranch, options);
    this.resolvedBranch = branch;
    this.pendingInitSkip = null;
    warnConfigDriftAfterCheckout(this.ctx, branch, targetBranch);
  }

  // The clone-mode half of the TUI's branch wizard; see createAndPushCloneBranch.
  async createAndPushBranch(baseBranch: string, branchName: string): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    await createAndPushCloneBranch(this.ctx, baseBranch, branchName);
  }

  async initialize(outcome?: SyncOutcomeAccumulator): Promise<void> {
    return this.withOutcome(outcome, async () => {
      this.pendingInitSkip = null;
      const branch = await this.resolveBranch();
      this.pendingInitSkip = await initializeClone(this.ctx, branch);
      this.initialized = true;
    });
  }

  // `phaseTimer` is instrumentation and nothing else: what the tick does is
  // identical either way. It is not conditional on `--debug`.
  // WorktreeSyncService.sync() builds one PhaseTimer — the same one the
  // worktree-mode runner is given, so both modes print one table in one
  // format — and hands it to every tick it runs, whichever caller asked for the
  // sync: the CLI, the MCP server and the TUI all reach a tick through sync().
  // `debug` gates the table alone — whether it is built and printed once the
  // sync is over — so the phase bookkeeping happens on an ordinary run too. The
  // parameter stays optional for the callers that reach this method directly
  // rather than through sync() (a test, an embedder); with no timer every
  // bracket below is a plain call.
  async runSyncAttempt(outcome?: SyncOutcomeAccumulator, phaseTimer?: PhaseTimer): Promise<void> {
    return this.withOutcome(outcome, () => this.runSyncAttemptInternal(phaseTimer));
  }

  private async runSyncAttemptInternal(phaseTimer?: PhaseTimer): Promise<void> {
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

    const worktreeDir = this.config.worktreeDir;

    // Everything up to the first write: which branch this clone is meant to
    // track, which one it is on, which remote it points at, and the
    // primary-checkout guard. All three of its skips leave the tick, so the
    // phase is closed by timePhase's `finally` rather than by each return path;
    // `null` is that exit, with the skip already recorded.
    const validated = await timePhase(
      phaseTimer,
      CLONE_SYNC_PHASES.VALIDATE,
      async (): Promise<{ branch: string; clients: MutatingGitClients } | null> => {
        const branch = await this.resolveBranch();
        const readGit = this.clients.localClientFor(worktreeDir);

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
          return null;
        }

        if (currentBranch !== branch) {
          this.recordSkip(
            { kind: "branch_mismatch", phase: "sync", currentBranch, expectedBranch: branch },
            `Clone at '${worktreeDir}' is on '${currentBranch}', expected '${branch}'. Skipping fetch+merge. ` +
              `Update 'branch' in the config or switch the clone back.`,
            `Skipping '${this.repoName}': current branch '${currentBranch}' is not '${branch}'`,
          );
          return null;
        }

        // Re-check every tick (not just at init): the daemon reuses this service, so
        // a clone whose origin no longer matches repoUrl must keep being skipped
        // rather than fetching from the wrong remote.
        const originMismatch = await evaluateOriginMatch(this.ctx, readGit, worktreeDir);
        if (originMismatch) {
          this.recordSkip(
            originMismatch.skip,
            originMismatch.warnMessage,
            `Skipping '${this.repoName}': ${originMismatch.progressDetail}`,
          );
          return null;
        }

        // Every step from here on writes to the repository, and this runs again on
        // every tick — so the primary-checkout guard has to be inside the tick, not
        // only in initialize().
        return { branch, clients: await this.clients.mutatingClientsFor(worktreeDir) };
      },
    );
    if (!validated) return;
    const { branch, clients } = validated;

    // The unshallow fetch uses the already-narrowed refspec, so a deleted
    // tracked branch fails it exactly like the branch fetch below — classify
    // it into the same soft skip instead of letting it escape as a hard
    // failure that only shallow clones would hit.
    try {
      await timePhase(phaseTimer, CLONE_SYNC_PHASES.UNSHALLOW, () => unshallowIfDepthRemoved(this.ctx, clients));
    } catch (error) {
      if (isMissingRemoteRefError(getErrorMessage(error))) {
        recordMissingRemoteRefSkip(this.ctx, branch);
        return;
      }
      throw error;
    }

    // Its own phase rather than part of the fetch: on the call that narrows the
    // refspec this is also where the stale remote-tracking refs are swept, and
    // a legacy all-branches clone has thousands of them.
    await timePhase(phaseTimer, CLONE_SYNC_PHASES.REMOTE_CONFIG, () =>
      configureSingleBranchRemote(this.ctx, clients, branch),
    );

    const fetched = await timePhase(phaseTimer, CLONE_SYNC_PHASES.FETCH, async () => {
      const fetchArgs = await buildSyncFetchArgs(this.ctx, clients.git, branch);
      this.emitProgress({ phase: "fetch", message: `Fetching origin/${branch} for '${this.repoName}'` });
      return fetchWithRecovery(this.ctx, clients, fetchArgs, worktreeDir, branch);
    });
    if (fetched.skipped) {
      return;
    }
    this.emitProgress({ phase: "fetch", message: `Fetched origin/${branch} for '${this.repoName}'` });

    const remoteBranchPresent = await timePhase(phaseTimer, CLONE_SYNC_PHASES.VERIFY_REF, () =>
      hasRemoteBranch(clients.git, branch),
    );
    if (!remoteBranchPresent) {
      this.recordSkip(
        { kind: "missing_remote_ref", branch, source: "post_fetch_verify" },
        `Tracked branch '${branch}' is missing on remote for '${this.repoName}'. Skipping sync.`,
        `Skipping '${this.repoName}': origin/${branch} is missing`,
      );
      return;
    }

    const sparseConfig = this.config.sparseCheckout;
    if (sparseConfig) {
      await timePhase(phaseTimer, CLONE_SYNC_PHASES.SPARSE, () =>
        reapplySparseCheckout(this.ctx, worktreeDir, branch, sparseConfig),
      );
    }

    // The relationship first, the working tree only if it turns out to matter.
    // Classification is a few ref reads; `git status` walks the whole working
    // tree and is the one command in a tick that scales with the checkout's
    // size, and the common daemon tick ends `up_to_date`, where nothing is
    // written and a scan buys nothing. It is also the right answer: a dirty
    // clone already at origin/<branch> is up to date, not skipped. The only
    // path that writes is the fast-forward below, and it still reads the tree
    // immediately before merging. The cost — a too-shallow clone spends its
    // deepen budget even when the tree turns out dirty — is weighed in
    // docs/internal/clone-mode-notes.md. It is also why the Status phase is
    // usually absent from the timing table.
    const {
      relationship,
      deepenedTo: lastDeepenedTo,
      deepenFetches,
    } = await timePhase(phaseTimer, CLONE_SYNC_PHASES.CLASSIFY, () =>
      classifyWithDeepening(this.ctx, clients, worktreeDir, branch),
    );
    // The deepen fetches interleave with the classification reads they exist to
    // feed — fetch, ask again, fetch — so they are this phase's count rather
    // than a phase of their own, which is also the only shape PhaseTimer can
    // hold: it tracks one open phase, so a nested one would close this one and
    // lose the reads around it.
    if (deepenFetches > 0) {
      phaseTimer?.setPhaseCount(CLONE_SYNC_PHASES.CLASSIFY, deepenFetches);
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
        const detail = describeDeepenAttempt(lastDeepenedTo);
        const progressDetail =
          lastDeepenedTo === null
            ? `no deepening attempted (configured depth at/above limits)`
            : `shallow depth budget exhausted at ${lastDeepenedTo}`;
        this.recordSkip(
          { kind: "indeterminate_shallow", branch, deepenedTo: lastDeepenedTo },
          `⏭️  '${this.repoName}' could not classify origin/${branch} after ${detail}. ` +
            `Skipping merge — remove 'depth' from the config to unshallow the clone.`,
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

    const isClean = await timePhase(phaseTimer, CLONE_SYNC_PHASES.STATUS, () =>
      this.gitService.checkWorktreeStatus(worktreeDir),
    );
    if (!isClean) {
      this.recordSkip(
        { kind: "dirty_tree" },
        `⏭️  Skipping ff-merge for '${this.repoName}' — working tree has local changes.`,
        `Skipping merge for '${this.repoName}': working tree has local changes`,
        "info",
      );
      return;
    }

    this.logger.info(`Fast-forwarding '${this.repoName}' to origin/${branch}...`);
    this.emitProgress({ phase: "merge", message: `Fast-forwarding '${this.repoName}' to origin/${branch}` });
    await timePhase(phaseTimer, CLONE_SYNC_PHASES.MERGE, async () => {
      // Read before the merge rather than derived from it afterwards: the
      // cleanup below only runs on a commit that provably did not move, and
      // "could not read HEAD" must not pass for that proof.
      const headBeforeMerge = await readHeadCommit(clients.git);
      try {
        await clients.git.merge([`origin/${branch}`, "--ff-only"]);
      } catch (mergeError) {
        await undoRejectedFastForward(this.ctx, clients, worktreeDir, branch, headBeforeMerge);
        throw mergeError;
      }
    });
    this.logger.info(`✅ Updated '${this.repoName}' to origin/${branch}.`);
    this.emitProgress({ phase: "merge", message: `Updated '${this.repoName}' to origin/${branch}` });
    this.outcomeAccumulator?.recordUpdated(branch, worktreeDir, "fast_forward");
  }

  // Display name only (log lines and progress messages), so the URL fallback
  // is shown with any embedded credentials stripped.
  private get repoName(): string {
    return (this.config as RepositoryConfig).name ?? redactRepoUrl(this.config.repoUrl);
  }

  // The view of this service the ./clone-sync modules work through. Every
  // member is a getter so they always see the current logger and outcome.
  private static createContext(service: CloneSyncService): CloneSyncContext {
    return {
      get config() {
        return service.config;
      },
      get gitService() {
        return service.gitService;
      },
      get logger() {
        return service.logger;
      },
      get branchCreatedActions() {
        return service.branchCreatedActions;
      },
      get clients() {
        return service.clients;
      },
      get repoName() {
        return service.repoName;
      },
      get trackedBranch() {
        return service.resolvedBranch ?? service.config.branch;
      },
      get outcome() {
        return service.outcomeAccumulator;
      },
      emitProgress: (event) => service.emitProgress(event),
      recordSkip: (reason, logMessage, progressMessage, logLevel) =>
        service.recordSkip(reason, logMessage, progressMessage, logLevel),
    };
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
}

import * as path from "path";

import { PATH_CONSTANTS } from "../constants";
import { fileExists, probePathExists } from "../utils/file-exists";
import { redactRepoUrl, repoDisplayLabel } from "../utils/git-url";
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
  getDeepenTargets,
  recordMissingRemoteRefSkip,
  unshallowIfDepthRemoved,
} from "./clone-sync/fetch";
import { CloneGitClients } from "./clone-sync/git-clients";
import { hasRemoteBranch, isShallowRepository, parseLsRemoteHeads, readHeadCommit } from "./clone-sync/git-helpers";
import { CLONE_SYNC_PHASES, timePhase } from "./clone-sync/phases";
import { assessSingleBranchRemote, configureSingleBranchRemote, evaluateOriginMatch } from "./clone-sync/remote-config";
import { assessSparseCheckout, reapplySparseCheckout } from "./clone-sync/sparse";
import { cloneSkipToOutcomeAction } from "./sync-outcome";

import type { GitService, RemoteRelationship } from "./git.service";
import type { Logger } from "./logger.service";
import type { SyncOutcomeAccumulator } from "./sync-outcome";
import type { SyncDryRunPlanBuilder, SyncDryRunStep } from "./sync-plan";
import type { MutatingGitClients } from "./clone-sync/git-clients";
import type { CloneSkipListener, CloneSkipReason, CloneSyncContext, PendingCloneSkip } from "./clone-sync/types";
import type { Config } from "../types";
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
      // A dry run's service: its clients carry the read-only GitService's
      // environment. Only planSyncAttempt may be called on it.
      readOnly?: boolean;
    } = {},
  ) {
    this.branchCreatedActions = options.branchCreatedActions ?? new BranchCreatedActionsService();
    this.progressEmitter = options.progressEmitter;
    this.onSkip = options.onSkip;
    this.ctx = CloneSyncService.createContext(this);
    this.clients = new CloneGitClients(this.ctx, options.readOnly ? gitService.getBaseGitEnv() : {});
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
        const blocked = await this.checkTickPreconditions(worktreeDir, branch);
        if (blocked) {
          this.recordSkip(blocked.skip, blocked.logMessage, blocked.progressMessage, blocked.logLevel);
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

    const relationshipSkip = this.relationshipSkip(relationship, branch, lastDeepenedTo);
    if (relationshipSkip) {
      this.recordSkip(
        relationshipSkip.skip,
        relationshipSkip.logMessage,
        relationshipSkip.progressMessage,
        relationshipSkip.logLevel,
      );
      return;
    }

    const isClean = await timePhase(phaseTimer, CLONE_SYNC_PHASES.STATUS, () =>
      this.gitService.checkWorktreeStatus(worktreeDir),
    );
    if (!isClean) {
      const dirty = this.dirtyTreeSkip();
      this.recordSkip(dirty.skip, dirty.logMessage, dirty.progressMessage, dirty.logLevel);
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

  // `sync --dry-run` for a clone: the tick's decisions — the same
  // preconditions, fetch, classification and working-tree check — reported as
  // plan steps instead of acted on. It fetches the tracked branch exactly as
  // the tick does (remote-tracking ref and objects; the shallow boundary moves
  // the way the tick's own fetch would move it) and writes nothing else: no
  // clone, no unshallow, no refspec narrowing, no deepening, no sparse
  // reapply, no merge. Where the tick would do one of those first, the plan
  // says so in a note.
  async planSyncAttempt(plan: SyncDryRunPlanBuilder): Promise<void> {
    const worktreeDir = this.config.worktreeDir;
    const branch = await this.resolveBranch();

    if ((await probePathExists(path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR))) !== "exists") {
      const depth = this.config.depth !== undefined ? ` at depth ${this.config.depth}` : "";
      plan.add({
        kind: "clone",
        path: path.resolve(worktreeDir),
        branch,
        message: `clone ${redactRepoUrl(this.config.repoUrl)} (branch '${branch}')${depth}`,
      });
      return;
    }

    const blocked = await this.checkTickPreconditions(worktreeDir, branch);
    if (blocked) {
      plan.add(this.skipStep(blocked.skip));
      return;
    }

    const clients = await this.clients.mutatingClientsFor(worktreeDir);
    if (this.config.depth === undefined && (await isShallowRepository(clients.git))) {
      plan.note("The clone is shallow and no depth is configured: a sync first fetches its full history.");
    }
    if (!(await assessSingleBranchRemote(clients.git, branch)).refspecConverged) {
      plan.note(
        `origin's fetch refspec is not the single-branch one: a sync first narrows it to '${branch}' and deletes the other origin/* remote-tracking refs.`,
      );
    }

    const fetchArgs = await buildSyncFetchArgs(this.ctx, clients.git, branch);
    const fetched = await fetchWithRecovery(this.ctx, clients, fetchArgs, worktreeDir, branch, false);
    if (fetched.skipped) {
      plan.add(this.skipStep({ kind: "missing_remote_ref", branch, source: "fetch_error" }));
      return;
    }
    plan.markFetched();
    if (!(await hasRemoteBranch(clients.git, branch))) {
      plan.add(this.skipStep({ kind: "missing_remote_ref", branch, source: "post_fetch_verify" }));
      return;
    }

    const sparseConfig = this.config.sparseCheckout;
    if (sparseConfig) {
      const sparse = await assessSparseCheckout(this.ctx, worktreeDir, sparseConfig);
      const details = { branch, path: worktreeDir };
      if (sparse.kind === "apply") {
        plan.add({
          kind: "update",
          ...details,
          reason: "sparse_checkout",
          message: sparse.narrowing ? "narrows the sparse-checkout patterns" : "rewrites the sparse-checkout patterns",
        });
      } else if (sparse.kind === "unsafe-narrowing") {
        plan.add({
          kind: "skip",
          scope: "sparse-checkout",
          reason: "sparse_narrowing_unsafe",
          ...details,
          message: "working tree has local changes",
        });
      } else if (sparse.kind === "failed") {
        plan.add({
          kind: "skip",
          scope: "sparse-checkout",
          reason: "sparse_check_failed",
          ...details,
          message: getErrorMessage(sparse.error),
        });
      }
    }

    const relationship = await this.gitService.classifyRemoteRelationship(worktreeDir, branch);
    if (relationship === "up_to_date") {
      plan.add({
        kind: "noop",
        scope: "repo",
        reason: "already_up_to_date",
        branch,
        path: worktreeDir,
        message: `Already up to date with origin/${branch}`,
      });
      return;
    }
    // Too shallow to classify with a deepen budget left: the tick would spend
    // it (more fetches, each moving the shallow boundary) before deciding, and
    // the dry run does not. The outcome's wording for this skip assumes the
    // budget is spent or empty, so the step says what was not simulated.
    const deepenBudget = getDeepenTargets(this.ctx);
    if (relationship === "indeterminate_shallow" && deepenBudget.length > 0) {
      const deepest = deepenBudget[deepenBudget.length - 1];
      plan.add({
        kind: "skip",
        scope: "repo",
        reason: "clone_indeterminate_shallow",
        branch,
        path: worktreeDir,
        message:
          `history too short to relate HEAD to origin/${branch}; deepening up to ${deepest} commits ` +
          `is not simulated by a dry run — a sync deepens first and may then fast-forward`,
      });
      return;
    }
    const relationshipSkip = this.relationshipSkip(relationship, branch, null);
    if (relationshipSkip) {
      plan.add(this.skipStep(relationshipSkip.skip));
      return;
    }

    if (!(await this.gitService.checkWorktreeStatus(worktreeDir))) {
      plan.add(this.skipStep(this.dirtyTreeSkip().skip));
      return;
    }
    plan.add({ kind: "update", branch, path: worktreeDir, reason: "fast_forward", message: `to origin/${branch}` });
  }

  // The tick's checks before it writes anything: HEAD readable, on the
  // tracked branch, and origin still the configured repoUrl. A failed check
  // is a skip, returned rather than recorded so a dry run can report it.
  private async checkTickPreconditions(worktreeDir: string, branch: string): Promise<PendingCloneSkip | null> {
    const readGit = this.clients.localClientFor(worktreeDir);

    let currentBranch: string;
    try {
      currentBranch = (await readGit.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      return {
        skip: { kind: "head_unreadable", phase: "sync", error: errorMessage },
        logMessage: `Could not read current branch from '${worktreeDir}': ${errorMessage}`,
        progressMessage: `Skipping '${this.repoName}': could not read current branch`,
        logLevel: "warn",
      };
    }

    if (currentBranch !== branch) {
      return {
        skip: { kind: "branch_mismatch", phase: "sync", currentBranch, expectedBranch: branch },
        logMessage:
          `Clone at '${worktreeDir}' is on '${currentBranch}', expected '${branch}'. Skipping fetch+merge. ` +
          `Update 'branch' in the config or switch the clone back.`,
        progressMessage: `Skipping '${this.repoName}': current branch '${currentBranch}' is not '${branch}'`,
        logLevel: "warn",
      };
    }

    // Re-check every tick (not just at init): the daemon reuses this service, so
    // a clone whose origin no longer matches repoUrl must keep being skipped
    // rather than fetching from the wrong remote.
    const originMismatch = await evaluateOriginMatch(this.ctx, readGit, worktreeDir);
    if (originMismatch) {
      return {
        skip: originMismatch.skip,
        logMessage: originMismatch.warnMessage,
        progressMessage: `Skipping '${this.repoName}': ${originMismatch.progressDetail}`,
        logLevel: "warn",
      };
    }
    return null;
  }

  // The merge the classification rules out, if it rules one out. Null for
  // `up_to_date` and `fast_forward`, which the caller handles itself.
  private relationshipSkip(
    relationship: RemoteRelationship,
    branch: string,
    lastDeepenedTo: number | null,
  ): PendingCloneSkip | null {
    switch (relationship) {
      case "up_to_date":
      case "fast_forward":
        return null;
      case "local_ahead":
        return {
          skip: { kind: "ahead_unpushed", branch },
          logMessage: `⏭️  '${this.repoName}' has unpushed commits ahead of origin/${branch}. Skipping merge.`,
          progressMessage: `Skipping merge for '${this.repoName}': unpushed commits ahead of origin/${branch}`,
          logLevel: "info",
        };
      case "indeterminate_shallow": {
        const detail = describeDeepenAttempt(lastDeepenedTo);
        const progressDetail =
          lastDeepenedTo === null
            ? `no deepening attempted (configured depth at/above limits)`
            : `shallow depth budget exhausted at ${lastDeepenedTo}`;
        return {
          skip: { kind: "indeterminate_shallow", branch, deepenedTo: lastDeepenedTo },
          logMessage:
            `⏭️  '${this.repoName}' could not classify origin/${branch} after ${detail}. ` +
            `Skipping merge — remove 'depth' from the config to unshallow the clone.`,
          progressMessage: `Skipping merge for '${this.repoName}': ${progressDetail}`,
          logLevel: "info",
        };
      }
      default:
        return {
          skip: { kind: "diverged", branch },
          logMessage: `⏭️  '${this.repoName}' has diverged from origin/${branch}. Skipping merge (no auto-reset).`,
          progressMessage: `Skipping merge for '${this.repoName}': diverged from origin/${branch}`,
          logLevel: "info",
        };
    }
  }

  private dirtyTreeSkip(): PendingCloneSkip {
    return {
      skip: { kind: "dirty_tree" },
      logMessage: `⏭️  Skipping ff-merge for '${this.repoName}' — working tree has local changes.`,
      progressMessage: `Skipping merge for '${this.repoName}': working tree has local changes`,
      logLevel: "info",
    };
  }

  // A clone skip as a plan step, worded and coded the way the tick's outcome
  // records it.
  private skipStep(reason: CloneSkipReason): SyncDryRunStep {
    const action = cloneSkipToOutcomeAction(reason, {
      branch: this.resolvedBranch ?? this.config.branch,
      path: this.config.worktreeDir,
    });
    return action.kind === "skipped"
      ? {
          kind: "skip",
          scope: action.scope,
          reason: action.reason,
          ...(action.branch !== undefined && { branch: action.branch }),
          ...(action.path !== undefined && { path: action.path }),
          ...(action.message !== undefined && { message: action.message }),
        }
      : { kind: "skip", scope: "repo", reason: `clone_${reason.kind}` };
  }

  // Display name only (log lines and progress messages), so the URL fallback
  // is shown with any embedded credentials stripped.
  private get repoName(): string {
    return repoDisplayLabel(this.config);
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

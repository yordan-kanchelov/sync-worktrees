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
import { initializeClone, inspectCloneDestination } from "./clone-sync/clone-bootstrap";
import { assertPreviousCloneCompleted } from "./clone-sync/clone-markers";
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

export type { CloneSkipReason } from "./clone-sync/types";

export class CloneSyncService {
  private initialized = false;
  private resolvedBranch: string | null = null;
  private defaultBranch: string | null = null;
  private branchCreatedActions: BranchCreatedActionsService;
  private progressEmitter?: GitProgressEmitter;
  private onSkip?: CloneSkipListener;
  private outcomeAccumulator?: SyncOutcomeAccumulator;
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

  async assertPrimaryCheckout(): Promise<void> {
    await this.clients.mutatingClientsFor(this.config.worktreeDir);
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
    const recorded = await this.readCloneTimeDefaultBranch();
    if (recorded) {
      this.resolvedBranch = this.defaultBranch = recorded;
      this.logger.info(`No branch configured for '${this.repoName}'; using '${recorded}', the default at clone time.`);
      this.emitProgress({ phase: "branch", message: `Using clone-time default branch '${recorded}'` });
      return recorded;
    }
    this.logger.info(`No branch configured for '${this.repoName}', detecting remote default branch...`);
    this.emitProgress({ phase: "branch", message: `Resolving remote default branch for '${this.repoName}'` });
    this.resolvedBranch = this.defaultBranch = await this.gitService.getRemoteDefaultBranch(this.config.repoUrl);
    this.logger.info(`  ↳ resolved default branch: ${this.resolvedBranch}`);
    this.emitProgress({ phase: "branch", message: `Resolved default branch '${this.resolvedBranch}'` });
    return this.resolvedBranch;
  }

  private async readCloneTimeDefaultBranch(): Promise<string | null> {
    const worktreeDir = path.resolve(this.config.worktreeDir);
    if (!(await fileExists(path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR)))) return null;
    try {
      const git = this.clients.localClientFor(worktreeDir);
      const target = (await git.raw(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"])).trim();
      const prefix = "refs/remotes/origin/";
      const branch = target.startsWith(prefix) ? target.slice(prefix.length) : "";
      return branch && branch !== "HEAD" ? branch : null;
    } catch {
      return null;
    }
  }

  async getRemoteBranches(): Promise<string[]> {
    const worktreeDir = path.resolve(this.config.worktreeDir);
    const repoArg = (await fileExists(path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR))) ? "origin" : this.config.repoUrl;
    const git = repoArg === "origin" ? this.clients.networkClientFor(worktreeDir) : this.clients.networkClientFor();
    const output = await git.raw(["ls-remote", "--heads", repoArg]);
    return parseLsRemoteHeads(output);
  }

  async checkoutBranch(branch: string): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    await this.resolveBranch();
    const targetBranch = this.config.branch ?? this.defaultBranch ?? branch;
    await switchCloneBranch(this.ctx, branch);
    this.resolvedBranch = branch;
    this.pendingInitSkip = null;
    warnConfigDriftAfterCheckout(this.ctx, branch, targetBranch);
  }

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

  async runSyncAttempt(outcome?: SyncOutcomeAccumulator, phaseTimer?: PhaseTimer): Promise<void> {
    return this.withOutcome(outcome, () => this.runSyncAttemptInternal(phaseTimer));
  }

  private async runSyncAttemptInternal(phaseTimer?: PhaseTimer): Promise<void> {
    if (
      this.initialized &&
      (await probePathExists(path.join(this.config.worktreeDir, PATH_CONSTANTS.GIT_DIR))) === "missing"
    ) {
      this.initialized = false;
    }
    if (!this.initialized) {
      await this.initialize();
      this.pendingInitSkip = null;
      return;
    }

    if (this.pendingInitSkip) {
      this.pendingInitSkip = null;
      return;
    }

    const worktreeDir = this.config.worktreeDir;

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

        return { branch, clients: await this.clients.mutatingClientsFor(worktreeDir) };
      },
    );
    if (!validated) return;
    const { branch, clients } = validated;

    try {
      await timePhase(phaseTimer, CLONE_SYNC_PHASES.UNSHALLOW, () => unshallowIfDepthRemoved(this.ctx, clients));
    } catch (error) {
      if (isMissingRemoteRefError(getErrorMessage(error))) {
        recordMissingRemoteRefSkip(this.ctx, branch);
        return;
      }
      throw error;
    }

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

    const {
      relationship,
      deepenedTo: lastDeepenedTo,
      deepenFetches,
    } = await timePhase(phaseTimer, CLONE_SYNC_PHASES.CLASSIFY, () =>
      classifyWithDeepening(this.ctx, clients, worktreeDir, branch),
    );
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

    if (await this.upstreamOutsideSparse(worktreeDir, branch)) {
      this.logger.info(`⏭️  Skipping '${this.repoName}' - upstream changes outside sparse paths`);
      this.emitProgress({
        phase: "skip",
        message: `Skipping merge for '${this.repoName}': upstream changes outside sparse paths`,
      });
      this.outcomeAccumulator?.recordSkipped("repo", "outside_sparse_checkout", { branch, path: worktreeDir });
      return;
    }

    this.logger.info(`Fast-forwarding '${this.repoName}' to origin/${branch}...`);
    this.emitProgress({ phase: "merge", message: `Fast-forwarding '${this.repoName}' to origin/${branch}` });
    await timePhase(phaseTimer, CLONE_SYNC_PHASES.MERGE, async () => {
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

  async planSyncAttempt(plan: SyncDryRunPlanBuilder): Promise<void> {
    const worktreeDir = this.config.worktreeDir;
    const branch = await this.resolveBranch();

    if ((await inspectCloneDestination(worktreeDir)) !== "clone") {
      const depth = this.config.depth !== undefined ? ` at depth ${this.config.depth}` : "";
      plan.add({
        kind: "clone",
        path: path.resolve(worktreeDir),
        branch,
        message: `clone ${redactRepoUrl(this.config.repoUrl)} (branch '${branch}')${depth}`,
      });
      return;
    }
    await assertPreviousCloneCompleted(worktreeDir);

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
    if (await this.upstreamOutsideSparse(worktreeDir, branch)) {
      plan.add({ kind: "skip", scope: "repo", reason: "outside_sparse_checkout", branch, path: worktreeDir });
      return;
    }
    plan.add({ kind: "update", branch, path: worktreeDir, reason: "fast_forward", message: `to origin/${branch}` });
  }

  private async upstreamOutsideSparse(worktreeDir: string, branch: string): Promise<boolean> {
    const cfg = this.config.sparseCheckout;
    if (!cfg || cfg.skipUpdateWhenOutsideSparse === false) return false;
    const sparseService = this.gitService.getSparseCheckoutService();
    if (sparseService.resolveMode(cfg) !== "cone") return false;
    const diff = await this.gitService.getChangedPathsInRange(worktreeDir, "HEAD", `origin/${branch}`);
    return diff !== null && !sparseService.pathsTouchSparse(diff, cfg);
  }

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

  private skipStep(reason: CloneSkipReason): SyncDryRunStep {
    const action = cloneSkipToOutcomeAction(reason, {
      branch: this.resolvedBranch ?? this.config.branch,
      path: this.config.worktreeDir,
    });
    return {
      kind: "skip",
      scope: action.scope,
      reason: action.reason,
      ...(action.branch !== undefined && { branch: action.branch }),
      ...(action.path !== undefined && { path: action.path }),
      ...(action.message !== undefined && { message: action.message }),
    };
  }

  private get repoName(): string {
    return repoDisplayLabel(this.config);
  }

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
    } catch {}
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
    } catch {}
    this.outcomeAccumulator?.add(
      cloneSkipToOutcomeAction(reason, {
        branch: this.resolvedBranch ?? this.config.branch,
        path: this.config.worktreeDir,
      }),
    );
  }
}

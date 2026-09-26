import * as path from "path";
import * as fs from "fs/promises";
import type { Dirent } from "fs";
import pLimit from "p-limit";
import { DEFAULT_CONFIG, GIT_CONSTANTS, METADATA_CONSTANTS } from "../constants";
import { GitOperationError } from "../errors";
import type { WorktreeSyncService } from "./worktree-sync.service";
import type { GitService } from "./git.service";
import { BranchCreatedActionsService } from "./branch-created-actions.service";
import type { HookExecutionService } from "./hook-execution.service";
import { PathResolutionService } from "./path-resolution.service";
import type { LogLevel } from "./logger.service";
import { Logger } from "./logger.service";
import type { WorktreeStatusResult } from "./worktree-status.service";
import { RefScanScope } from "./worktree-status.service";
import { getErrorMessage } from "../utils/errors";
import { appendGitAuthHint } from "../utils/git-auth-error";
import { formatRepoLockUnavailable } from "../utils/repo-lock-format";
import { formatBytes } from "../utils/disk-space";
import type { DiskUsageCache } from "../utils/disk-usage-cache";
import { getDefaultBareRepoDir, redactSecretsInText, repoDisplayLabel } from "../utils/git-url";
import { resolveMode } from "../utils/repo-mode";
import type {
  RepositoryConfig,
  RepoOperationNotStarted,
  HookContext,
  WorktreeStatusEntry,
  DivergedDirectoryInfo,
  RepositoryListEntry,
  RepositoryDiskUsage,
  ForceCleanRepositoryPreview,
  ForceCleanRepositoryResult,
  ForceCleanRepositorySelection,
} from "../types";

/**
 * Where the collision suffix has already got to. The wizard submits the name
 * it displayed, so a typed `x` whose name was taken arrives here as `x-1` —
 * and a suffix appended to that would offer `x-1-1`, then `x-1-2`, instead of
 * continuing the `x-1`, `x-2`, `x-3` sequence the user was shown. Splitting
 * the trailing `-<n>` back off makes the service's walk the same walk, wherever
 * it is picked up. The digits are bounded so an absurd one cannot be counted
 * past the point where incrementing it stops changing the name.
 */
const splitBranchSuffix = (branchName: string): { stem: string; suffix: number } => {
  const match = /^(.+)-(\d{1,9})$/.exec(branchName);
  return match ? { stem: match[1], suffix: Number(match[2]) } : { stem: branchName, suffix: 0 };
};

function unprobedWorktreeStatus(reason: string): WorktreeStatusResult {
  // A probe that rejected answered nothing, so every flag reads unknown and
  // canRemove stays false -- the same fail-closed shape WorktreeStatusService
  // itself returns when its path probe cannot say. The row is rendered from
  // `error`, not from these, but any other reader must not mistake "we could
  // not look" for "there is nothing here".
  return {
    isClean: false,
    hasUnpushedCommits: true,
    hasStashedChanges: true,
    hasOperationInProgress: true,
    hasModifiedSubmodules: true,
    upstreamGone: false,
    fullyPushedUpstreamDeleted: false,
    canRemove: false,
    reasons: [reason],
    divergence: null,
  };
}

export interface CreateBranchResult {
  success: boolean;
  finalName: string;
  error?: string;
}

export interface RepositoryOperationsHost {
  /** The current generation of repositories; a reload replaces it. */
  getServices(): readonly WorktreeSyncService[];
  log(message: string, level: "info" | "warn" | "error"): void;
  /** The parallelism limit shared with sync cycles and reload. */
  readonly limit: ReturnType<typeof pLimit>;
  readonly diskUsage: DiskUsageCache;
  readonly hookExecutionService: HookExecutionService;
  /** Recompute the header's disk-space total. */
  refreshDiskSpace(): Promise<void>;
  /** A status check of every worktree of a repository finished. */
  onWorktreeStatus?(repoIndex: number, entries: readonly WorktreeStatusEntry[]): void;
}

/**
 * Everything the interactive UI does to a repository besides syncing it:
 * branch creation and publishing (with rollback), worktree creation, the
 * status and disk-usage views, diverged-directory cleanup and force clean.
 * The TUI reaches git only through here, never through a sync service's
 * GitService, so each operation's queueing behind the repository lock and its
 * clone-mode branch live in one place.
 */
export class RepositoryOperations {
  private readonly branchCreatedActions = new BranchCreatedActionsService();
  private readonly pathResolution = new PathResolutionService();

  constructor(private readonly host: RepositoryOperationsHost) {}

  private requireService(repoIndex: number): WorktreeSyncService {
    const services = this.host.getServices();
    if (repoIndex < 0 || repoIndex >= services.length) {
      throw new Error(`Invalid repository index: ${repoIndex}`);
    }
    return services[repoIndex];
  }

  private hasService(repoIndex: number): boolean {
    return repoIndex >= 0 && repoIndex < this.host.getServices().length;
  }

  public getRepositoryList(): RepositoryListEntry[] {
    return this.host.getServices().map((service, index) => ({
      index,
      name: this.getRepoName(index),
      repoUrl: service.config.repoUrl,
    }));
  }

  public getRepoName(index: number): string {
    const service = this.host.getServices()[index];
    return (service.config as RepositoryConfig).name || `repo-${index}`;
  }

  public getRunningHookCount(): number {
    return this.host.hookExecutionService.getActiveCount();
  }

  public async getRepositoryDiskUsage(repoIndex: number): Promise<RepositoryDiskUsage> {
    const service = this.requireService(repoIndex);
    const config = service.config;
    const repoName = this.getRepoName(repoIndex);
    const mode = resolveMode(config);
    const sizeTargets: Array<{ kind: "bare" | "worktree"; path: string }> = [
      ...(mode === "worktree"
        ? [{ kind: "bare" as const, path: config.bareRepoDir || getDefaultBareRepoDir(config.repoUrl) }]
        : []),
      { kind: "worktree", path: config.worktreeDir },
    ];

    let bareSizeBytes = 0;
    let worktreeSizeBytes = 0;
    const errors: string[] = [];

    for (const target of sizeTargets) {
      try {
        const size = await this.host.diskUsage.size(target.path);
        if (target.kind === "bare") {
          bareSizeBytes = size;
        } else {
          worktreeSizeBytes = size;
        }
      } catch (error) {
        errors.push(`${target.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const sizeBytes = bareSizeBytes + worktreeSizeBytes;
    const failedAllPaths = errors.length === sizeTargets.length;
    const partialFailure = errors.length > 0 && !failedAllPaths;

    return {
      repoIndex,
      repoName,
      sizeBytes: failedAllPaths ? null : sizeBytes,
      sizeFormatted: failedAllPaths ? "N/A" : partialFailure ? `≥${formatBytes(sizeBytes)}` : formatBytes(sizeBytes),
      bareSizeBytes,
      worktreeSizeBytes,
      error: errors.length > 0 ? errors.join("; ") : undefined,
    };
  }

  public async getBranchesForRepo(repoIndex: number): Promise<string[]> {
    const service = this.requireService(repoIndex);
    if (!service.isInitialized() && !service.isCloneMode()) {
      return [];
    }
    // Clone-mode branch listing hits the network (ls-remote) whether or not
    // the clone is initialized — fail to an empty list in both cases so the
    // wizard's fetch-and-retry path handles it uniformly.
    try {
      return await service.getRemoteBranches();
    } catch {
      return [];
    }
  }

  public async getDefaultBranchForRepo(repoIndex: number): Promise<string> {
    const service = this.requireService(repoIndex);
    // Clone mode never runs GitService.initialize(), so GitService's default
    // branch is still the 'main' its constructor set, whatever the clone
    // actually tracks — the wizard would pre-select and label a branch the
    // repository does not follow and create from the wrong base. The sync
    // service's accessor is clone-aware: the configured branch, or the
    // remote's HEAD (resolved once, then cached) when none is configured.
    try {
      return await service.getDefaultBranch();
    } catch (error) {
      // The wizard drops this to keep its branch list on screen, so say why
      // here or the reason is lost: resolving an unconfigured branch asks the
      // remote, and its message is the one that tells the user to set
      // `branch` explicitly.
      this.host.log(
        `Could not resolve the default branch for '${this.getRepoName(repoIndex)}': ${getErrorMessage(error)}`,
        "warn",
      );
      throw error;
    }
  }

  public async fetchForRepo(repoIndex: number): Promise<void> {
    const service = this.requireService(repoIndex);
    const result = await service.runQueuedRepoOperation(async () => {
      // Use the unlocked init path: initialize() re-enters the repo mutex and would
      // self-deadlock inside this queued operation.
      if (!service.isInitialized()) {
        await service.initializeUnlocked();
      }
      if (service.isCloneMode()) {
        // Clone-mode tracks a single branch; there is nothing to fetch-all here.
        // Branch discovery is a live `git ls-remote` performed when the picker opens.
        return;
      }
      await service.getGitService().fetchAll();
    });
    if (!result.started) {
      throw new Error(this.describeNotStarted(result, "fetch skipped"));
    }
  }

  // Interactive operations queue behind in-flight work, so a result that did
  // not start means the cross-process lock: contention is worth retrying, an
  // unavailable lock is not and must name its cause instead.
  private describeNotStarted(result: RepoOperationNotStarted, consequence: string): string {
    if (result.reason === "lock_unavailable") {
      return `${formatRepoLockUnavailable(result)}; ${consequence}.`;
    }
    return `Another process holds the repository lock; ${consequence}. Try again.`;
  }

  public async createAndPushBranch(
    repoIndex: number,
    baseBranch: string,
    branchName: string,
  ): Promise<CreateBranchResult> {
    if (!this.hasService(repoIndex)) {
      return { success: false, finalName: branchName, error: `Invalid repository index: ${repoIndex}` };
    }

    const service = this.host.getServices()[repoIndex];
    const gitService = service.getGitService();
    // Every branch a rollback below could not remove. The loop reads it rather
    // than sniffing the message it is about to discard.
    const leftovers: string[] = [];

    // A clone-mode repo has no bare repository, and GitService's write helpers
    // all run in one — falling back to the relative '.bare/<repo name>', which
    // is either missing or another repository's store. Clone mode creates and
    // publishes the branch inside the clone itself instead.
    const createAndPush = service.isCloneMode()
      ? (name: string): Promise<void> => service.createAndPushBranch(baseBranch, name)
      : async (name: string): Promise<void> => {
          await gitService.createBranch(name, baseBranch);
          // Read before the push, so the rollback below can compare-and-swap
          // on the commit this attempt created the branch at.
          const createdAt = await gitService.getLocalBranchCommit(name);
          try {
            await gitService.pushBranch(name);
          } catch (error) {
            await this.rollbackUnpushedBranch(gitService, name, createdAt, error, leftovers);
          }
        };

    // Serialize branch+push behind any in-flight sync so it can't race git's
    // index/refs. addWorktree (createWorktreeForBranch) is a separate queued op.
    const result = await service.runQueuedRepoOperation(async () => {
      const maxAttempts = 10;
      // The walk continues from the name handed in rather than restarting
      // under it: the wizard submits the name it displayed, so a `x` it showed
      // as `x-1` arrives here as `x-1`, and appending to THAT offers `x-1-1`.
      const { stem, suffix: startingSuffix } = splitBranchSuffix(branchName);
      let suffix = startingSuffix;
      let nextName = branchName;
      // What the result names is the branch this call actually tried, not the
      // one the caller asked for: after a suffix walk they are different
      // names, and reporting the caller's would name a branch nothing was
      // attempted on.
      let attemptedName = branchName;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        attemptedName = nextName;
        try {
          await createAndPush(attemptedName);
          return { success: true, finalName: attemptedName };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          // A leftover the rollback could not remove is precisely the state
          // the retry must not run in — it is the defect this whole flow is
          // about: '<name>' orphaned locally and never pushed while
          // '<name>-1' is created instead. Retrying would also discard the
          // message that names it, which is the only place the user is told.
          if (errorMessage.includes("already exists") && leftovers.length === 0) {
            suffix++;
            nextName = `${stem}-${suffix}`;
            continue;
          }
          return { success: false, finalName: attemptedName, error: errorMessage };
        }
      }

      return {
        success: false,
        finalName: attemptedName,
        error: `Failed to create branch after ${maxAttempts} attempts`,
      };
    });

    if (!result.started) {
      return {
        success: false,
        finalName: branchName,
        error: this.describeNotStarted(result, "branch not created"),
      };
    }
    return result.value;
  }

  // A push that never landed must not leave the local branch behind: the
  // wizard reports the failure and offers the same name again, and the next
  // attempt would then collide with this attempt's own leftover — quietly
  // creating '<name>-1' while '<name>' is still nowhere on the remote. The
  // delete is a compare-and-swap on the commit the branch was created at, so a
  // ref something else moved in the meantime is left alone, and a leftover
  // that could not be removed is named in the message rather than hidden.
  private async rollbackUnpushedBranch(
    gitService: GitService,
    branchName: string,
    createdAt: string | null,
    pushError: unknown,
    leftovers: string[],
  ): Promise<never> {
    // git's stderr for an https remote carries the credential in the URL it
    // failed on ("unable to access 'https://x-access-token:<token>@…'"), and
    // this message is shown in the wizard's result pane — the same two guards
    // clone mode's twin applies, for the same reason.
    const message = redactSecretsInText(getErrorMessage(pushError));
    // "stale info" is how the create-only lease reports a ref that exists on
    // origin after all — it reads as a collision, not as a stale
    // remote-tracking ref, so it is phrased as one, and the "already exists"
    // wording sends the loop above round again with a suffixed name.
    const detail = message.includes("stale info")
      ? `branch '${branchName}' already exists on origin — it was pushed while this one was being prepared; ` +
        `choose another name`
      : `could not push '${branchName}' to origin: ${appendGitAuthHint(message)}`;

    let leftover = "";
    try {
      if (createdAt === null) {
        throw new Error("the commit it was created at could not be read");
      }
      await gitService.deleteLocalBranchIfAt(branchName, createdAt);
    } catch (deleteError) {
      // With the bare repository named: it is under '.bare/<repo>', a
      // directory the user never stands in, so a bare `git branch -D` is an
      // instruction that works nowhere they are likely to run it. Clone mode's
      // twin names its clone the same way.
      leftover =
        ` The local branch '${branchName}' is still in the bare repository — removing it failed ` +
        `(${getErrorMessage(deleteError)}); delete it with ` +
        `\`git -C "${path.resolve(gitService.getBareRepoPath())}" branch -D ${branchName}\`.`;
      leftovers.push(leftover);
    }

    throw new GitOperationError("push", `${detail}.${leftover}`, pushError instanceof Error ? pushError : undefined);
  }

  public async getWorktreesForRepo(repoIndex: number): Promise<Array<{ path: string; branch: string }>> {
    return this.getWorktreesFromService(this.requireService(repoIndex));
  }

  public async getWorktreeStatusForRepo(repoIndex: number): Promise<WorktreeStatusEntry[]> {
    const service = this.requireService(repoIndex);
    const gitService = service.getGitService();
    const worktrees = await this.getWorktreesFromService(service);

    // WorktreeStatusService already caps the git processes a repository's
    // probes run at once (maxStatusChecks, shared across every worktree), so
    // this bounds worktrees in flight rather than processes: without it every
    // worktree opens a snapshot that then waits its turn on that budget, so a
    // 300-worktree repository holds 300 half-finished snapshots -- a git client
    // and a status buffer each -- and no row can finish until nearly all of the
    // first-phase commands have. Same limit as the sync path's prune probes.
    const limit = pLimit(
      Math.max(1, service.config.parallelism?.maxStatusChecks ?? DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS),
    );

    // Every worktree comes back, probed or not. The `fulfilled` filter this
    // replaces dropped a rejected probe's worktree from the list entirely, so
    // the view showed fewer worktrees than the repository has and said nothing
    // about the ones it had lost.
    //
    // One branch/remote-ref scan for the whole refresh, not one per worktree.
    const refScans = new RefScanScope();
    const entries = await Promise.all(
      worktrees.map((wt) =>
        limit(async (): Promise<WorktreeStatusEntry> => {
          try {
            const status = await gitService.getFullWorktreeStatus(wt.path, true, refScans);
            return { branch: wt.branch, path: wt.path, status };
          } catch (error) {
            const message = getErrorMessage(error);
            return {
              branch: wt.branch,
              path: wt.path,
              status: unprobedWorktreeStatus(message),
              error: message,
            };
          }
        }),
      ),
    );
    // The home screen's dirty/unpushed column is this check, remembered -- not
    // a probe of its own. Only while the index still names this repository: a
    // reload during the check hands the index to another one.
    if (this.host.getServices()[repoIndex] === service) {
      this.host.onWorktreeStatus?.(repoIndex, entries);
    }
    return entries;
  }

  private async getWorktreesFromService(
    service: WorktreeSyncService,
  ): Promise<Array<{ path: string; branch: string }>> {
    const worktreeProvider = service as WorktreeSyncService & {
      getWorktrees?: () => Promise<Array<{ path: string; branch: string }>>;
    };
    if (typeof worktreeProvider.getWorktrees === "function") {
      return worktreeProvider.getWorktrees();
    }
    return service.getGitService().getWorktrees();
  }

  public async getDivergedDirectoriesForRepo(repoIndex: number): Promise<DivergedDirectoryInfo[]> {
    if (!this.hasService(repoIndex)) {
      return [];
    }

    const service = this.host.getServices()[repoIndex];
    const worktreeDir = service.config.worktreeDir;
    const divergedDir = path.join(worktreeDir, GIT_CONSTANTS.DIVERGED_DIR_NAME);

    let dirEntries: Dirent[];
    try {
      dirEntries = await fs.readdir(divergedDir, { withFileTypes: true, encoding: "utf-8" });
    } catch {
      return [];
    }

    const subdirs = dirEntries.filter((e) => e.isDirectory());

    const results = await Promise.allSettled(
      subdirs.map(async (entry): Promise<DivergedDirectoryInfo> => {
        const fullPath = path.join(divergedDir, entry.name);
        const infoFilePath = path.join(fullPath, METADATA_CONSTANTS.DIVERGED_INFO_FILE);

        let originalBranch = entry.name;
        let divergedAt = "";
        let keepRef: string | undefined;

        try {
          const infoContent = await fs.readFile(infoFilePath, "utf-8");
          const info = JSON.parse(infoContent) as Record<string, unknown>;
          if (typeof info.originalBranch === "string") originalBranch = info.originalBranch;
          if (typeof info.divergedAt === "string") divergedAt = info.divergedAt;
          if (typeof info.keepRef === "string") keepRef = info.keepRef;
        } catch {
          // Extract date and branch from directory name pattern: YYYY-MM-DD-branch-suffix
          const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})-(.+?)(?:-[a-f0-9]+)?$/);
          if (match) {
            divergedAt = match[1];
            originalBranch = match[2];
          }
        }

        const sizeBytes = await this.host.diskUsage.size(fullPath).catch(() => 0);
        const sizeFormatted = formatBytes(sizeBytes);

        return {
          name: entry.name,
          path: fullPath,
          originalBranch,
          divergedAt,
          sizeBytes,
          sizeFormatted,
          keepRef,
        };
      }),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<DivergedDirectoryInfo> => r.status === "fulfilled")
      .map((r) => r.value)
      .sort((a, b) => b.divergedAt.localeCompare(a.divergedAt));
  }

  public async deleteDivergedDirectory(repoIndex: number, name: string): Promise<void> {
    const service = this.requireService(repoIndex);
    const worktreeDir = service.config.worktreeDir;
    const divergedBase = path.resolve(worktreeDir, GIT_CONSTANTS.DIVERGED_DIR_NAME);

    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw new Error(`Invalid diverged directory name: "${name}"`);
    }

    const targetPath = path.join(divergedBase, name);

    if (!this.pathResolution.isPathInsideBaseDir(targetPath, divergedBase)) {
      throw new Error(`Path traversal rejected: "${name}" resolves outside the diverged directory`);
    }

    let keepRef: string | undefined;
    try {
      const info = JSON.parse(
        await fs.readFile(path.join(targetPath, METADATA_CONSTANTS.DIVERGED_INFO_FILE), "utf-8"),
      ) as Record<string, unknown>;
      if (typeof info.keepRef === "string") keepRef = info.keepRef;
    } catch {
      // Legacy entries have no keep ref metadata.
    }
    await service.discardDivergedDirectory(targetPath, keepRef);
    // The directory is gone and the worktree directory that held it is smaller,
    // so both cached figures are now wrong. Without this the status view served
    // the repository's old total for a whole TTL -- across closing and
    // reopening the modal, which is worse than the walk-on-every-open it
    // replaced. The header total is rebuilt on the next cycle, as it was
    // before.
    this.host.diskUsage.invalidate(targetPath);
    this.host.diskUsage.invalidate(worktreeDir);
    this.host.log(`🗑️ Deleted diverged directory: ${name}`, "info");
  }

  public async getForceCleanPreview(): Promise<ForceCleanRepositoryPreview[]> {
    return Promise.all(
      this.host.getServices().map((service, repoIndex) =>
        this.host.limit(async () => {
          const repoName = this.getRepoName(repoIndex);
          try {
            return { repoIndex, repoName, preview: await service.getForceCleanPreview() };
          } catch (error) {
            return { repoIndex, repoName, error: getErrorMessage(error) };
          }
        }),
      ),
    );
  }

  // `selections` is what the confirmation actually showed, per repo: the trash
  // entry ids and recovery ref names behind the counts. A repo whose preview
  // failed has no selection and is skipped — purging it would destroy content
  // the user was never shown a count for — and within a selected repo the
  // service purges only these names.
  public async forceClean(selections: ForceCleanRepositorySelection[]): Promise<ForceCleanRepositoryResult[]> {
    const selected = new Map(selections.map((selection) => [selection.repoIndex, selection]));
    const results = await Promise.all(
      this.host.getServices().map((service, repoIndex) =>
        this.host.limit(async () => {
          const repoName = this.getRepoName(repoIndex);
          const selection = selected.get(repoIndex);
          if (!selection) {
            return { repoIndex, repoName, error: "skipped: cleanup preview was unavailable" };
          }
          try {
            const result = await service.forceClean(selection);
            const leftBehind = result.skippedNewEntries + result.skippedNewKeepRefs;
            const level = result.errors.length > 0 || leftBehind > 0 ? "warn" : "info";
            const skipped =
              leftBehind > 0
                ? `; left ${result.skippedNewEntries} trash entries and ${result.skippedNewKeepRefs} recovery refs added after the preview`
                : "";
            // The modal truncates its result lines once they scroll, so the
            // log is where the full notes and errors stay readable.
            const retained =
              result.keepRefsRetained > 0
                ? `; kept ${result.keepRefsRetained} recovery refs still backing a .diverged copy`
                : "";
            const errors = result.errors.length > 0 ? ` (${result.errors.join("; ")})` : "";
            this.host.log(
              `🧹 Force clean ${repoName}: deleted ${result.trashDeleted} trash entries and ${result.keepRefsDeleted} recovery refs; GC ${result.gcSkipped ? "skipped" : result.gcSucceeded ? "complete" : "failed"}${retained}${skipped}${errors}`,
              level,
            );
            return { repoIndex, repoName, result };
          } catch (error) {
            const message = getErrorMessage(error);
            this.host.log(`Force clean ${repoName} failed: ${message}`, "error");
            return { repoIndex, repoName, error: message };
          }
        }),
      ),
    );
    await this.host.refreshDiskSpace();
    return results;
  }

  public async createWorktreeForBranch(repoIndex: number, branchName: string): Promise<void> {
    const service = this.requireService(repoIndex);
    const gitService = service.getGitService();

    const result = await service.runQueuedRepoOperation(async () => {
      if (service.isCloneMode()) {
        // The wizard just created and pushed this branch — switching to it is
        // intentional config drift; checkoutBranch warns to update config.branch.
        await service.checkoutBranch(branchName, { allowConfigDrift: true });
        return;
      }
      // Named inside the queued operation: the choice between the plain and
      // the hashed directory name depends on what is registered and on disk.
      const worktreePath = await gitService.resolveNewWorktreePath(branchName);
      await gitService.addWorktree(branchName, worktreePath);
    });
    if (!result.started) {
      throw new Error(this.describeNotStarted(result, "worktree not created"));
    }
  }

  private buildUiLogger(): Logger {
    return new Logger({
      outputFn: (msg: string, level: LogLevel): void => {
        const uiLevel: "info" | "warn" | "error" = level === "warn" ? "warn" : level === "error" ? "error" : "info";
        this.host.log(msg, uiLevel);
      },
    });
  }

  public executeOnBranchCreatedHooks(repoIndex: number, context: HookContext): void {
    if (!this.hasService(repoIndex)) {
      return;
    }

    const config = this.host.getServices()[repoIndex].config;
    const repoName = repoDisplayLabel(config);

    this.branchCreatedActions.runHooks({
      config,
      repoName,
      branchName: context.branchName,
      worktreePath: context.worktreePath,
      baseBranch: context.baseBranch,
      logger: this.buildUiLogger(),
      hookExecutionService: this.host.hookExecutionService,
    });
  }

  public async copyBranchFiles(repoIndex: number, baseBranch: string, targetBranch: string): Promise<void> {
    if (!this.hasService(repoIndex)) {
      return;
    }

    const service = this.host.getServices()[repoIndex];
    const config = service.config;

    if (!config.filesToCopyOnBranchCreate?.length) {
      return;
    }

    const worktrees = await this.getWorktreesFromService(service);

    const sourceWorktree = worktrees.find((w) => w.branch === baseBranch);
    const targetWorktree = worktrees.find((w) => w.branch === targetBranch);

    if (!sourceWorktree || !targetWorktree) {
      this.host.log(`Could not find worktrees for file copy: source=${baseBranch}, target=${targetBranch}`, "warn");
      return;
    }

    await this.branchCreatedActions.copyFiles({
      config,
      branchName: targetBranch,
      worktreePath: targetWorktree.path,
      sourceDir: sourceWorktree.path,
      logger: this.buildUiLogger(),
    });
  }
}

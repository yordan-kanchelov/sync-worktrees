import * as path from "path";
import * as fs from "fs/promises";
import type { Dirent } from "fs";
import pLimit from "p-limit";
import { DEFAULT_CONFIG, GIT_CONSTANTS, METADATA_CONSTANTS } from "../constants";
import { GitOperationError, UnpushedBranchLeftoverError } from "../errors";
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
import { REPOSITORY_MODES, resolveMode } from "../utils/repo-mode";
import type {
  Config,
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

const splitBranchSuffix = (branchName: string): { stem: string; suffix: number } => {
  const match = /^(.+)-(\d{1,9})$/.exec(branchName);
  return match ? { stem: match[1], suffix: Number(match[2]) } : { stem: branchName, suffix: 0 };
};

function unprobedWorktreeStatus(reason: string): WorktreeStatusResult {
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
  getServices(): readonly WorktreeSyncService[];
  log(message: string, level: "info" | "warn" | "error"): void;
  readonly limit: ReturnType<typeof pLimit>;
  readonly diskUsage: DiskUsageCache;
  readonly hookExecutionService: HookExecutionService;
  refreshDiskSpace(): Promise<void>;
  onWorktreeStatus?(repoIndex: number, entries: readonly WorktreeStatusEntry[]): void;
}

export function getRepositoryDiskTargets(
  config: Pick<Config, "mode" | "repoUrl" | "worktreeDir" | "bareRepoDir">,
): Array<{ kind: "bare" | "worktree"; path: string }> {
  return [
    ...(resolveMode(config) === REPOSITORY_MODES.WORKTREE
      ? [{ kind: "bare" as const, path: config.bareRepoDir || getDefaultBareRepoDir(config.repoUrl) }]
      : []),
    { kind: "worktree", path: config.worktreeDir },
  ];
}

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
    const sizeTargets = getRepositoryDiskTargets(config);

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
    try {
      return await service.getRemoteBranches();
    } catch {
      return [];
    }
  }

  public async getDefaultBranchForRepo(repoIndex: number): Promise<string> {
    const service = this.requireService(repoIndex);
    try {
      return await service.getDefaultBranch();
    } catch (error) {
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
      if (!service.isInitialized()) {
        await service.initializeUnlocked();
      }
      if (service.isCloneMode()) {
        return;
      }
      await service.getGitService().fetchAll();
    });
    if (!result.started) {
      throw new Error(this.describeNotStarted(result, "fetch skipped"));
    }
  }

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

    const createAndPush = service.isCloneMode()
      ? (name: string): Promise<void> => service.createAndPushBranch(baseBranch, name)
      : async (name: string): Promise<void> => {
          await gitService.createBranch(name, baseBranch);
          const createdAt = await gitService.getLocalBranchCommit(name);
          try {
            await gitService.pushBranch(name);
          } catch (error) {
            await this.rollbackUnpushedBranch(gitService, name, createdAt, error);
          }
        };

    const result = await service.runQueuedRepoOperation(async () => {
      const maxAttempts = 10;
      const { stem, suffix: startingSuffix } = splitBranchSuffix(branchName);
      let suffix = startingSuffix;
      let nextName = branchName;
      let attemptedName = branchName;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        attemptedName = nextName;
        try {
          await createAndPush(attemptedName);
          return { success: true, finalName: attemptedName };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (errorMessage.includes("already exists") && !(error instanceof UnpushedBranchLeftoverError)) {
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

  private async rollbackUnpushedBranch(
    gitService: GitService,
    branchName: string,
    createdAt: string | null,
    pushError: unknown,
  ): Promise<never> {
    const message = redactSecretsInText(getErrorMessage(pushError));
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
      leftover =
        ` The local branch '${branchName}' is still in the bare repository — removing it failed ` +
        `(${getErrorMessage(deleteError)}); delete it with ` +
        `\`git -C "${path.resolve(gitService.getBareRepoPath())}" branch -D ${branchName}\`.`;
    }

    const cause = pushError instanceof Error ? pushError : undefined;
    if (leftover) throw new UnpushedBranchLeftoverError(`${detail}.${leftover}`, cause);
    throw new GitOperationError("push", `${detail}.${leftover}`, cause);
  }

  public async getWorktreesForRepo(repoIndex: number): Promise<Array<{ path: string; branch: string }>> {
    return this.getWorktreesFromService(this.requireService(repoIndex));
  }

  public async getWorktreeStatusForRepo(repoIndex: number): Promise<WorktreeStatusEntry[]> {
    const service = this.requireService(repoIndex);
    const gitService = service.getGitService();
    const worktrees = await this.getWorktreesFromService(service);

    const limit = pLimit(
      Math.max(1, service.config.parallelism?.maxStatusChecks ?? DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS),
    );

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
    if (this.host.getServices()[repoIndex] === service) {
      this.host.onWorktreeStatus?.(repoIndex, entries);
    }
    return entries;
  }

  private async getWorktreesFromService(
    service: WorktreeSyncService,
  ): Promise<Array<{ path: string; branch: string }>> {
    return service.getWorktrees();
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
          const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})-(.+?)(?:(?:-[0-9a-f]{8})?-[0-9a-z]+)?$/);
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
    } catch {}
    await service.discardDivergedDirectory(targetPath, keepRef);
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
        await service.checkoutBranch(branchName);
        return;
      }
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

    if (!config.filesToCopyOnBranchCreate?.length || service.isCloneMode()) {
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

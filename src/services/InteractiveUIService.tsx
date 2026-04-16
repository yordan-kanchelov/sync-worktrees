import React from "react";
import * as path from "path";
import { render, Instance } from "ink";
import * as cron from "node-cron";
import pLimit from "p-limit";
import { spawn } from "child_process";
import App from "../components/App";
import { DEFAULT_CONFIG } from "../constants";
import { WorktreeSyncService } from "./worktree-sync.service";
import { ConfigLoaderService } from "./config-loader.service";
import { FileCopyService } from "./file-copy.service";
import { HookExecutionService } from "./hook-execution.service";
import { Logger, LogOutputFn, LogLevel } from "./logger.service";
import { calculateSyncDiskSpace } from "../utils/disk-space";
import { getDefaultBareRepoDir } from "../utils/git-url";
import { appEvents } from "../utils/app-events";
import * as fs from "fs/promises";
import { calculateDirectorySize, formatBytes } from "../utils/disk-space";
import { GIT_CONSTANTS, METADATA_CONSTANTS } from "../constants";
import type { RepositoryConfig, HookContext, WorktreeStatusEntry, DivergedDirectoryInfo } from "../types";

export interface ReloadOptions {
  filter?: string;
  noUpdateExisting?: boolean;
  debug?: boolean;
}

export class InteractiveUIService {
  private app: Instance | null = null;
  private syncServices: WorktreeSyncService[];
  private configPath?: string;
  private cronSchedule?: string;
  private cronJobs: cron.ScheduledTask[] = [];
  private repositoryCount: number;
  private logBuffer: Array<{ message: string; level: "info" | "warn" | "error" }> = [];
  private uiReady = false;
  private hookExecutionService = new HookExecutionService();
  private limit: ReturnType<typeof pLimit>;
  private reloadInProgress = false;
  private isDestroyed = false;
  private reloadOptions: ReloadOptions;

  constructor(
    syncServices: WorktreeSyncService[],
    configPath?: string,
    cronSchedule?: string,
    maxParallel?: number,
    reloadOptions?: ReloadOptions,
  ) {
    if (syncServices.length === 0) {
      throw new Error("InteractiveUIService requires at least one WorktreeSyncService");
    }

    this.syncServices = syncServices;
    this.configPath = configPath;
    this.cronSchedule = cronSchedule;
    this.repositoryCount = syncServices.length;
    this.limit = pLimit(maxParallel ?? DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES);
    this.reloadOptions = reloadOptions ?? {};

    this.startBufferFlushCheck();
    this.renderUI();
    this.injectLoggersIntoServices();

    // Add initial log after a short delay to verify the pipeline works
    setTimeout(() => {
      this.addLog("🚀 sync-worktrees UI initialized", "info");
    }, 100);
  }

  private startBufferFlushCheck(): void {
    const unsubscribe = appEvents.on("uiReady", () => {
      this.uiReady = true;
      this.flushLogBuffer();
      unsubscribe();
    });
  }

  private createOutputFn(): LogOutputFn {
    return (message: string, level: LogLevel) => {
      const uiLevel = level === "debug" ? "info" : level;
      this.addLog(message, uiLevel);
    };
  }

  private injectLoggersIntoServices(): void {
    const outputFn = this.createOutputFn();
    for (const service of this.syncServices) {
      const config = service.config as RepositoryConfig;
      service.updateLogger(
        new Logger({
          repoName: config.name,
          debug: config.debug,
          outputFn,
        }),
      );
    }
  }

  public addLog(message: string, level: "info" | "warn" | "error" = "info"): void {
    if (this.isDestroyed) return;
    if (this.uiReady) {
      appEvents.emit("addLog", { message, level });
    } else {
      this.logBuffer.push({ message, level });
    }
  }

  private flushLogBuffer(): void {
    for (const log of this.logBuffer) {
      appEvents.emit("addLog", { message: log.message, level: log.level });
    }
    this.logBuffer = [];
  }

  public setupCronJobs(): void {
    const scheduleGroups = new Map<string, WorktreeSyncService[]>();

    for (const service of this.syncServices) {
      if (service.config.runOnce) continue;
      const schedule = service.config.cronSchedule || this.cronSchedule;
      if (!schedule) continue;

      if (!scheduleGroups.has(schedule)) {
        scheduleGroups.set(schedule, []);
      }
      scheduleGroups.get(schedule)!.push(service);
    }

    for (const [schedule, services] of scheduleGroups) {
      const task = cron.schedule(schedule, async () => {
        this.setStatus("syncing");
        try {
          await Promise.allSettled(
            services.map((service) =>
              this.limit(async () => {
                if (!service.isInitialized()) {
                  await service.initialize();
                }
                await service.sync();
              }),
            ),
          );
        } finally {
          this.setStatus("idle");
          this.updateLastSyncTime();
          this.calculateAndUpdateDiskSpace().catch((err) => {
            this.addLog(`Failed to calculate disk space: ${err instanceof Error ? err.message : String(err)}`, "error");
          });
        }
      });
      this.cronJobs.push(task);
    }
  }

  private cancelCronJobs(): void {
    for (const job of this.cronJobs) {
      job.stop();
    }
    this.cronJobs = [];
  }

  private renderUI(): void {
    if (this.app) {
      this.app.unmount();
    }

    this.app = render(
      <App
        repositoryCount={this.repositoryCount}
        cronSchedule={this.cronSchedule}
        onManualSync={() => this.handleManualSync()}
        onReload={() => this.handleReload()}
        onQuit={() => this.handleQuit()}
        getRepositoryList={() => this.getRepositoryList()}
        getBranchesForRepo={(index: number) => this.getBranchesForRepo(index)}
        getDefaultBranchForRepo={(index: number) => this.getDefaultBranchForRepo(index)}
        fetchForRepo={(index: number) => this.fetchForRepo(index)}
        createAndPushBranch={(repoIndex: number, baseBranch: string, branchName: string) =>
          this.createAndPushBranch(repoIndex, baseBranch, branchName)
        }
        getWorktreesForRepo={(index: number) => this.getWorktreesForRepo(index)}
        getWorktreeStatusForRepo={(index: number) => this.getWorktreeStatusForRepo(index)}
        getDivergedDirectoriesForRepo={(index: number) => this.getDivergedDirectoriesForRepo(index)}
        deleteDivergedDirectory={(repoIndex: number, name: string) =>
          this.deleteDivergedDirectory(repoIndex, name)
        }
        openEditorInWorktree={(path: string) => this.openEditorInWorktree(path)}
        copyBranchFiles={(repoIndex: number, baseBranch: string, targetBranch: string) =>
          this.copyBranchFiles(repoIndex, baseBranch, targetBranch)
        }
        createWorktreeForBranch={(repoIndex: number, branchName: string) =>
          this.createWorktreeForBranch(repoIndex, branchName)
        }
        executeOnBranchCreatedHooks={(repoIndex: number, context: HookContext) =>
          this.executeOnBranchCreatedHooks(repoIndex, context)
        }
      />,
    );
  }

  private async handleManualSync(): Promise<void> {
    await this.triggerInitialSync();
  }

  public async triggerInitialSync(): Promise<void> {
    this.setStatus("syncing");

    try {
      await Promise.allSettled(
        this.syncServices.map((service) =>
          this.limit(async () => {
            if (!service.isInitialized()) {
              await service.initialize();
            }
            await service.sync();
          }),
        ),
      );

      this.updateLastSyncTime();
      await this.calculateAndUpdateDiskSpace();
    } catch (error) {
      this.addLog(`Sync failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      this.setStatus("idle");
    }
  }

  private async handleReload(): Promise<void> {
    if (this.reloadInProgress) {
      return;
    }
    this.reloadInProgress = true;
    try {
      if (!this.configPath) {
        this.setStatus("idle");
        return;
      }

      await this.waitForInProgressSyncs();

      this.addLog("Reloading configuration...");
      this.setStatus("syncing");

      // Validate and load new config BEFORE canceling old cron jobs
      // to prevent a window with no cron running on validation failure
      const configLoader = new ConfigLoaderService();
      const configFile = await configLoader.loadConfigFile(this.configPath);
      const configDir = path.dirname(path.resolve(this.configPath));

      let repositories = configFile.repositories.map((repo) =>
        configLoader.resolveRepositoryConfig(repo, configFile.defaults, configDir, configFile.retry),
      );

      if (this.reloadOptions.filter) {
        repositories = configLoader.filterRepositories(repositories, this.reloadOptions.filter);
      }

      if (this.reloadOptions.noUpdateExisting) {
        repositories = repositories.map((repo) => ({
          ...repo,
          updateExistingWorktrees: false,
        }));
      }

      if (this.reloadOptions.debug) {
        repositories = repositories.map((repo) => ({
          ...repo,
          debug: true,
        }));
      }

      const initResults = await Promise.allSettled(
        repositories.map((repoConfig) =>
          this.limit(async () => {
            const service = new WorktreeSyncService(repoConfig);
            await service.initialize();
            return service;
          }),
        ),
      );

      const newServices: WorktreeSyncService[] = [];
      for (const result of initResults) {
        if (result.status === "fulfilled") {
          newServices.push(result.value);
        } else {
          this.addLog(`Failed to initialize repository: ${result.reason}`, "error");
        }
      }

      if (newServices.length === 0) {
        throw new Error("No repositories could be initialized from the configuration");
      }

      // Cancel old cron jobs only after new config is validated and services initialized
      this.cancelCronJobs();

      this.syncServices = newServices;
      this.repositoryCount = this.syncServices.length;
      this.injectLoggersIntoServices();

      const uniqueSchedules = [...new Set(repositories.map((r) => r.cronSchedule))];
      this.cronSchedule = uniqueSchedules.length === 1 ? uniqueSchedules[0] : undefined;

      this.setupCronJobs();

      appEvents.emit("updateRepositoryCount", this.repositoryCount);
      appEvents.emit("updateCronSchedule", this.cronSchedule);

      const failures: Array<{ repo: string; error: string }> = [];

      const syncResults = await Promise.allSettled(
        this.syncServices.map((service) =>
          this.limit(async () => {
            await service.sync();
            return service;
          }).catch((error) => {
            const repoName = (service.config as RepositoryConfig).name || service.config.repoUrl;
            throw Object.assign(error instanceof Error ? error : new Error(String(error)), { repoName });
          }),
        ),
      );

      for (const result of syncResults) {
        if (result.status === "rejected") {
          const repoName = (result.reason as any)?.repoName ?? "unknown";
          const errorMessage = result.reason instanceof Error ? result.reason.message : String(result.reason);
          this.addLog(`Failed to sync repository '${repoName}': ${errorMessage}`, "error");
          failures.push({ repo: repoName, error: errorMessage });
        }
      }

      this.updateLastSyncTime();
      await this.calculateAndUpdateDiskSpace();
      this.setStatus("idle");

      if (failures.length > 0) {
        this.addLog(`Reload completed with ${failures.length} repository failure(s)`, "warn");
      }
    } catch (error) {
      this.addLog(`Reload failed: ${(error as Error).message}`, "error");
      this.setupCronJobs();
      this.setStatus("idle");
    } finally {
      this.reloadInProgress = false;
    }
  }

  private async handleQuit(): Promise<void> {
    await this.destroy();
    process.exit(0);
  }

  private async waitForInProgressSyncs(): Promise<void> {
    const inProgressServices = this.syncServices.filter((s) => s.isSyncInProgress());

    if (inProgressServices.length === 0) {
      return;
    }

    this.addLog(`Waiting for ${inProgressServices.length} in-progress sync(s) to finish...`, "info");

    const syncChecks = inProgressServices.map(async (service) => {
      const timeout = 30000;
      const checkInterval = 500;
      const startTime = Date.now();

      while (service.isSyncInProgress()) {
        if (Date.now() - startTime > timeout) {
          throw new Error("Timeout waiting for sync operations to complete");
        }
        await new Promise((resolve) => setTimeout(resolve, checkInterval));
      }
    });

    try {
      await Promise.all(syncChecks);
    } catch {
      this.addLog(
        "Warning: Timeout waiting for sync operations to complete after 30s. Proceeding with potential data loss risk.",
        "warn",
      );
    }
  }

  public updateLastSyncTime(): void {
    if (this.isDestroyed) return;
    appEvents.emit("updateLastSyncTime");
  }

  public setStatus(status: "idle" | "syncing"): void {
    if (this.isDestroyed) return;
    appEvents.emit("setStatus", status);
  }

  public setDiskSpace(diskSpace: string): void {
    if (this.isDestroyed) return;
    appEvents.emit("setDiskSpace", diskSpace);
  }

  public async calculateAndUpdateDiskSpace(): Promise<void> {
    try {
      const bareRepoDirs = this.syncServices.map(
        (service) => service.config.bareRepoDir || getDefaultBareRepoDir(service.config.repoUrl),
      );
      const worktreeDirs = this.syncServices.map((service) => service.config.worktreeDir);

      const diskSpace = await calculateSyncDiskSpace(bareRepoDirs, worktreeDirs);
      this.setDiskSpace(diskSpace);
    } catch (error) {
      this.addLog(`Failed to calculate disk space: ${error instanceof Error ? error.message : String(error)}`, "error");
      this.setDiskSpace("N/A");
    }
  }

  public getRepositoryList(): Array<{ index: number; name: string; repoUrl: string }> {
    return this.syncServices.map((service, index) => ({
      index,
      name: (service.config as RepositoryConfig).name || `repo-${index}`,
      repoUrl: service.config.repoUrl,
    }));
  }

  public async getBranchesForRepo(repoIndex: number): Promise<string[]> {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      throw new Error(`Invalid repository index: ${repoIndex}`);
    }

    const service = this.syncServices[repoIndex];
    if (!service.isInitialized()) {
      return [];
    }
    const gitService = service.getGitService();
    return gitService.getRemoteBranches();
  }

  public getDefaultBranchForRepo(repoIndex: number): string {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      throw new Error(`Invalid repository index: ${repoIndex}`);
    }

    const service = this.syncServices[repoIndex];
    const gitService = service.getGitService();
    return gitService.getDefaultBranch();
  }

  public async fetchForRepo(repoIndex: number): Promise<void> {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      throw new Error(`Invalid repository index: ${repoIndex}`);
    }

    const service = this.syncServices[repoIndex];
    if (!service.isInitialized()) {
      await service.initialize();
    }
    const gitService = service.getGitService();
    await gitService.fetchAll();
  }

  public async createAndPushBranch(
    repoIndex: number,
    baseBranch: string,
    branchName: string,
  ): Promise<{ success: boolean; finalName: string; error?: string }> {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      return { success: false, finalName: branchName, error: `Invalid repository index: ${repoIndex}` };
    }

    const service = this.syncServices[repoIndex];
    const gitService = service.getGitService();

    const maxAttempts = 10;
    let finalName = branchName;
    let suffix = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await gitService.createBranch(finalName, baseBranch);
        await gitService.pushBranch(finalName);
        return { success: true, finalName };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes("already exists")) {
          suffix++;
          finalName = `${branchName}-${suffix}`;
          continue;
        }
        return { success: false, finalName: branchName, error: errorMessage };
      }
    }

    return { success: false, finalName: branchName, error: `Failed to create branch after ${maxAttempts} attempts` };
  }

  public async getWorktreesForRepo(repoIndex: number): Promise<Array<{ path: string; branch: string }>> {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      throw new Error(`Invalid repository index: ${repoIndex}`);
    }

    const service = this.syncServices[repoIndex];
    const gitService = service.getGitService();
    return gitService.getWorktrees();
  }

  public async getWorktreeStatusForRepo(repoIndex: number): Promise<WorktreeStatusEntry[]> {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      throw new Error(`Invalid repository index: ${repoIndex}`);
    }

    const service = this.syncServices[repoIndex];
    const gitService = service.getGitService();
    const worktrees = await gitService.getWorktrees();

    const results = await Promise.allSettled(
      worktrees.map(async (wt) => {
        const status = await gitService.getFullWorktreeStatus(wt.path, true);
        return { branch: wt.branch, path: wt.path, status };
      }),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<WorktreeStatusEntry> => r.status === "fulfilled")
      .map((r) => r.value);
  }

  public async getDivergedDirectoriesForRepo(repoIndex: number): Promise<DivergedDirectoryInfo[]> {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      return [];
    }

    const service = this.syncServices[repoIndex];
    const worktreeDir = service.config.worktreeDir;
    const divergedDir = path.join(worktreeDir, GIT_CONSTANTS.DIVERGED_DIR_NAME);

    let dirEntries: import("fs").Dirent[];
    try {
      dirEntries = await fs.readdir(divergedDir, { withFileTypes: true, encoding: "utf-8" });
    } catch {
      return [];
    }

    const subdirs = dirEntries.filter((e) => e.isDirectory());

    const results = await Promise.allSettled(
      subdirs.map(async (entry) => {
        const fullPath = path.join(divergedDir, entry.name);
        const infoFilePath = path.join(fullPath, METADATA_CONSTANTS.DIVERGED_INFO_FILE);

        let originalBranch = entry.name;
        let divergedAt = "";

        try {
          const infoContent = await fs.readFile(infoFilePath, "utf-8");
          const info = JSON.parse(infoContent);
          if (info.originalBranch) originalBranch = info.originalBranch;
          if (info.divergedAt) divergedAt = info.divergedAt;
        } catch {
          // Extract date and branch from directory name pattern: YYYY-MM-DD-branch-suffix
          const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})-(.+?)(?:-[a-f0-9]+)?$/);
          if (match) {
            divergedAt = match[1];
            originalBranch = match[2];
          }
        }

        const sizeBytes = await calculateDirectorySize(fullPath);
        const sizeFormatted = formatBytes(sizeBytes);

        return {
          name: entry.name,
          path: fullPath,
          originalBranch,
          divergedAt,
          sizeBytes,
          sizeFormatted,
        };
      }),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<DivergedDirectoryInfo> => r.status === "fulfilled")
      .map((r) => r.value)
      .sort((a, b) => b.divergedAt.localeCompare(a.divergedAt));
  }

  public async deleteDivergedDirectory(repoIndex: number, name: string): Promise<void> {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      throw new Error(`Invalid repository index: ${repoIndex}`);
    }

    const service = this.syncServices[repoIndex];
    const worktreeDir = service.config.worktreeDir;
    const targetPath = path.join(worktreeDir, GIT_CONSTANTS.DIVERGED_DIR_NAME, name);

    await fs.rm(targetPath, { recursive: true, force: true });
    this.addLog(`🗑️ Deleted diverged directory: ${name}`, "info");
  }

  public async createWorktreeForBranch(repoIndex: number, branchName: string): Promise<void> {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      throw new Error(`Invalid repository index: ${repoIndex}`);
    }

    const service = this.syncServices[repoIndex];
    const gitService = service.getGitService();
    const worktreeDir = service.config.worktreeDir;
    const worktreePath = path.join(worktreeDir, branchName);

    await gitService.addWorktree(branchName, worktreePath);
  }

  public openEditorInWorktree(worktreePath: string): { success: boolean; error?: string } {
    const editor = process.env.EDITOR || process.env.VISUAL || "code";

    try {
      const child = spawn(editor, [worktreePath], {
        detached: true,
        stdio: "ignore",
      });

      child.on("error", (err) => {
        this.addLog(`Failed to open editor '${editor}': ${err.message}`, "error");
        this.addLog("Set EDITOR or VISUAL environment variable to your preferred editor", "warn");
      });

      child.unref();

      // Return success optimistically - spawn errors are async and will be logged
      // to the UI when they occur. For detached processes, we can't reliably
      // catch spawn errors synchronously.
      return { success: true };
    } catch (err) {
      // This catches synchronous errors like ENOENT when the command doesn't exist
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.addLog(`Failed to open editor '${editor}': ${errorMessage}`, "error");
      return { success: false, error: errorMessage };
    }
  }

  public executeOnBranchCreatedHooks(repoIndex: number, context: HookContext): void {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      return;
    }

    const service = this.syncServices[repoIndex];
    const config = service.config;

    if (!config.hooks?.onBranchCreated?.length) {
      return;
    }

    this.addLog(`Running ${config.hooks.onBranchCreated.length} hook(s) for branch '${context.branchName}'...`, "info");

    this.hookExecutionService.executeOnBranchCreated(config.hooks, context, {
      onStdout: (data) => {
        this.addLog(`[hook] ${data}`, "info");
      },
      onStderr: (data) => {
        this.addLog(`[hook] ${data}`, "warn");
      },
      onError: (command, error) => {
        this.addLog(`[hook] Failed to execute '${command}': ${error.message}`, "error");
      },
      onComplete: (command, exitCode) => {
        if (exitCode === 0) {
          this.addLog(`[hook] Command completed successfully`, "info");
        } else if (exitCode !== null) {
          this.addLog(`[hook] Command exited with code ${exitCode}`, "warn");
        }
      },
    });
  }

  public async copyBranchFiles(repoIndex: number, baseBranch: string, targetBranch: string): Promise<void> {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      return;
    }

    const service = this.syncServices[repoIndex];
    const config = service.config;

    if (!config.filesToCopyOnBranchCreate?.length) {
      return;
    }

    const gitService = service.getGitService();
    const worktrees = await gitService.getWorktrees();

    const sourceWorktree = worktrees.find((w) => w.branch === baseBranch);
    const targetWorktree = worktrees.find((w) => w.branch === targetBranch);

    if (!sourceWorktree || !targetWorktree) {
      this.addLog(`Could not find worktrees for file copy: source=${baseBranch}, target=${targetBranch}`, "warn");
      return;
    }

    const fileCopyService = new FileCopyService();

    try {
      const result = await fileCopyService.copyFiles(
        sourceWorktree.path,
        targetWorktree.path,
        config.filesToCopyOnBranchCreate,
      );

      if (result.copied.length > 0) {
        this.addLog(`📋 Copied ${result.copied.length} file(s) to new branch: ${result.copied.join(", ")}`, "info");
      }
      if (result.errors.length > 0) {
        this.addLog(`⚠️ Failed to copy ${result.errors.length} file(s):`, "warn");
        for (const err of result.errors) {
          this.addLog(`  - ${err.file}: ${err.error}`, "warn");
        }
      }
    } catch (error) {
      this.addLog(`Failed to copy files to new branch: ${error}`, "error");
    }
  }

  public async destroy(): Promise<void> {
    this.isDestroyed = true;
    this.cancelCronJobs();

    // Wait for in-flight sync operations before tearing down
    try {
      await this.waitForInProgressSyncs();
    } catch {
      // Best effort - proceed with teardown even if syncs don't finish
    }

    this.hookExecutionService.cleanup();
    if (this.app) {
      this.app.unmount();
      this.app = null;
    }
    appEvents.removeAllListeners();
    this.uiReady = false;
    this.logBuffer = [];
  }
}

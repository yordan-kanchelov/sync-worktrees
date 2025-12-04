import React from "react";
import * as path from "path";
import { render, Instance } from "ink";
import * as cron from "node-cron";
import { spawn } from "child_process";
import App from "../components/App";
import { WorktreeSyncService } from "./worktree-sync.service";
import { ConfigLoaderService } from "./config-loader.service";
import { FileCopyService } from "./file-copy.service";
import { Logger, LogOutputFn, LogLevel } from "./logger.service";
import { calculateSyncDiskSpace } from "../utils/disk-space";
import { getDefaultBareRepoDir } from "../utils/git-url";
import { appEvents } from "../utils/app-events";
import type { RepositoryConfig } from "../types";

export class InteractiveUIService {
  private app: Instance | null = null;
  private syncServices: WorktreeSyncService[];
  private configPath?: string;
  private cronSchedule?: string;
  private cronJobs: cron.ScheduledTask[] = [];
  private repositoryCount: number;
  private logBuffer: Array<{ message: string; level: "info" | "warn" | "error" }> = [];
  private uiReady = false;
  private bufferFlushInterval: ReturnType<typeof setInterval> | null = null;

  constructor(syncServices: WorktreeSyncService[], configPath?: string, cronSchedule?: string) {
    if (syncServices.length === 0) {
      throw new Error("InteractiveUIService requires at least one WorktreeSyncService");
    }

    this.syncServices = syncServices;
    this.configPath = configPath;
    this.cronSchedule = cronSchedule;
    this.repositoryCount = syncServices.length;

    this.setupCronJobs();
    this.renderUI();
    this.startBufferFlushCheck();
    this.injectLoggersIntoServices();

    // Add initial log after a short delay to verify the pipeline works
    setTimeout(() => {
      this.addLog("🚀 sync-worktrees UI initialized", "info");
    }, 100);
  }

  private startBufferFlushCheck(): void {
    this.bufferFlushInterval = setInterval(() => {
      if (!this.uiReady && this.logBuffer.length > 0) {
        // Give the UI a moment to mount and subscribe to events
        this.uiReady = true;
        this.flushLogBuffer();
        if (this.bufferFlushInterval) {
          clearInterval(this.bufferFlushInterval);
          this.bufferFlushInterval = null;
        }
      }
    }, 50);
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

  private setupCronJobs(): void {
    if (!this.cronSchedule) {
      return;
    }

    for (const service of this.syncServices) {
      if (service.config.runOnce) {
        continue;
      }

      const schedule = service.config.cronSchedule || this.cronSchedule;
      const task = cron.schedule(schedule, async () => {
        this.setStatus("syncing");
        try {
          await service.sync();
        } catch (error) {
          console.error(`Error syncing: ${(error as Error).message}`);
        } finally {
          this.setStatus("idle");
        }
        this.updateLastSyncTime();
        await this.calculateAndUpdateDiskSpace();
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
        createAndPushBranch={(repoIndex: number, baseBranch: string, branchName: string) =>
          this.createAndPushBranch(repoIndex, baseBranch, branchName)
        }
        getWorktreesForRepo={(index: number) => this.getWorktreesForRepo(index)}
        openEditorInWorktree={(path: string) => this.openEditorInWorktree(path)}
        copyBranchFiles={(repoIndex: number, baseBranch: string, targetBranch: string) =>
          this.copyBranchFiles(repoIndex, baseBranch, targetBranch)
        }
        createWorktreeForBranch={(repoIndex: number, branchName: string) =>
          this.createWorktreeForBranch(repoIndex, branchName)
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
      for (const service of this.syncServices) {
        await service.sync();
      }

      this.updateLastSyncTime();
      await this.calculateAndUpdateDiskSpace();
    } catch (error) {
      console.error("Sync failed:", error);
    } finally {
      this.setStatus("idle");
    }
  }

  private async handleReload(): Promise<void> {
    try {
      if (!this.configPath) {
        this.setStatus("idle");
        return;
      }

      await this.waitForInProgressSyncs();

      this.cancelCronJobs();

      console.log("Reloading configuration...");
      this.setStatus("syncing");

      const configLoader = new ConfigLoaderService();
      const configFile = await configLoader.loadConfigFile(this.configPath);

      const newServices: WorktreeSyncService[] = [];
      for (const repoConfig of configFile.repositories) {
        try {
          const service = new WorktreeSyncService(repoConfig);
          await service.initialize();
          newServices.push(service);
        } catch (error) {
          console.error(`Failed to initialize repository ${repoConfig.name}: ${(error as Error).message}`);
        }
      }

      if (newServices.length === 0) {
        throw new Error("No repositories could be initialized from the configuration");
      }

      this.syncServices = newServices;
      this.repositoryCount = this.syncServices.length;

      this.setupCronJobs();

      const failures: Array<{ repo: string; error: string }> = [];

      for (const service of this.syncServices) {
        try {
          await service.sync();
        } catch (error) {
          const repoName = (service.config as RepositoryConfig).name || service.config.repoUrl;
          const errorMessage = (error as Error).message;
          console.error(`Failed to sync repository ${repoName}: ${errorMessage}`);
          failures.push({ repo: repoName, error: errorMessage });
        }
      }

      this.renderUI();
      this.updateLastSyncTime();
      await this.calculateAndUpdateDiskSpace();
      this.setStatus("idle");

      if (failures.length > 0) {
        console.warn(`Reload completed with ${failures.length} repository failure(s)`);
      }
    } catch (error) {
      console.error(`Reload failed: ${(error as Error).message}`);
      this.setupCronJobs();
      this.setStatus("idle");
    }
  }

  private async handleQuit(): Promise<void> {
    await this.waitForInProgressSyncs();

    this.destroy();
    process.exit(0);
  }

  private async waitForInProgressSyncs(): Promise<void> {
    const inProgressServices = this.syncServices.filter((s) => s.isSyncInProgress());

    if (inProgressServices.length === 0) {
      return;
    }

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
    } catch (error) {
      // Silently handle timeout
    }
  }

  public updateLastSyncTime(): void {
    appEvents.emit("updateLastSyncTime");
  }

  public setStatus(status: "idle" | "syncing"): void {
    appEvents.emit("setStatus", status);
  }

  public setDiskSpace(diskSpace: string): void {
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
      console.error("Failed to calculate disk space:", error);
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

    try {
      let finalName = branchName;
      let suffix = 0;

      while (true) {
        const exists = await gitService.branchExists(finalName);
        if (!exists.local && !exists.remote) {
          break;
        }
        suffix++;
        finalName = `${branchName}-${suffix}`;
      }

      await gitService.createBranch(finalName, baseBranch);
      await gitService.pushBranch(finalName);

      return { success: true, finalName };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, finalName: branchName, error: errorMessage };
    }
  }

  public async getWorktreesForRepo(repoIndex: number): Promise<Array<{ path: string; branch: string }>> {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      throw new Error(`Invalid repository index: ${repoIndex}`);
    }

    const service = this.syncServices[repoIndex];
    const gitService = service.getGitService();
    return gitService.getWorktrees();
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
      console.warn(`Could not find worktrees for file copy: source=${baseBranch}, target=${targetBranch}`);
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
        console.log(`📋 Copied ${result.copied.length} file(s) to new branch: ${result.copied.join(", ")}`);
      }
      if (result.errors.length > 0) {
        console.warn(`⚠️ Failed to copy ${result.errors.length} file(s):`);
        for (const err of result.errors) {
          console.warn(`  - ${err.file}: ${err.error}`);
        }
      }
    } catch (error) {
      console.error(`Failed to copy files to new branch: ${error}`);
    }
  }

  public destroy(): void {
    if (this.bufferFlushInterval) {
      clearInterval(this.bufferFlushInterval);
      this.bufferFlushInterval = null;
    }
    this.cancelCronJobs();
    if (this.app) {
      this.app.unmount();
      this.app = null;
    }
    appEvents.removeAllListeners();
    this.uiReady = false;
    this.logBuffer = [];
  }
}

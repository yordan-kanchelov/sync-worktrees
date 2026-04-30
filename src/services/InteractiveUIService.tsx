import React from "react";
import * as path from "path";
import { render, Instance } from "ink";
import * as cron from "node-cron";
import pLimit from "p-limit";
import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import App from "../components/App";
import { DEFAULT_CONFIG } from "../constants";
import { WorktreeSyncService } from "./worktree-sync.service";
import { ConfigLoaderService } from "./config-loader.service";
import { FileCopyService } from "./file-copy.service";
import { HookExecutionService } from "./hook-execution.service";
import { PathResolutionService } from "./path-resolution.service";
import { Logger, LogOutputFn, LogLevel } from "./logger.service";
import { calculateSyncDiskSpace } from "../utils/disk-space";
import { getDefaultBareRepoDir } from "../utils/git-url";
import { AppEventEmitter } from "../utils/app-events";
import { shellEscape } from "../utils/shell-escape";
import * as fs from "fs/promises";
import { calculateDirectorySize, formatBytes } from "../utils/disk-space";
import { formatDuration } from "../utils/timing";
import { GIT_CONSTANTS, METADATA_CONSTANTS, TERMINAL_CONSTANTS } from "../constants";
import type { RepositoryConfig, HookContext, WorktreeStatusEntry, DivergedDirectoryInfo } from "../types";

const WAIT_SYNC_FAST_TIMEOUT_MS = 2000;
const WAIT_SYNC_DEFAULT_TIMEOUT_MS = 30000;

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
  private pathResolution = new PathResolutionService();
  private limit: ReturnType<typeof pLimit>;
  private reloadInProgress = false;
  private isDestroyed = false;
  private reloadOptions: ReloadOptions;
  private events: AppEventEmitter;
  private ownsEvents: boolean;
  private unsubscribeCallbacks: Array<() => void> = [];

  constructor(
    syncServices: WorktreeSyncService[],
    configPath?: string,
    cronSchedule?: string,
    maxParallel?: number,
    reloadOptions?: ReloadOptions,
    events?: AppEventEmitter,
  ) {
    this.ownsEvents = events === undefined;
    this.events = events ?? new AppEventEmitter();
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

  public getEvents(): AppEventEmitter {
    return this.events;
  }

  private startBufferFlushCheck(): void {
    const unsubscribe = this.events.on("uiReady", () => {
      this.uiReady = true;
      this.flushLogBuffer();
      unsubscribe();
      const index = this.unsubscribeCallbacks.indexOf(unsubscribe);
      if (index !== -1) this.unsubscribeCallbacks.splice(index, 1);
    });
    this.unsubscribeCallbacks.push(unsubscribe);
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
      this.events.emit("addLog", { message, level });
    } else {
      this.logBuffer.push({ message, level });
    }
  }

  private flushLogBuffer(): void {
    for (const log of this.logBuffer) {
      this.events.emit("addLog", { message: log.message, level: log.level });
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
        await this.runSyncCycle(services, { logErrors: false });
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

  public registerCronJob(job: cron.ScheduledTask): void {
    this.cronJobs.push(job);
  }

  private renderUI(): void {
    if (this.app) {
      this.app.unmount();
    }

    this.app = render(
      <App
        events={this.events}
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
        openTerminalInWorktree={(repoIndex: number, path: string, branchName: string) =>
          this.openTerminalInWorktree(repoIndex, path, branchName)
        }
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
    await this.runSyncCycle(this.syncServices, { logErrors: true });
  }

  private async handleReload(): Promise<void> {
    if (this.reloadInProgress) {
      return;
    }
    this.reloadInProgress = true;
    let cronJobsCancelled = false;
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
      const { repositories } = await configLoader.buildRepositories(this.configPath, {
        filter: this.reloadOptions.filter,
        noUpdateExisting: this.reloadOptions.noUpdateExisting,
        debug: this.reloadOptions.debug,
      });

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
      cronJobsCancelled = true;

      this.syncServices = newServices;
      this.repositoryCount = this.syncServices.length;
      this.injectLoggersIntoServices();

      const uniqueSchedules = [...new Set(this.syncServices.map((s) => s.config.cronSchedule))];
      this.cronSchedule = uniqueSchedules.length === 1 ? uniqueSchedules[0] : undefined;

      this.setupCronJobs();

      this.events.emit("updateRepositoryCount", this.repositoryCount);
      this.events.emit("updateCronSchedule", this.cronSchedule);

      const { failures, skipped, attempted } = await this.runSyncServices(this.syncServices);
      await this.recordSyncOutcome({ failures, skipped, attempted });
      this.setStatus("idle");

      for (const skip of skipped) {
        this.addLog(`Sync skipped for '${skip.repo}': ${skip.reason}`, "warn");
      }
      if (failures.length > 0) {
        for (const failure of failures) {
          this.addLog(`Failed to sync repository '${failure.repo}': ${failure.error}`, "error");
        }
        this.addLog(`Reload completed with ${failures.length} repository failure(s)`, "warn");
      }
    } catch (error) {
      this.addLog(`Reload failed: ${(error as Error).message}`, "error");
      if (cronJobsCancelled) {
        this.setupCronJobs();
      }
      this.setStatus("idle");
    } finally {
      this.reloadInProgress = false;
    }
  }

  private async handleQuit(): Promise<void> {
    await this.destroy();
    process.exit(0);
  }

  private async waitForInProgressSyncs(timeoutMs: number = WAIT_SYNC_DEFAULT_TIMEOUT_MS): Promise<void> {
    const inProgressServices = this.syncServices.filter((s) => s.isSyncInProgress());

    if (inProgressServices.length === 0) {
      return;
    }

    this.addLog(`Waiting for ${inProgressServices.length} in-progress sync(s) to finish...`, "info");

    const syncChecks = inProgressServices.map(async (service) => {
      const checkInterval = 500;
      const startTime = Date.now();

      while (service.isSyncInProgress()) {
        if (Date.now() - startTime > timeoutMs) {
          throw new Error("Timeout waiting for sync operations to complete");
        }
        await new Promise((resolve) => setTimeout(resolve, checkInterval));
      }
    });

    try {
      await Promise.all(syncChecks);
    } catch {
      this.addLog(
        `Warning: Timeout waiting for sync operations to complete after ${formatDuration(timeoutMs)}. Proceeding with potential data loss risk.`,
        "warn",
      );
    }
  }

  public updateLastSyncTime(): void {
    if (this.isDestroyed) return;
    this.events.emit("updateLastSyncTime");
  }

  public setStatus(status: "idle" | "syncing"): void {
    if (this.isDestroyed) return;
    this.events.emit("setStatus", status);
  }

  public setDiskSpace(diskSpace: string): void {
    if (this.isDestroyed) return;
    this.events.emit("setDiskSpace", diskSpace);
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
      name: this.getRepoName(index),
      repoUrl: service.config.repoUrl,
    }));
  }

  private getRepoName(index: number): string {
    const service = this.syncServices[index];
    return (service.config as RepositoryConfig).name || `repo-${index}`;
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
          if (typeof info.originalBranch === "string") originalBranch = info.originalBranch;
          if (typeof info.divergedAt === "string") divergedAt = info.divergedAt;
        } catch {
          // Extract date and branch from directory name pattern: YYYY-MM-DD-branch-suffix
          const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})-(.+?)(?:-[a-f0-9]+)?$/);
          if (match) {
            divergedAt = match[1];
            originalBranch = match[2];
          }
        }

        const sizeBytes = await calculateDirectorySize(fullPath).catch(() => 0);
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
    const divergedBase = path.resolve(worktreeDir, GIT_CONSTANTS.DIVERGED_DIR_NAME);

    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw new Error(`Invalid diverged directory name: "${name}"`);
    }

    const targetPath = path.join(divergedBase, name);

    if (!this.pathResolution.isPathInsideBaseDir(targetPath, divergedBase)) {
      throw new Error(`Path traversal rejected: "${name}" resolves outside the diverged directory`);
    }

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
    const worktreePath = this.pathResolution.getBranchWorktreePath(worktreeDir, branchName);

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

  public openTerminalInWorktree(
    repoIndex: number,
    worktreePath: string,
    branchName: string,
  ): { success: boolean; error?: string } {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      const message = `Invalid repository index: ${repoIndex}`;
      this.addLog(message, "error");
      return { success: false, error: message };
    }
    const repoName = this.getRepoName(repoIndex);
    const sanitizedBranch = this.pathResolution.sanitizeBranchName(branchName);
    const sessionName = `${repoName}-${sanitizedBranch}`;
    const tmuxCommand = `tmux new-session -A -s ${shellEscape(sessionName)} -c ${shellEscape(worktreePath)}`;

    const launcher = this.resolveTerminalLauncher(tmuxCommand);
    if (!launcher) {
      const message =
        "No terminal launcher found. Set SYNC_WORKTREES_TERMINAL or $TERMINAL to a terminal emulator command.";
      this.addLog(message, "error");
      return { success: false, error: message };
    }

    try {
      const child = spawn(launcher.command, launcher.args, {
        detached: true,
        stdio: "ignore",
      });

      child.on("error", (err) => {
        this.addLog(`Failed to open terminal '${launcher.command}': ${err.message}`, "error");
        this.addLog("Set SYNC_WORKTREES_TERMINAL to your preferred terminal command", "warn");
      });

      child.unref();

      return { success: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.addLog(`Failed to open terminal '${launcher.command}': ${errorMessage}`, "error");
      return { success: false, error: errorMessage };
    }
  }

  private resolveTerminalLauncher(tmuxCommand: string): { command: string; args: string[] } | null {
    const override = this.parseCommandString(process.env[TERMINAL_CONSTANTS.ENV_OVERRIDE]);
    if (override) {
      // Wrap the tmux command in `sh -c` so terminal emulators that exec their trailing
      // arg as a program name (e.g. `alacritty -e`, `kitty -e`) can run the composite command.
      return { command: override.command, args: [...override.args, "sh", "-c", tmuxCommand] };
    }

    switch (process.platform) {
      case "darwin": {
        // Ghostty cannot be launched directly from the CLI on macOS; use `open -na` instead.
        const ghosttyPaths = ["/Applications/Ghostty.app", `${process.env.HOME}/Applications/Ghostty.app`];
        if (ghosttyPaths.some((p) => existsSync(p))) {
          return {
            command: "open",
            args: ["-na", "Ghostty.app", "--args", "-e", "sh", "-c", tmuxCommand],
          };
        }
        const escapedTmuxCommand = tmuxCommand.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const script = `tell application "Terminal" to do script "${escapedTmuxCommand}"`;
        return { command: "osascript", args: ["-e", script] };
      }
      case "linux": {
        const envTerminal = this.parseCommandString(process.env[TERMINAL_CONSTANTS.ENV_FALLBACK]);
        if (envTerminal) {
          return { command: envTerminal.command, args: [...envTerminal.args, "-e", "sh", "-c", tmuxCommand] };
        }
        for (const candidate of TERMINAL_CONSTANTS.LINUX_CANDIDATES) {
          if (this.commandExists(candidate)) {
            if (candidate === "gnome-terminal") {
              return { command: candidate, args: ["--", "sh", "-c", tmuxCommand] };
            }
            return { command: candidate, args: ["-e", "sh", "-c", tmuxCommand] };
          }
        }
        return null;
      }
      default:
        return null;
    }
  }

  private parseCommandString(raw: string | undefined): { command: string; args: string[] } | null {
    if (!raw || raw.trim().length === 0) return null;
    const parts = raw.trim().split(/\s+/);
    return { command: parts[0], args: parts.slice(1) };
  }

  private commandExists(command: string): boolean {
    try {
      const result = spawnSync("which", [command], { stdio: "ignore" });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  private async runSyncCycle(
    services: WorktreeSyncService[],
    options: { logErrors: boolean },
  ): Promise<Array<{ repo: string; error: string }>> {
    this.setStatus("syncing");

    try {
      const { failures, skipped, attempted } = await this.runSyncServices(services);

      if (options.logErrors) {
        for (const failure of failures) {
          this.addLog(`Failed to sync repository '${failure.repo}': ${failure.error}`, "error");
        }
      }
      for (const skip of skipped) {
        this.addLog(`Sync skipped for '${skip.repo}': ${skip.reason}`, "warn");
      }

      await this.recordSyncOutcome({ failures, skipped, attempted });
      return failures;
    } finally {
      this.setStatus("idle");
    }
  }

  private async recordSyncOutcome(outcome: {
    failures: Array<{ repo: string; error: string }>;
    skipped: Array<{ repo: string; reason: string }>;
    attempted: number;
  }): Promise<void> {
    const allSkipped =
      outcome.attempted > 0 &&
      outcome.skipped.length === outcome.attempted &&
      outcome.failures.length === 0;
    if (allSkipped) return;
    this.updateLastSyncTime();
    await this.calculateAndUpdateDiskSpace();
  }

  private async runSyncServices(services: WorktreeSyncService[]): Promise<{
    failures: Array<{ repo: string; error: string }>;
    skipped: Array<{ repo: string; reason: string }>;
    attempted: number;
  }> {
    const syncResults = await Promise.allSettled(
      services.map((service) =>
        this.limit(async () => {
          if (!service.isInitialized()) {
            await service.initialize();
          }
          const result = await service.sync();
          return { service, result };
        }).catch((error) => {
          const repoName = (service.config as RepositoryConfig).name || service.config.repoUrl;
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { repoName });
        }),
      ),
    );

    const failures: Array<{ repo: string; error: string }> = [];
    const skipped: Array<{ repo: string; reason: string }> = [];
    for (let i = 0; i < syncResults.length; i++) {
      const result = syncResults[i];
      if (result.status === "rejected") {
        const repoName = (result.reason as { repoName?: string })?.repoName ?? "unknown";
        const errorMessage = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failures.push({ repo: repoName, error: errorMessage });
      } else if (result.value.result && result.value.result.started === false) {
        const repoName =
          (services[i].config as RepositoryConfig).name || services[i].config.repoUrl;
        skipped.push({ repo: repoName, reason: `sync skipped: ${result.value.result.reason}` });
      }
    }

    return { failures, skipped, attempted: services.length };
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

  public async destroy(fast = false): Promise<void> {
    this.isDestroyed = true;
    this.cancelCronJobs();

    try {
      await this.waitForInProgressSyncs(fast ? WAIT_SYNC_FAST_TIMEOUT_MS : WAIT_SYNC_DEFAULT_TIMEOUT_MS);
    } catch {
      // Best effort - proceed with teardown even if syncs don't finish
    }

    this.hookExecutionService.cleanup();
    if (this.app) {
      this.app.unmount();
      this.app = null;
    }
    for (const unsubscribe of this.unsubscribeCallbacks) {
      unsubscribe();
    }
    this.unsubscribeCallbacks = [];
    if (this.ownsEvents) {
      this.events.removeAllListeners();
    }
    this.uiReady = false;
    this.logBuffer = [];
  }
}

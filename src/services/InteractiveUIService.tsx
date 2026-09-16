import React from "react";
import * as path from "path";
import type { Instance } from "ink";
import { render } from "ink";
import * as cron from "node-cron";
import pLimit from "p-limit";
import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import type { Dirent } from "fs";
import App from "../components/App";
import { DEFAULT_CONFIG } from "../constants";
import { WorktreeSyncService } from "./worktree-sync.service";
import { ConfigLoaderService } from "./config-loader.service";
import { BranchCreatedActionsService } from "./branch-created-actions.service";
import { HookExecutionService } from "./hook-execution.service";
import { PathResolutionService } from "./path-resolution.service";
import type { LogOutputFn, LogLevel } from "./logger.service";
import { Logger } from "./logger.service";
import { formatCloneSkipReason } from "../utils/clone-skip-format";
import { getErrorMessage } from "../utils/lfs-error";
import { formatRepoLockUnavailable } from "../utils/repo-lock-format";
import { calculateSyncDiskSpace } from "../utils/disk-space";
import { getDefaultBareRepoDir } from "../utils/git-url";
import { AppEventEmitter } from "../utils/app-events";
import { createMouseTracking } from "../utils/mouse";
import type { MouseTracking } from "../utils/mouse";
import { resolveMode } from "../utils/repo-mode";
import { shellEscape } from "../utils/shell-escape";
import * as fs from "fs/promises";
import { calculateDirectorySize, formatBytes } from "../utils/disk-space";
import { formatDuration } from "../utils/timing";
import { GIT_CONSTANTS, METADATA_CONSTANTS, TERMINAL_CONSTANTS } from "../constants";
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

const WAIT_SYNC_FAST_TIMEOUT_MS = 2000;
const WAIT_SYNC_DEFAULT_TIMEOUT_MS = 30000;
const FORCE_QUIT_GUARD_MS = 500;

export interface InteractiveUIRuntime {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  exit: (code: number) => void;
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
  private branchCreatedActions = new BranchCreatedActionsService();
  private pathResolution = new PathResolutionService();
  private limit: ReturnType<typeof pLimit>;
  private maxProgressLines: number;
  private reloadInProgress = false;
  private syncCycleInFlight = false;
  private isDestroyed = false;
  private events: AppEventEmitter;
  private ownsEvents: boolean;
  private unsubscribeCallbacks: Array<() => void> = [];
  private progressUnsubscribers: Array<() => void> = [];
  private readonly stdout: NodeJS.WriteStream;
  private readonly stdin: NodeJS.ReadStream;
  private readonly exitProcess: (code: number) => void;
  private readonly mouse: MouseTracking;
  private inkExited = false;
  private shutdown: Promise<void> | null = null;
  private shutdownStartedAt = 0;
  private releaseForceQuit: (() => void) | null = null;

  constructor(
    syncServices: WorktreeSyncService[],
    configPath?: string,
    cronSchedule?: string,
    maxParallel?: number,
    events?: AppEventEmitter,
    runtime: Partial<InteractiveUIRuntime> = {},
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
    this.maxProgressLines = Math.max(1, maxParallel ?? DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES);
    this.limit = pLimit(this.maxProgressLines);
    this.stdout = runtime.stdout ?? process.stdout;
    this.stdin = runtime.stdin ?? process.stdin;
    this.exitProcess = runtime.exit ?? ((code: number): void => process.exit(code));
    this.mouse = createMouseTracking(this.stdout);

    this.startBufferFlushCheck();
    this.renderUI();
    this.subscribeToServiceProgress();
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

  // The logger a service the UI owns must be built with: while Ink holds the
  // alternate screen a console line is written over the interface instead of
  // into the log panel, so it belongs in the config before the service (and
  // every sub-service that copies it) exists — see handleReload.
  private createServiceLogger(config: RepositoryConfig): Logger {
    return new Logger({
      repoName: config.name,
      debug: config.debug,
      outputFn: this.createOutputFn(),
    });
  }

  private injectLoggersIntoServices(): void {
    for (const service of this.syncServices) {
      service.updateLogger(this.createServiceLogger(service.config as RepositoryConfig));
    }
  }

  private subscribeToServiceProgress(): void {
    for (const unsubscribe of this.progressUnsubscribers) {
      unsubscribe();
    }
    this.progressUnsubscribers = this.syncServices.map((service, index) => {
      const repoName = this.getRepoName(index);
      if (!service.onProgress) return () => undefined;
      return service.onProgress((event) => {
        if (this.isDestroyed) return;
        this.events.emit("setSyncProgress", {
          repo: repoName,
          phase: event.phase,
          message: event.message,
          progress: event.progress,
          processed: event.processed,
          total: event.total,
        });
      });
    });
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
    const jobs = this.cronJobs;
    this.cronJobs = [];
    for (const job of jobs) {
      // destroy(), not stop(): stop() only clears the runner's timer, while
      // node-cron keeps every task it ever scheduled in a module-level registry
      // that is released on `task:destroyed` and nothing else. The task holds
      // the tick callback, the callback closes over this generation of
      // WorktreeSyncService objects, and those hold a simple-git client per
      // worktree — so every `r` reload leaked one whole generation. destroy()
      // stops the runner on the way through, so stopping first is redundant.
      // Both are `void | Promise<void>` (node-cron 4.6): a background task's
      // destroy() rejects after its own 5s timeout, and dropping that promise
      // on the floor would take the process down with an unhandled rejection.
      try {
        const settled: unknown = job.destroy();
        if (typeof (settled as PromiseLike<void> | undefined)?.then === "function") {
          void Promise.resolve(settled).catch((error: unknown) => {
            this.addLog(`Failed to release cron task: ${getErrorMessage(error)}`, "warn");
          });
        }
      } catch (error) {
        this.addLog(`Failed to release cron task: ${getErrorMessage(error)}`, "warn");
      }
    }
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
        maxProgressLines={this.maxProgressLines}
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
        getRepositoryDiskUsage={(index: number) => this.getRepositoryDiskUsage(index)}
        getDivergedDirectoriesForRepo={(index: number) => this.getDivergedDirectoriesForRepo(index)}
        deleteDivergedDirectory={(repoIndex: number, name: string) => this.deleteDivergedDirectory(repoIndex, name)}
        getForceCleanPreview={() => this.getForceCleanPreview()}
        forceClean={(selections: ForceCleanRepositorySelection[]) => this.forceClean(selections)}
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
      {
        alternateScreen: true,
        incrementalRendering: true,
        stdout: this.stdout,
        stdin: this.stdin,
      },
    );

    // render() has already entered the alternate screen and drawn the first
    // frame, so the tracking mode goes on over it here and comes back off in
    // destroy(), after Ink has restored the primary buffer. Gated on the same
    // condition Ink gates the alternate screen on: a DECSET written down a pipe
    // is just bytes in whatever is reading it.
    if (this.stdout.isTTY) {
      this.mouse.enable();
    }

    const instance = this.app;
    const onInkExit = (): void => this.handleInkExit(instance);
    // Ink 7 answers Ctrl+C itself, at the root of its own tree and before the
    // byte reaches any useInput listener: it drops raw mode and unmounts, but
    // never calls onQuit, never cancels the cron jobs and never exits, so the
    // process went on syncing headlessly against an interface nobody could see.
    // The exit promise is the only signal for that which does not depend on
    // which modal currently owns the keyboard, and it also fires when Ink tears
    // the tree down after a render error. Both settlements route to the same
    // place; a rejected exit promise is still an exit.
    void instance.waitUntilExit().then(onInkExit, onInkExit);
  }

  private handleInkExit(instance: Instance): void {
    // Not `this.app === null`: destroy() nulls it as it unmounts, and Ink
    // settles its exit promise a tick later, so that arrival is our own
    // teardown reporting back and there is nothing left to do about it.
    if (this.app !== instance) return;
    this.inkExited = true;
    if (this.shutdown !== null) {
      // Ctrl+C on top of the wait `q` started. Ink answers it by tearing its
      // own tree down, which leaves the user staring at a bare terminal, so
      // read it as the second press it is rather than letting the wait run on.
      this.requestForceQuit();
      return;
    }
    void this.handleQuit().catch((error: unknown) => {
      this.addLog(`Shutdown failed: ${getErrorMessage(error)}`, "error");
      this.exitProcess(1);
    });
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
      const { repositories } = await configLoader.buildRepositories(this.configPath);

      const initResults = await Promise.allSettled(
        repositories.map((repoConfig) =>
          this.limit(async () => {
            // Before construction, not after: initialize() logs (fetch
            // progress, metadata repair, status probe failures) through the
            // logger each sub-service was handed when it was built.
            repoConfig.logger = this.createServiceLogger(repoConfig);
            const service = new WorktreeSyncService(repoConfig);
            await service.initialize();
            return {
              service,
              clonePhaseSkips: service.getRecordedSkips().map((reason) => ({
                repo: repoConfig.name || repoConfig.repoUrl,
                reason: formatCloneSkipReason(reason),
              })),
            };
          }),
        ),
      );

      const newServices: WorktreeSyncService[] = [];
      const initClonePhaseSkips: Array<{ repo: string; reason: string }> = [];
      for (const result of initResults) {
        if (result.status === "fulfilled") {
          newServices.push(result.value.service);
          initClonePhaseSkips.push(...result.value.clonePhaseSkips);
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
      this.subscribeToServiceProgress();
      // Not injectLoggersIntoServices(): these services were built with their
      // panel logger already in config, above. Injecting again would build a
      // second Logger per repository and leave config.logger pointing at the
      // first, dead one. Startup still needs the injection, because there the
      // services exist before the UI that owns the panel does.

      const uniqueSchedules = [...new Set(this.syncServices.map((s) => s.config.cronSchedule))];
      this.cronSchedule = uniqueSchedules.length === 1 ? uniqueSchedules[0] : undefined;

      this.setupCronJobs();

      this.events.emit("updateRepositoryCount", this.repositoryCount);
      this.events.emit("updateCronSchedule", this.cronSchedule);

      const {
        failures,
        skipped,
        clonePhaseSkips: syncClonePhaseSkips,
        attempted,
      } = await this.runSyncServices(this.syncServices);
      const clonePhaseSkips = [...initClonePhaseSkips, ...syncClonePhaseSkips];
      await this.recordSyncOutcome({ failures, skipped, attempted });
      this.setStatus("idle");

      for (const skip of skipped) {
        this.addLog(`Sync skipped for '${skip.repo}': ${skip.reason}`, "warn");
      }
      for (const skip of clonePhaseSkips) {
        this.addLog(`Clone-mode skip for '${skip.repo}': ${skip.reason}`, "warn");
      }
      if (clonePhaseSkips.length > 0) {
        this.addLog(`⚠️  ${clonePhaseSkips.length} clone-mode skip(s) during reload`, "warn");
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
    this.exitProcess(0);
  }

  // Shutdown progress is the one thing a user needs while the interface is
  // waiting on a sync, and on the Ctrl+C path Ink has already put the terminal
  // back on the primary buffer, so the log panel it would go to is gone. Write
  // those lines to the stream as well, or the process just looks hung.
  private shutdownNotice(message: string, level: "info" | "warn"): void {
    this.addLog(message, level);
    if (!this.inkExited) return;
    try {
      this.stdout.write(`${message}\n`);
    } catch {
      // Best effort - the stream may already be gone during teardown.
    }
  }

  private requestForceQuit(): void {
    const release = this.releaseForceQuit;
    if (release === null) return;
    // A held key repeats every few tens of milliseconds. The shortcut has to be
    // a second decision, not the tail of the keystroke that started the wait.
    if (Date.now() - this.shutdownStartedAt < FORCE_QUIT_GUARD_MS) return;
    this.releaseForceQuit = null;
    release();
  }

  private async waitForInProgressSyncs(
    timeoutMs: number = WAIT_SYNC_DEFAULT_TIMEOUT_MS,
    abort?: Promise<void>,
  ): Promise<void> {
    const inProgressServices = this.syncServices.filter((s) => s.isSyncInProgress());

    if (inProgressServices.length === 0) {
      return;
    }

    const hint = abort ? " Press q or Ctrl+C again to quit now." : "";
    this.shutdownNotice(`Waiting for ${inProgressServices.length} in-progress sync(s) to finish...${hint}`, "info");

    let settledEarly = false;
    const syncChecks = inProgressServices.map(async (service) => {
      const checkInterval = 500;
      const startTime = Date.now();

      while (service.isSyncInProgress()) {
        if (settledEarly) return;
        if (Date.now() - startTime > timeoutMs) {
          throw new Error("Timeout waiting for sync operations to complete");
        }
        await new Promise((resolve) => setTimeout(resolve, checkInterval));
      }
    });

    // Settled rather than raced bare: once the force-quit shortcut wins the
    // race the timeout rejection still arrives, and an unattended rejection
    // there would take the whole process down on the way out.
    const waited = Promise.all(syncChecks).then(
      () => "finished" as const,
      () => "timeout" as const,
    );
    const outcome = abort ? await Promise.race([waited, abort.then(() => "forced" as const)]) : await waited;
    settledEarly = true;

    if (outcome === "timeout") {
      this.shutdownNotice(
        `Warning: Timeout waiting for sync operations to complete after ${formatDuration(timeoutMs)}. Proceeding with potential data loss risk.`,
        "warn",
      );
    } else if (outcome === "forced") {
      this.shutdownNotice("Force quit: leaving in-progress sync(s) unfinished.", "warn");
    }
  }

  public updateLastSyncTime(): void {
    if (this.isDestroyed) return;
    this.events.emit("updateLastSyncTime");
  }

  public setStatus(status: "idle" | "syncing"): void {
    if (this.isDestroyed) return;
    this.events.emit("setStatus", status);
    if (status === "idle") {
      this.events.emit("setSyncProgress", null);
    }
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

  public getRepositoryList(): RepositoryListEntry[] {
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

  public async getRepositoryDiskUsage(repoIndex: number): Promise<RepositoryDiskUsage> {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      throw new Error(`Invalid repository index: ${repoIndex}`);
    }

    const service = this.syncServices[repoIndex];
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
        const size = await calculateDirectorySize(target.path);
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
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      throw new Error(`Invalid repository index: ${repoIndex}`);
    }

    const service = this.syncServices[repoIndex];
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
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      throw new Error(`Invalid repository index: ${repoIndex}`);
    }

    // Clone mode never runs GitService.initialize(), so GitService's default
    // branch is still the 'main' its constructor set, whatever the clone
    // actually tracks — the wizard would pre-select and label a branch the
    // repository does not follow and create from the wrong base. The sync
    // service's accessor is clone-aware: the configured branch, or the
    // remote's HEAD (resolved once, then cached) when none is configured.
    try {
      return await this.syncServices[repoIndex].getDefaultBranch();
    } catch (error) {
      // The wizard drops this to keep its branch list on screen, so say why
      // here or the reason is lost: resolving an unconfigured branch asks the
      // remote, and its message is the one that tells the user to set
      // `branch` explicitly.
      this.addLog(
        `Could not resolve the default branch for '${this.getRepoName(repoIndex)}': ${getErrorMessage(error)}`,
        "warn",
      );
      throw error;
    }
  }

  public async fetchForRepo(repoIndex: number): Promise<void> {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      throw new Error(`Invalid repository index: ${repoIndex}`);
    }

    const service = this.syncServices[repoIndex];
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
  ): Promise<{ success: boolean; finalName: string; error?: string }> {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      return { success: false, finalName: branchName, error: `Invalid repository index: ${repoIndex}` };
    }

    const service = this.syncServices[repoIndex];
    const gitService = service.getGitService();

    // A clone-mode repo has no bare repository, and GitService's write helpers
    // all run in one — falling back to the relative '.bare/<repo name>', which
    // is either missing or another repository's store. Clone mode creates and
    // publishes the branch inside the clone itself instead.
    const createAndPush = service.isCloneMode()
      ? (name: string): Promise<void> => service.createAndPushBranch(baseBranch, name)
      : async (name: string): Promise<void> => {
          await gitService.createBranch(name, baseBranch);
          await gitService.pushBranch(name);
        };

    // Serialize branch+push behind any in-flight sync so it can't race git's
    // index/refs. addWorktree (createWorktreeForBranch) is a separate queued op.
    const result = await service.runQueuedRepoOperation(async () => {
      const maxAttempts = 10;
      let finalName = branchName;
      let suffix = 0;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          await createAndPush(finalName);
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

  public async getWorktreesForRepo(repoIndex: number): Promise<Array<{ path: string; branch: string }>> {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      throw new Error(`Invalid repository index: ${repoIndex}`);
    }

    const service = this.syncServices[repoIndex];
    return this.getWorktreesFromService(service);
  }

  public async getWorktreeStatusForRepo(repoIndex: number): Promise<WorktreeStatusEntry[]> {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      throw new Error(`Invalid repository index: ${repoIndex}`);
    }

    const service = this.syncServices[repoIndex];
    const gitService = service.getGitService();
    const worktrees = await this.getWorktreesFromService(service);

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
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      return [];
    }

    const service = this.syncServices[repoIndex];
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

        const sizeBytes = await calculateDirectorySize(fullPath).catch(() => 0);
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
    this.addLog(`🗑️ Deleted diverged directory: ${name}`, "info");
  }

  public async getForceCleanPreview(): Promise<ForceCleanRepositoryPreview[]> {
    return Promise.all(
      this.syncServices.map((service, repoIndex) =>
        this.limit(async () => {
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
      this.syncServices.map((service, repoIndex) =>
        this.limit(async () => {
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
            this.addLog(
              `🧹 Force clean ${repoName}: deleted ${result.trashDeleted} trash entries and ${result.keepRefsDeleted} recovery refs; GC ${result.gcSkipped ? "skipped" : result.gcSucceeded ? "complete" : "failed"}${skipped}`,
              level,
            );
            return { repoIndex, repoName, result };
          } catch (error) {
            const message = getErrorMessage(error);
            this.addLog(`Force clean ${repoName} failed: ${message}`, "error");
            return { repoIndex, repoName, error: message };
          }
        }),
      ),
    );
    await this.calculateAndUpdateDiskSpace();
    return results;
  }

  public async createWorktreeForBranch(repoIndex: number, branchName: string): Promise<void> {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      throw new Error(`Invalid repository index: ${repoIndex}`);
    }

    const service = this.syncServices[repoIndex];
    const gitService = service.getGitService();
    const worktreeDir = service.config.worktreeDir;
    const worktreePath = this.pathResolution.getBranchWorktreePath(worktreeDir, branchName);

    const result = await service.runQueuedRepoOperation(async () => {
      if (service.isCloneMode()) {
        // The wizard just created and pushed this branch — switching to it is
        // intentional config drift; checkoutBranch warns to update config.branch.
        await service.checkoutBranch(branchName, { allowConfigDrift: true });
        return;
      }
      await gitService.addWorktree(branchName, worktreePath);
    });
    if (!result.started) {
      throw new Error(this.describeNotStarted(result, "worktree not created"));
    }
  }

  public openEditorInWorktree(worktreePath: string): { success: boolean; error?: string } {
    const editor = process.env.EDITOR || process.env.VISUAL || "code";
    // EDITOR may include flags (e.g. "code -w"); spawn without a shell treats
    // the whole string as the binary name, so split command and args ourselves.
    const [command, ...editorArgs] = editor.trim().split(/\s+/);

    try {
      const child = spawn(command, [...editorArgs, worktreePath], {
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
    // One cycle at a time, per UI service. The daemon now starts a sync and
    // arms the cron jobs in the same breath, so a tick landing inside the
    // startup cycle is routine rather than the rare `s`-during-a-sync it used
    // to be. WorktreeSyncService's repoMutex already refuses the second
    // caller's work (`in_progress`), so nothing raced the repository itself —
    // but the losing cycle still got far enough to do two things it should not:
    // runSyncServices calls clearRecordedSkips() on every service before it
    // learns it cannot run, wiping the clone-mode skips the in-flight cycle had
    // accumulated (sync() clears that accumulator inside the lock precisely so
    // a losing caller cannot truncate the winner's payload), and this method's
    // `finally` drove the status back to "idle" and blanked the progress panel
    // while the first cycle was still fetching. Skipping outright is what the
    // tick means anyway: the work is already being done.
    if (this.syncCycleInFlight) {
      this.addLog("A sync is already running; skipping this cycle.", "info");
      return [];
    }
    this.syncCycleInFlight = true;
    this.setStatus("syncing");

    try {
      const { failures, skipped, partialSkips, clonePhaseSkips, attempted } = await this.runSyncServices(services);

      if (options.logErrors) {
        for (const failure of failures) {
          this.addLog(`Failed to sync repository '${failure.repo}': ${failure.error}`, "error");
        }
      }
      for (const skip of skipped) {
        this.addLog(`Sync skipped for '${skip.repo}': ${skip.reason}`, "warn");
      }
      for (const skip of clonePhaseSkips) {
        this.addLog(`Clone-mode skip for '${skip.repo}': ${skip.reason}`, "warn");
      }
      if (clonePhaseSkips.length > 0) {
        this.addLog(`⚠️  ${clonePhaseSkips.length} clone-mode skip(s) this cycle`, "warn");
      }
      for (const partial of partialSkips) {
        this.addLog(`${partial.repo}: ${partial.reason}`, "info");
      }

      await this.recordSyncOutcome({ failures, skipped, attempted });
      return failures;
    } finally {
      this.setStatus("idle");
      this.syncCycleInFlight = false;
    }
  }

  private async recordSyncOutcome(outcome: {
    failures: Array<{ repo: string; error: string }>;
    skipped: Array<{ repo: string; reason: string }>;
    attempted: number;
  }): Promise<void> {
    const allSkipped =
      outcome.attempted > 0 && outcome.skipped.length === outcome.attempted && outcome.failures.length === 0;
    if (allSkipped) return;
    this.updateLastSyncTime();
    await this.calculateAndUpdateDiskSpace();
  }

  private async runSyncServices(services: WorktreeSyncService[]): Promise<{
    failures: Array<{ repo: string; error: string }>;
    skipped: Array<{ repo: string; reason: string }>;
    partialSkips: Array<{ repo: string; reason: string }>;
    clonePhaseSkips: Array<{ repo: string; reason: string }>;
    attempted: number;
  }> {
    const syncResults = await Promise.allSettled(
      services.map((service) => {
        const repoName = (service.config as RepositoryConfig).name || service.config.repoUrl;
        return this.limit(async () => {
          service.clearRecordedSkips();
          try {
            if (!service.isInitialized()) {
              await service.initialize();
            }
            const result = await service.sync();
            return { service, result };
          } finally {
            this.events.emit("setSyncProgress", {
              repo: repoName,
              phase: "complete",
              message: "Finished",
              completed: true,
            });
          }
        }).catch((error) => {
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { repoName });
        });
      }),
    );

    const failures: Array<{ repo: string; error: string }> = [];
    const skipped: Array<{ repo: string; reason: string }> = [];
    const partialSkips: Array<{ repo: string; reason: string }> = [];
    const clonePhaseSkips: Array<{ repo: string; reason: string }> = [];
    for (let i = 0; i < syncResults.length; i++) {
      const result = syncResults[i];
      const repoName = (services[i].config as RepositoryConfig).name || services[i].config.repoUrl;
      if (result.status === "rejected") {
        const fallbackName = (result.reason as { repoName?: string })?.repoName ?? repoName;
        const errorMessage = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failures.push({ repo: fallbackName, error: errorMessage });
      } else if (result.value.result && result.value.result.started === false) {
        const notStarted = result.value.result;
        if (notStarted.reason === "lock_unavailable") {
          // Not a skip: nothing synced this repo and no other process will.
          failures.push({ repo: repoName, error: formatRepoLockUnavailable(notStarted) });
        } else {
          skipped.push({ repo: repoName, reason: `sync skipped: ${notStarted.reason}` });
        }
      } else if (result.status === "fulfilled" && result.value.result?.started === true) {
        const outcome = result.value.result.outcome;
        if (outcome?.counts.failed) {
          failures.push({ repo: repoName, error: `${outcome.counts.failed} sync action(s) failed` });
        }
        // Per-action skips are informational; the repo did complete its sync
        // attempt. Surface as a separate channel so updateLastSyncTime still
        // runs and the per-cycle log stays at info-level.
        if (outcome?.mode === "worktree" && outcome.counts.skipped > 0) {
          partialSkips.push({ repo: repoName, reason: `${outcome.counts.skipped} sync action(s) skipped` });
        }
      }
      for (const reason of services[i].getRecordedSkips()) {
        clonePhaseSkips.push({ repo: repoName, reason: formatCloneSkipReason(reason) });
      }
    }

    return { failures, skipped, partialSkips, clonePhaseSkips, attempted: services.length };
  }

  private buildUiLogger(): Logger {
    return new Logger({
      outputFn: (msg: string, level: LogLevel): void => {
        const uiLevel: "info" | "warn" | "error" = level === "warn" ? "warn" : level === "error" ? "error" : "info";
        this.addLog(msg, uiLevel);
      },
    });
  }

  public executeOnBranchCreatedHooks(repoIndex: number, context: HookContext): void {
    if (repoIndex < 0 || repoIndex >= this.syncServices.length) {
      return;
    }

    const service = this.syncServices[repoIndex];
    const config = service.config;
    const repoName = (config as RepositoryConfig).name || config.repoUrl;

    this.branchCreatedActions.runHooks({
      config,
      repoName,
      branchName: context.branchName,
      worktreePath: context.worktreePath,
      baseBranch: context.baseBranch,
      logger: this.buildUiLogger(),
      hookExecutionService: this.hookExecutionService,
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

    const worktrees = await this.getWorktreesFromService(service);

    const sourceWorktree = worktrees.find((w) => w.branch === baseBranch);
    const targetWorktree = worktrees.find((w) => w.branch === targetBranch);

    if (!sourceWorktree || !targetWorktree) {
      this.addLog(`Could not find worktrees for file copy: source=${baseBranch}, target=${targetBranch}`, "warn");
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

  // A second call while the first is still waiting is the force-quit shortcut:
  // a second `q`, or the real SIGINT a second Ctrl+C becomes once Ink has
  // dropped raw mode. It shortcuts the wait rather than starting a second
  // teardown, and returns the shutdown already in flight so every caller -
  // signal handler included - settles on the same one.
  public async destroy(fast = false): Promise<void> {
    if (this.shutdown !== null) {
      this.requestForceQuit();
      return this.shutdown;
    }
    this.shutdownStartedAt = Date.now();
    this.shutdown = this.runShutdown(fast);
    return this.shutdown;
  }

  // isDestroyed is set *after* the wait, not before it. As the first statement
  // it silenced addLog for the whole shutdown, so the "waiting for N in-progress
  // sync(s)" notice and the data-loss warning this method emits were both
  // dropped and the interface just froze for up to 30s before exiting anyway.
  private async runShutdown(fast: boolean): Promise<void> {
    this.cancelCronJobs();

    const forceQuit = new Promise<void>((resolve) => {
      this.releaseForceQuit = resolve;
    });

    try {
      await this.waitForInProgressSyncs(fast ? WAIT_SYNC_FAST_TIMEOUT_MS : WAIT_SYNC_DEFAULT_TIMEOUT_MS, forceQuit);
    } catch {
      // Best effort - proceed with teardown even if syncs don't finish
    }
    this.releaseForceQuit = null;

    this.isDestroyed = true;
    this.hookExecutionService.cleanup();
    if (this.app) {
      this.app.unmount();
      this.app = null;
    }
    // After Ink's own unmount, deliberately: Ink writes the alternate-screen
    // exit inside unmount() and treats everything written before it as
    // disposable, so the sequence that has to survive belongs on the primary
    // buffer the shell gets back. Outside the branch above, not inside it: on
    // the Ctrl+C path Ink unmounted itself before it settled the exit promise
    // that got us here, so the buffer is already restored and the unmount()
    // above is Ink's own no-op — but `this.app` is still that instance, so a
    // reader cannot take the branch as a proxy for "we did the restoring".
    this.mouse.disable();
    for (const unsubscribe of this.unsubscribeCallbacks) {
      unsubscribe();
    }
    this.unsubscribeCallbacks = [];
    for (const unsubscribe of this.progressUnsubscribers) {
      unsubscribe();
    }
    this.progressUnsubscribers = [];
    if (this.ownsEvents) {
      this.events.removeAllListeners();
    }
    this.uiReady = false;
    this.logBuffer = [];
  }
}

import React from "react";
import type { Instance } from "ink";
import { render } from "ink";
import pLimit from "p-limit";
import App from "../components/App";
import { DEFAULT_CONFIG } from "../constants";
import { WorktreeSyncService } from "./worktree-sync.service";
import { ConfigLoaderService } from "./config-loader.service";
import { resolveMaxRepositories } from "./config-schema";
import { HookExecutionService } from "./hook-execution.service";
import type { LogOutputFn, LogLevel } from "./logger.service";
import { Logger } from "./logger.service";
import { RepositoryDashboard } from "./repository-dashboard";
import { RepositoryOperations, getRepositoryDiskTargets } from "./repository-operations";
import { SyncCycleScheduler, WAIT_SYNC_DEFAULT_TIMEOUT_MS, WAIT_SYNC_FAST_TIMEOUT_MS } from "./sync-cycle-scheduler";
import { TerminalLauncher } from "./terminal-launcher";
import { formatCloneSkipReason } from "../utils/clone-skip-format";
import { getErrorMessage } from "../utils/errors";
import { calculateSyncDiskSpace } from "../utils/disk-space";
import { DiskUsageCache } from "../utils/disk-usage-cache";
import { repoDisplayLabel } from "../utils/git-url";
import { AppEventEmitter } from "../utils/app-events";
import type { LastSyncOutcome } from "../utils/app-events";
import { createMouseTracking } from "../utils/mouse";
import type { MouseTracking } from "../utils/mouse";
import type { RepositoryConfig, HookContext, ForceCleanRepositorySelection } from "../types";

const FORCE_QUIT_GUARD_MS = 500;

export interface InteractiveUIRuntime {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  exit: (code: number) => void;
  debug: boolean;
}

export class InteractiveUIService {
  private app: Instance | null = null;
  private syncServices: WorktreeSyncService[];
  private configPath?: string;
  private readonly debugOverride: boolean;
  private repositoryFilter?: string;
  private repositoryCount: number;
  private logBuffer: Array<{ message: string; level: "info" | "warn" | "error" }> = [];
  private uiReady = false;
  private readonly hookExecutionService = new HookExecutionService();
  private readonly limit: ReturnType<typeof pLimit>;
  private readonly diskUsage: DiskUsageCache;
  private maxRepositories: number;
  private reloadInProgress = false;
  private reloadGeneration = 0;
  private isDestroyed = false;
  private readonly events: AppEventEmitter;
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
  public readonly scheduler: SyncCycleScheduler;
  public readonly operations: RepositoryOperations;
  public readonly launcher: TerminalLauncher;
  public readonly dashboard: RepositoryDashboard;

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
    this.debugOverride = runtime.debug ?? false;
    this.repositoryCount = syncServices.length;
    this.maxRepositories = Math.max(1, maxParallel ?? DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES);
    this.limit = pLimit(this.maxRepositories);
    this.diskUsage = new DiskUsageCache(this.maxRepositories);
    this.stdout = runtime.stdout ?? process.stdout;
    this.stdin = runtime.stdin ?? process.stdin;
    this.exitProcess = runtime.exit ?? ((code: number): void => process.exit(code));
    this.mouse = createMouseTracking(this.stdout);

    const log = (message: string, level: "info" | "warn" | "error"): void => this.addLog(message, level);
    const services = (): WorktreeSyncService[] => this.syncServices;
    const refreshDiskSpace = (): Promise<void> => this.calculateAndUpdateDiskSpace();
    this.dashboard = new RepositoryDashboard({
      events: this.events,
      getServices: services,
      getRepoName: (index) => this.operations.getRepoName(index),
      scheduleFor: (service) => this.scheduler.scheduleFor(service),
      isActive: () => !this.isDestroyed,
    });
    this.scheduler = new SyncCycleScheduler(
      {
        events: this.events,
        limit: this.limit,
        getServices: services,
        isShuttingDown: () => this.shutdown !== null,
        log,
        notice: (message, level) => this.shutdownNotice(message, level),
        setStatus: (status) => this.setStatus(status),
        setLastSyncOutcome: (outcome) => this.setLastSyncOutcome(outcome),
        updateLastSyncTime: () => this.updateLastSyncTime(),
        refreshDiskSpace,
        dashboard: this.dashboard,
      },
      cronSchedule,
    );
    this.operations = new RepositoryOperations({
      getServices: services,
      log,
      limit: this.limit,
      diskUsage: this.diskUsage,
      hookExecutionService: this.hookExecutionService,
      refreshDiskSpace,
      onWorktreeStatus: (repoIndex, entries) => this.dashboard.recordWorktreeStatus(repoIndex, entries),
    });
    this.launcher = new TerminalLauncher({
      log,
      getRepoName: (index) =>
        index >= 0 && index < this.syncServices.length ? this.operations.getRepoName(index) : null,
    });

    this.startBufferFlushCheck();
    this.renderUI();
    this.subscribeToServiceProgress();
    this.injectLoggersIntoServices();

    this.addLog("🚀 sync-worktrees UI initialized", "info");
  }

  public setRepositoryFilter(filter: string | undefined): void {
    this.repositoryFilter = filter;
  }

  public getEvents(): AppEventEmitter {
    return this.events;
  }

  private startBufferFlushCheck(): void {
    const unsubscribe = this.events.on("uiReady", () => {
      this.uiReady = true;
      this.flushLogBuffer();
      this.dashboard.publish();
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
    this.progressUnsubscribers = this.syncServices.map((service, index) =>
      this.subscribeToProgress(service, this.operations.getRepoName(index)),
    );
  }

  private subscribeToProgress(service: WorktreeSyncService, repoName: string): () => void {
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
    this.scheduler.setupCronJobs();
  }

  private renderUI(): void {
    const ops = this.operations;
    this.app = render(
      <App
        events={this.events}
        repositoryCount={this.repositoryCount}
        cronSchedule={this.scheduler.getScheduledCronExpressions()}
        maxProgressLines={this.maxRepositories}
        onManualSync={() => this.handleManualSync()}
        onSyncRepository={(index: number) => this.handleSyncRepository(index)}
        copyToClipboard={(text: string) => this.launcher.copyToClipboard(text)}
        onReload={() => this.handleReload()}
        onQuit={() => this.handleQuit()}
        getRepositoryList={() => ops.getRepositoryList()}
        getBranchesForRepo={(index: number) => ops.getBranchesForRepo(index)}
        getDefaultBranchForRepo={(index: number) => ops.getDefaultBranchForRepo(index)}
        fetchForRepo={(index: number) => ops.fetchForRepo(index)}
        createAndPushBranch={(repoIndex: number, baseBranch: string, branchName: string) =>
          ops.createAndPushBranch(repoIndex, baseBranch, branchName)
        }
        getWorktreesForRepo={(index: number) => ops.getWorktreesForRepo(index)}
        getWorktreeStatusForRepo={(index: number) => ops.getWorktreeStatusForRepo(index)}
        getRepositoryDiskUsage={(index: number) => ops.getRepositoryDiskUsage(index)}
        getDivergedDirectoriesForRepo={(index: number) => ops.getDivergedDirectoriesForRepo(index)}
        deleteDivergedDirectory={(repoIndex: number, name: string) => ops.deleteDivergedDirectory(repoIndex, name)}
        getForceCleanPreview={() => ops.getForceCleanPreview()}
        forceClean={(selections: ForceCleanRepositorySelection[]) => ops.forceClean(selections)}
        getRunningHookCount={() => ops.getRunningHookCount()}
        openEditorInWorktree={(path: string) => this.launcher.openEditorInWorktree(path)}
        openTerminalInWorktree={(repoIndex: number, path: string, branchName: string) =>
          this.launcher.openTerminalInWorktree(repoIndex, path, branchName)
        }
        copyBranchFiles={(repoIndex: number, baseBranch: string, targetBranch: string) =>
          ops.copyBranchFiles(repoIndex, baseBranch, targetBranch)
        }
        createWorktreeForBranch={(repoIndex: number, branchName: string) =>
          ops.createWorktreeForBranch(repoIndex, branchName)
        }
        executeOnBranchCreatedHooks={(repoIndex: number, context: HookContext) =>
          ops.executeOnBranchCreatedHooks(repoIndex, context)
        }
      />,
      {
        alternateScreen: true,
        incrementalRendering: true,
        stdout: this.stdout,
        stdin: this.stdin,
      },
    );

    if (this.stdout.isTTY) {
      this.mouse.enable();
    }

    const instance = this.app;
    const onInkExit = (): void => this.handleInkExit(instance);
    void instance.waitUntilExit().then(onInkExit, onInkExit);
  }

  private handleInkExit(instance: Instance): void {
    if (this.app !== instance) return;
    this.inkExited = true;
    if (this.shutdown !== null) {
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

  private async handleSyncRepository(index: number): Promise<void> {
    const service = this.syncServices[index];
    if (!service) {
      throw new Error(`Invalid repository index: ${index}`);
    }
    this.addLog(`🔄 Syncing '${this.operations.getRepoName(index)}'...`, "info");
    await this.scheduler.runSyncCycle([service], { logErrors: true });
  }

  public async triggerInitialSync(): Promise<void> {
    await this.scheduler.runSyncCycle(this.syncServices, { logErrors: true });
  }

  private async handleReload(): Promise<void> {
    if (this.reloadInProgress) {
      return;
    }
    this.reloadInProgress = true;
    let cronJobsCancelled = false;
    this.scheduler.beginSyncCycle();
    let cycleOpen = true;
    const closeCycle = (): void => {
      if (!cycleOpen) return;
      cycleOpen = false;
      this.scheduler.endSyncCycle();
    };
    try {
      if (!this.configPath) {
        return;
      }
      if (this.shutdown !== null) {
        this.addLog("Shutting down; reload ignored.", "info");
        return;
      }

      await this.scheduler.waitForInProgressSyncs();

      this.addLog("Reloading configuration...");

      const configLoader = new ConfigLoaderService();
      const { repositories, configFile } = await configLoader.buildRepositories(this.configPath, {
        debug: this.debugOverride,
        filter: this.repositoryFilter,
      });
      if (repositories.length === 0 && this.repositoryFilter) {
        throw new Error(`No repositories match filter: ${this.repositoryFilter}`);
      }

      const initResults = await Promise.allSettled(
        repositories.map((repoConfig) =>
          this.limit(async () => {
            repoConfig.logger = this.createServiceLogger(repoConfig);
            const service = new WorktreeSyncService(repoConfig);
            const unsubscribeProgress = this.subscribeToProgress(service, repoDisplayLabel(repoConfig));
            try {
              await service.initialize();
            } finally {
              unsubscribeProgress();
            }
            return {
              service,
              clonePhaseSkips: service.getRecordedSkips().map((reason) => ({
                repo: repoDisplayLabel(repoConfig),
                reason: formatCloneSkipReason(reason),
              })),
            };
          }),
        ),
      );

      const newServices: WorktreeSyncService[] = [];
      const initClonePhaseSkips: Array<{ repo: string; reason: string }> = [];
      for (const [index, result] of initResults.entries()) {
        if (result.status === "fulfilled") {
          newServices.push(result.value.service);
          initClonePhaseSkips.push(...result.value.clonePhaseSkips);
        } else {
          const failed = repositories[index];
          this.addLog(`Failed to initialize repository '${repoDisplayLabel(failed)}': ${result.reason}`, "error");
        }
      }

      if (newServices.length === 0) {
        throw new Error("No repositories could be initialized from the configuration");
      }

      if (this.shutdown !== null) {
        this.addLog("Shutting down; reload abandoned.", "info");
        return;
      }

      this.scheduler.cancelCronJobs();
      cronJobsCancelled = true;

      this.syncServices = newServices;
      for (const service of newServices) {
        for (const target of getRepositoryDiskTargets(service.config)) this.diskUsage.invalidate(target.path);
      }
      this.repositoryCount = this.syncServices.length;
      this.maxRepositories = Math.max(1, resolveMaxRepositories(configFile));
      this.limit.concurrency = this.maxRepositories;
      this.diskUsage.setMaxParallel(this.maxRepositories);
      this.subscribeToServiceProgress();

      const uniqueSchedules = [...new Set(this.syncServices.map((s) => s.config.cronSchedule))];
      this.scheduler.defaultSchedule = uniqueSchedules.length === 1 ? uniqueSchedules[0] : undefined;

      this.scheduler.setupCronJobs();

      this.events.emit("updateRepositoryCount", this.repositoryCount);
      this.events.emit("updateMaxProgressLines", this.maxRepositories);
      this.events.emit("repositoriesReloaded", ++this.reloadGeneration);
      this.events.emit("updateCronSchedule", this.scheduler.getScheduledCronExpressions());
      this.dashboard.publish();

      const claimed = this.scheduler.claimForCycle(this.syncServices);
      const {
        failures,
        skipped,
        clonePhaseSkips: syncClonePhaseSkips,
        attempted,
      } = await this.scheduler.runSyncServices(claimed).finally(() => this.scheduler.releaseFromCycle(claimed));
      const clonePhaseSkips = [...initClonePhaseSkips, ...syncClonePhaseSkips];
      await this.scheduler.recordSyncOutcome({ failures, skipped, attempted });
      closeCycle();

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
        this.scheduler.setupCronJobs();
      }
    } finally {
      closeCycle();
      this.reloadInProgress = false;
    }
  }

  private async handleQuit(): Promise<void> {
    await this.destroy();
    this.exitProcess(0);
  }

  private shutdownNotice(message: string, level: "info" | "warn"): void {
    this.addLog(message, level);
    if (!this.inkExited) return;
    this.writeLines([message]);
  }

  private describeTerminatedHooks(commands: string[]): string[] {
    if (commands.length === 0) return [];
    return [
      `Terminating ${commands.length} hook(s) still running; hooks do not outlive the interface:`,
      ...commands.map((command) => `[hook] terminated on exit: ${command}`),
    ];
  }

  private writeLines(lines: string[]): void {
    try {
      for (const line of lines) {
        this.stdout.write(`${line}\n`);
      }
    } catch {}
  }

  private requestForceQuit(): void {
    const release = this.releaseForceQuit;
    if (release === null) return;
    if (Date.now() - this.shutdownStartedAt < FORCE_QUIT_GUARD_MS) return;
    this.releaseForceQuit = null;
    release();
  }

  public updateLastSyncTime(): void {
    if (this.isDestroyed) return;
    this.events.emit("updateLastSyncTime");
  }

  public setLastSyncOutcome(outcome: LastSyncOutcome): void {
    if (this.isDestroyed) return;
    this.events.emit("setLastSyncOutcome", outcome);
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
      const targets = this.syncServices.flatMap((service) => getRepositoryDiskTargets(service.config));
      const bareRepoDirs = targets.filter((target) => target.kind === "bare").map((target) => target.path);
      const worktreeDirs = targets.filter((target) => target.kind === "worktree").map((target) => target.path);

      const diskSpace = await calculateSyncDiskSpace(bareRepoDirs, worktreeDirs, (dirPath) =>
        this.diskUsage.refresh(dirPath),
      );
      this.setDiskSpace(diskSpace);
    } catch (error) {
      this.addLog(`Failed to calculate disk space: ${error instanceof Error ? error.message : String(error)}`, "error");
      this.setDiskSpace("N/A");
    }
  }

  public async destroy(fast = false): Promise<void> {
    if (this.shutdown !== null) {
      this.requestForceQuit();
      return this.shutdown;
    }
    this.shutdownStartedAt = Date.now();
    this.shutdown = this.runShutdown(fast);
    return this.shutdown;
  }

  private async runShutdown(fast: boolean): Promise<void> {
    this.scheduler.cancelCronJobs();

    const forceQuit = new Promise<void>((resolve) => {
      this.releaseForceQuit = resolve;
    });

    try {
      await this.scheduler.waitForInProgressSyncs(
        fast ? WAIT_SYNC_FAST_TIMEOUT_MS : WAIT_SYNC_DEFAULT_TIMEOUT_MS,
        forceQuit,
      );
    } catch {}
    this.releaseForceQuit = null;

    const hookLines = this.describeTerminatedHooks(await this.hookExecutionService.cleanup());
    for (const line of hookLines) {
      this.addLog(line, "warn");
    }

    this.isDestroyed = true;
    if (this.app) {
      this.app.unmount();
      this.app = null;
    }
    this.mouse.disable();
    this.writeLines(hookLines);
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

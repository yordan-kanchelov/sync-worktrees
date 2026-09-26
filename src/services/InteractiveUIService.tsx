import React from "react";
import type { Instance } from "ink";
import { render } from "ink";
import pLimit from "p-limit";
import App from "../components/App";
import { DEFAULT_CONFIG } from "../constants";
import { WorktreeSyncService } from "./worktree-sync.service";
import { ConfigLoaderService } from "./config-loader.service";
import { HookExecutionService } from "./hook-execution.service";
import type { LogOutputFn, LogLevel } from "./logger.service";
import { Logger } from "./logger.service";
import { RepositoryOperations } from "./repository-operations";
import { SyncCycleScheduler, WAIT_SYNC_DEFAULT_TIMEOUT_MS, WAIT_SYNC_FAST_TIMEOUT_MS } from "./sync-cycle-scheduler";
import { TerminalLauncher } from "./terminal-launcher";
import { formatCloneSkipReason } from "../utils/clone-skip-format";
import { getErrorMessage } from "../utils/errors";
import { calculateSyncDiskSpace } from "../utils/disk-space";
import { DiskUsageCache } from "../utils/disk-usage-cache";
import { getDefaultBareRepoDir, repoDisplayLabel } from "../utils/git-url";
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
  /** `--debug`: forced onto every repository, including those a reload loads. */
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
  /** Cron jobs, the cycles in flight and the syncing/idle status they drive. */
  public readonly scheduler: SyncCycleScheduler;
  /** Every non-sync action the TUI takes on a repository; the only way it reaches git. */
  public readonly operations: RepositoryOperations;
  /** The editor and terminal "open" actions. */
  public readonly launcher: TerminalLauncher;

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
    // One number, and it is the parallelism setting, not a display one. The
    // progress pane happens to want one line per repository that can be syncing
    // at once, so it is fed from here; the disk walks are I/O and must never be
    // widened by someone lengthening a pane.
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

    // Add initial log after a short delay to verify the pipeline works
    setTimeout(() => {
      this.addLog("🚀 sync-worktrees UI initialized", "info");
    }, 100);
  }

  /**
   * The `--filter` the CLI started with. A config reload rebuilds the
   * repository list from the file, and without this it would quietly widen a
   * filtered session back to every repository.
   */
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
    this.progressUnsubscribers = this.syncServices.map((service, index) =>
      this.subscribeToProgress(service, this.operations.getRepoName(index)),
    );
  }

  // Pulled out of the loop above so a service can be watched before it joins
  // `syncServices` — a reload's initialize() is the longest thing the interface
  // ever waits on and reports the clone it is running through this emitter.
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
    if (this.app) {
      this.app.unmount();
    }

    // Every repository action goes through the operations facade, never
    // through a sync service's GitService directly.
    const ops = this.operations;
    this.app = render(
      <App
        events={this.events}
        repositoryCount={this.repositoryCount}
        cronSchedule={this.scheduler.getScheduledCronExpressions()}
        maxProgressLines={this.maxRepositories}
        onManualSync={() => this.handleManualSync()}
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
    await this.scheduler.runSyncCycle(this.syncServices, { logErrors: true });
  }

  private async handleReload(): Promise<void> {
    if (this.reloadInProgress) {
      return;
    }
    this.reloadInProgress = true;
    let cronJobsCancelled = false;
    // A reload runs a sync of its own, so it is a cycle as far as the status
    // bar is concerned — and it is not the only one that can be running. Both
    // of its `idle`s used to be unconditional, which put whichever of the two
    // finished first in a position to blank the other's progress rows and
    // re-arm the `s`/`x`/`r` guards mid-fetch. Opened here rather than after
    // the wait below, so that every exit from this method closes it exactly
    // once — including the one that leaves because there is no config file.
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

      // Validate and load new config BEFORE canceling old cron jobs
      // to prevent a window with no cron running on validation failure
      const configLoader = new ConfigLoaderService();
      const { repositories } = await configLoader.buildRepositories(this.configPath, {
        debug: this.debugOverride,
        filter: this.repositoryFilter,
      });
      // An edit that leaves the --filter matching nothing would otherwise
      // surface below as "No repositories could be initialized", which blames
      // the repositories rather than the filter. Either way the old services
      // and their cron jobs stay in place.
      if (repositories.length === 0 && this.repositoryFilter) {
        throw new Error(`No repositories match filter: ${this.repositoryFilter}`);
      }

      const initResults = await Promise.allSettled(
        repositories.map((repoConfig) =>
          this.limit(async () => {
            // Before construction, not after: initialize() logs (fetch
            // progress, metadata repair, status probe failures) through the
            // logger each sub-service was handed when it was built.
            repoConfig.logger = this.createServiceLogger(repoConfig);
            const service = new WorktreeSyncService(repoConfig);
            // For the same window and the same reason: a clone reports its
            // progress through the emitter rather than the logger, and these
            // services are only watched by subscribeToServiceProgress() once
            // every initialize() has resolved. Dropped again here — the ones
            // that survive are re-subscribed below, the ones that failed are
            // discarded.
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
          // allSettled keeps the order of what it was handed, and it was handed
          // repositories.map(...), so index is this repository. Its name has to
          // come from there: a rejected init never returned a service to read
          // one off, and a git failure ('Permission denied (publickey)') names
          // nothing the user can find in the config.
          const failed = repositories[index];
          this.addLog(`Failed to initialize repository '${repoDisplayLabel(failed)}': ${result.reason}`, "error");
        }
      }

      if (newServices.length === 0) {
        throw new Error("No repositories could be initialized from the configuration");
      }

      // `q` pressed while the new config was loading: the shutdown has already
      // released the cron jobs and is waiting on the syncs it could see, so
      // swapping in services and syncing them now would outlive that wait.
      if (this.shutdown !== null) {
        this.addLog("Shutting down; reload abandoned.", "info");
        return;
      }

      // Cancel old cron jobs only after new config is validated and services initialized
      this.scheduler.cancelCronJobs();
      cronJobsCancelled = true;

      this.syncServices = newServices;
      // initialize() above can clone a bare repository or lay down worktrees,
      // and a cycle in which every repository is skipped never rebuilds the
      // header total -- so drop what the cache holds for these paths rather
      // than serve the status view a figure from before the reload.
      for (const service of newServices) {
        this.diskUsage.invalidate(service.config.bareRepoDir || getDefaultBareRepoDir(service.config.repoUrl));
        this.diskUsage.invalidate(service.config.worktreeDir);
      }
      this.repositoryCount = this.syncServices.length;
      this.subscribeToServiceProgress();
      // Not injectLoggersIntoServices(): these services were built with their
      // panel logger already in config, above. Injecting again would build a
      // second Logger per repository and leave config.logger pointing at the
      // first, dead one. Startup still needs the injection, because there the
      // services exist before the UI that owns the panel does.

      const uniqueSchedules = [...new Set(this.syncServices.map((s) => s.config.cronSchedule))];
      this.scheduler.defaultSchedule = uniqueSchedules.length === 1 ? uniqueSchedules[0] : undefined;

      this.scheduler.setupCronJobs();

      this.events.emit("updateRepositoryCount", this.repositoryCount);
      this.events.emit("updateCronSchedule", this.scheduler.getScheduledCronExpressions());

      // The reload's sync is a cycle like any other, so it claims the
      // repositories it is about to sync. `setupCronJobs()` just above has
      // already armed the new schedules, so a tick landing inside this await is
      // routine — and without the claim it would reach clearRecordedSkips() for
      // every repository the reload is syncing, which is the one thing the
      // claim exists to prevent.
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

  // Shutdown progress is the one thing a user needs while the interface is
  // waiting on a sync, and on the Ctrl+C path Ink has already put the terminal
  // back on the primary buffer, so the log panel it would go to is gone. Write
  // those lines to the stream as well, or the process just looks hung.
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
    // The one guarded write to the stream, shared by every line teardown puts
    // there. The guard is for a stream that refuses the write outright - stdout
    // is injected here, so it is not always a live tty - and not for EPIPE,
    // which a stream reports through an "error" event that no synchronous catch
    // could ever see. What it buys is that a stream saying no does not abandon
    // the rest of teardown, which is what puts the terminal back.
    try {
      for (const line of lines) {
        this.stdout.write(`${line}\n`);
      }
    } catch {
      // Nothing left to report it to.
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
      const bareRepoDirs = this.syncServices.map(
        (service) => service.config.bareRepoDir || getDefaultBareRepoDir(service.config.repoUrl),
      );
      const worktreeDirs = this.syncServices.map((service) => service.config.worktreeDir);

      const diskSpace = await calculateSyncDiskSpace(bareRepoDirs, worktreeDirs, (dirPath) =>
        this.diskUsage.refresh(dirPath),
      );
      this.setDiskSpace(diskSpace);
    } catch (error) {
      this.addLog(`Failed to calculate disk space: ${error instanceof Error ? error.message : String(error)}`, "error");
      this.setDiskSpace("N/A");
    }
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
    this.scheduler.cancelCronJobs();

    const forceQuit = new Promise<void>((resolve) => {
      this.releaseForceQuit = resolve;
    });

    try {
      await this.scheduler.waitForInProgressSyncs(
        fast ? WAIT_SYNC_FAST_TIMEOUT_MS : WAIT_SYNC_DEFAULT_TIMEOUT_MS,
        forceQuit,
      );
    } catch {
      // Best effort - proceed with teardown even if syncs don't finish
    }
    this.releaseForceQuit = null;

    // Before isDestroyed, which silences addLog: killing the user's in-flight
    // `npm ci` is the one part of teardown they have to be told about, and the
    // lines are repeated on the stream below because on a plain `q` the log
    // panel is torn down a few statements later and never read. Awaited, and
    // not only for the list: the exit that follows this method closes the pipes
    // the hooks hold, so a hook trapping SIGTERM only gets to act on it because
    // cleanup() holds the process open until it has.
    const hookLines = this.describeTerminatedHooks(await this.hookExecutionService.cleanup());
    for (const line of hookLines) {
      this.addLog(line, "warn");
    }

    this.isDestroyed = true;
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

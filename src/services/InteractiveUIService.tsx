import React from "react";
import * as path from "path";
import type { Instance } from "ink";
import { render } from "ink";
import * as cron from "node-cron";
import pLimit from "p-limit";
import { spawn, spawnSync } from "child_process";
import type { ChildProcess } from "child_process";
import { existsSync } from "fs";
import type { Dirent } from "fs";
import App from "../components/App";
import { DEFAULT_CONFIG } from "../constants";
import { GitOperationError } from "../errors";
import { WorktreeSyncService } from "./worktree-sync.service";
import type { GitService } from "./git.service";
import { ConfigLoaderService } from "./config-loader.service";
import { BranchCreatedActionsService } from "./branch-created-actions.service";
import { HookExecutionService } from "./hook-execution.service";
import { PathResolutionService } from "./path-resolution.service";
import type { LogOutputFn, LogLevel } from "./logger.service";
import type { WorktreeStatusResult } from "./worktree-status.service";
import { Logger } from "./logger.service";
import { formatCloneSkipReason } from "../utils/clone-skip-format";
import { getErrorMessage } from "../utils/lfs-error";
import { appendGitAuthHint } from "../utils/git-auth-error";
import { formatRepoLockUnavailable } from "../utils/repo-lock-format";
import { calculateSyncDiskSpace } from "../utils/disk-space";
import { DiskUsageCache } from "../utils/disk-usage-cache";
import { getDefaultBareRepoDir, redactSecretsInText } from "../utils/git-url";
import { AppEventEmitter } from "../utils/app-events";
import { createMouseTracking } from "../utils/mouse";
import type { MouseTracking } from "../utils/mouse";
import { resolveMode } from "../utils/repo-mode";
import { shellEscape } from "../utils/shell-escape";
import * as fs from "fs/promises";
import { formatBytes } from "../utils/disk-space";
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

const DEFAULT_EDITOR = "code";
// A launcher that exits non-zero inside this window never opened a window; one that exits
// later ran and was closed, which is the user's business and not a launch failure.
const LAUNCH_FAILURE_WINDOW_MS = 5000;
const TERMINAL_EDITOR_BASENAMES = new Set(["vi", "vim", "nvim", "nano", "pico", "micro", "helix", "hx", "kak"]);
const EMACS_BASENAMES = new Set(["emacs", "emacsclient"]);
const EMACS_TTY_FLAGS = new Set(["-nw", "--no-window-system", "-t", "--tty"]);
// `-g` is a GUI flag to vim and to nobody else on the list: measured here, `vim -g` and `vi -g`
// reach vim's own parser and answer "E25: GUI cannot be used", while nano and pico read `-g` as
// --showcursor, helix as --grammar and emacs as --geometry, and nvim has no `-g` at all. So the
// escape hatch is scoped to the family that defines it instead of being read off any argv.
const VIM_BASENAMES = new Set(["vi", "vim"]);
const VIM_GUI_FLAGS = new Set(["-g"]);
// Exec flags a user may already have written into the override or $TERMINAL, where appending a
// second one would make it an argument to the first. Derived from the table below so a new
// entry there is recognised here too.
const TERMINAL_EXEC_FLAGS = new Set<string>([
  TERMINAL_CONSTANTS.DEFAULT_EXEC_FLAG,
  ...Object.values(TERMINAL_CONSTANTS.EXEC_FLAG_OVERRIDES),
]);

/**
 * Heuristic, and deliberately failing open: an editor we do not recognise is treated as a GUI
 * editor, which is exactly today's behaviour, so nothing that works now starts being refused.
 * Unknown terminal editors are caught a moment later by the non-zero exit instead. A flag beats
 * the basename only for the family whose own parser defines that flag, and an explicit terminal
 * flag wins over a GUI one: `emacs -nw` is refused even with `-g` on the line, `vim -g` is not.
 */
function isTerminalEditor(command: string, args: string[]): boolean {
  const base = path.basename(command);
  // emacs draws a window unless told otherwise, so for that family the tty flags decide alone.
  // They cannot be read off any other editor's argv: `-t` is vim's "edit where tag is defined".
  if (EMACS_BASENAMES.has(base)) return args.some((arg) => EMACS_TTY_FLAGS.has(arg));
  if (!TERMINAL_EDITOR_BASENAMES.has(base)) return false;
  return !(VIM_BASENAMES.has(base) && args.some((arg) => VIM_GUI_FLAGS.has(arg)));
}

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
  private diskUsage: DiskUsageCache;
  private maxRepositories: number;
  private reloadInProgress = false;
  // Which repositories a cycle currently owns, and how many cycles are running.
  // Both are properties of the set of cycles in flight, not of whichever one
  // happens to finish first -- see runSyncCycle.
  private syncingServices = new Set<WorktreeSyncService>();
  private activeSyncCycles = 0;
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
        maxProgressLines={this.maxRepositories}
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
    // A reload runs a sync of its own, so it is a cycle as far as the status
    // bar is concerned — and it is not the only one that can be running. Both
    // of its `idle`s used to be unconditional, which put whichever of the two
    // finished first in a position to blank the other's progress rows and
    // re-arm the `s`/`x`/`r` guards mid-fetch. Opened here rather than after
    // the wait below, so that every exit from this method closes it exactly
    // once — including the one that leaves because there is no config file.
    this.beginSyncCycle();
    let cycleOpen = true;
    const closeCycle = (): void => {
      if (!cycleOpen) return;
      cycleOpen = false;
      this.endSyncCycle();
    };
    try {
      if (!this.configPath) {
        return;
      }

      await this.waitForInProgressSyncs();

      this.addLog("Reloading configuration...");

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
      this.cronSchedule = uniqueSchedules.length === 1 ? uniqueSchedules[0] : undefined;

      this.setupCronJobs();

      this.events.emit("updateRepositoryCount", this.repositoryCount);
      this.events.emit("updateCronSchedule", this.cronSchedule);

      // The reload's sync is a cycle like any other, so it claims the
      // repositories it is about to sync. `setupCronJobs()` just above has
      // already armed the new schedules, so a tick landing inside this await is
      // routine — and without the claim it would reach clearRecordedSkips() for
      // every repository the reload is syncing, which is the one thing the
      // claim exists to prevent.
      const claimed = this.claimForCycle(this.syncServices);
      const {
        failures,
        skipped,
        clonePhaseSkips: syncClonePhaseSkips,
        attempted,
      } = await this.runSyncServices(claimed).finally(() => this.releaseFromCycle(claimed));
      const clonePhaseSkips = [...initClonePhaseSkips, ...syncClonePhaseSkips];
      await this.recordSyncOutcome({ failures, skipped, attempted });
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
        this.setupCronJobs();
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

      const diskSpace = await calculateSyncDiskSpace(bareRepoDirs, worktreeDirs, (dirPath) =>
        this.diskUsage.refresh(dirPath),
      );
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
        const size = await this.diskUsage.size(target.path);
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
    return Promise.all(
      worktrees.map((wt) =>
        limit(async (): Promise<WorktreeStatusEntry> => {
          try {
            const status = await gitService.getFullWorktreeStatus(wt.path, true);
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

        const sizeBytes = await this.diskUsage.size(fullPath).catch(() => 0);
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
    // The directory is gone and the worktree directory that held it is smaller,
    // so both cached figures are now wrong. Without this the status view served
    // the repository's old total for a whole TTL -- across closing and
    // reopening the modal, which is worse than the walk-on-every-open it
    // replaced. The header total is rebuilt on the next cycle, as it was
    // before.
    this.diskUsage.invalidate(targetPath);
    this.diskUsage.invalidate(worktreeDir);
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
    const editor = process.env.EDITOR || process.env.VISUAL || DEFAULT_EDITOR;
    // EDITOR may include flags (e.g. "code -w") and a quoted path may contain spaces;
    // spawn without a shell treats the whole string as the binary name, so split it as a
    // shell would.
    const parsed = this.parseCommandString(editor);
    if (!parsed) {
      // Only a set-but-blank EDITOR/VISUAL reaches here: unset and empty are falsy and already
      // fell through to the default above. Quietly editing with something else instead would
      // be the same silent substitution this method exists to stop.
      const message = "EDITOR/VISUAL is set to whitespace only; set it to an editor command";
      this.addLog(message, "error");
      return { success: false, error: message };
    }
    const { command, args: editorArgs } = parsed;

    if (isTerminalEditor(command, editorArgs)) {
      // Refuse rather than spawn: detached with stdio "ignore" there is no TTY, so the editor
      // reads EOF and exits within about two seconds having drawn nothing. Reporting that as
      // success is the defect. Terminal mode runs tmux in an emulator, which is where a terminal
      // editor can really run -- but only if an emulator resolves, so ask before sending anyone
      // there: on a headless host the probe finds none and that advice is a second dead end.
      const remedy = this.resolveTerminalLauncher("")
        ? "use Terminal mode, or set EDITOR/VISUAL to a GUI editor"
        : "no emulator is available for Terminal mode either, so set EDITOR/VISUAL to a GUI editor";
      const message = `'${editor}' is a terminal editor and has no TTY here; ${remedy}`;
      this.addLog(message, "error");
      return { success: false, error: message };
    }

    try {
      const child = spawn(command, [...editorArgs, worktreePath], {
        detached: true,
        stdio: "ignore",
      });

      child.on("error", (err) => {
        this.addLog(`Failed to open editor '${editor}': ${err.message}`, "error");
        this.addLog("Set EDITOR or VISUAL environment variable to your preferred editor", "warn");
      });

      this.reportLauncherExit(
        child,
        "Editor",
        editor,
        // Deliberately not a diagnosis: nothing here knows why the child stopped, and the same
        // exit arrives from a terminal editor, a GUI editor with no display, a bad flag and a
        // missing library alike. The error line above names the command and the status.
        "Check EDITOR/VISUAL and its flags: a terminal editor needs a TTY, a GUI editor needs a display",
      );
      child.unref();

      // Success here means "launched", not "still running": the spawn is detached so the
      // outcome is only knowable later, and reportLauncherExit logs it when it arrives.
      return { success: true };
    } catch (err) {
      // Not the missing-binary case: a command that does not exist makes spawn return a
      // child with no pid and emit "error" asynchronously, which the handler above logs.
      // Only a bad call reaches here, e.g. arguments spawn rejects outright.
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.addLog(`Failed to open editor '${editor}': ${errorMessage}`, "error");
      return { success: false, error: errorMessage };
    }
  }

  private reportLauncherExit(child: ChildProcess, kind: string, command: string, hint: string): void {
    // The child is detached and unref'd, so it cannot be awaited without holding the TUI
    // open. The exit event still fires while the TUI lives, which costs nothing and blocks
    // nothing; after quit addLog is a no-op, so a late exit cannot reopen a closed wizard.
    const startedAt = Date.now();
    child.on("exit", (code, signal) => {
      if (Date.now() - startedAt >= LAUNCH_FAILURE_WINDOW_MS) return;
      // A child killed by a signal reports code null with the signal set, so a code-only guard
      // drops exactly the crash worth hearing about: measured here, a launcher that segfaults
      // or aborts arrives 3ms in with code null, and the wizard had already said success.
      const outcome =
        signal !== null
          ? `was killed by ${signal}`
          : code !== null && code !== 0
            ? `exited immediately with code ${code}`
            : null;
      if (outcome === null) return;
      this.addLog(`${kind} '${command}' ${outcome} — nothing was opened`, "error");
      this.addLog(hint, "warn");
    });
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

      this.reportLauncherExit(
        child,
        "Terminal",
        launcher.command,
        `Check ${TERMINAL_CONSTANTS.ENV_OVERRIDE}: the emulator has to accept a trailing 'sh -c <command>'`,
      );
      child.unref();

      return { success: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.addLog(`Failed to open terminal '${launcher.command}': ${errorMessage}`, "error");
      return { success: false, error: errorMessage };
    }
  }

  private resolveTerminalLauncher(tmuxCommand: string): { command: string; args: string[] } | null {
    // The tmux command is wrapped in `sh -c` so emulators that exec their trailing argv as a
    // program name (`alacritty -e`, `kitty -e`) can run the composite command -- which means
    // every branch below needs an exec flag, and they all get it from terminalExecArgs.
    const override = this.parseCommandString(process.env[TERMINAL_CONSTANTS.ENV_OVERRIDE]);
    if (override) {
      return {
        command: override.command,
        args: [...this.terminalExecArgs(override.command, override.args), "sh", "-c", tmuxCommand],
      };
    }

    switch (process.platform) {
      case "darwin": {
        // Ghostty cannot be launched directly from the CLI on macOS; use `open -na` instead.
        const ghosttyPaths = ["/Applications/Ghostty.app", `${process.env.HOME}/Applications/Ghostty.app`];
        if (ghosttyPaths.some((p) => existsSync(p))) {
          return {
            command: "open",
            // The flag is Ghostty's, not `open`'s, so it comes from the same table as the rest.
            args: ["-na", "Ghostty.app", "--args", ...this.terminalExecArgs("ghostty", []), "sh", "-c", tmuxCommand],
          };
        }
        const escapedTmuxCommand = tmuxCommand.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const script = `tell application "Terminal" to do script "${escapedTmuxCommand}"`;
        return { command: "osascript", args: ["-e", script] };
      }
      case "linux": {
        const envTerminal = this.parseCommandString(process.env[TERMINAL_CONSTANTS.ENV_FALLBACK]);
        if (envTerminal) {
          const args = this.terminalExecArgs(envTerminal.command, envTerminal.args);
          return { command: envTerminal.command, args: [...args, "sh", "-c", tmuxCommand] };
        }
        for (const candidate of TERMINAL_CONSTANTS.LINUX_CANDIDATES) {
          if (this.commandExists(candidate)) {
            return { command: candidate, args: [...this.terminalExecArgs(candidate, []), "sh", "-c", tmuxCommand] };
          }
        }
        return null;
      }
      default:
        return null;
    }
  }

  private terminalExecArgs(command: string, args: string[]): string[] {
    // One lookup for every launcher path, so the override, the $TERMINAL fallback and the
    // candidate probe can no longer disagree about which flag an emulator wants. A user who
    // already wrote an exec flag keeps theirs: a second one would be an argument to the first.
    if (args.some((arg) => TERMINAL_EXEC_FLAGS.has(arg))) return args;
    const overrides: Readonly<Record<string, string | undefined>> = TERMINAL_CONSTANTS.EXEC_FLAG_OVERRIDES;
    return [...args, overrides[path.basename(command)] ?? TERMINAL_CONSTANTS.DEFAULT_EXEC_FLAG];
  }

  private parseCommandString(raw: string | undefined): { command: string; args: string[] } | null {
    if (!raw || raw.trim().length === 0) return null;
    // Split the way a shell would: a quoted path keeps its spaces instead of becoming
    // several broken argv entries. An unterminated quote closes at end of string so a
    // typo degrades to a best-effort argv rather than silently dropping the setting.
    const parts: string[] = [];
    let current = "";
    let quote: string | null = null;
    let started = false;

    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (quote !== null) {
        if (ch === quote) {
          quote = null;
        } else if (quote === '"' && ch === "\\" && (raw[i + 1] === '"' || raw[i + 1] === "\\")) {
          current += raw[++i];
        } else {
          current += ch;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        started = true;
      } else if (ch === "\\" && i + 1 < raw.length) {
        current += raw[++i];
        started = true;
      } else if (/\s/.test(ch)) {
        if (started) parts.push(current);
        current = "";
        started = false;
      } else {
        current += ch;
        started = true;
      }
    }
    if (started) parts.push(current);
    if (parts.length === 0) return null;
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

  private repoLabel(service: WorktreeSyncService): string {
    return (service.config as RepositoryConfig).name || service.config.repoUrl;
  }

  // A cycle takes the repositories no other cycle holds, and leaves the rest to
  // the cycle that holds them.
  private claimForCycle(services: WorktreeSyncService[]): WorktreeSyncService[] {
    const claimed = services.filter((service) => !this.syncingServices.has(service));
    for (const service of claimed) {
      this.syncingServices.add(service);
    }
    return claimed;
  }

  private releaseFromCycle(services: WorktreeSyncService[]): void {
    for (const service of services) {
      this.syncingServices.delete(service);
    }
  }

  // Status is a property of the set of cycles in flight: the first one in says
  // "syncing", and only the last one out says "idle".
  private beginSyncCycle(): void {
    this.activeSyncCycles += 1;
    if (this.activeSyncCycles === 1) {
      this.setStatus("syncing");
    }
  }

  private endSyncCycle(): void {
    if (this.activeSyncCycles > 0) {
      this.activeSyncCycles -= 1;
    }
    if (this.activeSyncCycles === 0) {
      this.setStatus("idle");
    }
  }

  private async runSyncCycle(
    services: WorktreeSyncService[],
    options: { logErrors: boolean },
  ): Promise<Array<{ repo: string; error: string }>> {
    // Cycles overlap by design: the daemon starts a sync and arms the cron jobs
    // in the same breath, node-cron leaves the next tick free to land inside a
    // slow one, two schedules put two groups on the same minute, and `s` starts
    // one by hand. Two things must not be shared across them.
    //
    // The repository is the first. WorktreeSyncService's repoMutex already
    // refuses the second caller's work (`in_progress`), so nothing races the
    // repository itself — but the losing cycle still got far enough to call
    // clearRecordedSkips() on every service before it learned it could not run,
    // wiping the clone-mode skips the in-flight cycle had accumulated (sync()
    // clears that accumulator inside the lock precisely so a loser cannot
    // truncate the winner's payload). So a cycle claims only the repositories
    // no other cycle holds, and reports the rest as the skips they are —
    // without which a second cron group would starve behind the first for as
    // long as it ran.
    //
    // The status is the second. It belongs to the set of cycles in flight, not
    // to whichever finishes first: driving it from this method's `finally`
    // blanked a running cycle's progress rows and re-armed the `s`/`x`/`r`
    // guards while that cycle was still fetching.
    const claimed = this.claimForCycle(services);
    if (claimed.length === 0) {
      this.addLog("A sync is already running; skipping this cycle.", "info");
      return [];
    }
    const claimedSet = new Set(claimed);
    const deferred = services
      .filter((service) => !claimedSet.has(service))
      .map((service) => ({ repo: this.repoLabel(service), reason: "sync skipped: in_progress" }));

    this.beginSyncCycle();

    try {
      const { failures, skipped, partialSkips, clonePhaseSkips, attempted } = await this.runSyncServices(claimed);
      const allSkipped = [...deferred, ...skipped];

      if (options.logErrors) {
        for (const failure of failures) {
          this.addLog(`Failed to sync repository '${failure.repo}': ${failure.error}`, "error");
        }
      }
      for (const skip of allSkipped) {
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

      await this.recordSyncOutcome({ failures, skipped: allSkipped, attempted: attempted + deferred.length });
      return failures;
    } finally {
      this.releaseFromCycle(claimed);
      this.endSyncCycle();
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
        const repoName = this.repoLabel(service);
        return this.limit(async () => {
          service.clearRecordedSkips();
          // A sync that fail-fasted never owned this repository, so it has no
          // progress row of its own to close: the row on screen belongs to
          // whoever does own it — another cycle, another process, an
          // interactive operation holding the repo mutex — and `completed`
          // would take that row away mid-fetch. Everything else, including a
          // sync that threw, still has to close its row.
          let ownedProgressRow = true;
          try {
            if (!service.isInitialized()) {
              await service.initialize();
            }
            const result = await service.sync();
            if (result?.started === false) {
              ownedProgressRow = false;
            }
            return { service, result };
          } finally {
            if (ownedProgressRow) {
              this.events.emit("setSyncProgress", {
                repo: repoName,
                phase: "complete",
                message: "Finished",
                completed: true,
              });
            }
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
      const repoName = this.repoLabel(services[i]);
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

import * as cron from "node-cron";
import type pLimit from "p-limit";
import type { WorktreeSyncService } from "./worktree-sync.service";
import type { RepositoryDashboard } from "./repository-dashboard";
import type { RepositoryConfig } from "../types";
import type { AppEventEmitter, LastSyncOutcome } from "../utils/app-events";
import { formatCloneSkipReason } from "../utils/clone-skip-format";
import { getErrorMessage } from "../utils/errors";
import { formatRepoLockUnavailable } from "../utils/repo-lock-format";
import { formatDuration } from "../utils/timing";

export const WAIT_SYNC_FAST_TIMEOUT_MS = 2000;
export const WAIT_SYNC_DEFAULT_TIMEOUT_MS = 30000;

type RepoMessage = { repo: string; error: string };
type RepoReason = { repo: string; reason: string };

export interface SyncServicesResult {
  failures: RepoMessage[];
  skipped: RepoReason[];
  partialSkips: RepoReason[];
  clonePhaseSkips: RepoReason[];
  attempted: number;
}

export interface SyncCycleHost {
  readonly events: AppEventEmitter;
  /** The parallelism limit shared with reload and the repository operations. */
  readonly limit: ReturnType<typeof pLimit>;
  /** The current generation of repositories; a reload replaces it. */
  getServices(): readonly WorktreeSyncService[];
  /** True once quitting has begun: no cycle starts and no cron job is armed after that. */
  isShuttingDown(): boolean;
  log(message: string, level: "info" | "warn" | "error"): void;
  /** A line about waiting on syncs, which must reach the user even once Ink has let go of the screen. */
  notice(message: string, level: "info" | "warn"): void;
  setStatus(status: "idle" | "syncing"): void;
  setLastSyncOutcome(outcome: LastSyncOutcome): void;
  updateLastSyncTime(): void;
  refreshDiskSpace(): Promise<void>;
  /** Told as each repository's sync starts and settles; feeds the home screen's table. */
  readonly dashboard?: Pick<RepositoryDashboard, "markSyncing" | "recordSettlement">;
}

/**
 * The interactive daemon's sync cycles: the cron jobs that start them, the
 * set of repositories each cycle in flight has claimed, and the syncing/idle
 * status that belongs to that set rather than to any one cycle.
 */
export class SyncCycleScheduler {
  private cronJobs: cron.ScheduledTask[] = [];
  // Which repositories a cycle currently owns, and how many cycles are running.
  // Both are properties of the set of cycles in flight, not of whichever one
  // happens to finish first -- see runSyncCycle.
  private syncingServices = new Set<WorktreeSyncService>();
  private activeSyncCycles = 0;

  /**
   * @param defaultSchedule the schedule a repository without its own
   *   `cronSchedule` runs on; a reload replaces it.
   */
  constructor(
    private readonly host: SyncCycleHost,
    public defaultSchedule?: string,
  ) {}

  /** The schedule a cron job runs this repository on, or undefined when none does. */
  public scheduleFor(service: WorktreeSyncService): string | undefined {
    if (service.config.runOnce) return undefined;
    return service.config.cronSchedule || this.defaultSchedule || undefined;
  }

  private groupBySchedule(): Map<string, WorktreeSyncService[]> {
    const scheduleGroups = new Map<string, WorktreeSyncService[]>();

    for (const service of this.host.getServices()) {
      const schedule = this.scheduleFor(service);
      if (!schedule) continue;

      if (!scheduleGroups.has(schedule)) {
        scheduleGroups.set(schedule, []);
      }
      scheduleGroups.get(schedule)!.push(service);
    }
    return scheduleGroups;
  }

  // Every schedule a cron job runs on, which is what "Next Sync" is computed
  // across. Repositories on different schedules used to blank it.
  public getScheduledCronExpressions(): string[] {
    return [...this.groupBySchedule().keys()];
  }

  public setupCronJobs(): void {
    // A reload that was already past its checks when `q` was pressed ends
    // here, and so does its failure path: re-arming would bring back the jobs
    // the shutdown just released and keep the daemon syncing while it exits.
    if (this.host.isShuttingDown()) return;

    for (const [schedule, services] of this.groupBySchedule()) {
      const task = cron.schedule(schedule, async () => {
        await this.runSyncCycle(services, { logErrors: false });
      });
      this.cronJobs.push(task);
    }
  }

  public cancelCronJobs(): void {
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
            this.host.log(`Failed to release cron task: ${getErrorMessage(error)}`, "warn");
          });
        }
      } catch (error) {
        this.host.log(`Failed to release cron task: ${getErrorMessage(error)}`, "warn");
      }
    }
  }

  public registerCronJob(job: cron.ScheduledTask): void {
    this.cronJobs.push(job);
  }

  public async waitForInProgressSyncs(
    timeoutMs: number = WAIT_SYNC_DEFAULT_TIMEOUT_MS,
    abort?: Promise<void>,
  ): Promise<void> {
    const inProgressServices = this.host.getServices().filter((s) => s.isSyncInProgress());

    if (inProgressServices.length === 0) {
      return;
    }

    const hint = abort ? " Press q or Ctrl+C again to quit now." : "";
    this.host.notice(`Waiting for ${inProgressServices.length} in-progress sync(s) to finish...${hint}`, "info");

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
      this.host.notice(
        `Warning: Timeout waiting for sync operations to complete after ${formatDuration(timeoutMs)}. Proceeding with potential data loss risk.`,
        "warn",
      );
    } else if (outcome === "forced") {
      this.host.notice("Force quit: leaving in-progress sync(s) unfinished.", "warn");
    }
  }

  private repoLabel(service: WorktreeSyncService): string {
    return (service.config as RepositoryConfig).name || service.config.repoUrl;
  }

  // A cycle takes the repositories no other cycle holds, and leaves the rest to
  // the cycle that holds them.
  public claimForCycle(services: readonly WorktreeSyncService[]): WorktreeSyncService[] {
    const claimed = services.filter((service) => !this.syncingServices.has(service));
    for (const service of claimed) {
      this.syncingServices.add(service);
    }
    return claimed;
  }

  public releaseFromCycle(services: readonly WorktreeSyncService[]): void {
    for (const service of services) {
      this.syncingServices.delete(service);
    }
  }

  // Status is a property of the set of cycles in flight: the first one in says
  // "syncing", and only the last one out says "idle".
  public beginSyncCycle(): void {
    this.activeSyncCycles += 1;
    if (this.activeSyncCycles === 1) {
      this.host.setStatus("syncing");
    }
  }

  public endSyncCycle(): void {
    if (this.activeSyncCycles > 0) {
      this.activeSyncCycles -= 1;
    }
    if (this.activeSyncCycles === 0) {
      this.host.setStatus("idle");
    }
  }

  public async runSyncCycle(
    services: readonly WorktreeSyncService[],
    options: { logErrors: boolean },
  ): Promise<RepoMessage[]> {
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
    //
    // And none starts once quitting has begun: `s` stays live while `q` waits
    // for the running sync, and a cycle started now would be one more thing
    // that wait has to outlast.
    if (this.host.isShuttingDown()) {
      // The key handler already put the bar on "syncing" for this press.
      if (this.activeSyncCycles === 0) this.host.setStatus("idle");
      return [];
    }
    const claimed = this.claimForCycle(services);
    if (claimed.length === 0) {
      this.host.log("A sync is already running; skipping this cycle.", "info");
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
          this.host.log(`Failed to sync repository '${failure.repo}': ${failure.error}`, "error");
        }
      }
      for (const skip of allSkipped) {
        this.host.log(`Sync skipped for '${skip.repo}': ${skip.reason}`, "warn");
      }
      for (const skip of clonePhaseSkips) {
        this.host.log(`Clone-mode skip for '${skip.repo}': ${skip.reason}`, "warn");
      }
      if (clonePhaseSkips.length > 0) {
        this.host.log(`⚠️  ${clonePhaseSkips.length} clone-mode skip(s) this cycle`, "warn");
      }
      for (const partial of partialSkips) {
        this.host.log(`${partial.repo}: ${partial.reason}`, "info");
      }

      await this.recordSyncOutcome({ failures, skipped: allSkipped, attempted: attempted + deferred.length });
      return failures;
    } finally {
      this.releaseFromCycle(claimed);
      this.endSyncCycle();
    }
  }

  public async recordSyncOutcome(outcome: {
    failures: RepoMessage[];
    skipped: RepoReason[];
    attempted: number;
  }): Promise<void> {
    const allSkipped =
      outcome.attempted > 0 && outcome.skipped.length === outcome.attempted && outcome.failures.length === 0;
    // Before the early return: a cycle in which nothing ran leaves "Last Sync"
    // where it was, but the bar still has to stop claiming the last one was OK.
    this.host.setLastSyncOutcome(
      outcome.failures.length > 0
        ? { kind: "failed", count: outcome.failures.length }
        : outcome.skipped.length > 0
          ? { kind: "skipped", count: outcome.skipped.length }
          : { kind: "ok" },
    );
    if (allSkipped) return;
    this.host.updateLastSyncTime();
    await this.host.refreshDiskSpace();
  }

  public async runSyncServices(services: readonly WorktreeSyncService[]): Promise<SyncServicesResult> {
    const dashboard = this.host.dashboard;
    const syncResults = await Promise.allSettled(
      services.map((service) => {
        const repoName = this.repoLabel(service);
        const settled = this.host
          .limit(async () => {
            dashboard?.markSyncing(service);
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
                this.host.events.emit("setSyncProgress", {
                  repo: repoName,
                  phase: "complete",
                  message: "Finished",
                  completed: true,
                });
              }
            }
          })
          .catch((error) => {
            throw Object.assign(error instanceof Error ? error : new Error(String(error)), { repoName });
          });
        // Each row settles as its own repository does, not when the slowest
        // repository of the cycle does. A branch of its own: the rejection is
        // still the allSettled below's to count.
        if (dashboard) {
          void settled.then(
            ({ result }) => dashboard.recordSettlement(service, { status: "fulfilled", result }),
            (error: unknown) => dashboard.recordSettlement(service, { status: "rejected", error }),
          );
        }
        return settled;
      }),
    );

    const failures: RepoMessage[] = [];
    const skipped: RepoReason[] = [];
    const partialSkips: RepoReason[] = [];
    const clonePhaseSkips: RepoReason[] = [];
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
}

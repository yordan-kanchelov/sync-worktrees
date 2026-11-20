import * as cron from "node-cron";
import type pLimit from "p-limit";
import type { WorktreeSyncService } from "./worktree-sync.service";
import type { RepositoryDashboard } from "./repository-dashboard";
import type { AppEventEmitter, LastSyncOutcome } from "../utils/app-events";
import { formatCloneSkipReason } from "../utils/clone-skip-format";
import { getErrorMessage } from "../utils/errors";
import { repoDisplayLabel } from "../utils/git-url";
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
  readonly limit: ReturnType<typeof pLimit>;
  getServices(): readonly WorktreeSyncService[];
  isShuttingDown(): boolean;
  log(message: string, level: "info" | "warn" | "error"): void;
  notice(message: string, level: "info" | "warn"): void;
  setStatus(status: "idle" | "syncing"): void;
  setLastSyncOutcome(outcome: LastSyncOutcome): void;
  updateLastSyncTime(): void;
  refreshDiskSpace(): Promise<void>;
  readonly dashboard?: Pick<RepositoryDashboard, "markSyncing" | "recordSettlement">;
}

export class SyncCycleScheduler {
  private cronJobs: cron.ScheduledTask[] = [];
  private syncingServices = new Set<WorktreeSyncService>();
  private activeSyncCycles = 0;

  constructor(
    private readonly host: SyncCycleHost,
    public defaultSchedule?: string,
  ) {}

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

  public getScheduledCronExpressions(): string[] {
    return [...this.groupBySchedule().keys()];
  }

  public setupCronJobs(): void {
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
    return repoDisplayLabel(service.config);
  }

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
    if (this.host.isShuttingDown()) {
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
            let ownedProgressRow = true;
            try {
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
          failures.push({ repo: repoName, error: formatRepoLockUnavailable(notStarted) });
        } else {
          skipped.push({ repo: repoName, reason: `sync skipped: ${notStarted.reason}` });
        }
      } else if (result.status === "fulfilled" && result.value.result?.started === true) {
        const outcome = result.value.result.outcome;
        if (outcome?.counts.failed) {
          failures.push({ repo: repoName, error: `${outcome.counts.failed} sync action(s) failed` });
        }
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

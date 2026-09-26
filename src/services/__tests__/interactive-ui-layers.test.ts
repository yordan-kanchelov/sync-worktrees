import pLimit from "p-limit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppEventEmitter } from "../../utils/app-events";
import { DiskUsageCache } from "../../utils/disk-usage-cache";
import { HookExecutionService } from "../hook-execution.service";
import { RepositoryOperations } from "../repository-operations";
import { SyncCycleScheduler } from "../sync-cycle-scheduler";
import { TerminalLauncher } from "../terminal-launcher";

import type { RepositoryOperationsHost } from "../repository-operations";
import type { SyncCycleHost } from "../sync-cycle-scheduler";
import type { WorktreeSyncService } from "../worktree-sync.service";

const cronMocks = vi.hoisted(() => ({
  schedule: vi.fn(() => ({ stop: vi.fn(), destroy: vi.fn() })),
}));

vi.mock("node-cron", () => ({ schedule: cronMocks.schedule }));

const clipboardMocks = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));

vi.mock("../../utils/clipboard", () => ({ copyToClipboard: clipboardMocks.copyToClipboard }));

// The three layers InteractiveUIService is built from, exercised without Ink:
// none of them imports the interface, and each reads the repositories through
// its host, so a reload that swaps the generation is seen on the next call.

function makeSyncService(
  name: string,
  overrides: Record<string, unknown> = {},
): { service: WorktreeSyncService; addWorktree: ReturnType<typeof vi.fn> } {
  const addWorktree = vi.fn(() => Promise.resolve());
  const service = {
    config: { name, repoUrl: `https://example.com/${name}.git`, worktreeDir: `/tmp/${name}` },
    isCloneMode: () => false,
    isInitialized: () => true,
    isSyncInProgress: () => false,
    clearRecordedSkips: vi.fn(),
    getRecordedSkips: () => [],
    sync: vi.fn(() => Promise.resolve({ started: true })),
    getGitService: () => ({
      addWorktree,
      resolveNewWorktreePath: (branch: string) => Promise.resolve(`/tmp/${name}/${branch.replace(/\//g, "-")}`),
    }),
    runQueuedRepoOperation: vi.fn(async (operation: () => Promise<unknown>) => ({
      started: true,
      value: await operation(),
    })),
    ...overrides,
  } as unknown as WorktreeSyncService;
  return { service, addWorktree };
}

describe("RepositoryOperations", () => {
  function makeOperations(services: WorktreeSyncService[]): {
    operations: RepositoryOperations;
    host: RepositoryOperationsHost;
    swap: (next: WorktreeSyncService[]) => void;
  } {
    let current = services;
    const host: RepositoryOperationsHost = {
      getServices: () => current,
      log: vi.fn(),
      limit: pLimit(2),
      diskUsage: new DiskUsageCache(2),
      hookExecutionService: new HookExecutionService(),
      refreshDiskSpace: vi.fn(() => Promise.resolve()),
    };
    return {
      operations: new RepositoryOperations(host),
      host,
      swap: (next) => {
        current = next;
      },
    };
  }

  it("creates a worktree through the repository's queued operation", async () => {
    const { service, addWorktree } = makeSyncService("alpha");
    const { operations } = makeOperations([service]);

    await operations.createWorktreeForBranch(0, "feature/x");

    expect(service.runQueuedRepoOperation).toHaveBeenCalledTimes(1);
    expect(addWorktree).toHaveBeenCalledWith("feature/x", expect.stringContaining("/tmp/alpha"));
  });

  it("targets the generation the host holds now, not the one it was built with", async () => {
    const first = makeSyncService("alpha");
    const second = makeSyncService("beta");
    const { operations, swap } = makeOperations([first.service]);

    swap([second.service]);
    await operations.createWorktreeForBranch(0, "main");

    expect(first.addWorktree).not.toHaveBeenCalled();
    expect(second.addWorktree).toHaveBeenCalledTimes(1);
    expect(operations.getRepositoryList()).toEqual([
      { index: 0, name: "beta", repoUrl: "https://example.com/beta.git" },
    ]);
  });

  it("rejects an index outside the current generation", async () => {
    const { operations } = makeOperations([makeSyncService("alpha").service]);

    await expect(operations.createWorktreeForBranch(1, "main")).rejects.toThrow("Invalid repository index: 1");
    await expect(operations.createAndPushBranch(-1, "main", "x")).resolves.toEqual({
      success: false,
      finalName: "x",
      error: "Invalid repository index: -1",
    });
  });
});

describe("SyncCycleScheduler", () => {
  afterEach(() => {
    cronMocks.schedule.mockClear();
  });

  function makeScheduler(
    services: WorktreeSyncService[],
    options: { shuttingDown?: boolean; defaultSchedule?: string } = {},
  ): { scheduler: SyncCycleScheduler; host: SyncCycleHost; statuses: string[] } {
    const statuses: string[] = [];
    const host: SyncCycleHost = {
      events: new AppEventEmitter(),
      limit: pLimit(2),
      getServices: () => services,
      isShuttingDown: () => options.shuttingDown ?? false,
      log: vi.fn(),
      notice: vi.fn(),
      setStatus: (status) => statuses.push(status),
      setLastSyncOutcome: vi.fn(),
      updateLastSyncTime: vi.fn(),
      refreshDiskSpace: vi.fn(() => Promise.resolve()),
    };
    return { scheduler: new SyncCycleScheduler(host, options.defaultSchedule), host, statuses };
  }

  it("arms one job per schedule, falling back to the default schedule", () => {
    const own = makeSyncService("own", {
      config: { name: "own", repoUrl: "u", worktreeDir: "/tmp/own", cronSchedule: "*/5 * * * *" },
    }).service;
    const inherits = makeSyncService("inherits").service;
    const once = makeSyncService("once", {
      config: { name: "once", repoUrl: "u", worktreeDir: "/tmp/once", runOnce: true },
    }).service;
    const { scheduler } = makeScheduler([own, inherits, once], { defaultSchedule: "0 * * * *" });

    scheduler.setupCronJobs();

    expect(scheduler.getScheduledCronExpressions()).toEqual(["*/5 * * * *", "0 * * * *"]);
    expect(cronMocks.schedule).toHaveBeenCalledTimes(2);
  });

  it("arms nothing and starts no cycle once shutdown has begun", async () => {
    const { service } = makeSyncService("alpha");
    const { scheduler, statuses } = makeScheduler([service], { shuttingDown: true, defaultSchedule: "0 * * * *" });

    scheduler.setupCronJobs();
    await scheduler.runSyncCycle([service], { logErrors: true });

    expect(cronMocks.schedule).not.toHaveBeenCalled();
    expect(service.sync).not.toHaveBeenCalled();
    expect(statuses).toEqual(["idle"]);
  });

  it("reports syncing once and idle only when the last overlapping cycle ends", async () => {
    let finishFirst!: () => void;
    const slow = makeSyncService("slow", {
      sync: vi.fn(
        () =>
          new Promise((resolve) => {
            finishFirst = () => resolve({ started: true });
          }),
      ),
    }).service;
    const fast = makeSyncService("fast").service;
    const { scheduler, statuses } = makeScheduler([slow, fast]);

    const firstCycle = scheduler.runSyncCycle([slow], { logErrors: true });
    await vi.waitFor(() => expect(slow.sync).toHaveBeenCalled());
    await scheduler.runSyncCycle([fast], { logErrors: true });

    expect(statuses).toEqual(["syncing"]);
    finishFirst();
    await firstCycle;
    expect(statuses).toEqual(["syncing", "idle"]);
  });
});

describe("TerminalLauncher", () => {
  it("refuses an index with no repository behind it", () => {
    const log = vi.fn();
    const launcher = new TerminalLauncher({ log, getRepoName: () => null });

    expect(launcher.openTerminalInWorktree(3, "/tmp/wt", "main")).toEqual({
      success: false,
      error: "Invalid repository index: 3",
    });
    expect(log).toHaveBeenCalledWith("Invalid repository index: 3", "error");
  });

  it("reports a failed copy and logs the path so it is not lost", async () => {
    clipboardMocks.copyToClipboard.mockResolvedValueOnce({ success: false, error: "No clipboard tool found" });
    const log = vi.fn();
    const launcher = new TerminalLauncher({ log, getRepoName: () => "repo" });

    await expect(launcher.copyToClipboard("/w/repo/main")).resolves.toEqual({
      success: false,
      error: "No clipboard tool found",
    });
    expect(log).toHaveBeenCalledWith("No clipboard tool found; the path was not copied: /w/repo/main", "warn");

    clipboardMocks.copyToClipboard.mockResolvedValueOnce({ success: true, tool: "pbcopy" });
    await expect(launcher.copyToClipboard("/w/repo/main")).resolves.toEqual({ success: true });
  });
});

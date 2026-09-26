import pLimit from "p-limit";
import { describe, expect, it, vi } from "vitest";

import { AppEventEmitter } from "../../utils/app-events";
import { RepositoryDashboard, describeSettlement } from "../repository-dashboard";
import { SyncCycleScheduler } from "../sync-cycle-scheduler";

import type { RepositoryDashboardRow } from "../../utils/app-events";
import type { SyncCycleHost } from "../sync-cycle-scheduler";
import type { WorktreeSyncService } from "../worktree-sync.service";
import type { SyncOutcomeCounts, WorktreeStatusEntry } from "../../types";

vi.mock("node-cron", () => ({ schedule: vi.fn(() => ({ stop: vi.fn(), destroy: vi.fn() })) }));

const counts = (overrides: Partial<SyncOutcomeCounts> = {}): SyncOutcomeCounts => ({
  created: 0,
  removed: 0,
  updated: 0,
  skipped: 0,
  preserved: 0,
  failed: 0,
  noop: 0,
  ...overrides,
});

function makeService(name: string, overrides: Record<string, unknown> = {}): WorktreeSyncService {
  return {
    config: { name, repoUrl: `https://example.com/${name}.git`, worktreeDir: `/tmp/${name}` },
    isInitialized: () => true,
    isSyncInProgress: () => false,
    clearRecordedSkips: vi.fn(),
    getRecordedSkips: () => [],
    sync: vi.fn(() => Promise.resolve({ started: true, outcome: { mode: "worktree", counts: counts() } })),
    getWorktrees: vi.fn(() => Promise.resolve([{ path: "/a" }, { path: "/b" }])),
    ...overrides,
  } as unknown as WorktreeSyncService;
}

function makeDashboard(initial: WorktreeSyncService[], options: { schedule?: string; now?: () => number } = {}) {
  let services = initial;
  const events = new AppEventEmitter();
  const tables: RepositoryDashboardRow[][] = [];
  events.on("setRepositoryDashboard", (rows) => tables.push([...rows]));
  const dashboard = new RepositoryDashboard(
    {
      events,
      getServices: () => services,
      getRepoName: (index) => (services[index].config as { name?: string }).name || `repo-${index}`,
      scheduleFor: () => options.schedule,
      isActive: () => true,
    },
    { now: options.now },
  );
  const latest = (): RepositoryDashboardRow[] => tables[tables.length - 1] ?? [];
  return {
    dashboard,
    events,
    latest,
    tables,
    swap: (next: WorktreeSyncService[]) => {
      services = next;
    },
  };
}

function makeScheduler(services: WorktreeSyncService[], dashboard: RepositoryDashboard): SyncCycleScheduler {
  const host: SyncCycleHost = {
    events: new AppEventEmitter(),
    limit: pLimit(2),
    getServices: () => services,
    isShuttingDown: () => false,
    log: vi.fn(),
    notice: vi.fn(),
    setStatus: vi.fn(),
    setLastSyncOutcome: vi.fn(),
    updateLastSyncTime: vi.fn(),
    refreshDiskSpace: vi.fn(() => Promise.resolve()),
    dashboard,
  };
  return new SyncCycleScheduler(host);
}

const entry = (flags: { clean?: boolean; unpushed?: boolean; error?: string }): WorktreeStatusEntry =>
  ({
    branch: "b",
    path: "/p",
    status: { isClean: flags.clean ?? true, hasUnpushedCommits: flags.unpushed ?? false },
    ...(flags.error !== undefined && { error: flags.error }),
  }) as WorktreeStatusEntry;

describe("describeSettlement", () => {
  it("says what a sync that ran did, or that it had nothing to do", () => {
    expect(
      describeSettlement({
        status: "fulfilled",
        result: { started: true, outcome: { mode: "worktree", started: true, actions: [], counts: counts() } },
      }),
    ).toEqual({ state: "idle", lastResult: "up to date" });
    expect(
      describeSettlement({
        status: "fulfilled",
        result: {
          started: true,
          outcome: { mode: "worktree", started: true, actions: [], counts: counts({ created: 2, removed: 1 }) },
        },
      }),
    ).toEqual({ state: "idle", lastResult: "2 created, 1 removed" });
  });

  it("marks a sync with failed actions as failed and keeps what else it did", () => {
    expect(
      describeSettlement({
        status: "fulfilled",
        result: {
          started: true,
          outcome: { mode: "worktree", started: true, actions: [], counts: counts({ failed: 1, updated: 3 }) },
        },
      }),
    ).toEqual({ state: "failed", lastResult: "1 action(s) failed; 3 updated" });
  });

  it("reads contention as a skip and an unavailable lock as a failure", () => {
    expect(describeSettlement({ status: "fulfilled", result: { started: false, reason: "locked" } })).toEqual({
      state: "skipped",
      lastResult: "locked by another process",
    });
    expect(describeSettlement({ status: "fulfilled", result: { started: false, reason: "in_progress" } })).toEqual({
      state: "skipped",
      lastResult: "busy with another sync or operation",
    });
    expect(
      describeSettlement({
        status: "fulfilled",
        result: { started: false, reason: "lock_unavailable", path: "/locks/x", code: "EACCES", error: "denied" },
      }),
    ).toEqual({ state: "failed", lastResult: "repository lock unavailable at '/locks/x' (EACCES: denied)" });
  });

  it("keeps a thrown error to its first line and scrubs credentials from it", () => {
    const settled = describeSettlement({
      status: "rejected",
      error: new Error("\nfatal: could not read from 'https://user:hunter2@example.com/r.git'\nhint: check access"),
    });

    expect(settled.state).toBe("failed");
    expect(settled.lastResult).toContain("fatal: could not read from");
    expect(settled.lastResult).not.toContain("hunter2");
    expect(settled.lastResult).not.toContain("hint");
  });
});

describe("RepositoryDashboard", () => {
  it("publishes one row per repository, with its schedule, before anything has synced", () => {
    const { dashboard, latest } = makeDashboard([makeService("alpha"), makeService("")], { schedule: "0 * * * *" });

    dashboard.publish();

    expect(latest()).toEqual([
      {
        name: "alpha",
        state: "idle",
        lastResult: null,
        lastSyncAt: null,
        worktrees: null,
        changes: null,
        schedule: "0 * * * *",
      },
      expect.objectContaining({ name: "repo-1", state: "idle" }),
    ]);
  });

  it("follows a sync cycle: syncing while it runs, then the result, the time and the worktree count", async () => {
    let finish!: () => void;
    const alpha = makeService("alpha", {
      sync: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ started: true, outcome: { mode: "worktree", counts: counts({ created: 1 }) } });
          }),
      ),
    });
    const { dashboard, latest } = makeDashboard([alpha], { now: () => 1_000 });
    const scheduler = makeScheduler([alpha], dashboard);

    const cycle = scheduler.runSyncCycle([alpha], { logErrors: true });
    await vi.waitFor(() => expect(latest()[0]?.state).toBe("syncing"));

    finish();
    await cycle;
    await vi.waitFor(() => expect(latest()[0]?.worktrees).toBe(2));

    expect(latest()[0]).toMatchObject({ state: "idle", lastResult: "1 created", lastSyncAt: 1_000 });
  });

  // A repository that finished early should not read "syncing" until the
  // slowest repository of its cycle is done.
  it("settles each row as its own repository finishes", async () => {
    let finishSlow!: () => void;
    const slow = makeService("slow", {
      sync: vi.fn(
        () =>
          new Promise((resolve) => {
            finishSlow = () => resolve({ started: true, outcome: { mode: "worktree", counts: counts() } });
          }),
      ),
    });
    const fast = makeService("fast");
    const { dashboard, latest } = makeDashboard([slow, fast]);
    const scheduler = makeScheduler([slow, fast], dashboard);

    const cycle = scheduler.runSyncCycle([slow, fast], { logErrors: true });
    await vi.waitFor(() => expect(latest()[1]?.state).toBe("idle"));
    expect(latest()[0]?.state).toBe("syncing");

    finishSlow();
    await cycle;
    expect(latest()[0]?.state).toBe("idle");
  });

  it("marks a repository whose sync threw as failed", async () => {
    const broken = makeService("broken", { sync: vi.fn(() => Promise.reject(new Error("network down"))) });
    const { dashboard, latest } = makeDashboard([broken]);

    await makeScheduler([broken], dashboard).runSyncCycle([broken], { logErrors: false });

    expect(latest()[0]).toMatchObject({ state: "failed", lastResult: "network down" });
  });

  it("leaves the age of the last real sync alone when a sync is skipped", async () => {
    let clock = 1_000;
    const alpha = makeService("alpha");
    const { dashboard, latest } = makeDashboard([alpha], { now: () => clock });
    const scheduler = makeScheduler([alpha], dashboard);

    await scheduler.runSyncCycle([alpha], { logErrors: true });
    clock = 5_000;
    vi.mocked(alpha.sync).mockResolvedValueOnce({ started: false, reason: "locked" });
    await scheduler.runSyncCycle([alpha], { logErrors: true });

    expect(latest()[0]).toMatchObject({ state: "skipped", lastResult: "locked by another process", lastSyncAt: 1_000 });
  });

  it("keeps the worktree count it had when listing the worktrees fails", async () => {
    const alpha = makeService("alpha");
    const { dashboard, latest } = makeDashboard([alpha]);
    const scheduler = makeScheduler([alpha], dashboard);
    await scheduler.runSyncCycle([alpha], { logErrors: true });
    await vi.waitFor(() => expect(latest()[0]?.worktrees).toBe(2));

    vi.mocked(alpha.getWorktrees).mockRejectedValueOnce(new Error("git worktree list failed"));
    await scheduler.runSyncCycle([alpha], { logErrors: true });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(latest()[0]?.worktrees).toBe(2);
  });

  it("tallies dirty and unpushed worktrees from a status check, ignoring worktrees it could not probe", () => {
    const { dashboard, latest } = makeDashboard([makeService("alpha")]);

    dashboard.recordWorktreeStatus(0, [
      entry({ clean: false }),
      entry({ clean: false, unpushed: true }),
      entry({}),
      entry({ clean: false, unpushed: true, error: "probe failed" }),
    ]);

    expect(latest()[0]).toMatchObject({ worktrees: 4, changes: { dirty: 2, unpushed: 1 } });
  });

  it("ignores a status check for an index the current generation does not have", () => {
    const { dashboard, tables } = makeDashboard([makeService("alpha")]);

    dashboard.recordWorktreeStatus(3, [entry({})]);

    expect(tables).toHaveLength(0);
  });

  it("keeps a repository's history across a reload and forgets repositories the reload dropped", () => {
    const { dashboard, latest, swap } = makeDashboard([makeService("alpha"), makeService("beta")]);
    dashboard.recordWorktreeStatus(0, [entry({ clean: false })]);
    dashboard.recordWorktreeStatus(1, [entry({})]);

    swap([makeService("alpha")]);
    dashboard.publish();

    expect(latest()).toEqual([expect.objectContaining({ name: "alpha", changes: { dirty: 1, unpushed: 0 } })]);

    swap([makeService("alpha"), makeService("beta")]);
    dashboard.publish();
    expect(latest()[1]).toMatchObject({ name: "beta", changes: null });
  });

  it("settles a row whose sync started before a reload swapped its service out", () => {
    const old = makeService("alpha");
    const { dashboard, latest, swap } = makeDashboard([old], { now: () => 1000 });
    dashboard.markSyncing(old);

    swap([makeService("alpha")]);
    dashboard.recordSettlement(old, { status: "fulfilled", result: undefined });

    expect(latest()[0]).toMatchObject({ name: "alpha", state: "idle", lastSyncAt: 1000 });
  });

  it("sends nothing once the interface is gone", () => {
    const events = new AppEventEmitter();
    const listener = vi.fn();
    events.on("setRepositoryDashboard", listener);
    const dashboard = new RepositoryDashboard({
      events,
      getServices: () => [makeService("alpha")],
      getRepoName: () => "alpha",
      scheduleFor: () => undefined,
      isActive: () => false,
    });

    dashboard.publish();
    dashboard.recordWorktreeStatus(0, [entry({})]);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("SyncCycleScheduler.scheduleFor", () => {
  it("gives a repository its own schedule, the default otherwise, and none for runOnce", () => {
    const own = makeService("own", {
      config: { name: "own", repoUrl: "u", worktreeDir: "/o", cronSchedule: "*/5 * * * *" },
    });
    const inherits = makeService("inherits");
    const once = makeService("once", { config: { name: "once", repoUrl: "u", worktreeDir: "/x", runOnce: true } });
    const { dashboard } = makeDashboard([]);
    const scheduler = makeScheduler([own, inherits, once], dashboard);
    scheduler.defaultSchedule = "0 * * * *";

    expect(scheduler.scheduleFor(own)).toBe("*/5 * * * *");
    expect(scheduler.scheduleFor(inherits)).toBe("0 * * * *");
    expect(scheduler.scheduleFor(once)).toBeUndefined();
  });
});

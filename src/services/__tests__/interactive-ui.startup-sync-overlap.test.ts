import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppEventEmitter } from "../../utils/app-events";
import { InteractiveUIService } from "../InteractiveUIService";

import type { Config, SyncResult } from "../../types";
import type { WorktreeSyncService } from "../worktree-sync.service";

const mocks = vi.hoisted(() => ({
  cronHandlers: [] as Array<() => Promise<void>>,
}));

vi.mock("ink", () => ({ render: vi.fn(() => ({ unmount: vi.fn() })) }));
vi.mock("node-cron", () => ({
  schedule: vi.fn((_expression: string, handler: () => Promise<void>) => {
    mocks.cronHandlers.push(handler);
    return { stop: vi.fn() };
  }),
}));
vi.mock("../../utils/disk-space", () => ({
  calculateSyncDiskSpace: vi.fn().mockResolvedValue({ totalSize: 0, formattedSize: "0 B" }),
  calculateDirectorySize: vi.fn().mockResolvedValue(0),
  formatBytes: vi.fn().mockReturnValue("0 B"),
  getDefaultBareRepoDir: vi.fn().mockReturnValue("/tmp/bare"),
}));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const config = {
  name: "repo-a",
  repoUrl: "https://github.com/test/repo.git",
  worktreeDir: "/tmp/worktrees",
  cronSchedule: "* * * * *",
  runOnce: false,
} as unknown as Config;

/**
 * A stand-in for WorktreeSyncService carrying the guard the real one has:
 * `runExclusiveRepoOperation` refuses a fail-fast caller outright while the
 * per-repo `repoMutex` is busy (worktree-sync.repo-mutex.test.ts pins that, and
 * so does the concurrent-initialize case there), so the second of two
 * overlapping cycles resolves `{ started: false, reason: "in_progress" }`
 * without touching the repository. What it does not protect is the bookkeeping
 * the UI keeps outside the lock, which is what this file is about.
 */
function makeService(gate: Promise<void>): {
  service: WorktreeSyncService;
  syncCalls: () => number;
  recordedSkips: () => readonly string[];
} {
  let active = false;
  let calls = 0;
  let skips: string[] = [];
  const service = {
    config,
    isInitialized: () => true,
    isSyncInProgress: () => active,
    // Called by runSyncServices before it knows whether this service can run.
    clearRecordedSkips: vi.fn(() => {
      skips = [];
    }),
    getRecordedSkips: () => skips,
    updateLogger: vi.fn(),
    onProgress: vi.fn(() => () => undefined),
    sync: vi.fn(async (): Promise<SyncResult> => {
      calls++;
      if (active) return { started: false, reason: "in_progress" };
      active = true;
      try {
        // A clone-mode skip the running cycle is meant to report at the end.
        skips.push("dirty_worktree");
        await gate;
        return {
          started: true,
          outcome: {
            mode: "clone",
            started: true,
            actions: [],
            counts: { created: 0, removed: 0, updated: 0, skipped: 0, failed: 0 },
          },
        } as unknown as SyncResult;
      } finally {
        active = false;
      }
    }),
  } as unknown as WorktreeSyncService;
  return { service, syncCalls: () => calls, recordedSkips: () => skips };
}

describe("a cron tick that fires while the startup sync is still running", () => {
  beforeEach(() => {
    mocks.cronHandlers.length = 0;
  });

  it("skips the cycle instead of half-running it over the one in flight", async () => {
    const gate = deferred();
    const { service, syncCalls, recordedSkips } = makeService(gate.promise);
    const events = new AppEventEmitter();
    const statuses: Array<"idle" | "syncing"> = [];
    const logs: string[] = [];
    events.on("setStatus", (status: "idle" | "syncing") => statuses.push(status));
    events.on("addLog", ({ message, level }: { message: string; level: string }) => logs.push(`${level}:${message}`));

    const ui = new InteractiveUIService([service], undefined, "* * * * *", 2, events);
    events.emit("uiReady");
    ui.setupCronJobs();
    expect(mocks.cronHandlers).toHaveLength(1);

    const startup = ui.triggerInitialSync();
    // Let the startup cycle reach the gated sync(). No wall clock: draining the
    // queues is enough, because everything before sync() is synchronous or
    // already-resolved.
    await new Promise((resolve) => setImmediate(resolve));

    const clearsBeforeTick = vi.mocked(service.clearRecordedSkips).mock.calls.length;
    await mocks.cronHandlers[0]();

    // The tick never reached the services: no second sync() attempt, and — the
    // reason this matters — no clearRecordedSkips() wiping the skip the cycle
    // in flight has already recorded and still has to report.
    expect(syncCalls()).toBe(1);
    expect(vi.mocked(service.clearRecordedSkips).mock.calls.length).toBe(clearsBeforeTick);
    expect(recordedSkips()).toEqual(["dirty_worktree"]);
    // And the status bar still says what is true.
    expect(statuses).toEqual(["syncing"]);
    expect(logs).toContain("info:A sync is already running; skipping this cycle.");

    gate.resolve();
    await startup;
    expect(statuses).toEqual(["syncing", "idle"]);
  });

  it("lets the next tick run once the startup sync has finished", async () => {
    const gate = deferred();
    const { service, syncCalls } = makeService(gate.promise);
    const events = new AppEventEmitter();

    const ui = new InteractiveUIService([service], undefined, "* * * * *", 2, events);
    events.emit("uiReady");
    ui.setupCronJobs();

    const startup = ui.triggerInitialSync();
    await new Promise((resolve) => setImmediate(resolve));
    gate.resolve();
    await startup;

    // The guard is a gate, not a latch: skipping one tick must not disarm the
    // schedule for the rest of the run.
    await mocks.cronHandlers[0]();
    expect(syncCalls()).toBe(2);
  });
});

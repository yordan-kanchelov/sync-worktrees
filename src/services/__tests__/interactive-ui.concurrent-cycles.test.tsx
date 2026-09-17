import { Console } from "node:console";
import { EventEmitter } from "node:events";

import React from "react";
import { render as renderApp, cleanup } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../../components/App";
import { AppEventEmitter } from "../../utils/app-events";
import { InteractiveUIService } from "../InteractiveUIService";

import type { AppSyncProgress } from "../../utils/app-events";
import type { Config, SyncResult } from "../../types";
import type { WorktreeSyncService } from "../worktree-sync.service";

const mocks = vi.hoisted(() => ({
  cronHandlers: [] as Array<{ schedule: string; handler: () => Promise<void> }>,
}));

// Only node-cron is faked: the tests below drive real Ink, both through the
// service's own render (into the sink stream) and through ink-testing-library
// for the App assertions, so `ink` itself has to stay real.
vi.mock("node-cron", () => ({
  schedule: vi.fn((schedule: string, handler: () => Promise<void>) => {
    mocks.cronHandlers.push({ schedule, handler });
    return { stop: vi.fn(), destroy: vi.fn() };
  }),
}));
// calculateSyncDiskSpace resolves the formatted string the status bar renders.
// Handing back an object instead puts one into `setDiskSpace`, and React throws
// on it -- which unmounts the App mid-test, silently, and takes every frame
// assertion after the first cycle with it.
vi.mock("../../utils/disk-space", () => ({
  calculateSyncDiskSpace: vi.fn().mockResolvedValue("0 B"),
  calculateDirectorySize: vi.fn().mockResolvedValue(0),
  formatBytes: vi.fn().mockReturnValue("0 B"),
  getDefaultBareRepoDir: vi.fn().mockReturnValue("/tmp/bare"),
}));

// src/__tests__/setup.ts replaces `global.console` with a plain object, which
// has no `Console` constructor for Ink's patchConsole to build on.
(globalThis.console as unknown as { Console: typeof Console }).Console = Console;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Somewhere for the service's own Ink instance to live. The assertions read the
// App rendered by ink-testing-library instead, on the same event emitter. Both
// streams claim to be a TTY: Ink tears its tree down when raw mode is
// unsupported, and the service reads that teardown as the user having quit.
class SinkStdout extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 24;
  write = (): boolean => true;
}

class SinkStdin extends EventEmitter {
  isTTY = true;
  setRawMode = (): void => {};
  setEncoding = (): void => {};
  resume = (): void => {};
  pause = (): void => {};
  ref = (): void => {};
  unref = (): void => {};
  read = (): string | null => null;
}

function makeConfig(name: string, cronSchedule: string): Config {
  return {
    name,
    repoUrl: `https://github.com/test/${name}.git`,
    worktreeDir: `/tmp/worktrees/${name}`,
    cronSchedule,
    runOnce: false,
  } as unknown as Config;
}

interface Fake {
  service: WorktreeSyncService;
  syncCalls: () => number;
  /** Resolve the sync that is currently gated. */
  release: () => void;
  /** Emit a progress event the way a real sync does, through onProgress. */
  emitProgress: (message: string) => void;
}

/**
 * A stand-in for WorktreeSyncService carrying the guard the real one has:
 * `runExclusiveRepoOperation` refuses a fail-fast caller while the per-repo
 * mutex is busy, so a second sync of the same repository resolves
 * `{ started: false, reason: "in_progress" }` without touching it.
 */
function makeFake(name: string, cronSchedule: string, options: { gated?: boolean; failFast?: boolean } = {}): Fake {
  let active = false;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let listener: ((event: { phase: string; message: string }) => void) | undefined;

  const service = {
    config: makeConfig(name, cronSchedule),
    isInitialized: () => true,
    isSyncInProgress: () => active,
    clearRecordedSkips: vi.fn(),
    getRecordedSkips: () => [],
    updateLogger: vi.fn(),
    onProgress: vi.fn((fn: (event: { phase: string; message: string }) => void) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    }),
    sync: vi.fn(async (): Promise<SyncResult> => {
      calls++;
      if (active) return { started: false, reason: "in_progress" };
      active = true;
      try {
        if (options.gated) await gate;
        // The fail-fast the claim cannot prevent: the repository mutex is held
        // by another process, or by an interactive operation in this one.
        if (options.failFast) return { started: false, reason: "in_progress" };
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

  return {
    service,
    syncCalls: () => calls,
    release,
    emitProgress: (message: string) => listener?.({ phase: "fetch", message }),
  };
}

describe("overlapping sync cycles", () => {
  let events: AppEventEmitter;
  let statuses: Array<"idle" | "syncing">;
  let progress: Array<AppSyncProgress | null>;
  let logs: string[];
  let ui: InteractiveUIService | null;

  const build = (services: WorktreeSyncService[]): InteractiveUIService => {
    ui = new InteractiveUIService(services, undefined, "* * * * *", 2, events, {
      stdout: new SinkStdout() as unknown as NodeJS.WriteStream,
      stdin: new SinkStdin() as unknown as NodeJS.ReadStream,
      exit: vi.fn(),
    });
    events.emit("uiReady");
    return ui;
  };

  // The App the user is actually looking at, on the same emitter the service
  // drives. The frame is what the assertions below read, rather than the raw
  // event stream: the two disagreed, and the raw stream is the one that could
  // not see it.
  const renderTestApp = (
    repos: Array<{ index: number; name: string }> = [{ index: 0, name: "repo-a" }],
  ): { lastFrame: () => string | undefined } =>
    renderApp(
      <App
        events={events}
        repositoryCount={repos.length}
        maxProgressLines={2}
        onManualSync={vi.fn()}
        onReload={vi.fn()}
        onQuit={vi.fn().mockResolvedValue(undefined)}
        getRepositoryList={() =>
          repos.map((repo) => ({ index: repo.index, name: repo.name, repoUrl: `https://example.com/${repo.name}.git` }))
        }
        getBranchesForRepo={vi.fn().mockResolvedValue([])}
        getDefaultBranchForRepo={vi.fn().mockResolvedValue("main")}
        createAndPushBranch={vi.fn()}
        getWorktreesForRepo={vi.fn().mockResolvedValue([])}
        openEditorInWorktree={vi.fn()}
        openTerminalInWorktree={vi.fn()}
        createWorktreeForBranch={vi.fn()}
      />,
    );

  beforeEach(() => {
    mocks.cronHandlers.length = 0;
    events = new AppEventEmitter();
    statuses = [];
    progress = [];
    logs = [];
    ui = null;
    events.on("setStatus", (status: "idle" | "syncing") => statuses.push(status));
    events.on("setSyncProgress", (entry: AppSyncProgress | null) => progress.push(entry));
    events.on("addLog", ({ message, level }: { message: string; level: string }) => logs.push(`${level}:${message}`));
  });

  afterEach(async () => {
    cleanup();
    await ui?.destroy(true);
    ui = null;
  });

  // The acceptance case, as a cycle that really runs: a second cycle landing on
  // a repository the first is still fetching used to run its own `finally` --
  // status back to idle, progress panel blanked, `s`/`x`/`r` re-armed -- 100 ms
  // into a 500 ms sync. repo-b is in the second cycle and nobody else's, so the
  // cycle gets as far as that `finally` rather than being thrown away whole,
  // which is the only version of this that pins anything.
  it("reports neither idle nor a completed row for a repository the first cycle is still syncing", async () => {
    const a = makeFake("repo-a", "*/30 * * * *", { gated: true });
    const b = makeFake("repo-b", "0 * * * *");
    const service = build([a.service, b.service]);
    service.setupCronJobs();
    expect(mocks.cronHandlers).toHaveLength(2);

    const slow = mocks.cronHandlers.find((job) => job.schedule === "*/30 * * * *")!.handler();
    await flush();
    // repo-a's sync resolves 500 ms in; the second cycle lands well inside that.
    setTimeout(a.release, 500);

    // What `s` does: a cycle over every repository, while repo-a is held.
    await service.triggerInitialSync();

    expect(b.syncCalls()).toBe(1);
    expect(statuses).toEqual(["syncing"]);
    expect(progress.filter((entry) => entry?.completed && entry.repo === "repo-a")).toEqual([]);

    await slow;

    expect(statuses).toEqual(["syncing", "idle"]);
    expect(progress.filter((entry) => entry?.completed && entry.repo === "repo-a")).toHaveLength(1);
  });

  // Two schedules are two cycles, and both of their repositories have to be
  // synced. A flag shared by all of them either starved the second group or let
  // whichever finished first speak for the other.
  it("keeps the status at syncing until the last of two cron groups finishes", async () => {
    const a = makeFake("repo-a", "*/30 * * * *", { gated: true });
    const b = makeFake("repo-b", "0 * * * *");
    const service = build([a.service, b.service]);
    service.setupCronJobs();
    expect(mocks.cronHandlers).toHaveLength(2);

    const slow = mocks.cronHandlers.find((job) => job.schedule === "*/30 * * * *")!.handler();
    await flush();
    await mocks.cronHandlers.find((job) => job.schedule === "0 * * * *")!.handler();

    // repo-b's group ran to completion on its own while repo-a is still fetching.
    expect(b.syncCalls()).toBe(1);
    expect(statuses).toEqual(["syncing"]);

    a.release();
    await slow;

    expect(a.syncCalls()).toBe(1);
    expect(statuses).toEqual(["syncing", "idle"]);
  });

  // A cycle whose group overlaps a running one takes the repositories that are
  // free and leaves the rest alone -- pressing `s` during a cron sync used to
  // throw the whole cycle away, so the repositories nobody was syncing waited
  // for the next tick.
  it("syncs the repositories the running cycle does not hold and reports the rest as skipped", async () => {
    const a = makeFake("repo-a", "*/30 * * * *", { gated: true });
    const b = makeFake("repo-b", "0 * * * *");
    const service = build([a.service, b.service]);
    service.setupCronJobs();

    const slow = mocks.cronHandlers.find((job) => job.schedule === "*/30 * * * *")!.handler();
    await flush();

    // What `s` does: a cycle over every repository, while repo-a is held.
    await service.triggerInitialSync();

    expect(b.syncCalls()).toBe(1);
    expect(a.syncCalls()).toBe(1);
    expect(a.service.clearRecordedSkips).toHaveBeenCalledTimes(1);
    expect(logs).toContain("warn:Sync skipped for 'repo-a': sync skipped: in_progress");

    a.release();
    await slow;
  });

  // "Last Sync" is a claim that something synced. A cycle in which one repo was
  // held by another cycle and the other fail-fasted synced nothing.
  it("does not stamp the last sync time for a cycle in which every repository was skipped", async () => {
    const a = makeFake("repo-a", "*/30 * * * *", { gated: true });
    const b = makeFake("repo-b", "0 * * * *");
    vi.mocked(b.service.sync).mockResolvedValue({ started: false, reason: "in_progress" } as SyncResult);
    const service = build([a.service, b.service]);
    service.setupCronJobs();
    let stamped = 0;
    events.on("updateLastSyncTime", () => stamped++);

    const slow = mocks.cronHandlers.find((job) => job.schedule === "*/30 * * * *")!.handler();
    await flush();

    await service.triggerInitialSync();

    // The cycle ran -- repo-b's sync was called and fail-fasted, repo-a was
    // left to the cycle that holds it -- and still stamped nothing.
    expect(b.service.sync).toHaveBeenCalledTimes(1);
    expect(logs).toContain("warn:Sync skipped for 'repo-a': sync skipped: in_progress");
    expect(stamped).toBe(0);

    a.release();
    await slow;

    expect(stamped).toBe(1);
  });

  // The fail-fast a cycle cannot see coming: another process, or an interactive
  // operation holding the repo mutex, owns the repository. The row on screen is
  // theirs, and closing it is not this cycle's to do.
  it("does not close the progress row of a repository whose sync fail-fasted", async () => {
    const a = makeFake("repo-a", "* * * * *");
    vi.mocked(a.service.sync).mockResolvedValue({ started: false, reason: "in_progress" } as SyncResult);
    const service = build([a.service]);

    await service.triggerInitialSync();

    expect(a.service.sync).toHaveBeenCalledTimes(1);
    expect(progress.filter((entry) => entry?.completed)).toEqual([]);
    expect(logs).toContain("warn:Sync skipped for 'repo-a': sync skipped: in_progress");
  });

  // The other half of the same rule, in one cycle so that the two cannot be
  // confused: a sync that threw was running, and owes its row; a sync that
  // fail-fasted never was, and does not.
  it("closes the progress row of the repository whose sync threw and not the one that fail-fasted", async () => {
    const a = makeFake("repo-a", "* * * * *");
    vi.mocked(a.service.sync).mockResolvedValue({ started: false, reason: "in_progress" } as SyncResult);
    const b = makeFake("repo-b", "* * * * *");
    vi.mocked(b.service.sync).mockRejectedValue(new Error("fetch failed"));
    const service = build([a.service, b.service]);

    await service.triggerInitialSync();

    expect(progress.filter((entry) => entry?.completed).map((entry) => entry!.repo)).toEqual(["repo-b"]);
  });

  // What the user is looking at, not what the service emitted. The status bar
  // has two owners: `setStatus`, which the cycle counter governs, and
  // `updateLastSyncTime`, which App also turned into an idle and a blank
  // progress panel. The second one fires inside the cycle -- `runSyncCycle`
  // awaits `recordSyncOutcome` before its `finally` -- so counting cycles never
  // stopped the fast cron group speaking for the slow one. It only stopped it
  // saying so on the channel the tests above subscribe to.
  it("keeps the rendered status and repo A's progress row while the other cron group finishes", async () => {
    const a = makeFake("repo-a", "*/30 * * * *", { gated: true });
    const b = makeFake("repo-b", "0 * * * *");
    const service = build([a.service, b.service]);
    service.setupCronJobs();

    const { lastFrame } = renderTestApp([
      { index: 0, name: "repo-a" },
      { index: 1, name: "repo-b" },
    ]);
    await delay(100);

    const slow = mocks.cronHandlers.find((job) => job.schedule === "*/30 * * * *")!.handler();
    await flush();
    a.emitProgress("fetch receiving: 40%");
    await delay(100);
    expect(lastFrame()).toContain("[repo-a] fetch receiving: 40%");
    expect(lastFrame()).toContain("Syncing...");

    // repo-b's group runs to completion and stamps "Last Sync" on its way out,
    // while repo-a is still fetching.
    await mocks.cronHandlers.find((job) => job.schedule === "0 * * * *")!.handler();
    await delay(100);

    // The stamp landed -- so this is the path under test -- and nothing else did.
    expect(lastFrame()).not.toContain("N/A");
    expect(lastFrame()).toContain("Syncing...");
    expect(lastFrame()).toContain("[repo-a] fetch receiving: 40%");

    a.release();
    await slow;
    await delay(100);

    // Only with the last cycle out does the bar go back and the row go away.
    expect(lastFrame()).toContain("Running");
    expect(lastFrame()).not.toContain("[repo-a] fetch receiving: 40%");
  });

  // T41's acceptance case at the App level: while a `setSyncProgress` row for
  // repo A is live, an `in_progress` skip for A must not remove it. The claim
  // keeps a second cycle away from a repository this process is already
  // syncing, so the skip left to meet is the one the claim cannot see, and
  // `runSyncServices` used to close every row from its `finally` regardless.
  it("leaves repo A's live progress row on screen across an in_progress skip", async () => {
    const a = makeFake("repo-a", "* * * * *", { gated: true, failFast: true });
    const b = makeFake("repo-b", "* * * * *", { gated: true });
    const service = build([a.service, b.service]);

    const { lastFrame } = renderTestApp([
      { index: 0, name: "repo-a" },
      { index: 1, name: "repo-b" },
    ]);
    await delay(100);

    const cycle = service.triggerInitialSync();
    await flush();
    // The row on screen belongs to whoever holds repo-a.
    a.emitProgress("fetch receiving: 40%");
    await delay(100);
    expect(lastFrame()).toContain("[repo-a] fetch receiving: 40%");

    // repo-a's sync fail-fasts now; repo-b keeps the cycle open.
    a.release();
    await delay(100);

    expect(a.service.sync).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain("[repo-a] fetch receiving: 40%");
    expect(lastFrame()).toContain("Syncing...");

    b.release();
    await cycle;

    // ...and repo-a was a skip, not a sync, for the whole of that.
    expect(logs).toContain("warn:Sync skipped for 'repo-a': sync skipped: in_progress");
  });
});

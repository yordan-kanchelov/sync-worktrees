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

vi.mock("node-cron", () => ({
  schedule: vi.fn((schedule: string, handler: () => Promise<void>) => {
    mocks.cronHandlers.push({ schedule, handler });
    return { stop: vi.fn(), destroy: vi.fn() };
  }),
}));
vi.mock("../../utils/disk-space", () => ({
  calculateSyncDiskSpace: vi.fn().mockResolvedValue("0 B"),
  calculateDirectorySize: vi.fn().mockResolvedValue(0),
  formatBytes: vi.fn().mockReturnValue("0 B"),
  getDefaultBareRepoDir: vi.fn().mockReturnValue("/tmp/bare"),
}));

(globalThis.console as unknown as { Console: typeof Console }).Console = Console;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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
  release: () => void;
  emitProgress: (message: string) => void;
}

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

  it("reports neither idle nor a completed row for a repository the first cycle is still syncing", async () => {
    const a = makeFake("repo-a", "*/30 * * * *", { gated: true });
    const b = makeFake("repo-b", "0 * * * *");
    const service = build([a.service, b.service]);
    service.setupCronJobs();
    expect(mocks.cronHandlers).toHaveLength(2);

    const slow = mocks.cronHandlers.find((job) => job.schedule === "*/30 * * * *")!.handler();
    await flush();
    setTimeout(a.release, 500);

    await service.triggerInitialSync();

    expect(b.syncCalls()).toBe(1);
    expect(statuses).toEqual(["syncing"]);
    expect(progress.filter((entry) => entry?.completed && entry.repo === "repo-a")).toEqual([]);

    await slow;

    expect(statuses).toEqual(["syncing", "idle"]);
    expect(progress.filter((entry) => entry?.completed && entry.repo === "repo-a")).toHaveLength(1);
  });

  it("keeps the status at syncing until the last of two cron groups finishes", async () => {
    const a = makeFake("repo-a", "*/30 * * * *", { gated: true });
    const b = makeFake("repo-b", "0 * * * *");
    const service = build([a.service, b.service]);
    service.setupCronJobs();
    expect(mocks.cronHandlers).toHaveLength(2);

    const slow = mocks.cronHandlers.find((job) => job.schedule === "*/30 * * * *")!.handler();
    await flush();
    await mocks.cronHandlers.find((job) => job.schedule === "0 * * * *")!.handler();

    expect(b.syncCalls()).toBe(1);
    expect(statuses).toEqual(["syncing"]);

    a.release();
    await slow;

    expect(a.syncCalls()).toBe(1);
    expect(statuses).toEqual(["syncing", "idle"]);
  });

  it("syncs the repositories the running cycle does not hold and reports the rest as skipped", async () => {
    const a = makeFake("repo-a", "*/30 * * * *", { gated: true });
    const b = makeFake("repo-b", "0 * * * *");
    const service = build([a.service, b.service]);
    service.setupCronJobs();

    const slow = mocks.cronHandlers.find((job) => job.schedule === "*/30 * * * *")!.handler();
    await flush();

    await service.triggerInitialSync();

    expect(b.syncCalls()).toBe(1);
    expect(a.syncCalls()).toBe(1);
    expect(a.service.clearRecordedSkips).toHaveBeenCalledTimes(1);
    expect(logs).toContain("warn:Sync skipped for 'repo-a': sync skipped: in_progress");

    a.release();
    await slow;
  });

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

    expect(b.service.sync).toHaveBeenCalledTimes(1);
    expect(logs).toContain("warn:Sync skipped for 'repo-a': sync skipped: in_progress");
    expect(stamped).toBe(0);

    a.release();
    await slow;

    expect(stamped).toBe(1);
  });

  it("does not close the progress row of a repository whose sync fail-fasted", async () => {
    const a = makeFake("repo-a", "* * * * *");
    vi.mocked(a.service.sync).mockResolvedValue({ started: false, reason: "in_progress" } as SyncResult);
    const service = build([a.service]);

    await service.triggerInitialSync();

    expect(a.service.sync).toHaveBeenCalledTimes(1);
    expect(progress.filter((entry) => entry?.completed)).toEqual([]);
    expect(logs).toContain("warn:Sync skipped for 'repo-a': sync skipped: in_progress");
  });

  it("closes the progress row of the repository whose sync threw and not the one that fail-fasted", async () => {
    const a = makeFake("repo-a", "* * * * *");
    vi.mocked(a.service.sync).mockResolvedValue({ started: false, reason: "in_progress" } as SyncResult);
    const b = makeFake("repo-b", "* * * * *");
    vi.mocked(b.service.sync).mockRejectedValue(new Error("fetch failed"));
    const service = build([a.service, b.service]);

    await service.triggerInitialSync();

    expect(progress.filter((entry) => entry?.completed).map((entry) => entry!.repo)).toEqual(["repo-b"]);
  });

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

    await mocks.cronHandlers.find((job) => job.schedule === "0 * * * *")!.handler();
    await delay(100);

    expect(lastFrame()).not.toContain("N/A");
    expect(lastFrame()).toContain("Syncing...");
    expect(lastFrame()).toContain("[repo-a] fetch receiving: 40%");

    a.release();
    await slow;
    await delay(100);

    expect(lastFrame()).toContain("Idle");
    expect(lastFrame()).not.toContain("[repo-a] fetch receiving: 40%");
  });

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
    a.emitProgress("fetch receiving: 40%");
    await delay(100);
    expect(lastFrame()).toContain("[repo-a] fetch receiving: 40%");

    a.release();
    await delay(100);

    expect(a.service.sync).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain("[repo-a] fetch receiving: 40%");
    expect(lastFrame()).toContain("Syncing...");

    b.release();
    await cycle;

    expect(logs).toContain("warn:Sync skipped for 'repo-a': sync skipped: in_progress");
  });
});

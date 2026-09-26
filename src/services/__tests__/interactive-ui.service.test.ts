import * as fs from "fs/promises";
import * as path from "path";

import * as ink from "ink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppEventEmitter } from "../../utils/app-events";
import { calculateDirectorySize, calculateSyncDiskSpace, formatBytes } from "../../utils/disk-space";
import { InteractiveUIService } from "../InteractiveUIService";
import { RefScanScope } from "../worktree-status.service";

import type { Config } from "../../types";
import { WorktreeSyncService } from "../worktree-sync.service";
import type * as ChildProcessModule from "child_process";
import type * as FsModule from "fs";
import type * as cron from "node-cron";
import type { Mock, Mocked } from "vitest";

const { mockConfigLoaderInstance, mockWorktreeSyncServiceInstance, mockSpawn, mockSpawnSync, mockExistsSync } =
  vi.hoisted(() => {
    return {
      mockConfigLoaderInstance: (() => {
        const inst: any = {
          loadConfigFile: vi.fn<any>(),
          resolveRepositoryConfig: vi.fn<any>().mockImplementation((repo: any) => repo),
          filterRepositories: vi.fn<any>().mockImplementation((repos: any, filter: any) => {
            if (!filter) return repos;
            return repos.filter((r: any) => r.name?.startsWith(String(filter).replace("*", "")));
          }),
        };
        inst.buildRepositories = vi.fn<any>().mockImplementation(async (configPath: any, overrides: any) => {
          const configFile = await inst.loadConfigFile(configPath);
          let repositories = configFile.repositories.map((r: any) =>
            inst.resolveRepositoryConfig(r, configFile.defaults, "/test", configFile.retry),
          );
          if (overrides?.filter) {
            repositories = inst.filterRepositories(repositories, overrides.filter);
          }
          if (overrides?.noUpdateExisting) {
            repositories = repositories.map((r: any) => ({ ...r, updateExistingWorktrees: false }));
          }
          if (overrides?.debug) {
            repositories = repositories.map((r: any) => ({ ...r, debug: true }));
          }
          return { repositories, configFile, configDir: "" };
        });
        return inst;
      })(),
      mockWorktreeSyncServiceInstance: {
        sync: vi.fn<any>(),
        initialize: vi.fn<any>(),
        initializeUnlocked: vi.fn<any>().mockResolvedValue(undefined),
        isInitialized: vi.fn<any>().mockReturnValue(false),
        isSyncInProgress: vi.fn<any>().mockReturnValue(false),
        runQueuedRepoOperation: vi
          .fn<any>()
          .mockImplementation(async (op: any) => ({ started: true, value: await op() })),
        updateLogger: vi.fn<any>(),
        onProgress: vi.fn<any>().mockReturnValue(vi.fn()),
        getRecordedSkips: vi.fn<any>().mockReturnValue([]),
        clearRecordedSkips: vi.fn<any>(),
        config: {} as any,
      } as any,
      mockSpawn: vi.fn<any>().mockImplementation(() => ({
        on: vi.fn(),
        unref: vi.fn(),
      })),
      mockSpawnSync: vi.fn<any>().mockImplementation(() => ({ status: 1, stdout: "", stderr: "" })),
      mockExistsSync: vi.fn<any>().mockReturnValue(false),
    };
  });

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcessModule>("child_process");
  return {
    ...actual,
    spawn: mockSpawn,
    spawnSync: mockSpawnSync,
  };
});

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof FsModule>("fs");
  return {
    ...actual,
    existsSync: mockExistsSync,
  };
});

vi.mock("fs/promises");
vi.mock("../../utils/disk-space", () => ({
  calculateSyncDiskSpace: vi.fn().mockResolvedValue({ totalSize: 0, formattedSize: "0 B" }),
  calculateDirectorySize: vi.fn().mockResolvedValue(1024),
  formatBytes: vi.fn().mockReturnValue("1.0 KB"),
}));

vi.mock("../worktree-sync.service", () => ({
  WorktreeSyncService: vi.fn(function (this: any, config: any) {
    const instance = { ...mockWorktreeSyncServiceInstance };
    if (config) {
      instance.config = config;
    }
    return instance;
  }),
}));
vi.mock("../config-loader.service", () => ({
  ConfigLoaderService: vi.fn(function (this: any) {
    return mockConfigLoaderInstance;
  }),
}));
vi.mock("ink", () => ({
  render: vi.fn(),
}));

describe("InteractiveUIService", () => {
  let mockSyncService: Mocked<WorktreeSyncService>;
  let mockRender: Mock;
  let mockUnmount: Mock;

  beforeEach(() => {
    vi.clearAllMocks();

    mockUnmount = vi.fn();
    mockRender = ink.render as unknown as Mock;
    mockRender.mockImplementation(() => {
      (globalThis as any).__inkAppMethods = {
        updateLastSyncTime: vi.fn(),
        setStatus: vi.fn(),
      };
      return { unmount: mockUnmount, waitUntilExit: vi.fn(() => new Promise<void>(() => {})) };
    });

    const mockConfig: Config = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/test/worktrees",
      cronSchedule: "0 * * * *",
      runOnce: false,
    };

    mockSyncService = {
      sync: vi.fn<any>().mockResolvedValue(undefined),
      initialize: vi.fn<any>().mockResolvedValue(undefined),
      initializeUnlocked: vi.fn<any>().mockResolvedValue(undefined),
      isInitialized: vi.fn<any>().mockReturnValue(false),
      isCloneMode: vi.fn<any>().mockReturnValue(false),
      isSyncInProgress: vi.fn<any>().mockReturnValue(false),
      getRemoteBranches: vi.fn<any>(),
      getDefaultBranch: vi.fn<any>().mockResolvedValue("main"),
      checkoutBranch: vi.fn<any>().mockResolvedValue(undefined),
      createAndPushBranch: vi.fn<any>().mockResolvedValue(undefined),
      runQueuedRepoOperation: vi
        .fn<any>()
        .mockImplementation(async (op: any) => ({ started: true, value: await op() })),
      discardDivergedDirectory: vi.fn<any>().mockResolvedValue(undefined),
      getForceCleanPreview: vi.fn<any>().mockResolvedValue({
        trashEntries: 1,
        trashBytes: 1024,
        unknownTrashSizes: 0,
        invalidTrashEntries: 0,
        keepRefs: 1,
        trashEntryIds: ["entry-a"],
        keepRefNames: ["refs/sync-worktrees/keep/entry-a"],
      }),
      forceClean: vi.fn<any>().mockResolvedValue({
        trashEntries: 0,
        trashBytes: 0,
        unknownTrashSizes: 0,
        invalidTrashEntries: 0,
        keepRefs: 0,
        trashEntryIds: [],
        keepRefNames: [],
        trashDeleted: 1,
        keepRefsDeleted: 1,
        keepRefsRetained: 0,
        skippedNewEntries: 0,
        skippedNewKeepRefs: 0,
        gcSucceeded: true,
        errors: [],
      }),
      updateLogger: vi.fn<any>(),
      onProgress: vi.fn<any>().mockReturnValue(vi.fn()),
      getRecordedSkips: vi.fn<any>().mockReturnValue([]),
      clearRecordedSkips: vi.fn<any>(),
      config: mockConfig,
    } as any;

    mockWorktreeSyncServiceInstance.sync.mockResolvedValue(undefined);
    mockWorktreeSyncServiceInstance.initialize.mockResolvedValue(undefined);
    mockWorktreeSyncServiceInstance.isInitialized.mockReturnValue(false);
    mockWorktreeSyncServiceInstance.isSyncInProgress.mockReturnValue(false);
    mockWorktreeSyncServiceInstance.onProgress.mockReturnValue(vi.fn());
    mockWorktreeSyncServiceInstance.config = mockConfig;

    delete (globalThis as any).__inkAppMethods;
  });

  describe("constructor", () => {
    it("should throw error if no sync services provided", () => {
      expect(() => new InteractiveUIService([], undefined, "0 * * * *")).toThrow(
        "InteractiveUIService requires at least one WorktreeSyncService",
      );
    });

    it("should initialize with single sync service", () => {
      const service = new InteractiveUIService([mockSyncService], undefined, "0 * * * *");
      expect(service).toBeDefined();
      void service.destroy();
    });

    it("should initialize with multiple sync services", () => {
      const service = new InteractiveUIService([mockSyncService, mockSyncService], undefined, "0 * * * *");
      expect(service).toBeDefined();
      void service.destroy();
    });

    it("should forward service progress events with the repository name", () => {
      let progressListener: ((event: { phase: string; message: string; progress?: number }) => void) | undefined;
      mockSyncService.onProgress.mockImplementation((listener) => {
        progressListener = listener;
        return vi.fn();
      });

      const service = new InteractiveUIService([mockSyncService]);
      const progressSpy = vi.fn();
      service.getEvents().on("setSyncProgress", progressSpy);

      progressListener?.({ phase: "fetch", message: "fetch receiving: 75% (3/4)", progress: 75 });

      expect(progressSpy).toHaveBeenCalledWith({
        repo: "repo-0",
        phase: "fetch",
        message: "fetch receiving: 75% (3/4)",
        progress: 75,
        processed: undefined,
        total: undefined,
      });
      void service.destroy();
    });

    it("should be able to emit events after initialization", () => {
      const service = new InteractiveUIService([mockSyncService]);
      const statusSpy = vi.fn();
      const updateSpy = vi.fn();

      service.getEvents().on("setStatus", statusSpy);
      service.getEvents().on("updateLastSyncTime", updateSpy);

      service.setStatus("syncing");
      service.updateLastSyncTime();

      expect(statusSpy).toHaveBeenCalledWith("syncing");
      expect(updateSpy).toHaveBeenCalled();

      void service.destroy();
    });
  });

  describe("logger injection", () => {
    it("should inject loggers into sync services", () => {
      const service = new InteractiveUIService([mockSyncService]);

      expect(mockSyncService.updateLogger).toHaveBeenCalled();

      void service.destroy();
    });

    it("should inject loggers into multiple sync services", () => {
      const mockSyncService2 = {
        sync: vi.fn<any>().mockResolvedValue(undefined),
        initialize: vi.fn<any>().mockResolvedValue(undefined),
        isSyncInProgress: vi.fn<any>().mockReturnValue(false),
        updateLogger: vi.fn<any>(),
        config: { ...mockSyncService.config, name: "repo-2" },
      } as any;

      const service = new InteractiveUIService([mockSyncService, mockSyncService2]);

      expect(mockSyncService.updateLogger).toHaveBeenCalled();
      expect(mockSyncService2.updateLogger).toHaveBeenCalled();

      void service.destroy();
    });
  });

  describe("updateLastSyncTime method", () => {
    it("should emit updateLastSyncTime event", () => {
      const service = new InteractiveUIService([mockSyncService]);
      const updateSpy = vi.fn();
      service.getEvents().on("updateLastSyncTime", updateSpy);

      service.updateLastSyncTime();

      expect(updateSpy).toHaveBeenCalled();

      void service.destroy();
    });

    it("should not throw when no listeners", () => {
      const service = new InteractiveUIService([mockSyncService]);

      expect(() => service.updateLastSyncTime()).not.toThrow();

      void service.destroy();
    });
  });

  describe("calculateAndUpdateDiskSpace", () => {
    it("reports a failed calculation in the log pane and shows N/A", async () => {
      vi.mocked(calculateSyncDiskSpace).mockRejectedValueOnce(new Error("measure blew up"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const service = new InteractiveUIService([mockSyncService]);
      const logs: Array<{ message: string; level: string }> = [];
      const diskSpace: string[] = [];
      service.getEvents().on("addLog", (entry) => void logs.push(entry));
      service.getEvents().on("setDiskSpace", (value) => void diskSpace.push(value));
      service.getEvents().emit("uiReady");

      await service.calculateAndUpdateDiskSpace();

      expect(logs).toContainEqual({ message: "Failed to calculate disk space: measure blew up", level: "error" });
      expect(diskSpace).toEqual(["N/A"]);
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();

      void service.destroy();
    });
  });

  describe("setStatus method", () => {
    it("should emit setStatus event", () => {
      const service = new InteractiveUIService([mockSyncService]);
      const setStatusSpy = vi.fn();
      service.getEvents().on("setStatus", setStatusSpy);

      service.setStatus("syncing");

      expect(setStatusSpy).toHaveBeenCalledWith("syncing");

      void service.destroy();
    });

    it("should handle both idle and syncing statuses", () => {
      const service = new InteractiveUIService([mockSyncService]);
      const setStatusSpy = vi.fn();
      service.getEvents().on("setStatus", setStatusSpy);

      service.setStatus("idle");
      service.setStatus("syncing");

      expect(setStatusSpy).toHaveBeenCalledWith("idle");
      expect(setStatusSpy).toHaveBeenCalledWith("syncing");

      void service.destroy();
    });
  });

  describe("destroy method", () => {
    it("should restore console and unmount app", async () => {
      const service = new InteractiveUIService([mockSyncService]);

      await service.destroy();

      expect(typeof console.log).toBe("function");
      expect(typeof console.warn).toBe("function");
      expect(typeof console.error).toBe("function");
      expect(mockUnmount).toHaveBeenCalled();
    });

    it("should clean up event listeners", async () => {
      const service = new InteractiveUIService([mockSyncService]);
      const statusSpy = vi.fn();
      service.getEvents().on("setStatus", statusSpy);

      await service.destroy();

      // After destroy, emitting events should not call listeners (they were removed)
      service.getEvents().emit("setStatus", "syncing");
      expect(statusSpy).not.toHaveBeenCalled();
    });

    it("should be safe to call multiple times", async () => {
      const service = new InteractiveUIService([mockSyncService]);

      await service.destroy();
      await service.destroy();
    });

    it("should prevent updates after destroy (isDestroyed guard)", async () => {
      const service = new InteractiveUIService([mockSyncService]);
      const statusSpy = vi.fn();
      const updateSpy = vi.fn();
      service.getEvents().on("setStatus", statusSpy);
      service.getEvents().on("updateLastSyncTime", updateSpy);

      await service.destroy();

      // After destroy, these should be no-ops
      service.setStatus("syncing");
      service.updateLastSyncTime();

      expect(statusSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it("should resolve quickly when called with fast option even if sync stays in progress", async () => {
      mockSyncService.isSyncInProgress.mockReturnValue(true);
      const service = new InteractiveUIService([mockSyncService]);

      vi.useFakeTimers();
      try {
        const destroyPromise = service.destroy(true);
        await vi.advanceTimersByTimeAsync(2500);
        await expect(destroyPromise).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }

      expect(mockUnmount).toHaveBeenCalled();
    });

    it("should use slow timeout by default when sync is not in progress", async () => {
      mockSyncService.isSyncInProgress.mockReturnValue(false);
      const service = new InteractiveUIService([mockSyncService]);

      await expect(service.destroy()).resolves.toBeUndefined();
      expect(mockUnmount).toHaveBeenCalled();
    });

    const collectLogs = (): { events: AppEventEmitter; messages: string[] } => {
      const events = new AppEventEmitter();
      const messages: string[] = [];
      events.on("addLog", ({ message }) => void messages.push(message));
      return { events, messages };
    };

    // The two timeouts are a policy, not an accident: a signal has a watchdog
    // behind it and must not sit on a 30s wait, while `q` is a person who asked
    // to leave and can afford to let a fetch land.
    it("keeps the 2s timeout for the signal path and the 30s timeout for the q path", async () => {
      mockSyncService.isSyncInProgress.mockReturnValue(true);
      const fast = collectLogs();
      const slow = collectLogs();
      const fastService = new InteractiveUIService([mockSyncService], undefined, undefined, undefined, fast.events);
      const slowService = new InteractiveUIService([mockSyncService], undefined, undefined, undefined, slow.events);
      fast.events.emit("uiReady");
      slow.events.emit("uiReady");
      fast.messages.length = 0;
      slow.messages.length = 0;

      vi.useFakeTimers();
      try {
        const fastShutdown = fastService.destroy(true);
        const slowShutdown = slowService.destroy();

        await vi.advanceTimersByTimeAsync(1900);
        expect(fast.messages.some((message) => message.startsWith("Warning: Timeout"))).toBe(false);

        await vi.advanceTimersByTimeAsync(1000);
        await fastShutdown;
        expect(fast.messages).toContain(
          "Warning: Timeout waiting for sync operations to complete after 2.0s. Proceeding with potential data loss risk.",
        );
        expect(slow.messages.some((message) => message.startsWith("Warning: Timeout"))).toBe(false);

        await vi.advanceTimersByTimeAsync(27000);
        expect(slow.messages.some((message) => message.startsWith("Warning: Timeout"))).toBe(false);

        await vi.advanceTimersByTimeAsync(1000);
        await slowShutdown;
        expect(slow.messages).toContain(
          "Warning: Timeout waiting for sync operations to complete after 30.0s. Proceeding with potential data loss risk.",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports the wait while it is still waiting, not after everything is torn down", async () => {
      mockSyncService.isSyncInProgress.mockReturnValue(true);
      const { events, messages } = collectLogs();
      const service = new InteractiveUIService([mockSyncService], undefined, undefined, undefined, events);
      events.emit("uiReady");
      messages.length = 0;

      vi.useFakeTimers();
      try {
        const shutdown = service.destroy(true);
        await vi.advanceTimersByTimeAsync(10);
        // Emitted while the interface is still mounted and listening, which is
        // the whole point: isDestroyed is set after the wait, not before it.
        expect(messages).toContain(
          "Waiting for 1 in-progress sync(s) to finish... Press q or Ctrl+C again to quit now.",
        );
        expect(mockUnmount).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(2500);
        await shutdown;
        expect(mockUnmount).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores a key repeat inside the guard window but honours a deliberate second quit", async () => {
      mockSyncService.isSyncInProgress.mockReturnValue(true);
      const service = new InteractiveUIService([mockSyncService]);

      const shutdown = service.destroy();
      let settled = false;
      void shutdown.then(() => {
        settled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      void service.destroy();
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(settled).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 400));
      void service.destroy();

      const outcome = await Promise.race([
        shutdown.then(() => "shut down"),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 3000)),
      ]);
      expect(outcome).toBe("shut down");
    });
  });

  describe("registerCronJob", () => {
    it("should stop registered cron jobs on destroy", async () => {
      const service = new InteractiveUIService([mockSyncService]);
      const destroySpy = vi.fn();
      service.scheduler.registerCronJob({ stop: vi.fn(), destroy: destroySpy } as unknown as cron.ScheduledTask);

      await service.destroy();

      expect(destroySpy).toHaveBeenCalled();
    });
  });

  describe("handleManualSync", () => {
    it("should sync all services on manual sync", async () => {
      const service = new InteractiveUIService([mockSyncService]);
      const onManualSync = (mockRender.mock.calls[0][0].props as any).onManualSync;

      await onManualSync();

      expect(mockSyncService.sync).toHaveBeenCalled();

      void service.destroy();
    });

    it("should sync multiple services", async () => {
      const mockService2 = {
        ...mockSyncService,
        sync: vi.fn<any>().mockResolvedValue(undefined),
        initialize: vi.fn<any>().mockResolvedValue(undefined),
        isInitialized: vi.fn<any>().mockReturnValue(false),
        isSyncInProgress: vi.fn<any>().mockReturnValue(false),
      };
      const service = new InteractiveUIService([mockSyncService, mockService2 as any]);
      const onManualSync = (mockRender.mock.calls[0][0].props as any).onManualSync;

      await onManualSync();

      expect(mockSyncService.sync).toHaveBeenCalled();
      expect(mockService2.sync).toHaveBeenCalled();

      void service.destroy();
    });

    it("syncs only the repository the switcher picked", async () => {
      const mockService2 = {
        ...mockSyncService,
        sync: vi.fn<any>().mockResolvedValue(undefined),
        isInitialized: vi.fn<any>().mockReturnValue(true),
        isSyncInProgress: vi.fn<any>().mockReturnValue(false),
      };
      const service = new InteractiveUIService([mockSyncService, mockService2 as any]);
      const onSyncRepository = (mockRender.mock.calls[0][0].props as any).onSyncRepository;

      await onSyncRepository(1);

      expect(mockService2.sync).toHaveBeenCalledTimes(1);
      expect(mockSyncService.sync).not.toHaveBeenCalled();
      await expect(onSyncRepository(5)).rejects.toThrow("Invalid repository index: 5");

      void service.destroy();
    });

    it("should handle sync errors gracefully", async () => {
      mockSyncService.sync.mockRejectedValue(new Error("Sync failed"));
      const service = new InteractiveUIService([mockSyncService]);
      const onManualSync = (mockRender.mock.calls[0][0].props as any).onManualSync;

      await expect(onManualSync()).resolves.not.toThrow();

      void service.destroy();
    });

    it("logs a repo whose lock could not be taken as a failure, not a skip", async () => {
      // An unwritable state dir is not contention: the daemon must surface it
      // at error level with the path and errno, never as "Sync skipped".
      const lockService = {
        sync: vi.fn<any>().mockResolvedValue({
          started: false,
          reason: "lock_unavailable",
          path: "/state/sync-worktrees/locks",
          code: "ENOTDIR",
          error: "ENOTDIR: not a directory, mkdir '/state/sync-worktrees/locks'",
        }),
        initialize: vi.fn<any>().mockResolvedValue(undefined),
        isInitialized: vi.fn<any>().mockReturnValue(true),
        isSyncInProgress: vi.fn<any>().mockReturnValue(false),
        updateLogger: vi.fn<any>(),
        clearRecordedSkips: vi.fn<any>(),
        getRecordedSkips: vi.fn<any>().mockReturnValue([]),
        config: { name: "alpha", worktreeDir: "/repo/alpha", repoUrl: "u" },
      };

      const service = new InteractiveUIService([lockService as any]);
      const logs: Array<{ message: string; level: string }> = [];
      service.getEvents().on("addLog", (entry: any) => logs.push(entry));
      service.getEvents().emit("uiReady");

      const onManualSync = (mockRender.mock.calls[0][0].props as any).onManualSync;
      await onManualSync();

      const failureLogs = logs.filter((l) => l.message.includes("/state/sync-worktrees/locks"));
      expect(failureLogs.length).toBeGreaterThan(0);
      for (const log of failureLogs) {
        expect(log.level).toBe("error");
        expect(log.message).toMatch(/^Failed to sync repository 'alpha'/);
        expect(log.message).toContain("ENOTDIR");
      }
      expect(logs.some((l) => /^Sync skipped for/.test(l.message))).toBe(false);
      expect(logs.some((l) => /another process/i.test(l.message))).toBe(false);

      void service.destroy();
    });

    it("clears, collects, and logs clone-mode skips per cycle", async () => {
      const skipService = {
        sync: vi.fn<any>().mockResolvedValue({ started: true }),
        initialize: vi.fn<any>().mockResolvedValue(undefined),
        isInitialized: vi.fn<any>().mockReturnValue(true),
        isSyncInProgress: vi.fn<any>().mockReturnValue(false),
        updateLogger: vi.fn<any>(),
        clearRecordedSkips: vi.fn<any>(),
        getRecordedSkips: vi.fn<any>().mockReturnValue([
          {
            kind: "branch_mismatch",
            phase: "sync",
            currentBranch: "feature",
            expectedBranch: "main",
          },
          { kind: "dirty_tree" },
        ]),
        config: { name: "alpha", worktreeDir: "/repo/alpha", repoUrl: "u" },
      };

      const service = new InteractiveUIService([skipService as any]);
      const logs: Array<{ message: string; level: string }> = [];
      service.getEvents().on("addLog", (entry: any) => logs.push(entry));
      service.getEvents().emit("uiReady");

      const onManualSync = (mockRender.mock.calls[0][0].props as any).onManualSync;
      await onManualSync();

      expect(skipService.clearRecordedSkips).toHaveBeenCalledTimes(1);
      const messages = logs.map((l) => l.message);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Clone-mode skip for 'alpha': clone is on 'feature', expected 'main'"),
          expect.stringContaining("Clone-mode skip for 'alpha': working tree has local changes"),
          expect.stringContaining("2 clone-mode skip(s) this cycle"),
        ]),
      );

      void service.destroy();
    });

    it("updates last-sync timestamp even when only clone-mode phase skips occurred", async () => {
      const skipService = {
        sync: vi.fn<any>().mockResolvedValue({ started: true }),
        initialize: vi.fn<any>().mockResolvedValue(undefined),
        isInitialized: vi.fn<any>().mockReturnValue(true),
        isSyncInProgress: vi.fn<any>().mockReturnValue(false),
        updateLogger: vi.fn<any>(),
        clearRecordedSkips: vi.fn<any>(),
        getRecordedSkips: vi.fn<any>().mockReturnValue([{ kind: "dirty_tree" }]),
        config: { name: "alpha", worktreeDir: "/repo/alpha", repoUrl: "u" },
      };

      const service = new InteractiveUIService([skipService as any]);
      const updateSpy = vi.fn();
      service.getEvents().on("updateLastSyncTime", updateSpy);

      const onManualSync = (mockRender.mock.calls[0][0].props as any).onManualSync;
      await onManualSync();

      expect(updateSpy).toHaveBeenCalled();

      void service.destroy();
    });

    it("updates last-sync timestamp and logs at info when only per-action worktree skips occurred", async () => {
      const partialService = {
        sync: vi.fn<any>().mockResolvedValue({
          started: true,
          outcome: {
            actions: [],
            counts: {
              created: 0,
              removed: 0,
              updated: 0,
              skipped: 1,
              preserved: 0,
              failed: 0,
              noop: 0,
            },
            mode: "worktree",
            started: true,
          },
        }),
        initialize: vi.fn<any>().mockResolvedValue(undefined),
        isInitialized: vi.fn<any>().mockReturnValue(true),
        isSyncInProgress: vi.fn<any>().mockReturnValue(false),
        updateLogger: vi.fn<any>(),
        clearRecordedSkips: vi.fn<any>(),
        getRecordedSkips: vi.fn<any>().mockReturnValue([]),
        config: { name: "alpha", worktreeDir: "/repo/alpha", repoUrl: "u" },
      };

      const service = new InteractiveUIService([partialService as any]);
      const updateSpy = vi.fn();
      const logs: Array<{ message: string; level: string }> = [];
      service.getEvents().on("updateLastSyncTime", updateSpy);
      service.getEvents().on("addLog", (entry: any) => logs.push(entry));
      service.getEvents().emit("uiReady");

      const onManualSync = (mockRender.mock.calls[0][0].props as any).onManualSync;
      await onManualSync();

      // Last-sync time must still advance — per-action skips are not "whole repo skipped".
      expect(updateSpy).toHaveBeenCalled();

      // The cycle log message must be info-level (not warn) and must NOT contain
      // the whole-repo "Sync skipped for" wording.
      const partialLogs = logs.filter((l) => l.message.includes("1 sync action(s) skipped"));
      expect(partialLogs.length).toBeGreaterThan(0);
      for (const log of partialLogs) {
        expect(log.level).toBe("info");
        expect(log.message).not.toMatch(/^Sync skipped for/);
      }

      void service.destroy();
    });
  });

  describe("triggerInitialSync", () => {
    it("should sync all services when called directly", async () => {
      const service = new InteractiveUIService([mockSyncService]);

      await service.triggerInitialSync();

      expect(mockSyncService.sync).toHaveBeenCalled();

      void service.destroy();
    });

    it("should set status to syncing then idle", async () => {
      const service = new InteractiveUIService([mockSyncService]);
      const statusChanges: string[] = [];
      service.getEvents().on("setStatus", (status: string) => statusChanges.push(status));

      await service.triggerInitialSync();

      expect(statusChanges).toContain("syncing");
      expect(statusChanges[statusChanges.length - 1]).toBe("idle");

      void service.destroy();
    });

    it("should update last sync time after sync", async () => {
      const service = new InteractiveUIService([mockSyncService]);
      const updateSpy = vi.fn();
      service.getEvents().on("updateLastSyncTime", updateSpy);

      await service.triggerInitialSync();

      expect(updateSpy).toHaveBeenCalled();

      void service.destroy();
    });

    it("should run services in parallel respecting maxParallel limit", async () => {
      const syncOrder: number[] = [];
      let concurrentCount = 0;
      let maxConcurrent = 0;

      const createMockService = (id: number) => ({
        ...mockSyncService,
        sync: vi.fn<any>().mockImplementation(async () => {
          concurrentCount++;
          maxConcurrent = Math.max(maxConcurrent, concurrentCount);
          syncOrder.push(id);
          await new Promise((resolve) => setTimeout(resolve, 50));
          concurrentCount--;
        }),
        initialize: vi.fn<any>().mockResolvedValue(undefined),
        isInitialized: vi.fn<any>().mockReturnValue(true),
        isSyncInProgress: vi.fn<any>().mockReturnValue(false),
        config: { ...mockSyncService.config, name: `repo-${id}` },
        updateLogger: vi.fn(),
      });

      const services = [createMockService(1), createMockService(2), createMockService(3), createMockService(4)];

      // maxParallel = 2 means at most 2 services should run concurrently
      const service = new InteractiveUIService(services as any, undefined, undefined, 2);

      await service.triggerInitialSync();

      // All services should have synced
      expect(services[0].sync).toHaveBeenCalled();
      expect(services[1].sync).toHaveBeenCalled();
      expect(services[2].sync).toHaveBeenCalled();
      expect(services[3].sync).toHaveBeenCalled();

      // Max concurrent should respect the limit
      expect(maxConcurrent).toBeLessThanOrEqual(2);

      void service.destroy();
    });

    it("should use default parallelism when maxParallel not specified", async () => {
      let concurrentCount = 0;
      let maxConcurrent = 0;

      const createMockService = (id: number) => ({
        ...mockSyncService,
        sync: vi.fn<any>().mockImplementation(async () => {
          concurrentCount++;
          maxConcurrent = Math.max(maxConcurrent, concurrentCount);
          await new Promise((resolve) => setTimeout(resolve, 20));
          concurrentCount--;
        }),
        initialize: vi.fn<any>().mockResolvedValue(undefined),
        isInitialized: vi.fn<any>().mockReturnValue(true),
        isSyncInProgress: vi.fn<any>().mockReturnValue(false),
        config: { ...mockSyncService.config, name: `repo-${id}` },
        updateLogger: vi.fn(),
      });

      const services = [createMockService(1), createMockService(2), createMockService(3)];

      // No maxParallel specified - should use default (2)
      const service = new InteractiveUIService(services as any);

      await service.triggerInitialSync();

      // All services should have synced
      services.forEach((s) => expect(s.sync).toHaveBeenCalled());

      // Default is 2, so max concurrent should be at most 2
      expect(maxConcurrent).toBeLessThanOrEqual(2);

      void service.destroy();
    });

    it("should handle errors in parallel sync without affecting other services", async () => {
      const successService = {
        ...mockSyncService,
        sync: vi.fn<any>().mockResolvedValue(undefined),
        initialize: vi.fn<any>().mockResolvedValue(undefined),
        isInitialized: vi.fn<any>().mockReturnValue(true),
        isSyncInProgress: vi.fn<any>().mockReturnValue(false),
        config: { ...mockSyncService.config, name: "success-repo" },
        updateLogger: vi.fn(),
      };

      const failingService = {
        ...mockSyncService,
        sync: vi.fn<any>().mockRejectedValue(new Error("Sync failed")),
        initialize: vi.fn<any>().mockResolvedValue(undefined),
        isInitialized: vi.fn<any>().mockReturnValue(true),
        isSyncInProgress: vi.fn<any>().mockReturnValue(false),
        config: { ...mockSyncService.config, name: "failing-repo" },
        updateLogger: vi.fn(),
      };

      const service = new InteractiveUIService([successService, failingService] as any, undefined, undefined, 2);

      // Should not throw - errors are handled gracefully
      await service.triggerInitialSync();

      // Both services should have been called
      expect(successService.sync).toHaveBeenCalled();
      expect(failingService.sync).toHaveBeenCalled();

      void service.destroy();
    });

    it("should log per-repository sync failures", async () => {
      const service = new InteractiveUIService([mockSyncService]);
      const logs: Array<{ message: string; level: string }> = [];
      service.getEvents().on("addLog", (entry: { message: string; level: string }) => logs.push(entry));

      service.getEvents().emit("uiReady");
      mockSyncService.sync.mockRejectedValue(new Error("Sync failed"));
      vi.spyOn(mockSyncService, "config", "get").mockReturnValue({
        ...(mockSyncService.config as object),
        name: "failing-repo",
      } as typeof mockSyncService.config & { name: string });

      await service.triggerInitialSync();

      expect(logs).toContainEqual({
        message: "Failed to sync repository 'failing-repo': Sync failed",
        level: "error",
      });

      void service.destroy();
    });
  });

  describe("handleReload", () => {
    it("should skip reload when no config file in single-repo mode", async () => {
      const service = new InteractiveUIService([mockSyncService]);
      const setStatusSpy = vi.fn();
      service.getEvents().on("setStatus", setStatusSpy);

      const onReload = (mockRender.mock.calls[0][0].props as any).onReload;

      await onReload();

      expect(setStatusSpy).toHaveBeenCalledWith("idle");

      void service.destroy();
    });

    it("should reload config and sync when config path provided", async () => {
      mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
        repositories: [
          {
            name: "test-repo",
            repoUrl: "https://github.com/test/repo.git",
            worktreeDir: "/test/worktrees",
            cronSchedule: "0 * * * *",
            runOnce: false,
          },
        ],
      });

      const service = new InteractiveUIService([mockSyncService], "/test/config.js");
      const onReload = (mockRender.mock.calls[0][0].props as any).onReload;

      await onReload();

      expect(mockConfigLoaderInstance.loadConfigFile).toHaveBeenCalledWith("/test/config.js");
      expect(mockWorktreeSyncServiceInstance.initialize).toHaveBeenCalled();
      expect(mockWorktreeSyncServiceInstance.sync).toHaveBeenCalled();

      void service.destroy();
    });

    // --debug is applied when the config is loaded. The reload loads it again,
    // so without being told the dashboard dropped debug output after an `r`.
    it.each([
      { debug: true, expectDebugLine: true },
      { debug: false, expectDebugLine: false },
    ])("applies the --debug override ($debug) to the repositories a reload loads", async (c) => {
      mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
        repositories: [
          {
            name: "alpha",
            repoUrl: "https://github.com/test/repo.git",
            worktreeDir: "/test/worktrees",
            cronSchedule: "0 * * * *",
            runOnce: false,
            debug: false,
          },
        ],
      });

      const service = new InteractiveUIService([mockSyncService], "/test/config.js", undefined, undefined, undefined, {
        debug: c.debug,
      });
      const logs: string[] = [];
      service.getEvents().on("addLog", (entry: any) => logs.push(entry.message));
      service.getEvents().emit("uiReady");

      const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
      await onReload();

      expect(mockConfigLoaderInstance.buildRepositories).toHaveBeenCalledWith("/test/config.js", { debug: c.debug });
      const reloaded = vi.mocked(WorktreeSyncService).mock.calls.at(-1)![0] as any;
      expect(reloaded.debug).toBe(c.debug);
      // And the logger the dashboard built for it follows suit.
      reloaded.logger.debug("debug probe line");
      expect(logs.some((message) => message.includes("debug probe line"))).toBe(c.expectDebugLine);

      void service.destroy();
    });

    // `sync-worktrees --filter backend-*` starts the UI on a subset; a reload
    // re-reads the whole file and must not widen that back to every repository.
    it("keeps the --filter the CLI started with across a reload", async () => {
      const repo = (name: string): Record<string, unknown> => ({
        name,
        repoUrl: `https://github.com/test/${name}.git`,
        worktreeDir: `/test/${name}`,
        cronSchedule: "0 * * * *",
        runOnce: false,
      });
      mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
        repositories: [repo("backend-api"), repo("frontend-web")],
      });

      const service = new InteractiveUIService([mockSyncService], "/test/config.js");
      service.setRepositoryFilter("backend-*");
      vi.mocked(WorktreeSyncService).mockClear();
      const onReload = (mockRender.mock.calls[0][0].props as any).onReload;

      await onReload();

      expect(mockConfigLoaderInstance.buildRepositories).toHaveBeenCalledWith("/test/config.js", {
        debug: false,
        filter: "backend-*",
      });
      const rebuilt = vi.mocked(WorktreeSyncService).mock.calls.map(([config]) => (config as { name?: string }).name);
      expect(rebuilt).toEqual(["backend-api"]);

      void service.destroy();
    });

    it("keeps the running services and names the filter when a reload leaves --filter matching nothing", async () => {
      mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
        repositories: [
          {
            name: "frontend-web",
            repoUrl: "https://github.com/test/frontend-web.git",
            worktreeDir: "/test/frontend-web",
            cronSchedule: "0 * * * *",
            runOnce: false,
          },
        ],
      });

      const service = new InteractiveUIService([mockSyncService], "/test/config.js");
      service.setRepositoryFilter("backend-*");
      const logs: Array<{ message: string; level: string }> = [];
      service.getEvents().on("addLog", (entry: any) => logs.push(entry));
      service.getEvents().emit("uiReady");
      vi.mocked(WorktreeSyncService).mockClear();
      const onReload = (mockRender.mock.calls[0][0].props as any).onReload;

      await onReload();

      expect(vi.mocked(WorktreeSyncService)).not.toHaveBeenCalled();
      expect(logs).toContainEqual(
        expect.objectContaining({ message: "Reload failed: No repositories match filter: backend-*", level: "error" }),
      );
      expect((service as any).syncServices).toEqual([mockSyncService]);

      void service.destroy();
    });

    it("preserves clone-mode skips recorded during reload initialization", async () => {
      mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
        repositories: [
          {
            name: "alpha",
            repoUrl: "https://github.com/test/repo.git",
            worktreeDir: "/test/worktrees",
            cronSchedule: "0 * * * *",
            runOnce: false,
          },
        ],
      });
      mockWorktreeSyncServiceInstance.getRecordedSkips
        .mockReturnValueOnce([{ kind: "head_unreadable", phase: "init", error: "bad HEAD" }])
        .mockReturnValueOnce([]);

      const service = new InteractiveUIService([mockSyncService], "/test/config.js");
      const logs: Array<{ message: string; level: string }> = [];
      service.getEvents().on("addLog", (entry: any) => logs.push(entry));
      service.getEvents().emit("uiReady");

      const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
      await onReload();

      const messages = logs.map((l) => l.message);
      expect(messages).toEqual(
        expect.arrayContaining([
          "Clone-mode skip for 'alpha': could not read HEAD: bad HEAD",
          "⚠️  1 clone-mode skip(s) during reload",
        ]),
      );

      void service.destroy();
    });

    it("should handle reload errors gracefully", async () => {
      mockConfigLoaderInstance.loadConfigFile.mockRejectedValue(new Error("Failed to load config"));

      const service = new InteractiveUIService([mockSyncService], "/test/config.js");
      const onReload = (mockRender.mock.calls[0][0].props as any).onReload;

      await expect(onReload()).resolves.not.toThrow();

      void service.destroy();
    });

    it("should prevent concurrent reloads (re-entry guard)", async () => {
      let resolveLoadConfig: () => void;
      const loadConfigPromise = new Promise<void>((resolve) => {
        resolveLoadConfig = resolve;
      });

      mockConfigLoaderInstance.loadConfigFile.mockImplementation(async () => {
        await loadConfigPromise;
        return {
          repositories: [
            {
              name: "test-repo",
              repoUrl: "https://github.com/test/repo.git",
              worktreeDir: "/test/worktrees",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
          ],
        };
      });

      const service = new InteractiveUIService([mockSyncService], "/test/config.js");
      const onReload = (mockRender.mock.calls[0][0].props as any).onReload;

      // Start first reload
      const firstReload = onReload();

      // Second reload should be a no-op since first is still in progress
      const secondReload = onReload();

      // Release the config loading
      resolveLoadConfig!();
      await firstReload;
      await secondReload;

      // loadConfigFile should only be called once (second reload was skipped)
      expect(mockConfigLoaderInstance.loadConfigFile).toHaveBeenCalledTimes(1);

      void service.destroy();
    });

    describe("cron job management on reload", () => {
      it("should cancel existing cron jobs before reload", async () => {
        mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
          repositories: [
            {
              name: "test-repo",
              repoUrl: "https://github.com/test/repo.git",
              worktreeDir: "/test/worktrees",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
          ],
        });

        const service = new InteractiveUIService([mockSyncService, mockSyncService], "/test/config.js", "0 * * * *");
        const cronJobsSpy = vi.fn();
        (service as any).scheduler.cronJobs = [
          { stop: vi.fn(), destroy: cronJobsSpy },
          { stop: vi.fn(), destroy: cronJobsSpy },
        ];

        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
        await onReload();

        expect(cronJobsSpy).toHaveBeenCalledTimes(2);

        void service.destroy();
      });

      it("should not duplicate cron jobs when config load fails before cancel", async () => {
        mockConfigLoaderInstance.loadConfigFile.mockRejectedValue(new Error("Failed to load config"));

        const service = new InteractiveUIService([mockSyncService], "/test/config.js", "0 * * * *");
        // destroy() as well as stop(): the teardown at the end of this test
        // calls it, and a double without it only reaches cancelCronJobs' catch,
        // which would turn a missing method into a warning nobody reads.
        const preExistingJob = { stop: vi.fn(), destroy: vi.fn() };
        (service as any).scheduler.cronJobs = [preExistingJob];

        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
        await onReload();

        const cronJobs = (service as any).scheduler.cronJobs;
        expect(cronJobs).toHaveLength(1);
        expect(preExistingJob.stop).not.toHaveBeenCalled();

        void service.destroy();
      });

      it("should create new cron jobs after reload (grouped by schedule)", async () => {
        mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
          repositories: [
            {
              name: "test-repo-1",
              repoUrl: "https://github.com/test/repo1.git",
              worktreeDir: "/test/worktrees1",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
            {
              name: "test-repo-2",
              repoUrl: "https://github.com/test/repo2.git",
              worktreeDir: "/test/worktrees2",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
          ],
        });

        const service = new InteractiveUIService([mockSyncService], "/test/config.js", "0 * * * *");
        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;

        await onReload();

        const cronJobs = (service as any).scheduler.cronJobs;
        expect(cronJobs).toBeDefined();
        expect(cronJobs.length).toBe(1);

        void service.destroy();
      });

      it("should handle reload with different number of repositories", async () => {
        mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
          repositories: [
            {
              name: "test-repo-1",
              repoUrl: "https://github.com/test/repo1.git",
              worktreeDir: "/test/worktrees1",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
          ],
        });

        const service = new InteractiveUIService(
          [mockSyncService, mockSyncService, mockSyncService],
          "/test/config.js",
          "0 * * * *",
        );

        // Constructor no longer creates cron jobs (index.ts handles cron setup)
        let cronJobs = (service as any).scheduler.cronJobs;
        expect(cronJobs.length).toBe(0);

        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
        await onReload();

        // After reload, cron jobs are created via setupCronJobs
        cronJobs = (service as any).scheduler.cronJobs;
        expect(cronJobs.length).toBe(1);

        void service.destroy();
      });

      it("should not create cron jobs when runOnce is true", async () => {
        mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
          repositories: [
            {
              name: "test-repo",
              repoUrl: "https://github.com/test/repo.git",
              worktreeDir: "/test/worktrees",
              cronSchedule: "0 * * * *",
              runOnce: true,
            },
          ],
        });

        const service = new InteractiveUIService([mockSyncService], "/test/config.js", "0 * * * *");
        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;

        await onReload();

        const cronJobs = (service as any).scheduler.cronJobs;
        expect(cronJobs).toEqual([]);

        void service.destroy();
      });

      it("should handle mixed runOnce configurations", async () => {
        mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
          repositories: [
            {
              name: "test-repo-1",
              repoUrl: "https://github.com/test/repo1.git",
              worktreeDir: "/test/worktrees1",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
            {
              name: "test-repo-2",
              repoUrl: "https://github.com/test/repo2.git",
              worktreeDir: "/test/worktrees2",
              cronSchedule: "0 * * * *",
              runOnce: true,
            },
            {
              name: "test-repo-3",
              repoUrl: "https://github.com/test/repo3.git",
              worktreeDir: "/test/worktrees3",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
          ],
        });

        const service = new InteractiveUIService([mockSyncService], "/test/config.js", "0 * * * *");
        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;

        await onReload();

        const cronJobs = (service as any).scheduler.cronJobs;
        // 2 non-runOnce repos with same schedule = 1 grouped cron job
        expect(cronJobs.length).toBe(1);

        void service.destroy();
      });
    });

    describe("repository count update on reload", () => {
      it("should update repository count after reload with fewer repos", async () => {
        mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
          repositories: [
            {
              name: "test-repo-1",
              repoUrl: "https://github.com/test/repo1.git",
              worktreeDir: "/test/worktrees1",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
            {
              name: "test-repo-2",
              repoUrl: "https://github.com/test/repo2.git",
              worktreeDir: "/test/worktrees2",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
          ],
        });

        const service = new InteractiveUIService(
          [mockSyncService, mockSyncService, mockSyncService, mockSyncService],
          "/test/config.js",
        );

        expect((service as any).repositoryCount).toBe(4);

        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
        await onReload();

        expect((service as any).repositoryCount).toBe(2);

        void service.destroy();
      });

      it("should update repository count after reload with more repos", async () => {
        mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
          repositories: [
            {
              name: "test-repo-1",
              repoUrl: "https://github.com/test/repo1.git",
              worktreeDir: "/test/worktrees1",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
            {
              name: "test-repo-2",
              repoUrl: "https://github.com/test/repo2.git",
              worktreeDir: "/test/worktrees2",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
            {
              name: "test-repo-3",
              repoUrl: "https://github.com/test/repo3.git",
              worktreeDir: "/test/worktrees3",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
          ],
        });

        const service = new InteractiveUIService([mockSyncService], "/test/config.js");

        expect((service as any).repositoryCount).toBe(1);

        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
        await onReload();

        expect((service as any).repositoryCount).toBe(3);

        void service.destroy();
      });

      it("should emit updateRepositoryCount event after reload", async () => {
        mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
          repositories: [
            {
              name: "test-repo-1",
              repoUrl: "https://github.com/test/repo1.git",
              worktreeDir: "/test/worktrees1",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
          ],
        });

        const service = new InteractiveUIService([mockSyncService, mockSyncService], "/test/config.js");

        const repoCountSpy = vi.fn();
        service.getEvents().on("updateRepositoryCount", repoCountSpy);

        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
        await onReload();

        expect(repoCountSpy).toHaveBeenCalledWith(1);
        expect(mockRender).toHaveBeenCalledTimes(1);

        void service.destroy();
      });
    });

    describe("service lifecycle on reload", () => {
      it("should wait for in-progress syncs before reload", async () => {
        let syncInProgress = true;
        mockSyncService.isSyncInProgress.mockImplementation(() => syncInProgress);

        mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
          repositories: [
            {
              name: "test-repo",
              repoUrl: "https://github.com/test/repo.git",
              worktreeDir: "/test/worktrees",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
          ],
        });

        const service = new InteractiveUIService([mockSyncService], "/test/config.js");
        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;

        const reloadPromise = onReload();

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(mockConfigLoaderInstance.loadConfigFile).not.toHaveBeenCalled();

        syncInProgress = false;
        await reloadPromise;

        expect(mockConfigLoaderInstance.loadConfigFile).toHaveBeenCalled();

        void service.destroy();
      });

      it("should timeout after 30 seconds if sync never completes", async () => {
        vi.useFakeTimers();

        mockSyncService.isSyncInProgress.mockReturnValue(true);

        mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
          repositories: [
            {
              name: "test-repo",
              repoUrl: "https://github.com/test/repo.git",
              worktreeDir: "/test/worktrees",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
          ],
        });

        const service = new InteractiveUIService([mockSyncService], "/test/config.js");
        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;

        const reloadPromise = onReload();

        await vi.advanceTimersByTimeAsync(31000);

        await reloadPromise;

        expect(mockConfigLoaderInstance.loadConfigFile).toHaveBeenCalled();

        void service.destroy();
        vi.useRealTimers();
      });

      it("should replace old services with new services from config", async () => {
        mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
          repositories: [
            {
              name: "new-repo",
              repoUrl: "https://github.com/new/repo.git",
              worktreeDir: "/new/worktrees",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
          ],
        });

        const service = new InteractiveUIService([mockSyncService], "/test/config.js");
        const oldServices = (service as any).syncServices;

        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
        await onReload();

        const newServices = (service as any).syncServices;
        expect(newServices).not.toBe(oldServices);
        expect(newServices.length).toBe(1);

        void service.destroy();
      });

      it("should initialize and sync all new services after reload", async () => {
        mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
          repositories: [
            {
              name: "test-repo-1",
              repoUrl: "https://github.com/test/repo1.git",
              worktreeDir: "/test/worktrees1",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
            {
              name: "test-repo-2",
              repoUrl: "https://github.com/test/repo2.git",
              worktreeDir: "/test/worktrees2",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
          ],
        });

        const service = new InteractiveUIService([mockSyncService], "/test/config.js");

        mockWorktreeSyncServiceInstance.initialize.mockClear();
        mockWorktreeSyncServiceInstance.sync.mockClear();

        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
        await onReload();

        expect(mockWorktreeSyncServiceInstance.initialize).toHaveBeenCalledTimes(4);
        expect(mockWorktreeSyncServiceInstance.sync).toHaveBeenCalledTimes(2);

        void service.destroy();
      });

      it("should handle multiple reload cycles", async () => {
        mockConfigLoaderInstance.loadConfigFile
          .mockResolvedValueOnce({
            repositories: [
              {
                name: "test-repo-1",
                repoUrl: "https://github.com/test/repo1.git",
                worktreeDir: "/test/worktrees1",
                cronSchedule: "0 * * * *",
                runOnce: false,
              },
            ],
          })
          .mockResolvedValueOnce({
            repositories: [
              {
                name: "test-repo-1",
                repoUrl: "https://github.com/test/repo1.git",
                worktreeDir: "/test/worktrees1",
                cronSchedule: "0 * * * *",
                runOnce: false,
              },
              {
                name: "test-repo-2",
                repoUrl: "https://github.com/test/repo2.git",
                worktreeDir: "/test/worktrees2",
                cronSchedule: "*/30 * * * *",
                runOnce: false,
              },
            ],
          })
          .mockResolvedValueOnce({
            repositories: [
              {
                name: "test-repo-2",
                repoUrl: "https://github.com/test/repo2.git",
                worktreeDir: "/test/worktrees2",
                cronSchedule: "0 * * * *",
                runOnce: false,
              },
            ],
          });

        const service = new InteractiveUIService([mockSyncService], "/test/config.js", "0 * * * *");
        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;

        await onReload();
        expect((service as any).repositoryCount).toBe(1);
        expect((service as any).scheduler.cronJobs.length).toBe(1);

        await onReload();
        expect((service as any).repositoryCount).toBe(2);
        // 2 repos with different schedules = 2 cron jobs
        expect((service as any).scheduler.cronJobs.length).toBe(2);

        await onReload();
        expect((service as any).repositoryCount).toBe(1);
        expect((service as any).scheduler.cronJobs.length).toBe(1);

        void service.destroy();
      });
    });

    describe("config resolution on reload", () => {
      it("should call resolveRepositoryConfig for each repository", async () => {
        mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
          defaults: { cronSchedule: "*/15 * * * *" },
          retry: { maxAttempts: 5 },
          repositories: [
            {
              name: "test-repo",
              repoUrl: "https://github.com/test/repo.git",
              worktreeDir: "/test/worktrees",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
          ],
        });

        const service = new InteractiveUIService([mockSyncService], "/test/config.js");
        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;

        await onReload();

        expect(mockConfigLoaderInstance.resolveRepositoryConfig).toHaveBeenCalledTimes(1);
        expect(mockConfigLoaderInstance.resolveRepositoryConfig).toHaveBeenCalledWith(
          expect.objectContaining({ name: "test-repo" }),
          expect.objectContaining({ cronSchedule: "*/15 * * * *" }),
          expect.any(String),
          expect.objectContaining({ maxAttempts: 5 }),
        );

        void service.destroy();
      });

      it("should re-inject loggers after reload", async () => {
        mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
          repositories: [
            {
              name: "test-repo",
              repoUrl: "https://github.com/test/repo.git",
              worktreeDir: "/test/worktrees",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
          ],
        });

        const service = new InteractiveUIService([mockSyncService], "/test/config.js");

        const constructed = vi.mocked(WorktreeSyncService);
        constructed.mockClear();

        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
        await onReload();

        // The reloaded services are built with the panel logger already in
        // their config, rather than constructed on the console default and
        // corrected afterwards -- initialize() logs before any correction
        // could run.
        expect(constructed).toHaveBeenCalledTimes(1);
        expect(constructed.mock.calls[0][0].logger).toBeDefined();

        void service.destroy();
      });

      it("should emit updateCronSchedule event after reload", async () => {
        mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
          repositories: [
            {
              name: "test-repo",
              repoUrl: "https://github.com/test/repo.git",
              worktreeDir: "/test/worktrees",
              cronSchedule: "*/30 * * * *",
              runOnce: false,
            },
          ],
        });

        const service = new InteractiveUIService([mockSyncService], "/test/config.js", "0 * * * *");

        const cronScheduleSpy = vi.fn();
        service.getEvents().on("updateCronSchedule", cronScheduleSpy);

        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
        await onReload();

        expect(cronScheduleSpy).toHaveBeenCalledWith(["*/30 * * * *"]);

        void service.destroy();
      });

      it("should not re-render UI on reload (uses events instead)", async () => {
        mockConfigLoaderInstance.loadConfigFile.mockResolvedValue({
          repositories: [
            {
              name: "test-repo",
              repoUrl: "https://github.com/test/repo.git",
              worktreeDir: "/test/worktrees",
              cronSchedule: "0 * * * *",
              runOnce: false,
            },
          ],
        });

        const service = new InteractiveUIService([mockSyncService], "/test/config.js");

        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
        await onReload();

        // render should only be called once (in constructor), not again on reload
        expect(mockRender).toHaveBeenCalledTimes(1);

        void service.destroy();
      });
    });
  });

  describe("handleQuit", () => {
    it("should call destroy and exit on quit", async () => {
      const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      new InteractiveUIService([mockSyncService]);
      const onQuit = (mockRender.mock.calls[0][0].props as any).onQuit;

      await onQuit();

      expect(mockExit).toHaveBeenCalledWith(0);

      mockExit.mockRestore();
    });

    it("should wait for in-progress syncs before quitting", async () => {
      const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      let syncInProgress = true;
      mockSyncService.isSyncInProgress.mockImplementation(() => syncInProgress);

      new InteractiveUIService([mockSyncService]);
      const onQuit = (mockRender.mock.calls[0][0].props as any).onQuit;

      setTimeout(() => {
        syncInProgress = false;
      }, 100);

      await onQuit();

      expect(mockExit).toHaveBeenCalledWith(0);

      mockExit.mockRestore();
    });
  });

  describe("last sync outcome", () => {
    const serviceNamed = (name: string, sync: () => Promise<unknown>) => ({
      ...mockSyncService,
      sync: vi.fn<any>().mockImplementation(sync),
      isInitialized: vi.fn<any>().mockReturnValue(true),
      getRecordedSkips: vi.fn<any>().mockReturnValue([]),
      clearRecordedSkips: vi.fn<any>(),
      config: { ...mockSyncService.config, name },
    });

    it("reports how many repositories failed, not just that a sync ran", async () => {
      const service = new InteractiveUIService([
        serviceNamed("ok", async () => ({ started: true })),
        serviceNamed("bad-1", async () => Promise.reject(new Error("fetch failed"))),
        serviceNamed("bad-2", async () => Promise.reject(new Error("fetch failed"))),
      ] as any);
      const outcomes: unknown[] = [];
      service.getEvents().on("setLastSyncOutcome", (outcome: unknown) => outcomes.push(outcome));

      await service.triggerInitialSync();

      expect(outcomes).toEqual([{ kind: "failed", count: 2 }]);
      void service.destroy();
    });

    it("reports OK when every repository synced", async () => {
      const service = new InteractiveUIService([serviceNamed("ok", async () => ({ started: true }))] as any);
      const outcomes: unknown[] = [];
      service.getEvents().on("setLastSyncOutcome", (outcome: unknown) => outcomes.push(outcome));

      await service.triggerInitialSync();

      expect(outcomes).toEqual([{ kind: "ok" }]);
      void service.destroy();
    });

    it("reports a cycle in which everything was skipped without moving the last sync time", async () => {
      const service = new InteractiveUIService([
        serviceNamed("busy", async () => ({ started: false, reason: "in_progress" })),
      ] as any);
      const outcomes: unknown[] = [];
      const stamped = vi.fn();
      service.getEvents().on("setLastSyncOutcome", (outcome: unknown) => outcomes.push(outcome));
      service.getEvents().on("updateLastSyncTime", stamped);

      await service.triggerInitialSync();

      expect(outcomes).toEqual([{ kind: "skipped", count: 1 }]);
      expect(stamped).not.toHaveBeenCalled();
      void service.destroy();
    });
  });

  describe("next sync across schedules", () => {
    it("hands the status bar every schedule when repositories use different ones", () => {
      const hourly = { ...mockSyncService, config: { ...mockSyncService.config, cronSchedule: "0 * * * *" } };
      const often = { ...mockSyncService, config: { ...mockSyncService.config, cronSchedule: "*/5 * * * *" } };
      const once = {
        ...mockSyncService,
        config: { ...mockSyncService.config, cronSchedule: "0 0 * * *", runOnce: true },
      };

      const service = new InteractiveUIService([hourly, often, once] as any, undefined, undefined);

      // runOnce repositories have no cron job, so they have no next run either.
      expect((mockRender.mock.calls[0][0].props as any).cronSchedule).toEqual(["0 * * * *", "*/5 * * * *"]);
      void service.destroy();
    });
  });

  // FU-T42-3: the interface stays live for the whole shutdown wait, and a
  // reload ends by arming cron jobs, so `r` pressed after `q` used to bring
  // back the jobs the shutdown had just released.
  describe("reload and sync during shutdown", () => {
    it("ignores a reload requested after quitting has started", async () => {
      let syncInProgress = true;
      mockSyncService.isSyncInProgress.mockImplementation(() => syncInProgress);
      const service = new InteractiveUIService([mockSyncService], "/test/config.js", "0 * * * *");

      const shutdown = service.destroy();
      const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
      await onReload();

      expect(mockConfigLoaderInstance.loadConfigFile).not.toHaveBeenCalled();
      expect((service as any).scheduler.cronJobs).toHaveLength(0);

      syncInProgress = false;
      await shutdown;
    });

    it("abandons a reload that was loading the config when quitting started", async () => {
      let releaseConfig!: () => void;
      mockConfigLoaderInstance.loadConfigFile.mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseConfig = () =>
              resolve({
                repositories: [
                  {
                    name: "test-repo",
                    repoUrl: "https://github.com/test/repo.git",
                    worktreeDir: "/test/worktrees",
                    cronSchedule: "0 * * * *",
                    runOnce: false,
                  },
                ],
              });
          }),
      );
      const service = new InteractiveUIService([mockSyncService], "/test/config.js", "0 * * * *");
      service.setupCronJobs();
      const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
      const reload = onReload();
      await vi.waitFor(() => expect(mockConfigLoaderInstance.loadConfigFile).toHaveBeenCalled());

      await service.destroy();
      releaseConfig();
      await reload;

      expect((service as any).scheduler.cronJobs).toHaveLength(0);
      expect((service as any).syncServices).toEqual([mockSyncService]);
      expect(mockSyncService.sync).not.toHaveBeenCalled();
    });

    it("does not start a manual sync once quitting has started", async () => {
      let syncInProgress = true;
      mockSyncService.isSyncInProgress.mockImplementation(() => syncInProgress);
      const service = new InteractiveUIService([mockSyncService]);
      const statuses: string[] = [];
      service.getEvents().on("setStatus", (status: string) => statuses.push(status));

      const shutdown = service.destroy();
      const onManualSync = (mockRender.mock.calls[0][0].props as any).onManualSync;
      await onManualSync();

      expect(mockSyncService.sync).not.toHaveBeenCalled();
      // The key handler put the bar on "syncing"; it has to come back.
      expect(statuses).toEqual(["idle"]);

      syncInProgress = false;
      await shutdown;
    });
  });

  describe("repository operations", () => {
    let mockGitService: any;

    beforeEach(() => {
      mockGitService = {
        getRemoteBranches: vi.fn().mockResolvedValue(["main", "develop", "feature/test"]),
        getDefaultBranch: vi.fn().mockReturnValue("main"),
        branchExists: vi.fn().mockResolvedValue({ local: false, remote: false }),
        createBranch: vi.fn().mockResolvedValue(undefined),
        pushBranch: vi.fn().mockResolvedValue(undefined),
        // Derived from the name, never a constant: the rollback's
        // compare-and-swap has to be on the commit THIS attempt created, and a
        // stand-in that answers the same oid for every branch would let a
        // rollback that reuses a stale oid pass.
        getLocalBranchCommit: vi.fn(async (name: string) => `oid-${name}`),
        deleteLocalBranchIfAt: vi.fn().mockResolvedValue(undefined),
        getBareRepoPath: vi.fn().mockReturnValue("/test/.bare/app"),
        getWorktrees: vi.fn().mockResolvedValue([
          { path: "/test/worktrees/main", branch: "main" },
          { path: "/test/worktrees/develop", branch: "develop" },
        ]),
        getFullWorktreeStatus: vi.fn().mockResolvedValue({
          isClean: true,
          hasUnpushedCommits: false,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: true,
          reasons: [],
        }),
        addWorktree: vi.fn().mockResolvedValue(undefined),
        resolveNewWorktreePath: vi.fn().mockResolvedValue("/test/worktrees/feature-new"),
        fetchAll: vi.fn().mockResolvedValue(undefined),
      };

      mockSyncService.getGitService = vi.fn().mockReturnValue(mockGitService);
      mockSyncService.getRemoteBranches = vi.fn().mockResolvedValue(["main", "develop", "feature/test"]);
    });

    describe("getRepositoryList", () => {
      it("should return list of repositories with indices", () => {
        const mockService1 = {
          ...mockSyncService,
          config: { ...mockSyncService.config, name: "repo-1", repoUrl: "https://github.com/test/repo1.git" },
        };
        const mockService2 = {
          ...mockSyncService,
          config: { ...mockSyncService.config, name: "repo-2", repoUrl: "https://github.com/test/repo2.git" },
        };

        const service = new InteractiveUIService([mockService1 as any, mockService2 as any]);
        const repos = service.operations.getRepositoryList();

        expect(repos).toHaveLength(2);
        expect(repos[0]).toEqual({ index: 0, name: "repo-1", repoUrl: "https://github.com/test/repo1.git" });
        expect(repos[1]).toEqual({ index: 1, name: "repo-2", repoUrl: "https://github.com/test/repo2.git" });

        void service.destroy();
      });

      it("should use fallback name when name is not set", () => {
        const mockServiceNoName = {
          ...mockSyncService,
          config: { repoUrl: "https://github.com/test/repo.git", worktreeDir: "/test" },
        };

        const service = new InteractiveUIService([mockServiceNoName as any]);
        const repos = service.operations.getRepositoryList();

        expect(repos[0].name).toBe("repo-0");

        void service.destroy();
      });
    });

    describe("getRepositoryDiskUsage", () => {
      it("should calculate disk usage for a worktree-mode repository", async () => {
        const service = new InteractiveUIService([mockSyncService]);

        const usage = await service.operations.getRepositoryDiskUsage(0);

        expect(calculateDirectorySize).toHaveBeenCalledWith(".bare/repo");
        expect(calculateDirectorySize).toHaveBeenCalledWith("/test/worktrees");
        expect(formatBytes).toHaveBeenCalledWith(2048);
        expect(usage).toEqual({
          repoIndex: 0,
          repoName: "repo-0",
          sizeBytes: 2048,
          sizeFormatted: "1.0 KB",
          bareSizeBytes: 1024,
          worktreeSizeBytes: 1024,
          error: undefined,
        });

        void service.destroy();
      });

      it("should calculate only checkout size for clone-mode repositories", async () => {
        const cloneService = {
          ...mockSyncService,
          config: { ...mockSyncService.config, mode: "clone", worktreeDir: "/test/clone" },
        };
        const service = new InteractiveUIService([cloneService as any]);

        const usage = await service.operations.getRepositoryDiskUsage(0);

        expect(calculateDirectorySize).toHaveBeenCalledTimes(1);
        expect(calculateDirectorySize).toHaveBeenCalledWith("/test/clone");
        expect(usage.bareSizeBytes).toBe(0);
        expect(usage.worktreeSizeBytes).toBe(1024);

        void service.destroy();
      });

      it("should return N/A when all repository size paths fail", async () => {
        vi.mocked(calculateDirectorySize)
          .mockRejectedValueOnce(new Error("ENOENT"))
          .mockRejectedValueOnce(new Error("ENOENT"));
        const service = new InteractiveUIService([mockSyncService]);

        const usage = await service.operations.getRepositoryDiskUsage(0);

        expect(usage.sizeBytes).toBeNull();
        expect(usage.sizeFormatted).toBe("N/A");
        expect(usage.error).toContain("ENOENT");

        void service.destroy();
      });

      it("should mark the size as a lower bound when only some paths fail", async () => {
        // Bare succeeds, worktree path fails: the failed path counts as 0, so
        // the total is a guaranteed undercount and must read as "at least" (≥).
        vi.mocked(calculateDirectorySize).mockResolvedValueOnce(1024).mockRejectedValueOnce(new Error("ENOENT"));
        const service = new InteractiveUIService([mockSyncService]);

        const usage = await service.operations.getRepositoryDiskUsage(0);

        expect(usage.sizeFormatted).toMatch(/^≥/);
        expect(usage.sizeBytes).toBe(1024);
        expect(usage.error).toContain("ENOENT");

        void service.destroy();
      });

      it("should throw for invalid repo index", async () => {
        const service = new InteractiveUIService([mockSyncService]);

        await expect(service.operations.getRepositoryDiskUsage(-1)).rejects.toThrow("Invalid repository index: -1");

        void service.destroy();
      });
    });

    describe("getBranchesForRepo", () => {
      it("should return branches for valid repo index", async () => {
        mockSyncService.isInitialized.mockReturnValue(true);
        const service = new InteractiveUIService([mockSyncService]);
        const branches = await service.operations.getBranchesForRepo(0);

        expect(branches).toEqual(["main", "develop", "feature/test"]);
        expect(mockSyncService.getRemoteBranches).toHaveBeenCalled();

        void service.destroy();
      });

      it("should return empty array if service not initialized", async () => {
        mockSyncService.isInitialized.mockReturnValue(false);
        const service = new InteractiveUIService([mockSyncService]);
        const branches = await service.operations.getBranchesForRepo(0);

        expect(branches).toEqual([]);
        expect(mockSyncService.getRemoteBranches).not.toHaveBeenCalled();

        void service.destroy();
      });

      it("should discover remote branches for uninitialized clone-mode repos", async () => {
        mockSyncService.isInitialized.mockReturnValue(false);
        mockSyncService.isCloneMode.mockReturnValue(true);
        mockSyncService.getRemoteBranches.mockResolvedValue(["main", "feature/fresh-clone"]);
        const service = new InteractiveUIService([mockSyncService]);

        const branches = await service.operations.getBranchesForRepo(0);

        expect(branches).toEqual(["main", "feature/fresh-clone"]);
        expect(mockSyncService.getRemoteBranches).toHaveBeenCalledTimes(1);

        void service.destroy();
      });

      it("should return empty array if uninitialized clone-mode branch discovery fails", async () => {
        mockSyncService.isInitialized.mockReturnValue(false);
        mockSyncService.isCloneMode.mockReturnValue(true);
        mockSyncService.getRemoteBranches.mockRejectedValue(new Error("ls-remote failed"));
        const service = new InteractiveUIService([mockSyncService]);

        const branches = await service.operations.getBranchesForRepo(0);

        expect(branches).toEqual([]);
        expect(mockSyncService.getRemoteBranches).toHaveBeenCalledTimes(1);

        void service.destroy();
      });

      it("should throw error for invalid repo index", async () => {
        const service = new InteractiveUIService([mockSyncService]);

        await expect(service.operations.getBranchesForRepo(-1)).rejects.toThrow("Invalid repository index: -1");
        await expect(service.operations.getBranchesForRepo(5)).rejects.toThrow("Invalid repository index: 5");

        void service.destroy();
      });
    });

    describe("getDefaultBranchForRepo", () => {
      it("should return default branch for valid repo index", async () => {
        const service = new InteractiveUIService([mockSyncService]);
        const branch = await service.operations.getDefaultBranchForRepo(0);

        expect(branch).toBe("main");
        expect(mockSyncService.getDefaultBranch).toHaveBeenCalled();

        void service.destroy();
      });

      it("should return the tracked branch for a clone-mode repo, not GitService's constant", async () => {
        // GitService.initialize() never runs in clone mode, so its default
        // branch is the 'main' the constructor set. Reading it here made the
        // wizard pre-select and label a branch the clone does not track.
        mockSyncService.isCloneMode.mockReturnValue(true);
        mockSyncService.getDefaultBranch.mockResolvedValue("develop");
        const service = new InteractiveUIService([mockSyncService]);

        const branch = await service.operations.getDefaultBranchForRepo(0);

        expect(branch).toBe("develop");
        expect(mockGitService.getDefaultBranch).not.toHaveBeenCalled();

        void service.destroy();
      });

      it("should throw error for invalid repo index", async () => {
        const service = new InteractiveUIService([mockSyncService]);

        await expect(service.operations.getDefaultBranchForRepo(-1)).rejects.toThrow("Invalid repository index: -1");
        await expect(service.operations.getDefaultBranchForRepo(5)).rejects.toThrow("Invalid repository index: 5");

        void service.destroy();
      });
    });

    describe("createAndPushBranch", () => {
      it("should create and push a new branch", async () => {
        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.createAndPushBranch(0, "main", "feature/new");

        expect(result.success).toBe(true);
        expect(result.finalName).toBe("feature/new");
        expect(mockGitService.createBranch).toHaveBeenCalledWith("feature/new", "main");
        expect(mockGitService.pushBranch).toHaveBeenCalledWith("feature/new");

        void service.destroy();
      });

      it("should append suffix if branch already exists", async () => {
        mockGitService.createBranch
          .mockRejectedValueOnce(new Error("already exists"))
          .mockRejectedValueOnce(new Error("already exists"))
          .mockResolvedValueOnce(undefined);

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.createAndPushBranch(0, "main", "feature/test");

        expect(result.success).toBe(true);
        expect(result.finalName).toBe("feature/test-2");
        expect(mockGitService.createBranch).toHaveBeenCalledTimes(3);

        void service.destroy();
      });

      // The wizard submits the name it displayed, so a typed `x` whose name was
      // taken arrives here ALREADY suffixed. Appending to what it was handed
      // would offer `x-1-1` and then `x-1-2`; the sequence the user was shown,
      // and the only one that reads as a suffix walk, is `x-1`, `x-2`, `x-3`.
      it("continues the suffix it was handed instead of restarting the walk under it", async () => {
        mockGitService.createBranch
          .mockRejectedValueOnce(new Error("already exists"))
          .mockRejectedValueOnce(new Error("already exists"))
          .mockResolvedValueOnce(undefined);

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.createAndPushBranch(0, "main", "x-1");

        expect(result).toEqual({ success: true, finalName: "x-3" });
        expect(mockGitService.createBranch).toHaveBeenNthCalledWith(1, "x-1", "main");
        expect(mockGitService.createBranch).toHaveBeenNthCalledWith(2, "x-2", "main");
        expect(mockGitService.createBranch).toHaveBeenNthCalledWith(3, "x-3", "main");
        expect(mockGitService.createBranch.mock.calls.map((call: string[]) => call[0])).not.toContain("x-1-1");

        void service.destroy();
      });

      // One collision after the wizard's own: the whole visible sequence is
      // `x-1` then `x-2`, which is what the picker would have offered next.
      it("takes a name the wizard already suffixed once to the next suffix, not a nested one", async () => {
        mockGitService.pushBranch.mockRejectedValueOnce(new Error("stale info: refs/heads/x-1"));

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.createAndPushBranch(0, "main", "x-1");

        expect(result).toEqual({ success: true, finalName: "x-2" });
        expect(mockGitService.pushBranch).toHaveBeenNthCalledWith(1, "x-1");
        expect(mockGitService.pushBranch).toHaveBeenNthCalledWith(2, "x-2");
        expect(mockGitService.pushBranch).toHaveBeenCalledTimes(2);

        void service.destroy();
      });

      // A trailing `-<n>` is a suffix to continue; nothing else is. A name that
      // merely ends in a hyphen or a non-number keeps the walk at `-1`.
      it("starts the walk at -1 for a name that does not end in a number", async () => {
        mockGitService.createBranch.mockRejectedValueOnce(new Error("already exists")).mockResolvedValueOnce(undefined);

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.createAndPushBranch(0, "main", "release-rc");

        expect(result).toEqual({ success: true, finalName: "release-rc-1" });

        void service.destroy();
      });

      // The name the result carries is the branch that was actually tried. A
      // failure reported under the caller's name points at a branch this call
      // never touched — here `x` was never pushed, `x-1` was.
      it("names the branch it actually attempted when the failure is not a collision", async () => {
        mockGitService.createBranch.mockRejectedValueOnce(new Error("already exists"));
        mockGitService.pushBranch.mockRejectedValueOnce(new Error("connection reset"));

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.createAndPushBranch(0, "main", "x");

        expect(result.success).toBe(false);
        expect(result.finalName).toBe("x-1");
        expect(result.error).toContain("could not push 'x-1'");

        void service.destroy();
      });

      it("names the last branch it attempted when every attempt collides", async () => {
        mockGitService.createBranch.mockRejectedValue(new Error("already exists"));

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.createAndPushBranch(0, "main", "x");

        expect(result.success).toBe(false);
        expect(result.finalName).toBe("x-9");
        expect(result.error).toContain("after 10 attempts");
        expect(mockGitService.createBranch).toHaveBeenCalledTimes(10);

        void service.destroy();
      });

      // A push that never landed must not leave the local branch behind: the
      // wizard offers the same name again, and the next attempt would collide
      // with this attempt's own leftover and quietly produce '<name>-1' while
      // '<name>' is still nowhere on the remote.
      it("deletes the branch it just created when the push fails, and names the push failure", async () => {
        mockGitService.pushBranch.mockRejectedValueOnce(new Error("remote rejected: pre-receive hook declined"));

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.createAndPushBranch(0, "main", "feature/new");

        expect(result.success).toBe(false);
        expect(result.error).toContain("could not push 'feature/new'");
        expect(result.error).toContain("pre-receive hook declined");
        // Compare-and-swap on the commit THIS attempt created the branch at.
        expect(mockGitService.deleteLocalBranchIfAt).toHaveBeenCalledWith("feature/new", "oid-feature/new");

        void service.destroy();
      });

      // The create-only lease reports a name that turned out to be on origin
      // as "stale info". Phrased as the collision it is, so the loop suffixes
      // and retries instead of handing the user git's wording.
      it("retries under a suffix when the lease refuses a name that is already on origin", async () => {
        mockGitService.pushBranch
          .mockRejectedValueOnce(new Error("stale info: refs/heads/feature/x"))
          .mockRejectedValueOnce(new Error("stale info: refs/heads/feature/x-1"));

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.createAndPushBranch(0, "main", "feature/x");

        expect(result).toEqual({ success: true, finalName: "feature/x-2" });
        expect(mockGitService.pushBranch).toHaveBeenNthCalledWith(1, "feature/x");
        expect(mockGitService.pushBranch).toHaveBeenNthCalledWith(2, "feature/x-1");
        expect(mockGitService.pushBranch).toHaveBeenNthCalledWith(3, "feature/x-2");
        // Every rollback swaps on ITS OWN attempt's commit. Re-reading the
        // first attempt's oid would pass against a stand-in that answers the
        // same value for every name, and would leave the second attempt's
        // branch behind against a real repository.
        expect(mockGitService.deleteLocalBranchIfAt).toHaveBeenNthCalledWith(1, "feature/x", "oid-feature/x");
        expect(mockGitService.deleteLocalBranchIfAt).toHaveBeenNthCalledWith(2, "feature/x-1", "oid-feature/x-1");

        void service.destroy();
      });

      // The branch is left in place when it cannot be removed, so the message
      // has to say so rather than let the user believe it was cleaned up.
      it("reports the leftover branch when the rollback itself fails", async () => {
        mockGitService.pushBranch.mockRejectedValueOnce(new Error("connection reset"));
        mockGitService.deleteLocalBranchIfAt.mockRejectedValueOnce(new Error("ref moved"));

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.createAndPushBranch(0, "main", "feature/new");

        expect(result.success).toBe(false);
        expect(result.error).toContain("is still in the bare repository");
        // The branch is in `.bare/<repo>`, which the user never cd's into, so
        // the command has to name the repository it is to be run against.
        expect(result.error).toContain('git -C "/test/.bare/app" branch -D feature/new');

        void service.destroy();
      });

      // git's stderr for an https remote embeds the credential in the URL it
      // failed on, and this message is shown in the wizard's result pane.
      it("redacts the credential out of the push failure and appends the auth hint", async () => {
        mockGitService.pushBranch.mockRejectedValueOnce(
          new Error(
            "fatal: unable to access 'https://x-access-token:ghp_sUp3rSecret@github.com/acme/app.git/': " +
              "Authentication failed for 'https://x-access-token:ghp_sUp3rSecret@github.com/acme/app.git/'",
          ),
        );

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.createAndPushBranch(0, "main", "feature/new");

        expect(result.success).toBe(false);
        expect(result.error).not.toContain("ghp_sUp3rSecret");
        expect(result.error).not.toContain("x-access-token");
        expect(result.error).toContain("https://***@github.com/acme/app.git/");
        expect(result.error).toContain("Hint: ");

        void service.destroy();
      });

      // The retry exists to get past a name that is taken. It must not run
      // once this attempt has left a branch behind: suffixing past the leftover
      // recreates the exact defect this flow is about — '<name>' orphaned
      // locally and never pushed while '<name>-1' is created instead — and it
      // would discard the only message that names the leftover.
      it("stops instead of suffixing past a branch the rollback could not remove", async () => {
        mockGitService.pushBranch.mockRejectedValueOnce(new Error("stale info: refs/heads/feature/x"));
        mockGitService.deleteLocalBranchIfAt.mockRejectedValueOnce(new Error("ref moved"));

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.createAndPushBranch(0, "main", "feature/x");

        expect(result.success).toBe(false);
        expect(result.finalName).toBe("feature/x");
        // The collision wording is still there — and so is the notice that the
        // retry would otherwise have thrown away with it.
        expect(result.error).toContain("already exists on origin");
        expect(result.error).toContain("The local branch 'feature/x' is still in the bare repository");
        expect(result.error).toContain('git -C "/test/.bare/app" branch -D feature/x');
        expect(mockGitService.pushBranch).toHaveBeenCalledTimes(1);
        expect(mockGitService.createBranch).toHaveBeenCalledTimes(1);

        void service.destroy();
      });

      it("should return error for invalid repo index", async () => {
        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.createAndPushBranch(-1, "main", "feature/new");

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid repository index");

        void service.destroy();
      });

      it("should handle git errors gracefully", async () => {
        mockGitService.createBranch.mockRejectedValue(new Error("Git error"));

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.createAndPushBranch(0, "main", "feature/new");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Git error");

        void service.destroy();
      });

      it("should serialize branch creation through the queued repo lock", async () => {
        const service = new InteractiveUIService([mockSyncService]);
        await service.operations.createAndPushBranch(0, "main", "feature/new");

        // Branch+push must run behind any in-flight sync to avoid racing git's refs.
        expect(mockSyncService.runQueuedRepoOperation).toHaveBeenCalledTimes(1);

        void service.destroy();
      });

      it("should return a failure (not throw) when another process holds the repo lock", async () => {
        (mockSyncService.runQueuedRepoOperation as any).mockResolvedValueOnce({ started: false, reason: "locked" });

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.createAndPushBranch(0, "main", "feature/new");

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/repository lock/i);
        expect(mockGitService.createBranch).not.toHaveBeenCalled();

        void service.destroy();
      });

      // Clone-mode repositories have no bare repository, and GitService's
      // createBranch/pushBranch both run in one — through `bareRepoPath`,
      // which falls back to the RELATIVE '.bare/<repo name>' when bareRepoDir
      // is undefined, as it deliberately is in clone mode. That path is either
      // missing (simple-git's constructor: "Cannot use simple-git on a
      // directory that does not exist") or, under a working directory holding
      // a bare store of the same repository name, somebody else's refs.
      it("creates the branch inside the clone for clone-mode repositories", async () => {
        const cloneService = {
          ...mockSyncService,
          isCloneMode: vi.fn().mockReturnValue(true),
          createAndPushBranch: vi.fn().mockResolvedValue(undefined),
        };
        const service = new InteractiveUIService([cloneService as any]);

        const result = await service.operations.createAndPushBranch(0, "main", "feature/x");

        expect(result).toEqual({ success: true, finalName: "feature/x" });
        expect(cloneService.createAndPushBranch).toHaveBeenCalledWith("main", "feature/x");
        expect(mockGitService.createBranch).not.toHaveBeenCalled();
        expect(mockGitService.pushBranch).not.toHaveBeenCalled();

        // ...and the wizard's follow-up switches the clone in place rather
        // than adding a worktree — the branch it just pushed is now real.
        await service.operations.createWorktreeForBranch(0, "feature/x");
        expect(cloneService.checkoutBranch).toHaveBeenCalledWith("feature/x", { allowConfigDrift: true });
        expect(mockGitService.addWorktree).not.toHaveBeenCalled();

        void service.destroy();
      });

      it("suffixes the name when the clone-mode path reports a collision", async () => {
        const cloneService = {
          ...mockSyncService,
          isCloneMode: vi.fn().mockReturnValue(true),
          createAndPushBranch: vi
            .fn()
            .mockRejectedValueOnce(new Error("branch 'feature/x' already exists on the remote of 'app'"))
            .mockResolvedValueOnce(undefined),
        };
        const service = new InteractiveUIService([cloneService as any]);

        const result = await service.operations.createAndPushBranch(0, "main", "feature/x");

        expect(result).toEqual({ success: true, finalName: "feature/x-1" });
        expect(cloneService.createAndPushBranch).toHaveBeenNthCalledWith(2, "main", "feature/x-1");

        void service.destroy();
      });

      it("surfaces the clone-mode failure message unchanged", async () => {
        const cloneService = {
          ...mockSyncService,
          isCloneMode: vi.fn().mockReturnValue(true),
          createAndPushBranch: vi
            .fn()
            .mockRejectedValue(new Error("Cannot create 'feature/x' in 'app': '/srv/app' is not a git clone.")),
        };
        const service = new InteractiveUIService([cloneService as any]);

        const result = await service.operations.createAndPushBranch(0, "main", "feature/x");

        expect(result.success).toBe(false);
        expect(result.error).toContain("'app'");
        expect(result.error).not.toContain("simple-git");

        void service.destroy();
      });

      it("names the cause instead of blaming another process when the repo lock is unavailable", async () => {
        (mockSyncService.runQueuedRepoOperation as any).mockResolvedValueOnce({
          started: false,
          reason: "lock_unavailable",
          path: "/state/sync-worktrees/locks",
          code: "EACCES",
          error: "EACCES: permission denied, mkdir '/state/sync-worktrees/locks'",
        });

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.createAndPushBranch(0, "main", "feature/new");

        expect(result.success).toBe(false);
        expect(result.error).toContain("/state/sync-worktrees/locks");
        expect(result.error).toContain("EACCES");
        expect(result.error).not.toMatch(/another process|try again/i);
        expect(mockGitService.createBranch).not.toHaveBeenCalled();

        void service.destroy();
      });
    });

    describe("getWorktreesForRepo", () => {
      it("should return worktrees for valid repo index", async () => {
        const service = new InteractiveUIService([mockSyncService]);
        const worktrees = await service.operations.getWorktreesForRepo(0);

        expect(worktrees).toHaveLength(2);
        expect(worktrees[0]).toEqual({ path: "/test/worktrees/main", branch: "main" });

        void service.destroy();
      });

      it("should throw error for invalid repo index", async () => {
        const service = new InteractiveUIService([mockSyncService]);

        await expect(service.operations.getWorktreesForRepo(-1)).rejects.toThrow("Invalid repository index: -1");

        void service.destroy();
      });

      it("should use the service worktree provider for clone-mode repositories", async () => {
        const cloneService = {
          ...mockSyncService,
          config: { ...mockSyncService.config, mode: "clone", worktreeDir: "/test/clone" },
          getGitService: vi.fn().mockReturnValue(mockGitService),
          getWorktrees: vi.fn().mockResolvedValue([{ path: "/test/clone", branch: "main" }]),
        };
        const service = new InteractiveUIService([cloneService as any]);

        const worktrees = await service.operations.getWorktreesForRepo(0);

        expect(worktrees).toEqual([{ path: "/test/clone", branch: "main" }]);
        expect(cloneService.getWorktrees).toHaveBeenCalled();
        expect(mockGitService.getWorktrees).not.toHaveBeenCalled();

        void service.destroy();
      });
    });

    describe("getWorktreeStatusForRepo", () => {
      it("should load status for clone-mode checkout path", async () => {
        const cloneService = {
          ...mockSyncService,
          config: { ...mockSyncService.config, mode: "clone", worktreeDir: "/test/clone" },
          getGitService: vi.fn().mockReturnValue(mockGitService),
          getWorktrees: vi.fn().mockResolvedValue([{ path: "/test/clone", branch: "main" }]),
        };
        const service = new InteractiveUIService([cloneService as any]);

        const statuses = await service.operations.getWorktreeStatusForRepo(0);

        expect(statuses).toHaveLength(1);
        expect(statuses[0].path).toBe("/test/clone");
        expect(statuses[0].branch).toBe("main");
        expect(mockGitService.getFullWorktreeStatus).toHaveBeenCalledWith(
          "/test/clone",
          true,
          expect.any(RefScanScope),
        );
        expect(mockGitService.getWorktrees).not.toHaveBeenCalled();

        void service.destroy();
      });
    });

    describe("createWorktreeForBranch", () => {
      it("should create worktree for branch", async () => {
        const service = new InteractiveUIService([mockSyncService]);
        await service.operations.createWorktreeForBranch(0, "feature/new");

        // The directory is named inside the queued operation, by GitService.
        expect(mockGitService.resolveNewWorktreePath).toHaveBeenCalledWith("feature/new");
        expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature/new", "/test/worktrees/feature-new");

        void service.destroy();
      });

      it("should checkout the branch for clone-mode repositories", async () => {
        const cloneService = {
          ...mockSyncService,
          isCloneMode: vi.fn().mockReturnValue(true),
          checkoutBranch: vi.fn().mockResolvedValue(undefined),
        };
        const service = new InteractiveUIService([cloneService as any]);

        await service.operations.createWorktreeForBranch(0, "feature/new");

        // allowConfigDrift: the wizard just created+pushed this branch, so the
        // switch is intentional drift from config.branch (warned downstream).
        expect(cloneService.checkoutBranch).toHaveBeenCalledWith("feature/new", { allowConfigDrift: true });
        expect(mockGitService.addWorktree).not.toHaveBeenCalled();

        void service.destroy();
      });

      it("should throw error for invalid repo index", async () => {
        const service = new InteractiveUIService([mockSyncService]);

        await expect(service.operations.createWorktreeForBranch(-1, "feature/new")).rejects.toThrow(
          "Invalid repository index: -1",
        );

        void service.destroy();
      });

      it("should serialize worktree creation through the queued repo lock", async () => {
        const service = new InteractiveUIService([mockSyncService]);
        await service.operations.createWorktreeForBranch(0, "feature/new");

        expect(mockSyncService.runQueuedRepoOperation).toHaveBeenCalledTimes(1);

        void service.destroy();
      });

      it("should throw when another process holds the repo lock", async () => {
        (mockSyncService.runQueuedRepoOperation as any).mockResolvedValueOnce({ started: false, reason: "locked" });

        const service = new InteractiveUIService([mockSyncService]);
        await expect(service.operations.createWorktreeForBranch(0, "feature/new")).rejects.toThrow(/repository lock/i);
        expect(mockGitService.addWorktree).not.toHaveBeenCalled();

        void service.destroy();
      });
    });

    describe("fetchForRepo", () => {
      it("should fetch through the queued repo lock using the unlocked init path", async () => {
        mockSyncService.isInitialized = vi.fn().mockReturnValue(false);
        const service = new InteractiveUIService([mockSyncService]);

        await service.operations.fetchForRepo(0);

        expect(mockSyncService.runQueuedRepoOperation).toHaveBeenCalledTimes(1);
        expect(mockGitService.fetchAll).toHaveBeenCalledTimes(1);
        // Must use initializeUnlocked inside the queued op; initialize() would
        // re-enter the repo mutex and self-deadlock.
        expect(mockSyncService.initializeUnlocked).toHaveBeenCalledTimes(1);
        expect(mockSyncService.initialize).not.toHaveBeenCalled();

        void service.destroy();
      });

      it("should not re-initialize when already initialized", async () => {
        mockSyncService.isInitialized = vi.fn().mockReturnValue(true);
        const service = new InteractiveUIService([mockSyncService]);

        await service.operations.fetchForRepo(0);

        expect(mockSyncService.initializeUnlocked).not.toHaveBeenCalled();
        expect(mockGitService.fetchAll).toHaveBeenCalledTimes(1);

        void service.destroy();
      });

      it("should throw when another process holds the repo lock", async () => {
        (mockSyncService.runQueuedRepoOperation as any).mockResolvedValueOnce({ started: false, reason: "locked" });

        const service = new InteractiveUIService([mockSyncService]);
        await expect(service.operations.fetchForRepo(0)).rejects.toThrow(/repository lock/i);

        void service.destroy();
      });

      it("is a no-op for clone-mode repos (branch discovery is live at picker open)", async () => {
        mockSyncService.isInitialized = vi.fn().mockReturnValue(true);
        mockSyncService.isCloneMode = vi.fn().mockReturnValue(true);
        const service = new InteractiveUIService([mockSyncService]);

        await service.operations.fetchForRepo(0);

        expect(mockGitService.fetchAll).not.toHaveBeenCalled();
        expect(mockSyncService.getRemoteBranches).not.toHaveBeenCalled();

        void service.destroy();
      });
    });

    describe("openEditorInWorktree", () => {
      const originalEditor = process.env.EDITOR;
      const originalVisual = process.env.VISUAL;

      afterEach(() => {
        if (originalEditor === undefined) {
          delete process.env.EDITOR;
        } else {
          process.env.EDITOR = originalEditor;
        }
        if (originalVisual === undefined) {
          delete process.env.VISUAL;
        } else {
          process.env.VISUAL = originalVisual;
        }
      });

      it("should return success when opening editor", () => {
        const service = new InteractiveUIService([mockSyncService]);
        const result = service.launcher.openEditorInWorktree("/test/worktrees/main");

        expect(result.success).toBe(true);

        void service.destroy();
      });

      it("should split EDITOR values that include flags so spawn gets a real binary name", () => {
        process.env.EDITOR = "code -w";
        mockSpawn.mockClear();

        const service = new InteractiveUIService([mockSyncService]);
        const result = service.launcher.openEditorInWorktree("/test/worktrees/main");

        expect(result.success).toBe(true);
        expect(mockSpawn).toHaveBeenCalledWith(
          "code",
          ["-w", "/test/worktrees/main"],
          expect.objectContaining({ detached: true }),
        );

        void service.destroy();
      });

      it.each([["vim"], ["vi"], ["nvim"], ["nano"], ["pico"], ["micro"], ["helix"], ["hx"], ["kak"]])(
        "refuses %s, which has no TTY when spawned detached",
        (editor) => {
          process.env.EDITOR = editor;
          delete process.env.VISUAL;
          mockSpawn.mockClear();

          const service = new InteractiveUIService([mockSyncService]);
          const result = service.launcher.openEditorInWorktree("/test/worktrees/main");

          expect(result.success).toBe(false);
          expect(result.error).toContain(`'${editor}' is a terminal editor`);
          expect(result.error).toContain("Terminal mode");
          expect(mockSpawn).not.toHaveBeenCalled();

          void service.destroy();
        },
      );

      it("refuses a terminal editor given by absolute path", () => {
        process.env.EDITOR = "/usr/local/bin/nvim";
        delete process.env.VISUAL;
        mockSpawn.mockClear();

        const service = new InteractiveUIService([mockSyncService]);
        const result = service.launcher.openEditorInWorktree("/test/worktrees/main");

        expect(result.success).toBe(false);
        expect(mockSpawn).not.toHaveBeenCalled();

        void service.destroy();
      });

      it("refuses the terminal editor named by VISUAL when EDITOR is unset", () => {
        delete process.env.EDITOR;
        process.env.VISUAL = "vim";
        mockSpawn.mockClear();

        const service = new InteractiveUIService([mockSyncService]);
        const result = service.launcher.openEditorInWorktree("/test/worktrees/main");

        expect(result.success).toBe(false);
        expect(mockSpawn).not.toHaveBeenCalled();

        void service.destroy();
      });

      it("lets the flag decide for emacs, which is a GUI editor until -nw says otherwise", () => {
        delete process.env.VISUAL;
        const service = new InteractiveUIService([mockSyncService]);

        process.env.EDITOR = "emacs";
        mockSpawn.mockClear();
        expect(service.launcher.openEditorInWorktree("/wt").success).toBe(true);
        expect(mockSpawn).toHaveBeenCalledWith("emacs", ["/wt"], expect.objectContaining({ detached: true }));

        for (const flag of ["-nw", "--no-window-system", "-t", "--tty"]) {
          process.env.EDITOR = `emacs ${flag}`;
          mockSpawn.mockClear();
          const result = service.launcher.openEditorInWorktree("/wt");
          expect(result.success, `emacs ${flag} should be refused`).toBe(false);
          expect(mockSpawn).not.toHaveBeenCalled();
        }

        void service.destroy();
      });

      it.each([["vim"], ["vi"]])("lets -g override the basename for %s, whose parser defines it", (editor) => {
        process.env.EDITOR = `${editor} -g`;
        delete process.env.VISUAL;
        mockSpawn.mockClear();

        const service = new InteractiveUIService([mockSyncService]);
        const result = service.launcher.openEditorInWorktree("/wt");

        expect(result.success).toBe(true);
        expect(mockSpawn).toHaveBeenCalledWith(editor, ["-g", "/wt"], expect.objectContaining({ detached: true }));

        void service.destroy();
      });

      // -g is vim's GUI flag and nobody else's: nano and pico read it as --showcursor (verified
      // against `nano --help` on this box), helix as --grammar, emacs as --geometry, and nvim
      // has no -g at all. Treating it as GUI-forcing everywhere spawned into the void exactly
      // the TTY-less editors this refusal exists for.
      it.each([
        ["nano", "-g"],
        ["pico", "-g"],
        ["helix", "-g"],
        ["hx", "-g"],
        ["kak", "-g"],
        ["nvim", "-g"],
        ["vim", "--gui"],
      ])("still refuses '%s %s', where the flag is not this editor's GUI flag", (editor, flag) => {
        process.env.EDITOR = `${editor} ${flag}`;
        delete process.env.VISUAL;
        mockSpawn.mockClear();

        const service = new InteractiveUIService([mockSyncService]);
        const result = service.launcher.openEditorInWorktree("/wt");

        expect(result.success, `${editor} ${flag} should still be refused`).toBe(false);
        expect(mockSpawn).not.toHaveBeenCalled();

        void service.destroy();
      });

      // An explicit terminal flag is the user saying what they want, and a flag that means
      // something else to this editor does not get to overrule it.
      it.each([["emacs -nw -g"], ["emacs -g -nw"], ["emacs --gui -t"], ["emacsclient -nw -g"]])(
        "refuses '%s', because the terminal flag wins over the GUI one",
        (value) => {
          process.env.EDITOR = value;
          delete process.env.VISUAL;
          mockSpawn.mockClear();

          const service = new InteractiveUIService([mockSyncService]);
          const result = service.launcher.openEditorInWorktree("/wt");

          expect(result.success, `${value} should be refused`).toBe(false);
          expect(mockSpawn).not.toHaveBeenCalled();

          void service.destroy();
        },
      );

      it("fails open: an editor nobody recognises is still launched", () => {
        process.env.EDITOR = "some-unknown-editor";
        delete process.env.VISUAL;
        mockSpawn.mockClear();

        const service = new InteractiveUIService([mockSyncService]);
        const result = service.launcher.openEditorInWorktree("/wt");

        expect(result.success).toBe(true);
        expect(mockSpawn).toHaveBeenCalledWith(
          "some-unknown-editor",
          ["/wt"],
          expect.objectContaining({ detached: true }),
        );

        void service.destroy();
      });

      it("keeps a quoted EDITOR path with spaces as one argv entry", () => {
        process.env.EDITOR = '"/Applications/My Editor.app/Contents/MacOS/ed" --new-window';
        delete process.env.VISUAL;
        mockSpawn.mockClear();

        const service = new InteractiveUIService([mockSyncService]);
        const result = service.launcher.openEditorInWorktree("/wt");

        expect(result.success).toBe(true);
        expect(mockSpawn).toHaveBeenCalledWith(
          "/Applications/My Editor.app/Contents/MacOS/ed",
          ["--new-window", "/wt"],
          expect.objectContaining({ detached: true }),
        );

        void service.destroy();
      });

      it("reports a whitespace-only EDITOR instead of quietly editing with something else", () => {
        process.env.EDITOR = "   ";
        delete process.env.VISUAL;
        mockSpawn.mockClear();

        const service = new InteractiveUIService([mockSyncService]);
        const result = service.launcher.openEditorInWorktree("/wt");

        expect(result.success).toBe(false);
        expect(result.error).toContain("whitespace only");
        expect(mockSpawn).not.toHaveBeenCalled();

        void service.destroy();
      });

      it.each([
        ["unset", undefined],
        ["empty", ""],
      ])("still falls back to the default editor when EDITOR is %s", (_label, value) => {
        if (value === undefined) delete process.env.EDITOR;
        else process.env.EDITOR = value;
        delete process.env.VISUAL;
        mockSpawn.mockClear();

        const service = new InteractiveUIService([mockSyncService]);
        const result = service.launcher.openEditorInWorktree("/wt");

        expect(result.success).toBe(true);
        expect(mockSpawn).toHaveBeenCalledWith("code", ["/wt"], expect.objectContaining({ detached: true }));

        void service.destroy();
      });

      // The refusal names Terminal mode as the remedy, so it asks whether one resolves first:
      // on a headless host none does, and sending the user there is a second dead end.
      it.each([
        [false, "no emulator is available", "use Terminal mode"],
        [true, "use Terminal mode", "no emulator is available"],
      ])("words the refusal for a host where an emulator resolves=%s", (resolves, present, absent) => {
        const platform = process.platform;
        const envOverride = process.env.SYNC_WORKTREES_TERMINAL;
        const envTerminal = process.env.TERMINAL;
        Object.defineProperty(process, "platform", { value: "linux" });
        delete process.env.SYNC_WORKTREES_TERMINAL;
        delete process.env.TERMINAL;
        mockSpawnSync.mockImplementation((...args: unknown[]) => ({
          status: resolves && (args[1] as string[])[0] === "konsole" ? 0 : 1,
          stdout: "",
          stderr: "",
        }));
        process.env.EDITOR = "vim";
        delete process.env.VISUAL;

        const service = new InteractiveUIService([mockSyncService]);
        try {
          const result = service.launcher.openEditorInWorktree("/wt");

          expect(result.success).toBe(false);
          expect(result.error).toContain(present);
          expect(result.error).not.toContain(absent);
        } finally {
          Object.defineProperty(process, "platform", { value: platform });
          if (envOverride === undefined) delete process.env.SYNC_WORKTREES_TERMINAL;
          else process.env.SYNC_WORKTREES_TERMINAL = envOverride;
          if (envTerminal === undefined) delete process.env.TERMINAL;
          else process.env.TERMINAL = envTerminal;
          mockSpawnSync.mockImplementation(() => ({ status: 1, stdout: "", stderr: "" }));
          void service.destroy();
        }
      });
    });

    describe("openTerminalInWorktree", () => {
      const originalPlatform = process.platform;
      const originalEnvOverride = process.env.SYNC_WORKTREES_TERMINAL;
      const originalEnvTerminal = process.env.TERMINAL;

      afterEach(() => {
        Object.defineProperty(process, "platform", { value: originalPlatform });
        if (originalEnvOverride === undefined) {
          delete process.env.SYNC_WORKTREES_TERMINAL;
        } else {
          process.env.SYNC_WORKTREES_TERMINAL = originalEnvOverride;
        }
        if (originalEnvTerminal === undefined) {
          delete process.env.TERMINAL;
        } else {
          process.env.TERMINAL = originalEnvTerminal;
        }
      });

      beforeEach(() => {
        mockSpawn.mockClear();
        mockSpawn.mockImplementation(() => ({ on: vi.fn(), unref: vi.fn() }));
        mockSpawnSync.mockClear();
        mockSpawnSync.mockImplementation(() => ({ status: 1, stdout: "", stderr: "" }));
        mockExistsSync.mockClear();
        mockExistsSync.mockReturnValue(false);
      });

      it("should prefer Ghostty on darwin when Ghostty.app is installed", () => {
        Object.defineProperty(process, "platform", { value: "darwin" });
        delete process.env.SYNC_WORKTREES_TERMINAL;
        mockExistsSync.mockImplementation((...args: unknown[]) => String(args[0]).includes("Ghostty.app"));

        const namedSyncService = {
          ...mockSyncService,
          config: { ...mockSyncService.config, name: "my-repo" },
        } as any;
        const service = new InteractiveUIService([namedSyncService]);
        const result = service.launcher.openTerminalInWorktree(0, "/worktrees/feat-x", "feat/x");

        expect(result.success).toBe(true);
        const call = (mockSpawn.mock.calls as any[]).find(([cmd]) => cmd === "open");
        expect(call).toBeDefined();
        // Whole argv, not a prefix: a stray flag after --args would slip past a slice() check
        // and change what Ghostty is actually told to run.
        expect(call[1]).toEqual([
          "-na",
          "Ghostty.app",
          "--args",
          "-e",
          "sh",
          "-c",
          expect.stringMatching(/^tmux new-session -A -s 'my-repo-feat-x-[0-9a-f]+' -c '\/worktrees\/feat-x'$/),
        ]);

        void service.destroy();
      });

      it("should use osascript on darwin and include tmux session name of <repo>-<branch>", () => {
        Object.defineProperty(process, "platform", { value: "darwin" });
        delete process.env.SYNC_WORKTREES_TERMINAL;

        const namedSyncService = {
          ...mockSyncService,
          config: { ...mockSyncService.config, name: "my-repo" },
        } as any;
        const service = new InteractiveUIService([namedSyncService]);
        const result = service.launcher.openTerminalInWorktree(0, "/test/worktrees/feat-x", "feat/x");

        expect(result.success).toBe(true);
        const call = (mockSpawn.mock.calls as any[]).find(([cmd]) => cmd === "osascript");
        expect(call).toBeDefined();
        expect(call[1][0]).toBe("-e");
        expect(call[1][1]).toContain("Terminal");
        expect(call[1][1]).toContain("my-repo-feat-x");
        expect(call[1][1]).toContain("/test/worktrees/feat-x");

        void service.destroy();
      });

      it("should honour SYNC_WORKTREES_TERMINAL env override", () => {
        Object.defineProperty(process, "platform", { value: "linux" });
        process.env.SYNC_WORKTREES_TERMINAL = "alacritty -e";

        const namedSyncService = {
          ...mockSyncService,
          config: { ...mockSyncService.config, name: "repo" },
        } as any;
        const service = new InteractiveUIService([namedSyncService]);
        const result = service.launcher.openTerminalInWorktree(0, "/path", "branch");

        expect(result.success).toBe(true);
        const call = (mockSpawn.mock.calls as any[]).find(([cmd]) => cmd === "alacritty");
        expect(call).toBeDefined();
        expect(call[1]).toEqual([
          "-e",
          "sh",
          "-c",
          expect.stringMatching(/^tmux new-session -A -s 'repo-branch-[0-9a-f]+' -c '\/path'$/),
        ]);

        void service.destroy();
      });

      it.each([
        ["gnome-terminal", "--"],
        ["mate-terminal", "--"],
        ["xfce4-terminal", "-x"],
        ["konsole", "-e"],
        ["alacritty", "-e"],
        ["kitty", "-e"],
        ["xterm", "-e"],
      ])("gives $TERMINAL=%s the %s its own option parser accepts", (terminal, flag) => {
        Object.defineProperty(process, "platform", { value: "linux" });
        delete process.env.SYNC_WORKTREES_TERMINAL;
        process.env.TERMINAL = terminal;

        const service = new InteractiveUIService([mockSyncService]);
        const result = service.launcher.openTerminalInWorktree(0, "/path", "branch");

        expect(result.success).toBe(true);
        const call = (mockSpawn.mock.calls as any[]).find(([cmd]) => cmd === terminal);
        expect(call, `${terminal} was never spawned`).toBeDefined();
        // Whole-argv equality, not toContain: a stray extra "-e" would slip past a substring check.
        expect(call[1]).toEqual([
          flag,
          "sh",
          "-c",
          expect.stringMatching(/^tmux new-session -A -s 'repo-0-branch-[0-9a-f]+' -c '\/path'$/),
        ]);
        expect(call[1]).toHaveLength(4);

        void service.destroy();
      });

      it("uses the same per-emulator rule when probing candidates as it does for $TERMINAL", () => {
        Object.defineProperty(process, "platform", { value: "linux" });
        delete process.env.SYNC_WORKTREES_TERMINAL;
        delete process.env.TERMINAL;
        mockSpawnSync.mockImplementation((...args: unknown[]) => ({
          status: (args[1] as string[])[0] === "gnome-terminal" ? 0 : 1,
          stdout: "",
          stderr: "",
        }));

        const service = new InteractiveUIService([mockSyncService]);
        const result = service.launcher.openTerminalInWorktree(0, "/path", "branch");

        expect(result.success).toBe(true);
        const call = (mockSpawn.mock.calls as any[]).find(([cmd]) => cmd === "gnome-terminal");
        expect(call).toBeDefined();
        expect(call[1]).toEqual([
          "--",
          "sh",
          "-c",
          expect.stringMatching(/^tmux new-session -A -s 'repo-0-branch-[0-9a-f]+' -c '\/path'$/),
        ]);

        void service.destroy();
      });

      it("keeps a $TERMINAL emulator's own flags and still appends the right exec flag", () => {
        Object.defineProperty(process, "platform", { value: "linux" });
        delete process.env.SYNC_WORKTREES_TERMINAL;
        process.env.TERMINAL = "gnome-terminal --hide-menubar";

        const service = new InteractiveUIService([mockSyncService]);
        expect(service.launcher.openTerminalInWorktree(0, "/path", "branch").success).toBe(true);

        const call = (mockSpawn.mock.calls as any[]).find(([cmd]) => cmd === "gnome-terminal");
        expect(call).toBeDefined();
        expect(call[1]).toEqual([
          "--hide-menubar",
          "--",
          "sh",
          "-c",
          expect.stringMatching(/^tmux new-session -A -s 'repo-0-branch-[0-9a-f]+' -c '\/path'$/),
        ]);

        void service.destroy();
      });

      it("keeps a quoted SYNC_WORKTREES_TERMINAL path with spaces as one argv entry", () => {
        Object.defineProperty(process, "platform", { value: "linux" });
        process.env.SYNC_WORKTREES_TERMINAL = '"/Applications/My Term.app/Contents/MacOS/term" -e';

        const service = new InteractiveUIService([mockSyncService]);
        expect(service.launcher.openTerminalInWorktree(0, "/path", "branch").success).toBe(true);

        const call = (mockSpawn.mock.calls as any[]).find(
          ([cmd]) => cmd === "/Applications/My Term.app/Contents/MacOS/term",
        );
        expect(call, "the quoted path was split into several argv entries").toBeDefined();
        expect(call[1]).toEqual([
          "-e",
          "sh",
          "-c",
          expect.stringMatching(/^tmux new-session -A -s 'repo-0-branch-[0-9a-f]+' -c '\/path'$/),
        ]);

        void service.destroy();
      });

      it("supplies the exec flag for a bare SYNC_WORKTREES_TERMINAL that carries none", () => {
        Object.defineProperty(process, "platform", { value: "linux" });
        process.env.SYNC_WORKTREES_TERMINAL = "gnome-terminal";

        const service = new InteractiveUIService([mockSyncService]);
        expect(service.launcher.openTerminalInWorktree(0, "/path", "branch").success).toBe(true);

        const call = (mockSpawn.mock.calls as any[]).find(([cmd]) => cmd === "gnome-terminal");
        expect(call).toBeDefined();
        expect(call[1]).toEqual([
          "--",
          "sh",
          "-c",
          expect.stringMatching(/^tmux new-session -A -s 'repo-0-branch-[0-9a-f]+' -c '\/path'$/),
        ]);

        void service.destroy();
      });

      // The override used to consult the exec-flag table only when it carried no args of its
      // own, so a user who added one flag of theirs lost the exec flag altogether -- the
      // original "-e sh -c" defect wearing a different hat.
      it("gives an override that carries its own flags the exec flag as well", () => {
        Object.defineProperty(process, "platform", { value: "linux" });
        process.env.SYNC_WORKTREES_TERMINAL = "gnome-terminal --tab";

        const service = new InteractiveUIService([mockSyncService]);
        expect(service.launcher.openTerminalInWorktree(0, "/path", "branch").success).toBe(true);

        const call = (mockSpawn.mock.calls as any[]).find(([cmd]) => cmd === "gnome-terminal");
        expect(call, "gnome-terminal was never spawned").toBeDefined();
        expect(call[1]).toEqual([
          "--tab",
          "--",
          "sh",
          "-c",
          expect.stringMatching(/^tmux new-session -A -s 'repo-0-branch-[0-9a-f]+' -c '\/path'$/),
        ]);

        void service.destroy();
      });

      it.each([
        ["SYNC_WORKTREES_TERMINAL", "alacritty -e"],
        ["TERMINAL", "alacritty -e"],
        ["SYNC_WORKTREES_TERMINAL", "xfce4-terminal -x"],
        ["TERMINAL", "gnome-terminal --"],
      ])("adds no second exec flag when %s=%s already has one", (variable, value) => {
        Object.defineProperty(process, "platform", { value: "linux" });
        delete process.env.SYNC_WORKTREES_TERMINAL;
        delete process.env.TERMINAL;
        process.env[variable] = value;
        const [command, flag] = value.split(" ");

        const service = new InteractiveUIService([mockSyncService]);
        expect(service.launcher.openTerminalInWorktree(0, "/path", "branch").success).toBe(true);

        const call = (mockSpawn.mock.calls as any[]).find(([cmd]) => cmd === command);
        expect(call, `${command} was never spawned`).toBeDefined();
        // Exactly one: a second flag would be read as an argument to the first.
        expect(call[1]).toEqual([
          flag,
          "sh",
          "-c",
          expect.stringMatching(/^tmux new-session -A -s 'repo-0-branch-[0-9a-f]+' -c '\/path'$/),
        ]);

        void service.destroy();
      });

      it("should return error for invalid repository index", () => {
        const service = new InteractiveUIService([mockSyncService]);
        const result = service.launcher.openTerminalInWorktree(5, "/path", "branch");

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid repository index");

        void service.destroy();
      });

      it("should return error when spawn throws synchronously", () => {
        Object.defineProperty(process, "platform", { value: "darwin" });
        delete process.env.SYNC_WORKTREES_TERMINAL;

        mockSpawn.mockImplementation(() => {
          throw new Error("ENOENT");
        });

        const service = new InteractiveUIService([mockSyncService]);
        const result = service.launcher.openTerminalInWorktree(0, "/path", "branch");

        expect(result.success).toBe(false);
        expect(result.error).toContain("ENOENT");

        void service.destroy();
      });
    });

    describe("copyBranchFiles", () => {
      it("should skip if no files configured", async () => {
        const service = new InteractiveUIService([mockSyncService]);
        await service.operations.copyBranchFiles(0, "main", "feature/new");

        expect(mockGitService.getWorktrees).not.toHaveBeenCalled();

        void service.destroy();
      });

      it("should skip for invalid repo index", async () => {
        const service = new InteractiveUIService([mockSyncService]);
        await expect(service.operations.copyBranchFiles(-1, "main", "feature/new")).resolves.not.toThrow();

        void service.destroy();
      });

      it("should skip if worktrees not found", async () => {
        const mockServiceWithFiles = {
          ...mockSyncService,
          config: { ...mockSyncService.config, filesToCopyOnBranchCreate: [".env.local"] },
          getGitService: vi.fn().mockReturnValue({
            ...mockGitService,
            getWorktrees: vi.fn().mockResolvedValue([]),
          }),
        };

        const service = new InteractiveUIService([mockServiceWithFiles as any]);
        await expect(service.operations.copyBranchFiles(0, "main", "feature/new")).resolves.not.toThrow();

        void service.destroy();
      });
    });

    describe("deleteDivergedDirectory", () => {
      it("should delete diverged directory for valid inputs", async () => {
        (fs.rm as Mock<any>).mockResolvedValue(undefined);
        const service = new InteractiveUIService([mockSyncService]);

        await service.operations.deleteDivergedDirectory(0, "2024-01-15-feature-x-abc123");

        expect(mockSyncService.discardDivergedDirectory).toHaveBeenCalledWith(
          path.join("/test/worktrees", ".diverged", "2024-01-15-feature-x-abc123"),
          undefined,
        );

        void service.destroy();
      });

      it("releases the recorded keep ref through the locked discard operation", async () => {
        (fs.readFile as Mock<any>).mockResolvedValue(
          JSON.stringify({ keepRef: "refs/sync-worktrees/keep/2024-01-15-feature-x-abc123" }),
        );
        const service = new InteractiveUIService([mockSyncService]);

        await service.operations.deleteDivergedDirectory(0, "2024-01-15-feature-x-abc123");

        expect(mockSyncService.discardDivergedDirectory).toHaveBeenCalledWith(
          path.join("/test/worktrees", ".diverged", "2024-01-15-feature-x-abc123"),
          "refs/sync-worktrees/keep/2024-01-15-feature-x-abc123",
        );
        void service.destroy();
      });

      it("should throw for invalid repo index", async () => {
        const service = new InteractiveUIService([mockSyncService]);

        await expect(service.operations.deleteDivergedDirectory(-1, "test")).rejects.toThrow(
          "Invalid repository index: -1",
        );
        await expect(service.operations.deleteDivergedDirectory(5, "test")).rejects.toThrow(
          "Invalid repository index: 5",
        );

        void service.destroy();
      });

      it("should reject path traversal attempts", async () => {
        (fs.rm as Mock<any>).mockResolvedValue(undefined);
        const service = new InteractiveUIService([mockSyncService]);

        await expect(service.operations.deleteDivergedDirectory(0, "../../evil-target")).rejects.toThrow(
          /Invalid diverged directory name|Path traversal rejected/,
        );
        expect(fs.rm).not.toHaveBeenCalled();

        void service.destroy();
      });

      it("should reject deeply nested traversal attempts", async () => {
        (fs.rm as Mock<any>).mockResolvedValue(undefined);
        const service = new InteractiveUIService([mockSyncService]);

        await expect(service.operations.deleteDivergedDirectory(0, "../../../etc/passwd")).rejects.toThrow(
          /Invalid diverged directory name|Path traversal rejected/,
        );
        expect(fs.rm).not.toHaveBeenCalled();

        void service.destroy();
      });

      it.each([
        ["empty string", ""],
        ["single dot", "."],
        ["double dot", ".."],
        ["forward slash", "nested/evil"],
        ["backslash", "nested\\evil"],
      ])("should reject %s name without calling fs.rm", async (_label, badName) => {
        (fs.rm as Mock<any>).mockResolvedValue(undefined);
        const service = new InteractiveUIService([mockSyncService]);

        await expect(service.operations.deleteDivergedDirectory(0, badName)).rejects.toThrow();
        expect(fs.rm).not.toHaveBeenCalled();

        void service.destroy();
      });
    });

    describe("getDivergedDirectoriesForRepo", () => {
      it("should return empty array for invalid repo index", async () => {
        const service = new InteractiveUIService([mockSyncService]);

        const result = await service.operations.getDivergedDirectoriesForRepo(-1);
        expect(result).toEqual([]);

        const result2 = await service.operations.getDivergedDirectoriesForRepo(5);
        expect(result2).toEqual([]);

        void service.destroy();
      });

      it("should return empty array when .diverged directory does not exist", async () => {
        (fs.readdir as Mock<any>).mockRejectedValue(new Error("ENOENT"));
        const service = new InteractiveUIService([mockSyncService]);

        const result = await service.operations.getDivergedDirectoriesForRepo(0);
        expect(result).toEqual([]);

        void service.destroy();
      });

      it("should parse entries from .diverged directory with metadata files", async () => {
        const mockDirents = [{ name: "2024-01-15-feature-x-abc123", isDirectory: () => true, isFile: () => false }];
        (fs.readdir as Mock<any>).mockResolvedValue(mockDirents);
        (fs.readFile as Mock<any>).mockResolvedValue(
          JSON.stringify({ originalBranch: "feature/x", divergedAt: "2024-01-15T10:00:00Z" }),
        );

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.getDivergedDirectoriesForRepo(0);

        expect(result).toHaveLength(1);
        expect(result[0].originalBranch).toBe("feature/x");
        expect(result[0].divergedAt).toBe("2024-01-15T10:00:00Z");
        expect(result[0].sizeFormatted).toBe("1.0 KB");

        void service.destroy();
      });

      it("should fallback to parsing directory name when metadata file is missing", async () => {
        const mockDirents = [{ name: "2024-03-20-my-branch-abc123", isDirectory: () => true, isFile: () => false }];
        (fs.readdir as Mock<any>).mockResolvedValue(mockDirents);
        (fs.readFile as Mock<any>).mockRejectedValue(new Error("ENOENT"));

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.getDivergedDirectoriesForRepo(0);

        expect(result).toHaveLength(1);
        expect(result[0].originalBranch).toBe("my-branch");
        expect(result[0].divergedAt).toBe("2024-03-20");

        void service.destroy();
      });

      it("should filter out non-directory entries", async () => {
        const mockDirents = [
          { name: "a-dir", isDirectory: () => true, isFile: () => false },
          { name: "a-file.txt", isDirectory: () => false, isFile: () => true },
        ];
        (fs.readdir as Mock<any>).mockResolvedValue(mockDirents);
        (fs.readFile as Mock<any>).mockRejectedValue(new Error("ENOENT"));

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.getDivergedDirectoriesForRepo(0);

        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("a-dir");

        void service.destroy();
      });

      it("should sort entries by divergedAt descending", async () => {
        const mockDirents = [
          { name: "2024-01-01-old-abc", isDirectory: () => true, isFile: () => false },
          { name: "2024-06-15-new-def", isDirectory: () => true, isFile: () => false },
        ];
        (fs.readdir as Mock<any>).mockResolvedValue(mockDirents);
        (fs.readFile as Mock<any>).mockRejectedValue(new Error("ENOENT"));

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.operations.getDivergedDirectoriesForRepo(0);

        expect(result).toHaveLength(2);
        expect(result[0].divergedAt).toBe("2024-06-15");
        expect(result[1].divergedAt).toBe("2024-01-01");

        void service.destroy();
      });
    });

    describe("force clean", () => {
      it("limits preview work across repositories", async () => {
        let concurrent = 0;
        let maxConcurrent = 0;
        const services = [1, 2, 3].map((id) => ({
          ...mockSyncService,
          config: { ...mockSyncService.config, name: `repo-${id}` },
          getForceCleanPreview: vi.fn<any>().mockImplementation(async () => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            await new Promise((resolve) => setTimeout(resolve, 10));
            concurrent--;
            return {
              trashEntries: 0,
              trashBytes: 0,
              unknownTrashSizes: 0,
              invalidTrashEntries: 0,
              keepRefs: 0,
              trashEntryIds: [],
              keepRefNames: [],
            };
          }),
        }));
        const ui = new InteractiveUIService(services as any, undefined, undefined, 1);

        await ui.operations.getForceCleanPreview();

        expect(maxConcurrent).toBe(1);
        void ui.destroy();
      });

      it("skips a repository the confirmation did not name and passes each selection through", async () => {
        const second = {
          ...mockSyncService,
          config: { ...mockSyncService.config, name: "repo-2" },
          forceClean: vi.fn<any>(),
        } as any;
        const ui = new InteractiveUIService([mockSyncService, second]);

        const results = await ui.operations.forceClean([
          { repoIndex: 0, trashEntryIds: ["entry-a"], keepRefNames: ["refs/sync-worktrees/keep/ref-a"] },
        ]);

        expect(mockSyncService.forceClean).toHaveBeenCalledWith({
          repoIndex: 0,
          trashEntryIds: ["entry-a"],
          keepRefNames: ["refs/sync-worktrees/keep/ref-a"],
        });
        expect(second.forceClean).not.toHaveBeenCalled();
        expect(results[1]).toMatchObject({ repoIndex: 1, error: "skipped: cleanup preview was unavailable" });

        void ui.destroy();
      });

      it("logs what a purge left behind because the preview never showed it", async () => {
        const ui = new InteractiveUIService([mockSyncService]);
        mockSyncService.forceClean.mockResolvedValue({
          trashEntries: 1,
          trashBytes: 0,
          unknownTrashSizes: 0,
          invalidTrashEntries: 0,
          keepRefs: 1,
          trashDeleted: 1,
          keepRefsDeleted: 1,
          keepRefsRetained: 0,
          skippedNewEntries: 1,
          skippedNewKeepRefs: 1,
          gcSucceeded: true,
          gcSkipped: false,
          errors: [],
        });
        const logs: Array<{ message: string; level: string }> = [];
        ui.getEvents().on("addLog", (entry: { message: string; level: string }) => logs.push(entry));
        ui.getEvents().emit("uiReady");

        await ui.operations.forceClean([{ repoIndex: 0, trashEntryIds: ["entry-a"], keepRefNames: [] }]);

        expect(logs).toContainEqual(
          expect.objectContaining({
            level: "warn",
            message: expect.stringContaining("left 1 trash entries and 1 recovery refs added after the preview"),
          }),
        );

        void ui.destroy();
      });

      // A gc the busy probe held back is not a gc that ran and failed; the log
      // line has to keep the two apart or every skip reads as a broken repo.
      it("logs a gc held back by the busy probe as skipped, not failed", async () => {
        const ui = new InteractiveUIService([mockSyncService]);
        mockSyncService.forceClean.mockResolvedValue({
          trashEntries: 0,
          trashBytes: 0,
          unknownTrashSizes: 0,
          invalidTrashEntries: 0,
          keepRefs: 0,
          trashDeleted: 1,
          keepRefsDeleted: 0,
          keepRefsRetained: 0,
          skippedNewEntries: 0,
          skippedNewKeepRefs: 0,
          gcSucceeded: false,
          gcSkipped: true,
          errors: ["git gc skipped, git is busy in: /w/feature-1 (index.lock)"],
        });
        const logs: Array<{ message: string; level: string }> = [];
        ui.getEvents().on("addLog", (entry: { message: string; level: string }) => logs.push(entry));
        ui.getEvents().emit("uiReady");

        await ui.operations.forceClean([{ repoIndex: 0, trashEntryIds: ["entry-a"], keepRefNames: [] }]);

        const message = logs.map((entry) => entry.message).join("\n");
        expect(message).toContain("GC skipped");
        expect(message).not.toContain("GC failed");

        void ui.destroy();
      });

      it("previews and cleans every configured repository while preserving partial failures", async () => {
        const failingService = {
          ...mockSyncService,
          config: { ...mockSyncService.config, name: "repo-2" },
          getForceCleanPreview: vi.fn<any>().mockRejectedValue(new Error("not initialized")),
          forceClean: vi.fn<any>().mockRejectedValue(new Error("locked")),
        } as any;
        const ui = new InteractiveUIService([mockSyncService, failingService]);

        const preview = await ui.operations.getForceCleanPreview();
        // Both repos are named in the confirmation here, so repo-2's own
        // failure — not a missing selection — is what has to survive.
        const result = await ui.operations.forceClean([
          { repoIndex: 0, trashEntryIds: ["entry-a"], keepRefNames: [] },
          { repoIndex: 1, trashEntryIds: [], keepRefNames: [] },
        ]);

        expect(preview).toEqual([
          expect.objectContaining({ repoIndex: 0, preview: expect.objectContaining({ trashEntries: 1 }) }),
          expect.objectContaining({ repoIndex: 1, repoName: "repo-2", error: "not initialized" }),
        ]);
        expect(result).toEqual([
          expect.objectContaining({ repoIndex: 0, result: expect.objectContaining({ trashDeleted: 1 }) }),
          expect.objectContaining({ repoIndex: 1, repoName: "repo-2", error: "locked" }),
        ]);

        void ui.destroy();
      });
    });
  });
});

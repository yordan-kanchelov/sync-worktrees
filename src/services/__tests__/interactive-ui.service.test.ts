import * as ink from "ink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appEvents } from "../../utils/app-events";
import { InteractiveUIService } from "../InteractiveUIService";

import type { Config } from "../../types";
import type { WorktreeSyncService } from "../worktree-sync.service";
import type { Mock, Mocked } from "vitest";

const { mockConfigLoaderInstance, mockWorktreeSyncServiceInstance } = vi.hoisted(() => {
  return {
    mockConfigLoaderInstance: {
      loadConfigFile: vi.fn<any>(),
      resolveRepositoryConfig: vi.fn<any>().mockImplementation((repo: any) => repo),
      filterRepositories: vi.fn<any>().mockImplementation((repos: any) => repos),
    } as any,
    mockWorktreeSyncServiceInstance: {
      sync: vi.fn<any>(),
      initialize: vi.fn<any>(),
      isInitialized: vi.fn<any>().mockReturnValue(false),
      isSyncInProgress: vi.fn<any>().mockReturnValue(false),
      updateLogger: vi.fn<any>(),
      config: {} as any,
    } as any,
  };
});

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
      return { unmount: mockUnmount };
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
      isInitialized: vi.fn<any>().mockReturnValue(false),
      isSyncInProgress: vi.fn<any>().mockReturnValue(false),
      updateLogger: vi.fn<any>(),
      config: mockConfig,
    } as any;

    mockWorktreeSyncServiceInstance.sync.mockResolvedValue(undefined);
    mockWorktreeSyncServiceInstance.initialize.mockResolvedValue(undefined);
    mockWorktreeSyncServiceInstance.isInitialized.mockReturnValue(false);
    mockWorktreeSyncServiceInstance.isSyncInProgress.mockReturnValue(false);
    mockWorktreeSyncServiceInstance.config = mockConfig;

    delete (globalThis as any).__inkAppMethods;
    appEvents.removeAllListeners();
  });

  afterEach(() => {
    appEvents.removeAllListeners();
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
      service.destroy();
    });

    it("should initialize with multiple sync services", () => {
      const service = new InteractiveUIService([mockSyncService, mockSyncService], undefined, "0 * * * *");
      expect(service).toBeDefined();
      service.destroy();
    });

    it("should be able to emit events after initialization", () => {
      const service = new InteractiveUIService([mockSyncService]);
      const statusSpy = vi.fn();
      const updateSpy = vi.fn();

      appEvents.on("setStatus", statusSpy);
      appEvents.on("updateLastSyncTime", updateSpy);

      service.setStatus("syncing");
      service.updateLastSyncTime();

      expect(statusSpy).toHaveBeenCalledWith("syncing");
      expect(updateSpy).toHaveBeenCalled();

      service.destroy();
    });
  });

  describe("logger injection", () => {
    it("should inject loggers into sync services", () => {
      const service = new InteractiveUIService([mockSyncService]);

      expect(mockSyncService.updateLogger).toHaveBeenCalled();

      service.destroy();
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

      service.destroy();
    });
  });

  describe("updateLastSyncTime method", () => {
    it("should emit updateLastSyncTime event", () => {
      const service = new InteractiveUIService([mockSyncService]);
      const updateSpy = vi.fn();
      appEvents.on("updateLastSyncTime", updateSpy);

      service.updateLastSyncTime();

      expect(updateSpy).toHaveBeenCalled();

      service.destroy();
    });

    it("should not throw when no listeners", () => {
      const service = new InteractiveUIService([mockSyncService]);
      appEvents.removeAllListeners();

      expect(() => service.updateLastSyncTime()).not.toThrow();

      service.destroy();
    });
  });

  describe("setStatus method", () => {
    it("should emit setStatus event", () => {
      const service = new InteractiveUIService([mockSyncService]);
      const setStatusSpy = vi.fn();
      appEvents.on("setStatus", setStatusSpy);

      service.setStatus("syncing");

      expect(setStatusSpy).toHaveBeenCalledWith("syncing");

      service.destroy();
    });

    it("should handle both idle and syncing statuses", () => {
      const service = new InteractiveUIService([mockSyncService]);
      const setStatusSpy = vi.fn();
      appEvents.on("setStatus", setStatusSpy);

      service.setStatus("idle");
      service.setStatus("syncing");

      expect(setStatusSpy).toHaveBeenCalledWith("idle");
      expect(setStatusSpy).toHaveBeenCalledWith("syncing");

      service.destroy();
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
      appEvents.on("setStatus", statusSpy);

      await service.destroy();

      // After destroy, emitting events should not call listeners (they were removed)
      appEvents.emit("setStatus", "syncing");
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
      appEvents.on("setStatus", statusSpy);
      appEvents.on("updateLastSyncTime", updateSpy);

      await service.destroy();

      // After destroy, these should be no-ops
      service.setStatus("syncing");
      service.updateLastSyncTime();

      expect(statusSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    });
  });

  describe("handleManualSync", () => {
    it("should sync all services on manual sync", async () => {
      const service = new InteractiveUIService([mockSyncService]);
      const onManualSync = (mockRender.mock.calls[0][0].props as any).onManualSync;

      await onManualSync();

      expect(mockSyncService.sync).toHaveBeenCalled();

      service.destroy();
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

      service.destroy();
    });

    it("should handle sync errors gracefully", async () => {
      mockSyncService.sync.mockRejectedValue(new Error("Sync failed"));
      const service = new InteractiveUIService([mockSyncService]);
      const onManualSync = (mockRender.mock.calls[0][0].props as any).onManualSync;

      await expect(onManualSync()).resolves.not.toThrow();

      service.destroy();
    });
  });

  describe("triggerInitialSync", () => {
    it("should sync all services when called directly", async () => {
      const service = new InteractiveUIService([mockSyncService]);

      await service.triggerInitialSync();

      expect(mockSyncService.sync).toHaveBeenCalled();

      service.destroy();
    });

    it("should set status to syncing then idle", async () => {
      const service = new InteractiveUIService([mockSyncService]);
      const statusChanges: string[] = [];
      appEvents.on("setStatus", (status: string) => statusChanges.push(status));

      await service.triggerInitialSync();

      expect(statusChanges).toContain("syncing");
      expect(statusChanges[statusChanges.length - 1]).toBe("idle");

      service.destroy();
    });

    it("should update last sync time after sync", async () => {
      const service = new InteractiveUIService([mockSyncService]);
      const updateSpy = vi.fn();
      appEvents.on("updateLastSyncTime", updateSpy);

      await service.triggerInitialSync();

      expect(updateSpy).toHaveBeenCalled();

      service.destroy();
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

      service.destroy();
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

      service.destroy();
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

      service.destroy();
    });
  });

  describe("handleReload", () => {
    it("should skip reload when no config file in single-repo mode", async () => {
      const service = new InteractiveUIService([mockSyncService]);
      const setStatusSpy = vi.fn();
      appEvents.on("setStatus", setStatusSpy);

      const onReload = (mockRender.mock.calls[0][0].props as any).onReload;

      await onReload();

      expect(setStatusSpy).toHaveBeenCalledWith("idle");

      service.destroy();
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

      service.destroy();
    });

    it("should handle reload errors gracefully", async () => {
      mockConfigLoaderInstance.loadConfigFile.mockRejectedValue(new Error("Failed to load config"));

      const service = new InteractiveUIService([mockSyncService], "/test/config.js");
      const onReload = (mockRender.mock.calls[0][0].props as any).onReload;

      await expect(onReload()).resolves.not.toThrow();

      service.destroy();
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

      service.destroy();
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
        (service as any).cronJobs = [{ stop: cronJobsSpy }, { stop: cronJobsSpy }];

        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
        await onReload();

        expect(cronJobsSpy).toHaveBeenCalledTimes(2);

        service.destroy();
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

        const cronJobs = (service as any).cronJobs;
        expect(cronJobs).toBeDefined();
        expect(cronJobs.length).toBe(1);

        service.destroy();
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
        let cronJobs = (service as any).cronJobs;
        expect(cronJobs.length).toBe(0);

        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
        await onReload();

        // After reload, cron jobs are created via setupCronJobs
        cronJobs = (service as any).cronJobs;
        expect(cronJobs.length).toBe(1);

        service.destroy();
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

        const cronJobs = (service as any).cronJobs;
        expect(cronJobs).toEqual([]);

        service.destroy();
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

        const cronJobs = (service as any).cronJobs;
        // 2 non-runOnce repos with same schedule = 1 grouped cron job
        expect(cronJobs.length).toBe(1);

        service.destroy();
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

        service.destroy();
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

        service.destroy();
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
        appEvents.on("updateRepositoryCount", repoCountSpy);

        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
        await onReload();

        expect(repoCountSpy).toHaveBeenCalledWith(1);
        expect(mockRender).toHaveBeenCalledTimes(1);

        service.destroy();
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

        service.destroy();
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

        service.destroy();
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

        service.destroy();
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

        expect(mockWorktreeSyncServiceInstance.initialize).toHaveBeenCalledTimes(2);
        expect(mockWorktreeSyncServiceInstance.sync).toHaveBeenCalledTimes(2);

        service.destroy();
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
        expect((service as any).cronJobs.length).toBe(1);

        await onReload();
        expect((service as any).repositoryCount).toBe(2);
        // 2 repos with different schedules = 2 cron jobs
        expect((service as any).cronJobs.length).toBe(2);

        await onReload();
        expect((service as any).repositoryCount).toBe(1);
        expect((service as any).cronJobs.length).toBe(1);

        service.destroy();
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

        service.destroy();
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

        mockWorktreeSyncServiceInstance.updateLogger.mockClear();

        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
        await onReload();

        expect(mockWorktreeSyncServiceInstance.updateLogger).toHaveBeenCalled();

        service.destroy();
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
        appEvents.on("updateCronSchedule", cronScheduleSpy);

        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
        await onReload();

        expect(cronScheduleSpy).toHaveBeenCalledWith("*/30 * * * *");

        service.destroy();
      });

      it("should apply CLI filter override during reload", async () => {
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

        const service = new InteractiveUIService([mockSyncService], "/test/config.js", "0 * * * *", undefined, {
          filter: "test-*",
        });
        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
        await onReload();

        expect(mockConfigLoaderInstance.filterRepositories).toHaveBeenCalledWith(expect.any(Array), "test-*");

        service.destroy();
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

        service.destroy();
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

  describe("repository operations", () => {
    let mockGitService: any;

    beforeEach(() => {
      mockGitService = {
        getRemoteBranches: vi.fn().mockResolvedValue(["main", "develop", "feature/test"]),
        getDefaultBranch: vi.fn().mockReturnValue("main"),
        branchExists: vi.fn().mockResolvedValue({ local: false, remote: false }),
        createBranch: vi.fn().mockResolvedValue(undefined),
        pushBranch: vi.fn().mockResolvedValue(undefined),
        getWorktrees: vi.fn().mockResolvedValue([
          { path: "/test/worktrees/main", branch: "main" },
          { path: "/test/worktrees/develop", branch: "develop" },
        ]),
        addWorktree: vi.fn().mockResolvedValue(undefined),
      };

      mockSyncService.getGitService = vi.fn().mockReturnValue(mockGitService);
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
        const repos = service.getRepositoryList();

        expect(repos).toHaveLength(2);
        expect(repos[0]).toEqual({ index: 0, name: "repo-1", repoUrl: "https://github.com/test/repo1.git" });
        expect(repos[1]).toEqual({ index: 1, name: "repo-2", repoUrl: "https://github.com/test/repo2.git" });

        service.destroy();
      });

      it("should use fallback name when name is not set", () => {
        const mockServiceNoName = {
          ...mockSyncService,
          config: { repoUrl: "https://github.com/test/repo.git", worktreeDir: "/test" },
        };

        const service = new InteractiveUIService([mockServiceNoName as any]);
        const repos = service.getRepositoryList();

        expect(repos[0].name).toBe("repo-0");

        service.destroy();
      });
    });

    describe("getBranchesForRepo", () => {
      it("should return branches for valid repo index", async () => {
        mockSyncService.isInitialized.mockReturnValue(true);
        const service = new InteractiveUIService([mockSyncService]);
        const branches = await service.getBranchesForRepo(0);

        expect(branches).toEqual(["main", "develop", "feature/test"]);
        expect(mockGitService.getRemoteBranches).toHaveBeenCalled();

        service.destroy();
      });

      it("should return empty array if service not initialized", async () => {
        mockSyncService.isInitialized.mockReturnValue(false);
        const service = new InteractiveUIService([mockSyncService]);
        const branches = await service.getBranchesForRepo(0);

        expect(branches).toEqual([]);
        expect(mockGitService.getRemoteBranches).not.toHaveBeenCalled();

        service.destroy();
      });

      it("should throw error for invalid repo index", async () => {
        const service = new InteractiveUIService([mockSyncService]);

        await expect(service.getBranchesForRepo(-1)).rejects.toThrow("Invalid repository index: -1");
        await expect(service.getBranchesForRepo(5)).rejects.toThrow("Invalid repository index: 5");

        service.destroy();
      });
    });

    describe("getDefaultBranchForRepo", () => {
      it("should return default branch for valid repo index", () => {
        const service = new InteractiveUIService([mockSyncService]);
        const branch = service.getDefaultBranchForRepo(0);

        expect(branch).toBe("main");
        expect(mockGitService.getDefaultBranch).toHaveBeenCalled();

        service.destroy();
      });

      it("should throw error for invalid repo index", () => {
        const service = new InteractiveUIService([mockSyncService]);

        expect(() => service.getDefaultBranchForRepo(-1)).toThrow("Invalid repository index: -1");
        expect(() => service.getDefaultBranchForRepo(5)).toThrow("Invalid repository index: 5");

        service.destroy();
      });
    });

    describe("createAndPushBranch", () => {
      it("should create and push a new branch", async () => {
        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.createAndPushBranch(0, "main", "feature/new");

        expect(result.success).toBe(true);
        expect(result.finalName).toBe("feature/new");
        expect(mockGitService.createBranch).toHaveBeenCalledWith("feature/new", "main");
        expect(mockGitService.pushBranch).toHaveBeenCalledWith("feature/new");

        service.destroy();
      });

      it("should append suffix if branch already exists", async () => {
        mockGitService.createBranch
          .mockRejectedValueOnce(new Error("already exists"))
          .mockRejectedValueOnce(new Error("already exists"))
          .mockResolvedValueOnce(undefined);

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.createAndPushBranch(0, "main", "feature/test");

        expect(result.success).toBe(true);
        expect(result.finalName).toBe("feature/test-2");
        expect(mockGitService.createBranch).toHaveBeenCalledTimes(3);

        service.destroy();
      });

      it("should return error for invalid repo index", async () => {
        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.createAndPushBranch(-1, "main", "feature/new");

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid repository index");

        service.destroy();
      });

      it("should handle git errors gracefully", async () => {
        mockGitService.createBranch.mockRejectedValue(new Error("Git error"));

        const service = new InteractiveUIService([mockSyncService]);
        const result = await service.createAndPushBranch(0, "main", "feature/new");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Git error");

        service.destroy();
      });
    });

    describe("getWorktreesForRepo", () => {
      it("should return worktrees for valid repo index", async () => {
        const service = new InteractiveUIService([mockSyncService]);
        const worktrees = await service.getWorktreesForRepo(0);

        expect(worktrees).toHaveLength(2);
        expect(worktrees[0]).toEqual({ path: "/test/worktrees/main", branch: "main" });

        service.destroy();
      });

      it("should throw error for invalid repo index", async () => {
        const service = new InteractiveUIService([mockSyncService]);

        await expect(service.getWorktreesForRepo(-1)).rejects.toThrow("Invalid repository index: -1");

        service.destroy();
      });
    });

    describe("createWorktreeForBranch", () => {
      it("should create worktree for branch", async () => {
        const service = new InteractiveUIService([mockSyncService]);
        await service.createWorktreeForBranch(0, "feature/new");

        expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature/new", "/test/worktrees/feature/new");

        service.destroy();
      });

      it("should throw error for invalid repo index", async () => {
        const service = new InteractiveUIService([mockSyncService]);

        await expect(service.createWorktreeForBranch(-1, "feature/new")).rejects.toThrow(
          "Invalid repository index: -1",
        );

        service.destroy();
      });
    });

    describe("openEditorInWorktree", () => {
      it("should return success when opening editor", () => {
        const service = new InteractiveUIService([mockSyncService]);
        const result = service.openEditorInWorktree("/test/worktrees/main");

        expect(result.success).toBe(true);

        service.destroy();
      });
    });

    describe("copyBranchFiles", () => {
      it("should skip if no files configured", async () => {
        const service = new InteractiveUIService([mockSyncService]);
        await service.copyBranchFiles(0, "main", "feature/new");

        expect(mockGitService.getWorktrees).not.toHaveBeenCalled();

        service.destroy();
      });

      it("should skip for invalid repo index", async () => {
        const service = new InteractiveUIService([mockSyncService]);
        await expect(service.copyBranchFiles(-1, "main", "feature/new")).resolves.not.toThrow();

        service.destroy();
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
        await expect(service.copyBranchFiles(0, "main", "feature/new")).resolves.not.toThrow();

        service.destroy();
      });
    });
  });
});

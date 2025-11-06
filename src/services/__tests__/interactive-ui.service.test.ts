import * as ink from "ink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InteractiveUIService } from "../InteractiveUIService";

import type { Config } from "../../types";
import type { WorktreeSyncService } from "../worktree-sync.service";
import type { Mock, Mocked } from "vitest";

const { mockConfigLoaderInstance, mockWorktreeSyncServiceInstance } = vi.hoisted(() => {
  return {
    mockConfigLoaderInstance: {
      loadConfigFile: vi.fn<any>(),
    } as any,
    mockWorktreeSyncServiceInstance: {
      sync: vi.fn<any>(),
      initialize: vi.fn<any>(),
      isSyncInProgress: vi.fn<any>().mockReturnValue(false),
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
  let originalConsoleLog: typeof console.log;
  let originalConsoleWarn: typeof console.warn;
  let originalConsoleError: typeof console.error;
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

    originalConsoleLog = console.log;
    originalConsoleWarn = console.warn;
    originalConsoleError = console.error;

    const mockConfig: Config = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/test/worktrees",
      cronSchedule: "0 * * * *",
      runOnce: false,
    };

    mockSyncService = {
      sync: vi.fn<any>().mockResolvedValue(undefined),
      initialize: vi.fn<any>().mockResolvedValue(undefined),
      isSyncInProgress: vi.fn<any>().mockReturnValue(false),
      config: mockConfig,
    } as any;

    mockWorktreeSyncServiceInstance.sync.mockResolvedValue(undefined);
    mockWorktreeSyncServiceInstance.initialize.mockResolvedValue(undefined);
    mockWorktreeSyncServiceInstance.isSyncInProgress.mockReturnValue(false);
    mockWorktreeSyncServiceInstance.config = mockConfig;

    delete (globalThis as any).__inkAppMethods;
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
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

    it("should set up global methods for ink components", () => {
      const service = new InteractiveUIService([mockSyncService]);

      const methods = (globalThis as any).__inkAppMethods;
      expect(methods).toBeDefined();
      expect(typeof methods.updateLastSyncTime).toBe("function");
      expect(typeof methods.setStatus).toBe("function");

      service.destroy();
    });
  });

  describe("console redirection", () => {
    it("should redirect console.log", () => {
      const service = new InteractiveUIService([mockSyncService]);

      console.log("test message");

      expect(originalConsoleLog).toHaveBeenCalledWith("test message");

      service.destroy();
    });

    it("should redirect console.warn", () => {
      const service = new InteractiveUIService([mockSyncService]);

      console.warn("warning message");

      expect(originalConsoleWarn).toHaveBeenCalledWith("warning message");

      service.destroy();
    });

    it("should redirect console.error", () => {
      const service = new InteractiveUIService([mockSyncService]);

      console.error("error message");

      expect(originalConsoleError).toHaveBeenCalledWith("error message");

      service.destroy();
    });

    it("should handle non-string console arguments", () => {
      const service = new InteractiveUIService([mockSyncService]);

      console.log({ foo: "bar" }, 123);

      expect(originalConsoleLog).toHaveBeenCalledWith(expect.stringContaining('"foo"'));

      service.destroy();
    });

    it("should restore console after destroy", () => {
      const service = new InteractiveUIService([mockSyncService]);

      const redirectedLog = console.log;
      const redirectedWarn = console.warn;
      const redirectedError = console.error;

      expect(redirectedLog).not.toBe(originalConsoleLog);
      expect(redirectedWarn).not.toBe(originalConsoleWarn);
      expect(redirectedError).not.toBe(originalConsoleError);

      service.destroy();

      expect(typeof console.log).toBe("function");
      expect(typeof console.warn).toBe("function");
      expect(typeof console.error).toBe("function");
      expect(console.log).not.toBe(redirectedLog);
      expect(console.warn).not.toBe(redirectedWarn);
      expect(console.error).not.toBe(redirectedError);
    });
  });

  describe("updateLastSyncTime method", () => {
    it("should update last sync time through global methods", () => {
      const service = new InteractiveUIService([mockSyncService]);
      const updateSpy = vi.fn();
      (globalThis as any).__inkAppMethods.updateLastSyncTime = updateSpy;

      service.updateLastSyncTime();

      expect(updateSpy).toHaveBeenCalled();

      service.destroy();
    });

    it("should handle missing global methods gracefully", () => {
      const service = new InteractiveUIService([mockSyncService]);
      delete (globalThis as any).__inkAppMethods;

      expect(() => service.updateLastSyncTime()).not.toThrow();

      service.destroy();
    });
  });

  describe("setStatus method", () => {
    it("should set status through global methods", () => {
      const service = new InteractiveUIService([mockSyncService]);
      const setStatusSpy = vi.fn();
      (globalThis as any).__inkAppMethods.setStatus = setStatusSpy;

      service.setStatus("syncing");

      expect(setStatusSpy).toHaveBeenCalledWith("syncing");

      service.destroy();
    });

    it("should handle both idle and syncing statuses", () => {
      const service = new InteractiveUIService([mockSyncService]);
      const setStatusSpy = vi.fn();
      (globalThis as any).__inkAppMethods.setStatus = setStatusSpy;

      service.setStatus("idle");
      service.setStatus("syncing");

      expect(setStatusSpy).toHaveBeenCalledWith("idle");
      expect(setStatusSpy).toHaveBeenCalledWith("syncing");

      service.destroy();
    });
  });

  describe("destroy method", () => {
    it("should restore console and unmount app", () => {
      const service = new InteractiveUIService([mockSyncService]);

      service.destroy();

      expect(typeof console.log).toBe("function");
      expect(typeof console.warn).toBe("function");
      expect(typeof console.error).toBe("function");
      expect(mockUnmount).toHaveBeenCalled();
    });

    it("should clean up global methods", () => {
      const service = new InteractiveUIService([mockSyncService]);

      service.destroy();

      expect((globalThis as any).__inkAppMethods).toBeUndefined();
    });

    it("should be safe to call multiple times", () => {
      const service = new InteractiveUIService([mockSyncService]);

      expect(() => {
        service.destroy();
        service.destroy();
      }).not.toThrow();
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

  describe("handleReload", () => {
    it("should skip reload when no config file in single-repo mode", async () => {
      const service = new InteractiveUIService([mockSyncService]);
      const setStatusSpy = vi.fn();
      (globalThis as any).__inkAppMethods.setStatus = setStatusSpy;

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

      it("should create new cron jobs after reload", async () => {
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
        expect(cronJobs.length).toBe(2);

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

        let cronJobs = (service as any).cronJobs;
        expect(cronJobs.length).toBe(3);

        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
        await onReload();

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
        expect(cronJobs.length).toBe(2);

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

      it("should re-render App component with updated repository count", async () => {
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

        const initialRenderCall = mockRender.mock.calls[0][0];
        expect(initialRenderCall.props.repositoryCount).toBe(2);

        const onReload = (mockRender.mock.calls[0][0].props as any).onReload;
        await onReload();

        const reloadRenderCall = mockRender.mock.calls[mockRender.mock.calls.length - 1][0];
        expect(reloadRenderCall.props.repositoryCount).toBe(1);

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
                cronSchedule: "0 * * * *",
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
        expect((service as any).cronJobs.length).toBe(2);

        await onReload();
        expect((service as any).repositoryCount).toBe(1);
        expect((service as any).cronJobs.length).toBe(1);

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
});

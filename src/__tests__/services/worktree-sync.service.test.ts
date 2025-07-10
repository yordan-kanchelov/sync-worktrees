import * as fs from "fs/promises";
import * as path from "path";

import { GitService } from "../../services/git.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { createTempDirectory } from "../test-utils";

import type { Config } from "../../types";

jest.mock("../../services/git.service");

describe("WorktreeSyncService retry behavior", () => {
  let syncService: WorktreeSyncService;
  let mockGitService: jest.Mocked<GitService>;
  let tempDir: string;
  let config: Config;

  beforeEach(async () => {
    tempDir = await createTempDirectory();

    config = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: path.join(tempDir, "worktrees"),
      cronSchedule: "0 * * * *",
      runOnce: false,
      retry: {
        maxAttempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 50,
      },
    };

    mockGitService = {
      initialize: jest.fn(),
      fetchAll: jest.fn(),
      getRemoteBranches: jest.fn(),
      getWorktrees: jest.fn(),
      getCurrentBranch: jest.fn(),
      addWorktree: jest.fn(),
      removeWorktree: jest.fn(),
      pruneWorktrees: jest.fn(),
      checkWorktreeStatus: jest.fn(),
      hasUnpushedCommits: jest.fn(),
      getGit: jest.fn(),
    } as any;

    (GitService as jest.MockedClass<typeof GitService>).mockImplementation(() => mockGitService);

    syncService = new WorktreeSyncService(config);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  describe("sync with retry", () => {
    it("should retry entire sync operation on network errors", async () => {
      await syncService.initialize();

      const networkError = new Error("Network connection failed");
      (networkError as any).code = "ECONNREFUSED";

      // First attempt fails on fetchAll
      mockGitService.fetchAll.mockRejectedValueOnce(networkError).mockResolvedValueOnce(undefined);

      mockGitService.getRemoteBranches.mockResolvedValue(["main", "develop"]);
      mockGitService.getWorktrees.mockResolvedValue([{ path: path.join(config.worktreeDir, "main"), branch: "main" }]);
      mockGitService.getCurrentBranch.mockResolvedValue("main");
      mockGitService.pruneWorktrees.mockResolvedValue(undefined);

      await syncService.sync();

      expect(mockGitService.fetchAll).toHaveBeenCalledTimes(2);
    });

    it("should retry on filesystem errors during sync", async () => {
      await syncService.initialize();

      const fsError = new Error("Resource temporarily unavailable");
      (fsError as any).code = "EBUSY";

      mockGitService.fetchAll.mockResolvedValue(undefined);
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "develop"]);

      // First attempt fails on getWorktrees
      mockGitService.getWorktrees
        .mockRejectedValueOnce(fsError)
        .mockResolvedValue([{ path: path.join(config.worktreeDir, "main"), branch: "main" }]);

      mockGitService.getCurrentBranch.mockResolvedValue("main");
      mockGitService.pruneWorktrees.mockResolvedValue(undefined);

      await syncService.sync();

      expect(mockGitService.getWorktrees).toHaveBeenCalledTimes(2);
    });

    it("should respect maxAttempts configuration", async () => {
      await syncService.initialize();

      const error = new Error("Persistent network error");
      (error as any).code = "ETIMEDOUT";

      mockGitService.fetchAll.mockRejectedValue(error);

      await expect(syncService.sync()).rejects.toThrow("Persistent network error");

      // Should try 3 times (maxAttempts = 3)
      expect(mockGitService.fetchAll).toHaveBeenCalledTimes(3);
    });

    it("should not retry on non-retryable errors", async () => {
      await syncService.initialize();

      const authError = new Error("Authentication failed");
      mockGitService.fetchAll.mockRejectedValue(authError);

      await expect(syncService.sync()).rejects.toThrow("Authentication failed");

      // Should only try once for non-retryable errors
      expect(mockGitService.fetchAll).toHaveBeenCalledTimes(1);
    });
  });

  describe("sync with unlimited retries", () => {
    it("should retry indefinitely when configured", async () => {
      const unlimitedConfig: Config = {
        ...config,
        retry: {
          maxAttempts: "unlimited",
          initialDelayMs: 1,
          maxDelayMs: 5,
        },
      };

      const unlimitedSyncService = new WorktreeSyncService(unlimitedConfig);
      await unlimitedSyncService.initialize();

      let attempts = 0;
      mockGitService.fetchAll.mockImplementation(() => {
        attempts++;
        if (attempts < 5) {
          const error = new Error("Network error");
          (error as any).code = "ECONNREFUSED";
          return Promise.reject(error);
        }
        return Promise.resolve(undefined);
      });

      mockGitService.getRemoteBranches.mockResolvedValue(["main"]);
      mockGitService.getWorktrees.mockResolvedValue([]);
      mockGitService.getCurrentBranch.mockResolvedValue("main");
      mockGitService.pruneWorktrees.mockResolvedValue(undefined);

      await unlimitedSyncService.sync();

      expect(mockGitService.fetchAll).toHaveBeenCalledTimes(5);
    });
  });

  describe("retry callback behavior", () => {
    it("should log retry attempts", async () => {
      const consoleSpy = jest.spyOn(console, "log").mockImplementation();

      await syncService.initialize();

      const error = new Error("Network timeout");
      (error as any).code = "ETIMEDOUT";

      mockGitService.fetchAll
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(undefined);

      mockGitService.getRemoteBranches.mockResolvedValue(["main"]);
      mockGitService.getWorktrees.mockResolvedValue([]);
      mockGitService.getCurrentBranch.mockResolvedValue("main");
      mockGitService.pruneWorktrees.mockResolvedValue(undefined);

      await syncService.sync();

      // Check that retry messages were logged
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("⚠️  Sync attempt 1 failed"));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("🔄 Retrying synchronization"));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("⚠️  Sync attempt 2 failed"));

      consoleSpy.mockRestore();
    });
  });

  describe("partial sync failures", () => {
    it("should complete sync if only non-critical operations fail", async () => {
      await syncService.initialize();

      mockGitService.fetchAll.mockResolvedValue(undefined);
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "develop"]);
      mockGitService.getWorktrees.mockResolvedValue([{ path: path.join(config.worktreeDir, "main"), branch: "main" }]);
      mockGitService.getCurrentBranch.mockResolvedValue("main");

      // Prune fails but is retryable
      const pruneError = new Error("Prune failed");
      (pruneError as any).code = "EBUSY"; // Make it retryable
      mockGitService.pruneWorktrees
        .mockRejectedValueOnce(pruneError)
        .mockRejectedValueOnce(pruneError)
        .mockResolvedValueOnce(undefined);

      await syncService.sync();

      // Verify sync completed despite prune retries
      expect(mockGitService.fetchAll).toHaveBeenCalled();
      expect(mockGitService.getRemoteBranches).toHaveBeenCalled();
      expect(mockGitService.pruneWorktrees).toHaveBeenCalledTimes(3);
    });
  });
});

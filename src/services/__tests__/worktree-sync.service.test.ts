import * as fs from "fs/promises";
import * as path from "path";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { GitService } from "../git.service";
import { WorktreeSyncService } from "../worktree-sync.service";

import type { Config } from "../../types";

// Mock modules
jest.mock("fs/promises");
jest.mock("../git.service");

describe("WorktreeSyncService", () => {
  let service: WorktreeSyncService;
  let mockConfig: Config;
  let mockGitService: jest.Mocked<GitService>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConfig = {
      repoPath: "/test/repo",
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/test/worktrees",
      cronSchedule: "0 * * * *",
      runOnce: false,
    };

    // Create mock GitService
    mockGitService = {
      initialize: jest.fn<any>().mockResolvedValue(undefined),
      fetchAll: jest.fn<any>().mockResolvedValue(undefined),
      getRemoteBranches: jest.fn<any>().mockResolvedValue(["main", "feature-1", "feature-2"]),
      addWorktree: jest.fn<any>().mockResolvedValue(undefined),
      removeWorktree: jest.fn<any>().mockResolvedValue(undefined),
      pruneWorktrees: jest.fn<any>().mockResolvedValue(undefined),
      checkWorktreeStatus: jest.fn<any>().mockResolvedValue(true),
      getGit: jest.fn<any>(),
    } as any;

    // Mock GitService constructor
    (GitService as jest.MockedClass<typeof GitService>).mockImplementation(() => mockGitService);

    service = new WorktreeSyncService(mockConfig);
  });

  describe("initialize", () => {
    it("should initialize git service", async () => {
      await service.initialize();

      expect(mockGitService.initialize).toHaveBeenCalled();
    });
  });

  describe("sync", () => {
    beforeEach(async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
    });

    it("should complete full sync workflow successfully", async () => {
      // Mock existing worktree directories
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["main", "feature-1", "old-branch"]);

      await service.sync();

      // Verify workflow steps
      expect(mockGitService.fetchAll).toHaveBeenCalled();
      expect(mockGitService.getRemoteBranches).toHaveBeenCalled();
      expect(fs.mkdir).toHaveBeenCalledWith("/test/worktrees", { recursive: true });
      expect(fs.readdir).toHaveBeenCalledWith("/test/worktrees");

      // Should create new worktree for feature-2
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature-2", path.join("/test/worktrees", "feature-2"));

      // Should check and remove old-branch
      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledWith(path.join("/test/worktrees", "old-branch"));
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith("old-branch");

      // Should prune at the end
      expect(mockGitService.pruneWorktrees).toHaveBeenCalled();
    });

    it("should handle empty remote branches", async () => {
      mockGitService.getRemoteBranches.mockResolvedValue([]);
      (fs.readdir as jest.Mock<any>).mockResolvedValue([]);

      await service.sync();

      expect(mockGitService.addWorktree).not.toHaveBeenCalled();
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(mockGitService.pruneWorktrees).toHaveBeenCalled();
    });

    it("should skip worktrees with local changes", async () => {
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["main", "dirty-branch"]);
      mockGitService.checkWorktreeStatus.mockResolvedValue(false); // Has local changes

      await service.sync();

      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledWith(path.join("/test/worktrees", "dirty-branch"));
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle errors during sync but still cleanup", async () => {
      const error = new Error("Fetch failed");
      mockGitService.fetchAll.mockRejectedValue(error);

      await expect(service.sync()).rejects.toThrow("Fetch failed");

      // Verify error is logged
      expect(console.error).toHaveBeenCalledWith("Error during worktree synchronization:", error);
    });

    it("should handle errors when checking worktree status", async () => {
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["main", "broken-branch"]);
      mockGitService.checkWorktreeStatus.mockRejectedValue(new Error("Status check failed"));

      await service.sync();

      // Should log error but continue
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Error checking worktree"), expect.any(Error));
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(mockGitService.pruneWorktrees).toHaveBeenCalled();
    });

    it("should create multiple new worktrees", async () => {
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-1", "feature-2", "feature-3"]);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["main"]);

      await service.sync();

      expect(mockGitService.addWorktree).toHaveBeenCalledTimes(3);
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature-1", path.join("/test/worktrees", "feature-1"));
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature-2", path.join("/test/worktrees", "feature-2"));
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature-3", path.join("/test/worktrees", "feature-3"));
    });

    it("should remove multiple stale worktrees", async () => {
      mockGitService.getRemoteBranches.mockResolvedValue(["main"]);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["main", "old-1", "old-2", "old-3"]);
      mockGitService.checkWorktreeStatus.mockResolvedValue(true); // All clean

      await service.sync();

      expect(mockGitService.removeWorktree).toHaveBeenCalledTimes(3);
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith("old-1");
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith("old-2");
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith("old-3");
    });
  });
});

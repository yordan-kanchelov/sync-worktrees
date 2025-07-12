import { WorktreeSyncService } from "../worktree-sync.service";

import type { Config } from "../../types";
import type { GitService } from "../git.service";

jest.mock("fs/promises");
jest.mock("simple-git");

describe("WorktreeSyncService - Update Existing Worktrees", () => {
  let service: WorktreeSyncService;
  let mockConfig: Config;
  let mockGitService: jest.Mocked<GitService>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConfig = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/test/worktrees",
      cronSchedule: "0 * * * *",
      runOnce: true,
      updateExistingWorktrees: true,
    };

    service = new WorktreeSyncService(mockConfig);

    // Mock GitService methods
    mockGitService = {
      initialize: jest.fn().mockResolvedValue(undefined),
      fetchAll: jest.fn().mockResolvedValue(undefined),
      getRemoteBranches: jest.fn().mockResolvedValue(["main", "feature", "develop"]),
      getWorktrees: jest.fn().mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature", branch: "feature" },
        { path: "/test/worktrees/develop", branch: "develop" },
      ]),
      checkWorktreeStatus: jest.fn().mockResolvedValue(true), // All clean by default
      isWorktreeBehind: jest.fn().mockResolvedValue(false), // Not behind by default
      updateWorktree: jest.fn().mockResolvedValue(undefined),
      addWorktree: jest.fn().mockResolvedValue(undefined),
      removeWorktree: jest.fn().mockResolvedValue(undefined),
      pruneWorktrees: jest.fn().mockResolvedValue(undefined),
      hasUnpushedCommits: jest.fn().mockResolvedValue(false),
      hasStashedChanges: jest.fn().mockResolvedValue(false),
      hasOperationInProgress: jest.fn().mockResolvedValue(false),
      hasModifiedSubmodules: jest.fn().mockResolvedValue(false),
      getDefaultBranch: jest.fn().mockReturnValue("main"),
    } as any;

    (service as any).gitService = mockGitService;
  });

  describe("Update functionality enabled (default)", () => {
    it("should update worktrees that are behind", async () => {
      // Mock that feature branch is behind
      mockGitService.isWorktreeBehind.mockImplementation(async (path) => {
        return path.includes("feature");
      });

      await service.sync();

      // Should check all worktrees
      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledTimes(3);
      expect(mockGitService.isWorktreeBehind).toHaveBeenCalledTimes(3);

      // Should update only the feature branch
      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(1);
      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/feature");
    });

    it("should skip updating worktrees with local changes", async () => {
      // Mock that all branches are behind
      mockGitService.isWorktreeBehind.mockResolvedValue(true);

      // Mock that feature branch has local changes
      mockGitService.checkWorktreeStatus.mockImplementation(async (path) => {
        return !path.includes("feature"); // feature is not clean
      });

      await service.sync();

      // Should check all worktrees
      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledTimes(3);

      // Should only check if behind for clean worktrees
      expect(mockGitService.isWorktreeBehind).toHaveBeenCalledTimes(2);

      // Should update only the clean worktrees that are behind
      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(2);
      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/main");
      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/develop");
      expect(mockGitService.updateWorktree).not.toHaveBeenCalledWith("/test/worktrees/feature");
    });

    it("should handle update failures gracefully", async () => {
      // Mock that all branches are behind
      mockGitService.isWorktreeBehind.mockResolvedValue(true);

      // Mock update failure for feature branch
      mockGitService.updateWorktree.mockImplementation(async (path) => {
        if (path.includes("feature")) {
          throw new Error("Fast-forward merge failed");
        }
      });

      await service.sync();

      // Should attempt to update all worktrees
      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(3);

      // Service should not throw even if one update fails
      expect(mockGitService.pruneWorktrees).toHaveBeenCalled();
    });

    it("should handle errors when checking worktree status", async () => {
      // Mock error when checking feature branch
      mockGitService.checkWorktreeStatus.mockImplementation(async (path) => {
        if (path.includes("feature")) {
          throw new Error("Git status failed");
        }
        return true;
      });

      mockGitService.isWorktreeBehind.mockResolvedValue(true);

      await service.sync();

      // Should only update worktrees that could be checked
      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(2);
      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/main");
      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/develop");
    });
  });

  describe("Update functionality disabled", () => {
    beforeEach(() => {
      mockConfig.updateExistingWorktrees = false;
      service = new WorktreeSyncService(mockConfig);
      (service as any).gitService = mockGitService;
    });

    it("should not update any worktrees when disabled", async () => {
      // Mock that all branches are behind
      mockGitService.isWorktreeBehind.mockResolvedValue(true);

      await service.sync();

      // Should not check or update any worktrees
      expect(mockGitService.checkWorktreeStatus).not.toHaveBeenCalled();
      expect(mockGitService.isWorktreeBehind).not.toHaveBeenCalled();
      expect(mockGitService.updateWorktree).not.toHaveBeenCalled();
    });
  });

  describe("No worktrees need updating", () => {
    it("should log that all worktrees are up to date", async () => {
      const consoleSpy = jest.spyOn(console, "log");

      // All worktrees are up to date (not behind)
      mockGitService.isWorktreeBehind.mockResolvedValue(false);

      await service.sync();

      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledTimes(3);
      expect(mockGitService.isWorktreeBehind).toHaveBeenCalledTimes(3);
      expect(mockGitService.updateWorktree).not.toHaveBeenCalled();

      expect(consoleSpy).toHaveBeenCalledWith("  - All worktrees are up to date.");
    });
  });
});

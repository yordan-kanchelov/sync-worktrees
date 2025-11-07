import * as fs from "fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { WorktreeSyncService } from "../worktree-sync.service";

import type { Config } from "../../types";
import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { Mock, Mocked } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");

describe("WorktreeSyncService - Update Existing Worktrees", () => {
  let service: WorktreeSyncService;
  let mockConfig: Config;
  let mockGitService: Mocked<GitService>;
  let mockLogger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();

    mockLogger = createMockLogger();

    mockConfig = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/test/worktrees",
      cronSchedule: "0 * * * *",
      runOnce: true,
      updateExistingWorktrees: true,
      logger: mockLogger,
    };

    service = new WorktreeSyncService(mockConfig);

    // Mock GitService methods
    mockGitService = {
      initialize: vi.fn().mockResolvedValue(undefined),
      fetchAll: vi.fn().mockResolvedValue(undefined),
      getRemoteBranches: vi.fn().mockResolvedValue(["main", "feature", "develop"]),
      getRemoteBranchesWithActivity: vi.fn().mockResolvedValue([
        { branch: "main", lastActivity: new Date() },
        { branch: "feature", lastActivity: new Date() },
        { branch: "develop", lastActivity: new Date() },
      ]),
      getWorktrees: vi.fn().mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature", branch: "feature" },
        { path: "/test/worktrees/develop", branch: "develop" },
      ]),
      checkWorktreeStatus: vi.fn().mockResolvedValue(true), // All clean by default
      isWorktreeBehind: vi.fn().mockResolvedValue(false), // Not behind by default
      canFastForward: vi.fn().mockResolvedValue(true), // Can fast-forward by default
      updateWorktree: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      pruneWorktrees: vi.fn().mockResolvedValue(undefined),
      hasUnpushedCommits: vi.fn().mockResolvedValue(false),
      hasStashedChanges: vi.fn().mockResolvedValue(false),
      hasOperationInProgress: vi.fn().mockResolvedValue(false),
      hasModifiedSubmodules: vi.fn().mockResolvedValue(false),
      getDefaultBranch: vi.fn().mockReturnValue("main"),
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

    it("should skip updating worktrees with an operation in progress", async () => {
      // feature has an operation in progress
      mockGitService.hasOperationInProgress.mockImplementation(async (p) => p.includes("feature"));
      mockGitService.isWorktreeBehind.mockResolvedValue(true);

      await service.sync();

      // Should not call update on feature
      expect(mockGitService.updateWorktree).not.toHaveBeenCalledWith("/test/worktrees/feature");
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

  describe("Default branch retention with branchMaxAge", () => {
    it("should not prune default branch even if filtered by age", async () => {
      // Recreate service with branchMaxAge configured
      mockConfig.branchMaxAge = "1d";
      service = new WorktreeSyncService(mockConfig);
      (service as any).gitService = mockGitService;

      // Simulate that age filtering removed all but (intentionally) not returning main
      (mockGitService.getRemoteBranches as Mock).mockResolvedValue(["feature", "develop"]);

      // Pretend worktreeDir contains main only
      (fs.readdir as Mock<any>).mockResolvedValue(["main"]);

      await service.sync();

      // Ensure we did not try to remove the main worktree
      expect(mockGitService.removeWorktree).not.toHaveBeenCalledWith("/test/worktrees/main");
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
      mockGitService.isWorktreeBehind.mockResolvedValue(false);

      await service.sync();

      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledTimes(3);
      expect(mockGitService.isWorktreeBehind).toHaveBeenCalledTimes(3);
      expect(mockGitService.updateWorktree).not.toHaveBeenCalled();

      expect(mockLogger.info).toHaveBeenCalledWith("  - All worktrees are up to date.");
    });
  });
});

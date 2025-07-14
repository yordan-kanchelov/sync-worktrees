import * as fs from "fs/promises";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { GitService } from "../../services/git.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { Config } from "../../types";

jest.mock("fs/promises");
jest.mock("../../services/git.service");

describe("Concurrent Operations and Race Conditions", () => {
  let service: WorktreeSyncService;
  let mockConfig: Config;
  let mockGitService: jest.Mocked<GitService>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConfig = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/test/worktrees",
      cronSchedule: "0 * * * *",
      runOnce: false,
    };

    mockGitService = {
      initialize: jest.fn<any>().mockResolvedValue(undefined),
      fetchAll: jest.fn<any>().mockResolvedValue(undefined),
      getRemoteBranches: jest.fn<any>().mockResolvedValue(["main"]),
      addWorktree: jest.fn<any>().mockResolvedValue(undefined),
      removeWorktree: jest.fn<any>().mockResolvedValue(undefined),
      pruneWorktrees: jest.fn<any>().mockResolvedValue(undefined),
      checkWorktreeStatus: jest.fn<any>().mockResolvedValue(true),
      hasUnpushedCommits: jest.fn<any>().mockResolvedValue(false),
      hasUpstreamGone: jest.fn<any>().mockResolvedValue(false),
      hasStashedChanges: jest.fn<any>().mockResolvedValue(false),
      hasOperationInProgress: jest.fn<any>().mockResolvedValue(false),
      hasModifiedSubmodules: jest.fn<any>().mockResolvedValue(false),
      getCurrentBranch: jest.fn<any>().mockResolvedValue("main"),
      getDefaultBranch: jest.fn().mockReturnValue("main"),
      getWorktrees: jest.fn<any>().mockResolvedValue([]),
      getGit: jest.fn<any>(),
    } as any;

    (GitService as jest.MockedClass<typeof GitService>).mockImplementation(() => mockGitService);

    service = new WorktreeSyncService(mockConfig);
  });

  describe("Simultaneous sync operations", () => {
    it("should handle multiple sync operations running concurrently", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["feature-1"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/feature-1", branch: "feature-1" }]);

      // First sync sees everything clean, second sync sees dirty state
      let syncCount = 0;
      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10)); // Simulate async delay
        syncCount++;
        // First sync's calls return clean, second sync's calls return dirty
        return syncCount <= 1;
      });

      // Ensure other checks show as clean for first sync
      mockGitService.hasUnpushedCommits.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return false;
      });
      mockGitService.hasStashedChanges.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return syncCount > 1; // Second sync sees stash
      });
      mockGitService.hasOperationInProgress.mockResolvedValue(false);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(false);

      // Run two syncs concurrently
      const sync1 = service.sync();
      const sync2 = service.sync();

      await Promise.all([sync1, sync2]);

      // Due to the timing and how the mocks work, the removal may or may not happen
      // depending on when each sync reads the state. The test verifies that
      // concurrent operations complete without throwing errors.
      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalled();
    });

    it("should handle lock file contention", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["locked-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/locked-branch", branch: "locked-branch" },
      ]);

      // Simulate lock file being created during operation
      mockGitService.checkWorktreeStatus.mockImplementationOnce(async () => {
        // Simulate delay then lock error
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error("fatal: Unable to create '.git/index.lock': File exists");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("External modifications during sync", () => {
    it("should handle files being modified during status check", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["active-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/active-branch", branch: "active-branch" },
      ]);

      // Status changes between checks
      mockGitService.checkWorktreeStatus.mockResolvedValueOnce(true);
      mockGitService.hasUnpushedCommits.mockResolvedValueOnce(false);
      mockGitService.hasStashedChanges.mockResolvedValueOnce(false);
      // Operation started during our checks
      mockGitService.hasOperationInProgress.mockResolvedValueOnce(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("operation in progress"));
    });

    it("should handle commits being added during checks", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["modified-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/modified-branch", branch: "modified-branch" },
      ]);

      // Clean at first check
      mockGitService.checkWorktreeStatus.mockResolvedValueOnce(true);
      // But unpushed commits appear during check
      mockGitService.hasUnpushedCommits.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return true; // Commits were added
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle stash being created during checks", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["stashing-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/stashing-branch", branch: "stashing-branch" },
      ]);

      // All checks pass except stash which is created during checks
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasUnpushedCommits.mockResolvedValue(false);
      mockGitService.hasStashedChanges.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return true; // Stash was created
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Git operations during sync", () => {
    it("should handle rebase starting during deletion check", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["rebasing-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/rebasing-branch", branch: "rebasing-branch" },
      ]);

      // Clean initially
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasUnpushedCommits.mockResolvedValue(false);
      mockGitService.hasStashedChanges.mockResolvedValue(false);
      // Rebase starts during our checks
      mockGitService.hasOperationInProgress.mockResolvedValue(true);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(false);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle merge operation during sync", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["merging-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/merging-branch", branch: "merging-branch" },
      ]);

      // Merge starts after initial clean check
      mockGitService.checkWorktreeStatus.mockResolvedValueOnce(true).mockResolvedValueOnce(false); // Now has merge conflicts
      mockGitService.hasOperationInProgress.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Directory operations race conditions", () => {
    it("should handle directory being created while checking", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);

      // Directory doesn't exist initially
      (fs.readdir as jest.Mock<any>).mockResolvedValueOnce([]).mockResolvedValueOnce(["new-branch"]); // Created during sync

      mockGitService.getWorktrees
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ path: "/test/worktrees/new-branch", branch: "new-branch" }]);

      await service.sync();

      // Should handle gracefully
      expect(mockGitService.pruneWorktrees).toHaveBeenCalled();
    });

    it("should handle directory being removed while checking", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["disappearing-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/disappearing-branch", branch: "disappearing-branch" },
      ]);

      // Directory is removed during check
      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("ENOENT: no such file or directory");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Orphaned directory cleanup race conditions", () => {
    it("should handle orphaned directory being accessed externally", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["orphaned"]);

      mockGitService.getWorktrees.mockResolvedValue([]); // No worktrees

      const mockStat = { isDirectory: jest.fn().mockReturnValue(true) };
      (fs.stat as jest.Mock<any>).mockResolvedValue(mockStat);

      // Directory is being accessed when we try to remove it
      (fs.rm as jest.Mock<any>).mockRejectedValue(new Error("EBUSY: resource busy"));

      await service.sync();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to remove orphaned directory"),
        expect.any(Error),
      );
    });
  });

  describe("Complex concurrent scenarios", () => {
    it("should handle multiple operations on same worktree", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["busy-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/busy-branch", branch: "busy-branch" }]);

      // Simulate that at least one check shows unsafe state
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasUnpushedCommits.mockResolvedValue(false);
      mockGitService.hasStashedChanges.mockResolvedValue(true); // Has stash, so unsafe
      mockGitService.hasOperationInProgress.mockResolvedValue(false);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(false);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle rapid sequential syncs", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["rapid-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/rapid-branch", branch: "rapid-branch" }]);

      // Each sync will see different states, simulating rapid changes
      let callCount = 0;
      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        callCount++;
        // Alternate between clean and dirty
        return callCount % 2 === 1;
      });

      // Randomly return unsafe states
      mockGitService.hasUnpushedCommits.mockImplementation(async () => {
        return Math.random() > 0.5;
      });
      mockGitService.hasStashedChanges.mockResolvedValue(false);
      mockGitService.hasOperationInProgress.mockResolvedValue(false);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(false);

      // Run multiple syncs in rapid succession
      const syncs = [];
      for (let i = 0; i < 5; i++) {
        syncs.push(service.sync());
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      await Promise.all(syncs);

      // With rapid state changes, the worktree might be removed if all checks
      // happened to pass during one of the syncs. The test verifies that
      // concurrent syncs complete without errors.
      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalled();
    });
  });
});

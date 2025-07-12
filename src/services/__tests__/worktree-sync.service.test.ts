import * as fs from "fs/promises";
import * as path from "path";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { TEST_BRANCHES } from "../../__tests__/test-utils";
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
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/test/worktrees",
      cronSchedule: "0 * * * *",
      runOnce: false,
    };

    // Create mock GitService
    mockGitService = {
      initialize: jest.fn<any>().mockResolvedValue(undefined),
      fetchAll: jest.fn<any>().mockResolvedValue(undefined),
      fetchBranch: jest.fn<any>().mockResolvedValue(undefined),
      getRemoteBranches: jest.fn<any>().mockResolvedValue(["main", "feature-1", "feature-2"]),
      addWorktree: jest.fn<any>().mockResolvedValue(undefined),
      removeWorktree: jest.fn<any>().mockResolvedValue(undefined),
      pruneWorktrees: jest.fn<any>().mockResolvedValue(undefined),
      checkWorktreeStatus: jest.fn<any>().mockResolvedValue(true),
      hasUnpushedCommits: jest.fn<any>().mockResolvedValue(false),
      hasStashedChanges: jest.fn<any>().mockResolvedValue(false),
      hasOperationInProgress: jest.fn<any>().mockResolvedValue(false),
      hasModifiedSubmodules: jest.fn<any>().mockResolvedValue(false),
      getCurrentBranch: jest.fn<any>().mockResolvedValue("main"),
      getDefaultBranch: jest.fn().mockReturnValue("main"),
      getWorktrees: jest.fn<any>().mockResolvedValue([]),
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
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["feature-1", "old-branch"]);

      // Mock actual Git worktrees
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/feature-1", branch: "feature-1" },
        { path: "/test/worktrees/old-branch", branch: "old-branch" },
      ]);

      await service.sync();

      // Verify workflow steps
      expect(mockGitService.fetchAll).toHaveBeenCalled();
      expect(mockGitService.getRemoteBranches).toHaveBeenCalled();
      expect(mockGitService.getDefaultBranch).toHaveBeenCalled();
      expect(fs.mkdir).toHaveBeenCalledWith("/test/worktrees", { recursive: true });
      expect(mockGitService.getWorktrees).toHaveBeenCalled();

      // Should create new worktree for feature-2 (but not main, as it's the current branch)
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature-2", path.join("/test/worktrees", "feature-2"));
      expect(mockGitService.addWorktree).not.toHaveBeenCalledWith("main", path.join("/test/worktrees", "main"));

      // Should check and remove old-branch
      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledWith(path.join("/test/worktrees", "old-branch"));
      expect(mockGitService.hasUnpushedCommits).toHaveBeenCalledWith(path.join("/test/worktrees", "old-branch"));
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "old-branch"));

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
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["dirty-branch"]);
      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/dirty-branch", branch: "dirty-branch" }]);
      mockGitService.checkWorktreeStatus.mockResolvedValue(false); // Has local changes

      await service.sync();

      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledWith(path.join("/test/worktrees", "dirty-branch"));
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should skip worktrees with unpushed commits", async () => {
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["unpushed-branch"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/unpushed-branch", branch: "unpushed-branch" },
      ]);
      mockGitService.checkWorktreeStatus.mockResolvedValue(true); // Clean
      mockGitService.hasUnpushedCommits.mockResolvedValue(true); // Has unpushed commits

      await service.sync();

      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledWith(path.join("/test/worktrees", "unpushed-branch"));
      expect(mockGitService.hasUnpushedCommits).toHaveBeenCalledWith(path.join("/test/worktrees", "unpushed-branch"));
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should skip worktrees with both local changes and unpushed commits", async () => {
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["dirty-unpushed-branch"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/dirty-unpushed-branch", branch: "dirty-unpushed-branch" },
      ]);
      mockGitService.checkWorktreeStatus.mockResolvedValue(false); // Has local changes
      mockGitService.hasUnpushedCommits.mockResolvedValue(true); // Has unpushed commits

      await service.sync();

      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledWith(
        path.join("/test/worktrees", "dirty-unpushed-branch"),
      );
      expect(mockGitService.hasUnpushedCommits).toHaveBeenCalledWith(
        path.join("/test/worktrees", "dirty-unpushed-branch"),
      );
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle errors during sync but still cleanup", async () => {
      const error = new Error("Fetch failed");
      mockGitService.fetchAll.mockRejectedValue(error);

      await expect(service.sync()).rejects.toThrow("Fetch failed");

      // The error gets wrapped because retry exhausts all attempts (even though it's only 1 attempt for non-retryable errors)
      expect(console.error).toHaveBeenCalledWith(
        "\n❌ Error during worktree synchronization after all retry attempts:",
        error,
      );
    });

    it("should handle errors when checking worktree status", async () => {
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["broken-branch"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/broken-branch", branch: "broken-branch" },
      ]);
      mockGitService.checkWorktreeStatus.mockRejectedValue(new Error("Status check failed"));

      await service.sync();

      // Should log error but continue
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Error checking worktree"), expect.any(Error));
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(mockGitService.pruneWorktrees).toHaveBeenCalled();
    });

    it("should create multiple new worktrees", async () => {
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-1", "feature-2", "feature-3"]);
      (fs.readdir as jest.Mock<any>).mockResolvedValue([]);

      await service.sync();

      // Should skip main (current branch) and create the other 3
      expect(mockGitService.addWorktree).toHaveBeenCalledTimes(3);
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature-1", path.join("/test/worktrees", "feature-1"));
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature-2", path.join("/test/worktrees", "feature-2"));
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature-3", path.join("/test/worktrees", "feature-3"));
      expect(mockGitService.addWorktree).not.toHaveBeenCalledWith("main", path.join("/test/worktrees", "main"));
    });

    it("should remove multiple stale worktrees", async () => {
      mockGitService.getRemoteBranches.mockResolvedValue(["main"]);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["old-1", "old-2", "old-3"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/old-1", branch: "old-1" },
        { path: "/test/worktrees/old-2", branch: "old-2" },
        { path: "/test/worktrees/old-3", branch: "old-3" },
      ]);
      mockGitService.checkWorktreeStatus.mockResolvedValue(true); // All clean

      await service.sync();

      expect(mockGitService.removeWorktree).toHaveBeenCalledTimes(3);
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "old-1"));
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "old-2"));
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "old-3"));
    });

    it("should only remove worktrees that are clean with no unpushed commits", async () => {
      mockGitService.getRemoteBranches.mockResolvedValue(["main"]);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["deleted-clean", "deleted-dirty", "deleted-unpushed"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/deleted-clean", branch: "deleted-clean" },
        { path: "/test/worktrees/deleted-dirty", branch: "deleted-dirty" },
        { path: "/test/worktrees/deleted-unpushed", branch: "deleted-unpushed" },
      ]);

      // Set up different conditions for each worktree
      mockGitService.checkWorktreeStatus
        .mockResolvedValueOnce(true) // deleted-clean: clean
        .mockResolvedValueOnce(false) // deleted-dirty: has uncommitted changes
        .mockResolvedValueOnce(true); // deleted-unpushed: clean

      mockGitService.hasUnpushedCommits
        .mockResolvedValueOnce(false) // deleted-clean: no unpushed commits
        .mockResolvedValueOnce(false) // deleted-dirty: no unpushed commits (but won't be checked due to uncommitted changes)
        .mockResolvedValueOnce(true); // deleted-unpushed: has unpushed commits

      await service.sync();

      // Should only remove the worktree that is both clean AND has no unpushed commits
      expect(mockGitService.removeWorktree).toHaveBeenCalledTimes(1);
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "deleted-clean"));
      expect(mockGitService.removeWorktree).not.toHaveBeenCalledWith(path.join("/test/worktrees", "deleted-dirty"));
      expect(mockGitService.removeWorktree).not.toHaveBeenCalledWith(path.join("/test/worktrees", "deleted-unpushed"));

      // Verify all safety checks were performed
      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledTimes(3);
      expect(mockGitService.hasUnpushedCommits).toHaveBeenCalledTimes(3); // Called for all worktrees
      expect(mockGitService.hasStashedChanges).toHaveBeenCalledTimes(3);
      expect(mockGitService.hasOperationInProgress).toHaveBeenCalledTimes(3);
      expect(mockGitService.hasModifiedSubmodules).toHaveBeenCalledTimes(3);
    });

    it("should clean up orphaned directories that are not Git worktrees", async () => {
      // Mock file system with directories that don't match Git worktrees
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["feature-1", "orphaned-dir", "another-orphan"]);

      // Mock Git worktrees - only feature-1 is a valid worktree
      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/feature-1", branch: "feature-1" }]);

      // Mock fs.stat to return directory info
      const mockStat = { isDirectory: jest.fn().mockReturnValue(true) };
      (fs.stat as jest.Mock<any>).mockResolvedValue(mockStat);

      // Mock fs.rm
      (fs.rm as jest.Mock<any>).mockResolvedValue(undefined);

      await service.sync();

      // Should remove orphaned directories
      expect(fs.rm).toHaveBeenCalledTimes(2);
      expect(fs.rm).toHaveBeenCalledWith(path.join("/test/worktrees", "orphaned-dir"), {
        recursive: true,
        force: true,
      });
      expect(fs.rm).toHaveBeenCalledWith(path.join("/test/worktrees", "another-orphan"), {
        recursive: true,
        force: true,
      });

      // Should not remove valid worktree directory
      expect(fs.rm).not.toHaveBeenCalledWith(path.join("/test/worktrees", "feature-1"), expect.any(Object));
    });

    it("should handle errors during orphaned directory cleanup gracefully", async () => {
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["feature-1", "orphaned-dir"]);
      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/feature-1", branch: "feature-1" }]);

      const mockStat = { isDirectory: jest.fn().mockReturnValue(true) };
      (fs.stat as jest.Mock<any>).mockResolvedValue(mockStat);

      // Mock fs.rm to throw an error
      (fs.rm as jest.Mock<any>).mockRejectedValue(new Error("Permission denied"));

      // Should not throw, just log the error
      await service.sync();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to remove orphaned directory"),
        expect.any(Error),
      );

      // Should continue with the rest of the sync
      expect(mockGitService.pruneWorktrees).toHaveBeenCalled();
    });

    it("should handle errors when reading worktree directory", async () => {
      // Mock fs.readdir to throw an error
      (fs.readdir as jest.Mock<any>).mockRejectedValue(new Error("Permission denied"));

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/feature-1", branch: "feature-1" }]);

      // Should not throw, just log the error
      await service.sync();

      expect(console.error).toHaveBeenCalledWith("Error during orphaned directory cleanup:", expect.any(Error));

      // Should continue with the rest of the sync
      expect(mockGitService.pruneWorktrees).toHaveBeenCalled();
    });

    describe("branches with slashes in names", () => {
      it("should handle feature branches with slashes correctly", async () => {
        const remoteBranchesWithSlashes = [TEST_BRANCHES.main, "feat/LCR-8879", "feat/PHX-3198", TEST_BRANCHES.bugfix];
        mockGitService.getRemoteBranches.mockResolvedValue(remoteBranchesWithSlashes);
        mockGitService.getCurrentBranch.mockResolvedValue(TEST_BRANCHES.main);

        // First sync - create worktrees
        (fs.readdir as jest.Mock<any>).mockResolvedValue([]);
        mockGitService.getWorktrees.mockResolvedValue([]);

        await service.sync();

        // Should create worktrees with full paths including slashes
        expect(mockGitService.addWorktree).toHaveBeenCalledWith(
          "feat/LCR-8879",
          path.join("/test/worktrees", "feat/LCR-8879"),
        );
        expect(mockGitService.addWorktree).toHaveBeenCalledWith(
          "feat/PHX-3198",
          path.join("/test/worktrees", "feat/PHX-3198"),
        );
        expect(mockGitService.addWorktree).toHaveBeenCalledWith(
          "bugfix/issue-123",
          path.join("/test/worktrees", "bugfix/issue-123"),
        );
      });

      it("should not treat parent directories of slash branches as orphaned", async () => {
        mockGitService.getRemoteBranches.mockResolvedValue(["main", "feat/LCR-8879", "feat/PHX-3198"]);
        mockGitService.getCurrentBranch.mockResolvedValue("main");

        // Mock file system showing nested structure
        (fs.readdir as jest.Mock<any>).mockResolvedValue(["feat"]); // Parent directory

        // Mock Git worktrees with nested paths
        mockGitService.getWorktrees.mockResolvedValue([
          { path: "/test/worktrees/feat/LCR-8879", branch: "feat/LCR-8879" },
          { path: "/test/worktrees/feat/PHX-3198", branch: "feat/PHX-3198" },
        ]);

        // Mock fs.stat to identify 'feat' as a directory
        const mockStat = { isDirectory: jest.fn().mockReturnValue(true) };
        (fs.stat as jest.Mock<any>).mockResolvedValue(mockStat);
        (fs.rm as jest.Mock<any>).mockResolvedValue(undefined);

        await service.sync();

        // Should NOT remove the 'feat' directory as it contains valid worktrees
        expect(fs.rm).not.toHaveBeenCalled();
        expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Removed orphaned directory: feat"));
      });

      it("should remove slash-named worktrees correctly when branch is deleted", async () => {
        mockGitService.getRemoteBranches.mockResolvedValue(["main"]); // feat branches deleted from remote
        mockGitService.getCurrentBranch.mockResolvedValue("main");

        (fs.readdir as jest.Mock<any>).mockResolvedValue(["feat"]);
        mockGitService.getWorktrees.mockResolvedValue([
          { path: "/test/worktrees/feat/LCR-8879", branch: "feat/LCR-8879" },
          { path: "/test/worktrees/feat/PHX-3198", branch: "feat/PHX-3198" },
        ]);

        mockGitService.checkWorktreeStatus.mockResolvedValue(true); // All clean
        mockGitService.hasUnpushedCommits.mockResolvedValue(false); // No unpushed

        await service.sync();

        // Should remove both worktrees with their full paths
        expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "feat/LCR-8879"));
        expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "feat/PHX-3198"));
      });

      it("should handle mixed flat and nested worktree structures", async () => {
        mockGitService.getRemoteBranches.mockResolvedValue(["main", "simple-branch", "feat/nested-branch"]);
        mockGitService.getCurrentBranch.mockResolvedValue("main");

        // Mock mixed directory structure
        (fs.readdir as jest.Mock<any>).mockResolvedValue(["simple-branch", "feat", "orphaned-dir"]);

        mockGitService.getWorktrees.mockResolvedValue([
          { path: "/test/worktrees/simple-branch", branch: "simple-branch" },
          { path: "/test/worktrees/feat/nested-branch", branch: "feat/nested-branch" },
        ]);

        const mockStat = { isDirectory: jest.fn().mockReturnValue(true) };
        (fs.stat as jest.Mock<any>).mockResolvedValue(mockStat);
        (fs.rm as jest.Mock<any>).mockResolvedValue(undefined);

        await service.sync();

        // Should only remove truly orphaned directory
        expect(fs.rm).toHaveBeenCalledTimes(1);
        expect(fs.rm).toHaveBeenCalledWith(path.join("/test/worktrees", "orphaned-dir"), {
          recursive: true,
          force: true,
        });
        expect(fs.rm).not.toHaveBeenCalledWith(path.join("/test/worktrees", "feat"), expect.any(Object));
      });
    });

    describe("LFS error handling", () => {
      it("should set GIT_LFS_SKIP_SMUDGE when falling back to branch-by-branch fetch", async () => {
        // Mock fetchAll to fail with LFS error
        mockGitService.fetchAll = jest.fn<any>().mockRejectedValue(new Error("smudge filter lfs failed"));

        let lfsSkipDuringFetch: string | undefined;
        mockGitService.fetchBranch = jest.fn<any>().mockImplementation(() => {
          // Capture the env var value during the fetch call
          lfsSkipDuringFetch = process.env.GIT_LFS_SKIP_SMUDGE;
          return Promise.resolve(undefined);
        });

        // Store original env value
        const originalLfsSkip = process.env.GIT_LFS_SKIP_SMUDGE;

        try {
          // Ensure env var is not set initially
          delete process.env.GIT_LFS_SKIP_SMUDGE;

          await service.sync();

          // Verify that fetchBranch was called
          expect(mockGitService.fetchBranch).toHaveBeenCalled();

          // Verify that GIT_LFS_SKIP_SMUDGE was set during branch-by-branch fetch
          expect(lfsSkipDuringFetch).toBe("1");
        } finally {
          // Restore original env value
          if (originalLfsSkip !== undefined) {
            process.env.GIT_LFS_SKIP_SMUDGE = originalLfsSkip;
          } else {
            delete process.env.GIT_LFS_SKIP_SMUDGE;
          }
        }
      });

      it("should not retry LFS branch-by-branch if skipLfs is already configured", async () => {
        // Configure to skip LFS from the start
        mockConfig.skipLfs = true;
        service = new WorktreeSyncService(mockConfig);
        service["gitService"] = mockGitService;

        // Mock fetchAll to fail with LFS error
        mockGitService.fetchAll = jest.fn<any>().mockRejectedValue(new Error("smudge filter lfs failed"));

        await expect(service.sync()).rejects.toThrow("LFS error retry limit exceeded");

        // Should not attempt branch-by-branch fetch when skipLfs is true
        expect(mockGitService.fetchBranch).not.toHaveBeenCalled();
      });
    });
  });
});

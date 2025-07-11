import * as fs from "fs/promises";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { GitService } from "../../services/git.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { Config } from "../../types";

jest.mock("fs/promises");
jest.mock("../../services/git.service");

describe("File System Edge Cases", () => {
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

  describe("Permission errors", () => {
    it("should not delete worktree with read-only files", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["readonly-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/readonly-branch", branch: "readonly-branch" },
      ]);

      // Simulate permission error when checking status
      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("EACCES: permission denied");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Error checking worktree"), expect.any(Error));
    });

    it("should handle locked files in worktree", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["locked-files"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/locked-files", branch: "locked-files" }]);

      // Git operations fail due to locked files
      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: Unable to create '.git/index.lock': File exists");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle worktree on read-only filesystem", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["readonly-fs"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/readonly-fs", branch: "readonly-fs" }]);

      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("EROFS: read-only file system");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Symbolic links", () => {
    it("should handle worktree containing symbolic links", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["symlink-branch"]);

      // Mock fs.stat for symlink detection
      const mockStat = {
        isDirectory: jest.fn().mockReturnValue(true),
        isSymbolicLink: jest.fn().mockReturnValue(true),
      };
      (fs.stat as jest.Mock<any>).mockResolvedValue(mockStat);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/symlink-branch", branch: "symlink-branch" },
      ]);

      // Worktree is clean but contains symlinks
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);

      await service.sync();

      // Should be able to remove if all checks pass
      expect(mockGitService.removeWorktree).toHaveBeenCalled();
    });

    it("should handle broken symbolic links", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["broken-symlinks"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/broken-symlinks", branch: "broken-symlinks" },
      ]);

      // Status check might fail due to broken symlinks
      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("ENOENT: no such file or directory");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle worktree that is itself a symlink", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["symlinked-worktree"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/actual/path/symlinked-worktree", branch: "symlinked-worktree" },
      ]);

      // Symlinked worktree might have path resolution issues
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);

      await service.sync();

      // Should handle symlinked worktrees properly
      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalled();
    });
  });

  describe("Case sensitivity", () => {
    it("should handle branch names differing only in case", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["Feature-1", "feature-1"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/Feature-1", branch: "Feature-1" },
        { path: "/test/worktrees/feature-1", branch: "feature-1" },
      ]);

      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-1"]);

      await service.sync();

      // Should handle case-sensitive branches correctly
      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledWith("/test/worktrees/Feature-1");
    });

    it("should handle case-insensitive filesystem issues", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["BRANCH-name"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/branch-name", branch: "branch-name" }]);

      // Filesystem returns different case than Git
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);

      await service.sync();

      // Should handle case differences gracefully
      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalled();
    });
  });

  describe("Large files and timeouts", () => {
    it("should handle timeout when checking large repository", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["large-repo"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/large-repo", branch: "large-repo" }]);

      // Simulate timeout
      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("Command failed: timeout");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle worktree with very large files", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["large-files"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/large-files", branch: "large-files" }]);

      // Operations might be slow but should complete
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasUnpushedCommits.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(false), 100)),
      );

      await service.sync();

      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalled();
      expect(mockGitService.hasUnpushedCommits).toHaveBeenCalled();
    });
  });

  describe("Special file types", () => {
    it("should handle worktree with named pipes", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["fifo-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/fifo-branch", branch: "fifo-branch" }]);

      // Named pipes might cause issues with Git operations
      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: pathspec 'fifo' did not match any files");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle worktree with device files", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["device-files"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/device-files", branch: "device-files" }]);

      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: not a regular file");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Filesystem limits", () => {
    it("should handle very long file paths", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);

      const longBranchName = "feature/" + "a".repeat(200);
      (fs.readdir as jest.Mock<any>).mockResolvedValue([longBranchName]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: `/test/worktrees/${longBranchName}`, branch: longBranchName },
      ]);

      // Long paths might cause issues
      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("ENAMETOOLONG: name too long");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle filesystem running out of space", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["no-space"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/no-space", branch: "no-space" }]);

      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("ENOSPC: no space left on device");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });
});

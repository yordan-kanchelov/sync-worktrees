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

  describe("Permission errors", () => {
    it("should not delete worktree with read-only files", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["readonly-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/readonly-branch", branch: "readonly-branch" },
      ]);

      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("EACCES: permission denied");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Error checking worktree"), expect.any(Error));
    });
  });

  describe("Symbolic links", () => {
    it("should handle broken symbolic links", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["broken-symlinks"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/broken-symlinks", branch: "broken-symlinks" },
      ]);

      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("ENOENT: no such file or directory");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Large files and timeouts", () => {
    it("should handle timeout when checking large repository", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["large-repo"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/large-repo", branch: "large-repo" }]);

      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("Command failed: timeout");
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

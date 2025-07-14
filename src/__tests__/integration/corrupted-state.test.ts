import * as fs from "fs/promises";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { GitService } from "../../services/git.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { Config } from "../../types";

jest.mock("fs/promises");
jest.mock("../../services/git.service");

describe("Corrupted State Recovery", () => {
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

  describe("Corrupted .git metadata", () => {
    it("should not delete worktree with corrupted HEAD file", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["corrupted-head"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/corrupted-head", branch: "corrupted-head" },
      ]);

      // Corrupted HEAD causes Git operations to fail
      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: bad object HEAD");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Error checking worktree"), expect.any(Error));
    });

    it("should handle missing .git directory", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["missing-git"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/missing-git", branch: "missing-git" }]);

      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: not a git repository");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle corrupted index file", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["corrupted-index"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/corrupted-index", branch: "corrupted-index" },
      ]);

      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: index file corrupt");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle corrupted objects database", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["corrupted-objects"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/corrupted-objects", branch: "corrupted-objects" },
      ]);

      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: loose object is corrupt");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Incomplete worktree operations", () => {
    it("should handle worktree with incomplete add operation", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["incomplete-add"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/incomplete-add", branch: "incomplete-add" },
      ]);

      // Incomplete worktree might not have proper Git setup
      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: core.worktree is not set");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle worktree locked during previous operation", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["locked-worktree"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/locked-worktree", branch: "locked-worktree" },
      ]);

      // Locked worktree file prevents operations
      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: worktree is locked");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle orphaned worktree lock files", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["orphaned-lock"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/orphaned-lock", branch: "orphaned-lock" },
      ]);

      // Lock file exists but process is gone
      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: Unable to create '.git/index.lock': File exists");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Recovery from network issues", () => {
    it("should handle partial fetch state", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["partial-fetch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/partial-fetch", branch: "partial-fetch" },
      ]);

      // Partial fetch might leave repository in inconsistent state
      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: bad object refs/remotes/origin/partial-fetch");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle interrupted clone operations", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["interrupted-clone"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/interrupted-clone", branch: "interrupted-clone" },
      ]);

      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: the remote end hung up unexpectedly");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Filesystem corruption", () => {
    it("should handle filesystem errors during checks", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["fs-error"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/fs-error", branch: "fs-error" }]);

      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("EIO: i/o error");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle cross-device link errors", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["cross-device"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/cross-device", branch: "cross-device" }]);

      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("EXDEV: cross-device link not permitted");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Worktree metadata corruption", () => {
    it("should handle corrupted worktree config", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["bad-config"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/bad-config", branch: "bad-config" }]);

      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: bad config line in file .git/config");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle missing worktree gitdir file", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["missing-gitdir"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/missing-gitdir", branch: "missing-gitdir" },
      ]);

      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: not a git repository: '.git'");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Complex corruption scenarios", () => {
    it("should handle multiple corruption indicators", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["multi-corrupt"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/multi-corrupt", branch: "multi-corrupt" },
      ]);

      // Multiple checks fail due to corruption
      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: bad object HEAD");
      });
      mockGitService.hasUnpushedCommits.mockImplementation(async () => {
        throw new Error("fatal: your current branch does not have any commits yet");
      });
      mockGitService.hasOperationInProgress.mockResolvedValue(true); // Lock files exist

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should recover from sync errors and continue", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["corrupt1", "corrupt2", "good"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/corrupt1", branch: "corrupt1" },
        { path: "/test/worktrees/corrupt2", branch: "corrupt2" },
        { path: "/test/worktrees/good", branch: "good" },
      ]);

      // First two are corrupted, last one is good but should be removed
      mockGitService.checkWorktreeStatus
        .mockImplementationOnce(async () => {
          throw new Error("fatal: bad object");
        })
        .mockImplementationOnce(async () => {
          throw new Error("fatal: index corrupt");
        })
        .mockResolvedValueOnce(true);

      mockGitService.hasUnpushedCommits.mockResolvedValue(false);
      mockGitService.hasStashedChanges.mockResolvedValue(false);
      mockGitService.hasOperationInProgress.mockResolvedValue(false);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(false);

      await service.sync();

      // Should not remove corrupted ones
      expect(mockGitService.removeWorktree).not.toHaveBeenCalledWith("/test/worktrees/corrupt1");
      expect(mockGitService.removeWorktree).not.toHaveBeenCalledWith("/test/worktrees/corrupt2");
      // Should remove the good one that's no longer needed
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith("/test/worktrees/good");
    });
  });
});

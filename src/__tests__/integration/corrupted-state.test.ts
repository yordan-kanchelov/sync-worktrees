import * as fs from "fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { GitService } from "../../services/git.service";
import type { Config } from "../../types";
import type { Mock, Mocked } from "vitest";

vi.mock("fs/promises");

const { mockGitServiceInstance } = vi.hoisted(() => {
  return {
    mockGitServiceInstance: {
      initialize: vi.fn<any>().mockResolvedValue(undefined),
      fetchAll: vi.fn<any>().mockResolvedValue(undefined),
      getRemoteBranches: vi.fn<any>().mockResolvedValue(["main"]),
      addWorktree: vi.fn<any>().mockResolvedValue(undefined),
      removeWorktree: vi.fn<any>().mockResolvedValue(undefined),
      pruneWorktrees: vi.fn<any>().mockResolvedValue(undefined),
      checkWorktreeStatus: vi.fn<any>().mockResolvedValue(true),
      hasUnpushedCommits: vi.fn<any>().mockResolvedValue(false),
      hasUpstreamGone: vi.fn<any>().mockResolvedValue(false),
      hasStashedChanges: vi.fn<any>().mockResolvedValue(false),
      hasOperationInProgress: vi.fn<any>().mockResolvedValue(false),
      hasModifiedSubmodules: vi.fn<any>().mockResolvedValue(false),
      getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        canRemove: true,
        reasons: [],
      }),
      getCurrentBranch: vi.fn<any>().mockResolvedValue("main"),
      getDefaultBranch: vi.fn().mockReturnValue("main"),
      getWorktrees: vi.fn<any>().mockResolvedValue([]),
      getGit: vi.fn<any>(),
    } as any,
  };
});

vi.mock("../../services/git.service", () => ({
  GitService: vi.fn(function (this: any) {
    return mockGitServiceInstance;
  }),
}));

describe("Corrupted State Recovery", () => {
  let service: WorktreeSyncService;
  let mockConfig: Config;
  let mockGitService: Mocked<GitService>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/test/worktrees",
      cronSchedule: "0 * * * *",
      runOnce: false,
    };

    mockGitService = mockGitServiceInstance;

    service = new WorktreeSyncService(mockConfig);
  });

  describe("Corrupted .git metadata", () => {
    it("should not delete worktree with corrupted HEAD file", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["corrupted-head"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/corrupted-head", branch: "corrupted-head" },
      ]);

      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: bad object HEAD");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Error checking worktree"), expect.any(Error));
    });

    it("should handle missing .git directory", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["missing-git"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/missing-git", branch: "missing-git" }]);

      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: not a git repository");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle corrupted index file", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["corrupted-index"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/corrupted-index", branch: "corrupted-index" },
      ]);

      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: index file corrupt");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle corrupted objects database", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["corrupted-objects"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/corrupted-objects", branch: "corrupted-objects" },
      ]);

      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: loose object is corrupt");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Incomplete worktree operations", () => {
    it("should handle worktree with incomplete add operation", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["incomplete-add"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/incomplete-add", branch: "incomplete-add" },
      ]);

      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: core.worktree is not set");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle worktree locked during previous operation", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["locked-worktree"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/locked-worktree", branch: "locked-worktree" },
      ]);

      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: worktree is locked");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle orphaned worktree lock files", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["orphaned-lock"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/orphaned-lock", branch: "orphaned-lock" },
      ]);

      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: Unable to create '.git/index.lock': File exists");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Recovery from network issues", () => {
    it("should handle partial fetch state", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["partial-fetch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/partial-fetch", branch: "partial-fetch" },
      ]);

      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: bad object refs/remotes/origin/partial-fetch");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle interrupted clone operations", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["interrupted-clone"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/interrupted-clone", branch: "interrupted-clone" },
      ]);

      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: the remote end hung up unexpectedly");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Filesystem corruption", () => {
    it("should handle filesystem errors during checks", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["fs-error"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/fs-error", branch: "fs-error" }]);

      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        throw new Error("EIO: i/o error");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle cross-device link errors", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["cross-device"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/cross-device", branch: "cross-device" }]);

      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        throw new Error("EXDEV: cross-device link not permitted");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Worktree metadata corruption", () => {
    it("should handle corrupted worktree config", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["bad-config"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/bad-config", branch: "bad-config" }]);

      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: bad config line in file .git/config");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle missing worktree gitdir file", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["missing-gitdir"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/missing-gitdir", branch: "missing-gitdir" },
      ]);

      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: not a git repository: '.git'");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Complex corruption scenarios", () => {
    it("should handle multiple corruption indicators", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["multi-corrupt"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/multi-corrupt", branch: "multi-corrupt" },
      ]);

      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: bad object HEAD");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should recover from sync errors and continue", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["corrupt1", "corrupt2", "good"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/corrupt1", branch: "corrupt1" },
        { path: "/test/worktrees/corrupt2", branch: "corrupt2" },
        { path: "/test/worktrees/good", branch: "good" },
      ]);

      mockGitService.getFullWorktreeStatus
        .mockImplementationOnce(async () => {
          throw new Error("fatal: bad object");
        })
        .mockImplementationOnce(async () => {
          throw new Error("fatal: index corrupt");
        })
        .mockResolvedValueOnce({
          isClean: true,
          hasUnpushedCommits: false,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: true,
          reasons: [],
        });

      await service.sync();

      // Should not remove corrupted ones
      expect(mockGitService.removeWorktree).not.toHaveBeenCalledWith("/test/worktrees/corrupt1");
      expect(mockGitService.removeWorktree).not.toHaveBeenCalledWith("/test/worktrees/corrupt2");
      // Should remove the good one that's no longer needed
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith("/test/worktrees/good");
    });
  });
});

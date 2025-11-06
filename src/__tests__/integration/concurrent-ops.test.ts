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

describe("Concurrent Operations and Race Conditions", () => {
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

  describe("Simultaneous sync operations", () => {
    it("should handle multiple sync operations running concurrently", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["feature-1"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/feature-1", branch: "feature-1" }]);

      let syncCount = 0;
      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        syncCount++;
        if (syncCount <= 1) {
          return {
            isClean: true,
            hasUnpushedCommits: false,
            hasStashedChanges: false,
            hasOperationInProgress: false,
            hasModifiedSubmodules: false,
            upstreamGone: false,
            canRemove: true,
            reasons: [],
          };
        } else {
          return {
            isClean: false,
            hasUnpushedCommits: false,
            hasStashedChanges: true,
            hasOperationInProgress: false,
            hasModifiedSubmodules: false,
            upstreamGone: false,
            canRemove: false,
            reasons: ["uncommitted changes", "stashed changes"],
          };
        }
      });

      const sync1 = service.sync();
      const sync2 = service.sync();

      await Promise.all([sync1, sync2]);

      expect(mockGitService.getFullWorktreeStatus).toHaveBeenCalled();
    });

    it("should handle lock file contention", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["locked-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/locked-branch", branch: "locked-branch" },
      ]);

      mockGitService.getFullWorktreeStatus.mockImplementationOnce(async () => {
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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["active-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/active-branch", branch: "active-branch" },
      ]);

      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: true,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        canRemove: false,
        reasons: ["operation in progress"],
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("operation in progress"));
    });

    it("should handle commits being added during checks", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["modified-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/modified-branch", branch: "modified-branch" },
      ]);

      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          isClean: true,
          hasUnpushedCommits: true,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: false,
          reasons: ["unpushed commits"],
        };
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle stash being created during checks", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["stashing-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/stashing-branch", branch: "stashing-branch" },
      ]);

      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          isClean: true,
          hasUnpushedCommits: false,
          hasStashedChanges: true,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: false,
          reasons: ["stashed changes"],
        };
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Git operations during sync", () => {
    it("should handle rebase starting during deletion check", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["rebasing-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/rebasing-branch", branch: "rebasing-branch" },
      ]);

      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: true,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        canRemove: false,
        reasons: ["operation in progress"],
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle merge operation during sync", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["merging-branch"]);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);

      // Directory doesn't exist initially
      (fs.readdir as Mock<any>).mockResolvedValueOnce([]).mockResolvedValueOnce(["new-branch"]); // Created during sync

      mockGitService.getWorktrees
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ path: "/test/worktrees/new-branch", branch: "new-branch" }]);

      await service.sync();

      // Should handle gracefully
      expect(mockGitService.pruneWorktrees).toHaveBeenCalled();
    });

    it("should handle directory being removed while checking", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["disappearing-branch"]);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["orphaned"]);

      mockGitService.getWorktrees.mockResolvedValue([]); // No worktrees

      const mockStat = { isDirectory: vi.fn().mockReturnValue(true) };
      (fs.stat as Mock<any>).mockResolvedValue(mockStat);

      // Directory is being accessed when we try to remove it
      (fs.rm as Mock<any>).mockRejectedValue(new Error("EBUSY: resource busy"));

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["busy-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/busy-branch", branch: "busy-branch" }]);

      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: true,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        canRemove: false,
        reasons: ["stashed changes"],
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle rapid sequential syncs", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["rapid-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/rapid-branch", branch: "rapid-branch" }]);

      let callCount = 0;
      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        callCount++;
        const isClean = callCount % 2 === 1;
        const hasUnpushedCommits = Math.random() > 0.5;
        return {
          isClean,
          hasUnpushedCommits,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: isClean && !hasUnpushedCommits,
          reasons: !isClean ? ["uncommitted changes"] : hasUnpushedCommits ? ["unpushed commits"] : [],
        };
      });

      const syncs = [];
      for (let i = 0; i < 5; i++) {
        syncs.push(service.sync());
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      await Promise.all(syncs);

      expect(mockGitService.getFullWorktreeStatus).toHaveBeenCalled();
    });
  });
});

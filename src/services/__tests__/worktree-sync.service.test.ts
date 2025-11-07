import * as fs from "fs/promises";
import * as path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { TEST_BRANCHES, createMockLogger } from "../../__tests__/test-utils";
import { WorktreeSyncService } from "../worktree-sync.service";

import type { Config } from "../../types";
import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { Mock, Mocked } from "vitest";

// Use vi.hoisted to create mock instance that can be accessed in both factory and tests
const { mockGitServiceInstance } = vi.hoisted(() => {
  return {
    mockGitServiceInstance: {
      initialize: vi.fn<any>().mockResolvedValue(undefined),
      fetchAll: vi.fn<any>().mockResolvedValue(undefined),
      fetchBranch: vi.fn<any>().mockResolvedValue(undefined),
      getRemoteBranches: vi.fn<any>().mockResolvedValue(["main", "feature-1", "feature-2"]),
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
      isWorktreeBehind: vi.fn<any>().mockResolvedValue(false),
      canFastForward: vi.fn<any>().mockResolvedValue(true),
      updateWorktree: vi.fn<any>().mockResolvedValue(undefined),
      getGit: vi.fn<any>(),
    } as any,
  };
});

// Mock modules
vi.mock("fs/promises");
vi.mock("../git.service", () => ({
  GitService: vi.fn(function (this: any) {
    return mockGitServiceInstance;
  }),
}));

describe("WorktreeSyncService", () => {
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
      runOnce: false,
      logger: mockLogger,
    };

    // Reference the hoisted mock instance
    mockGitService = mockGitServiceInstance;

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

      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);

      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return [];
      });

      mockGitService.fetchAll.mockResolvedValue(undefined);
      mockGitService.getWorktrees.mockResolvedValue([]);
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-1", "feature-2"]);
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasUnpushedCommits.mockResolvedValue(false);
      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        canRemove: true,
        reasons: [],
      });
    });

    it("should complete full sync workflow successfully", async () => {
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["feature-1", "old-branch"];
      });

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
      expect(mockGitService.getFullWorktreeStatus).toHaveBeenCalledWith(
        path.join("/test/worktrees", "old-branch"),
        undefined,
      );
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "old-branch"));

      // Should prune at the end
      expect(mockGitService.pruneWorktrees).toHaveBeenCalled();
    });

    it("should handle empty remote branches", async () => {
      mockGitService.getRemoteBranches.mockResolvedValue([]);
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return [];
      });

      await service.sync();

      expect(mockGitService.addWorktree).not.toHaveBeenCalled();
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(mockGitService.pruneWorktrees).toHaveBeenCalled();
    });

    it("should skip worktrees with local changes", async () => {
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["dirty-branch"];
      });
      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/dirty-branch", branch: "dirty-branch" }]);
      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: false,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        canRemove: false,
        reasons: ["uncommitted changes"],
      });

      await service.sync();

      expect(mockGitService.getFullWorktreeStatus).toHaveBeenCalledWith(
        path.join("/test/worktrees", "dirty-branch"),
        undefined,
      );
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should skip worktrees with unpushed commits", async () => {
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["unpushed-branch"];
      });
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/unpushed-branch", branch: "unpushed-branch" },
      ]);
      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: true,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        canRemove: false,
        reasons: ["unpushed commits"],
      });

      await service.sync();

      expect(mockGitService.getFullWorktreeStatus).toHaveBeenCalledWith(
        path.join("/test/worktrees", "unpushed-branch"),
        undefined,
      );
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should show special message for worktrees with deleted upstream", async () => {
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["deleted-upstream-branch"];
      });
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/deleted-upstream-branch", branch: "deleted-upstream-branch" },
      ]);
      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: true,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: true,
        canRemove: false,
        reasons: ["unpushed commits"],
      });

      await service.sync();

      expect(mockGitService.getFullWorktreeStatus).toHaveBeenCalledWith(
        path.join("/test/worktrees", "deleted-upstream-branch"),
        undefined,
      );
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Cannot automatically remove 'deleted-upstream-branch' - upstream branch was deleted"),
      );
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Please review manually: cd"));
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("git worktree remove"));
    });

    it("should skip worktrees with both local changes and unpushed commits", async () => {
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["dirty-unpushed-branch"];
      });
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/dirty-unpushed-branch", branch: "dirty-unpushed-branch" },
      ]);
      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: false,
        hasUnpushedCommits: true,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        canRemove: false,
        reasons: ["uncommitted changes", "unpushed commits"],
      });

      await service.sync();

      expect(mockGitService.getFullWorktreeStatus).toHaveBeenCalledWith(
        path.join("/test/worktrees", "dirty-unpushed-branch"),
        undefined,
      );
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle errors during sync but still cleanup", async () => {
      const error = new Error("Fetch failed");
      mockGitService.fetchAll.mockRejectedValue(error);

      await expect(service.sync()).rejects.toThrow("Fetch failed");

      expect(mockLogger.error).toHaveBeenCalledWith(
        "\n❌ Error during worktree synchronization after all retry attempts:",
        error,
      );
    });

    it("should handle errors when checking worktree status", async () => {
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["broken-branch"];
      });
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/broken-branch", branch: "broken-branch" },
      ]);
      mockGitService.getFullWorktreeStatus.mockRejectedValue(new Error("Status check failed"));

      await service.sync();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Error checking worktree"),
        expect.any(Error),
      );
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(mockGitService.pruneWorktrees).toHaveBeenCalled();
    });

    it("should create multiple new worktrees", async () => {
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-1", "feature-2", "feature-3"]);
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return [];
      });

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
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["old-1", "old-2", "old-3"];
      });
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/old-1", branch: "old-1" },
        { path: "/test/worktrees/old-2", branch: "old-2" },
        { path: "/test/worktrees/old-3", branch: "old-3" },
      ]);

      await service.sync();

      expect(mockGitService.removeWorktree).toHaveBeenCalledTimes(3);
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "old-1"));
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "old-2"));
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "old-3"));
    });

    it("should only remove worktrees that are clean with no unpushed commits", async () => {
      mockGitService.getRemoteBranches.mockResolvedValue(["main"]);
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["deleted-clean", "deleted-dirty", "deleted-unpushed"];
      });
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/deleted-clean", branch: "deleted-clean" },
        { path: "/test/worktrees/deleted-dirty", branch: "deleted-dirty" },
        { path: "/test/worktrees/deleted-unpushed", branch: "deleted-unpushed" },
      ]);

      // Set up different conditions for each worktree
      mockGitService.getFullWorktreeStatus
        .mockResolvedValueOnce({
          isClean: true,
          hasUnpushedCommits: false,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: true,
          reasons: [],
        }) // deleted-clean: can remove
        .mockResolvedValueOnce({
          isClean: false,
          hasUnpushedCommits: false,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: false,
          reasons: ["uncommitted changes"],
        }) // deleted-dirty: has uncommitted changes
        .mockResolvedValueOnce({
          isClean: true,
          hasUnpushedCommits: true,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: false,
          reasons: ["unpushed commits"],
        }); // deleted-unpushed: has unpushed commits

      await service.sync();

      // Should only remove the worktree that is both clean AND has no unpushed commits
      expect(mockGitService.removeWorktree).toHaveBeenCalledTimes(1);
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "deleted-clean"));
      expect(mockGitService.removeWorktree).not.toHaveBeenCalledWith(path.join("/test/worktrees", "deleted-dirty"));
      expect(mockGitService.removeWorktree).not.toHaveBeenCalledWith(path.join("/test/worktrees", "deleted-unpushed"));

      // Verify all safety checks were performed via getFullWorktreeStatus
      expect(mockGitService.getFullWorktreeStatus).toHaveBeenCalledTimes(3);
    });

    it("should clean up orphaned directories that are not Git worktrees", async () => {
      // Mock file system with directories that don't match Git worktrees
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["feature-1", "orphaned-dir", "another-orphan"];
      });

      // Mock Git worktrees - only feature-1 is a valid worktree
      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/feature-1", branch: "feature-1" }]);

      // Mock fs.stat to return directory info
      const mockStat = { isDirectory: vi.fn().mockReturnValue(true) };
      (fs.stat as Mock<any>).mockResolvedValue(mockStat);

      // Mock fs.rm
      (fs.rm as Mock<any>).mockResolvedValue(undefined);

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
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["feature-1", "orphaned-dir"];
      });
      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/feature-1", branch: "feature-1" }]);

      const mockStat = { isDirectory: vi.fn().mockReturnValue(true) };
      (fs.stat as Mock<any>).mockResolvedValue(mockStat);

      // Mock fs.rm to throw an error
      (fs.rm as Mock<any>).mockRejectedValue(new Error("Permission denied"));

      await service.sync();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to remove orphaned directory"),
        expect.any(Error),
      );

      expect(mockGitService.pruneWorktrees).toHaveBeenCalled();
    });

    it("should handle errors when reading worktree directory", async () => {
      // Mock fs.readdir to throw an error
      (fs.readdir as Mock<any>).mockRejectedValue(new Error("Permission denied"));

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/feature-1", branch: "feature-1" }]);

      await service.sync();

      expect(mockLogger.error).toHaveBeenCalledWith("Error during orphaned directory cleanup:", expect.any(Error));

      expect(mockGitService.pruneWorktrees).toHaveBeenCalled();
    });

    describe("branches with slashes in names", () => {
      it("should handle feature branches with slashes correctly", async () => {
        const remoteBranchesWithSlashes = [TEST_BRANCHES.main, "feat/LCR-8879", "feat/PHX-3198", TEST_BRANCHES.bugfix];
        mockGitService.getRemoteBranches.mockResolvedValue(remoteBranchesWithSlashes);
        mockGitService.getCurrentBranch.mockResolvedValue(TEST_BRANCHES.main);

        // First sync - create worktrees
        (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
          if ((dirPath as string).endsWith(".diverged")) {
            const error: any = new Error("ENOENT: no such file or directory");
            error.code = "ENOENT";
            throw error;
          }
          return [];
        });
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
        (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
          if ((dirPath as string).endsWith(".diverged")) {
            const error: any = new Error("ENOENT: no such file or directory");
            error.code = "ENOENT";
            throw error;
          }
          return ["feat"]; // Parent directory
        });

        // Mock Git worktrees with nested paths
        mockGitService.getWorktrees.mockResolvedValue([
          { path: "/test/worktrees/feat/LCR-8879", branch: "feat/LCR-8879" },
          { path: "/test/worktrees/feat/PHX-3198", branch: "feat/PHX-3198" },
        ]);

        // Mock fs.stat to identify 'feat' as a directory
        const mockStat = { isDirectory: vi.fn().mockReturnValue(true) };
        (fs.stat as Mock<any>).mockResolvedValue(mockStat);
        (fs.rm as Mock<any>).mockResolvedValue(undefined);

        await service.sync();

        expect(fs.rm).not.toHaveBeenCalled();
        expect(mockLogger.info).not.toHaveBeenCalledWith(expect.stringContaining("Removed orphaned directory: feat"));
      });

      it("should remove slash-named worktrees correctly when branch is deleted", async () => {
        mockGitService.getRemoteBranches.mockResolvedValue(["main"]); // feat branches deleted from remote
        mockGitService.getCurrentBranch.mockResolvedValue("main");

        (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
          if ((dirPath as string).endsWith(".diverged")) {
            const error: any = new Error("ENOENT: no such file or directory");
            error.code = "ENOENT";
            throw error;
          }
          return ["feat"];
        });
        mockGitService.getWorktrees.mockResolvedValue([
          { path: "/test/worktrees/feat/LCR-8879", branch: "feat/LCR-8879" },
          { path: "/test/worktrees/feat/PHX-3198", branch: "feat/PHX-3198" },
        ]);

        await service.sync();

        // Should remove both worktrees with their full paths
        expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "feat/LCR-8879"));
        expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "feat/PHX-3198"));
      });

      it("should handle mixed flat and nested worktree structures", async () => {
        mockGitService.getRemoteBranches.mockResolvedValue(["main", "simple-branch", "feat/nested-branch"]);
        mockGitService.getCurrentBranch.mockResolvedValue("main");

        // Mock mixed directory structure
        (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
          if ((dirPath as string).endsWith(".diverged")) {
            const error: any = new Error("ENOENT: no such file or directory");
            error.code = "ENOENT";
            throw error;
          }
          return ["simple-branch", "feat", "orphaned-dir"];
        });

        mockGitService.getWorktrees.mockResolvedValue([
          { path: "/test/worktrees/simple-branch", branch: "simple-branch" },
          { path: "/test/worktrees/feat/nested-branch", branch: "feat/nested-branch" },
        ]);

        const mockStat = { isDirectory: vi.fn().mockReturnValue(true) };
        (fs.stat as Mock<any>).mockResolvedValue(mockStat);
        (fs.rm as Mock<any>).mockResolvedValue(undefined);

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
        mockGitService.fetchAll = vi.fn<any>().mockRejectedValue(new Error("smudge filter lfs failed")) as any;

        let lfsSkipDuringFetch: string | undefined;
        mockGitService.fetchBranch = vi.fn<any>().mockImplementation(() => {
          // Capture the env var value during the fetch call
          lfsSkipDuringFetch = process.env.GIT_LFS_SKIP_SMUDGE;
          return Promise.resolve(undefined);
        }) as any;

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
        mockGitService.fetchAll = vi.fn<any>().mockRejectedValue(new Error("smudge filter lfs failed")) as any;

        await expect(service.sync()).rejects.toThrow("LFS error retry limit exceeded");

        // Should not attempt branch-by-branch fetch when skipLfs is true
        expect(mockGitService.fetchBranch).not.toHaveBeenCalled();
      });
    });

    it("should not update worktrees when updateExistingWorktrees is disabled", async () => {
      // Disable update functionality
      mockConfig.updateExistingWorktrees = false;
      service = new WorktreeSyncService(mockConfig);

      // Mock worktrees that exist both locally and remotely
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-1"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature-1", branch: "feature-1" },
      ]);

      // These should not be called when updates are disabled
      mockGitService.isWorktreeBehind.mockResolvedValue(true);

      await service.sync();

      // Verify update checks were not performed
      expect(mockGitService.isWorktreeBehind).not.toHaveBeenCalled();
      expect(mockGitService.updateWorktree).not.toHaveBeenCalled();
    });

    it("should update worktrees that are behind when updateExistingWorktrees is enabled", async () => {
      // Mock worktrees that exist both locally and remotely
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-1", "feature-2"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature-1", branch: "feature-1" },
        { path: "/test/worktrees/feature-2", branch: "feature-2" },
      ]);

      // Mock fs.readdir to handle .diverged directory
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["main", "feature-1", "feature-2"];
      });

      // Mock different conditions
      mockGitService.hasOperationInProgress.mockResolvedValue(false); // No operations in progress

      mockGitService.checkWorktreeStatus
        .mockResolvedValueOnce(true) // main: clean
        .mockResolvedValueOnce(false) // feature-1: has local changes
        .mockResolvedValueOnce(true); // feature-2: clean

      mockGitService.canFastForward.mockResolvedValue(true); // All can fast-forward

      mockGitService.isWorktreeBehind
        .mockResolvedValueOnce(false) // main: up to date
        .mockResolvedValueOnce(true); // feature-2: behind

      await service.sync();

      // Should only check behind status for clean worktrees
      expect(mockGitService.isWorktreeBehind).toHaveBeenCalledTimes(2); // Only for clean worktrees

      // Should only update feature-2 (clean and behind)
      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(1);
      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/feature-2");
    });
  });

  describe("retry behavior", () => {
    let retryConfig: Config;
    let retrySyncService: WorktreeSyncService;
    let mockRetryLogger: Logger;

    beforeEach(async () => {
      mockRetryLogger = createMockLogger();

      retryConfig = {
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "/test/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
        logger: mockRetryLogger,
        retry: {
          maxAttempts: 3,
          initialDelayMs: 10,
          maxDelayMs: 50,
        },
      };

      retrySyncService = new WorktreeSyncService(retryConfig);
      await retrySyncService.initialize();
    });

    it("should retry entire sync operation on network errors", async () => {
      const networkError = new Error("Network connection failed");
      (networkError as any).code = "ECONNREFUSED";

      mockGitService.fetchAll.mockRejectedValueOnce(networkError).mockResolvedValueOnce(undefined);
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "develop"]);
      mockGitService.getWorktrees.mockResolvedValue([{ path: path.join("/test/worktrees", "main"), branch: "main" }]);
      mockGitService.getCurrentBranch.mockResolvedValue("main");
      mockGitService.pruneWorktrees.mockResolvedValue(undefined);

      await retrySyncService.sync();

      expect(mockGitService.fetchAll).toHaveBeenCalledTimes(2);
    });

    it("should retry on filesystem errors during sync", async () => {
      const fsError = new Error("Resource temporarily unavailable");
      (fsError as any).code = "EBUSY";

      mockGitService.fetchAll.mockResolvedValue(undefined);
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "develop"]);
      mockGitService.getWorktrees
        .mockRejectedValueOnce(fsError)
        .mockResolvedValue([{ path: path.join("/test/worktrees", "main"), branch: "main" }]);
      mockGitService.getCurrentBranch.mockResolvedValue("main");
      mockGitService.pruneWorktrees.mockResolvedValue(undefined);

      await retrySyncService.sync();

      expect(mockGitService.getWorktrees).toHaveBeenCalledTimes(2);
    });

    it("should respect maxAttempts configuration", async () => {
      const error = new Error("Persistent network error");
      (error as any).code = "ETIMEDOUT";

      mockGitService.fetchAll.mockRejectedValue(error);

      await expect(retrySyncService.sync()).rejects.toThrow("Persistent network error");

      expect(mockGitService.fetchAll).toHaveBeenCalledTimes(3);
    });

    it("should not retry on non-retryable errors", async () => {
      const authError = new Error("Authentication failed");
      mockGitService.fetchAll.mockRejectedValue(authError);

      await expect(retrySyncService.sync()).rejects.toThrow("Authentication failed");

      expect(mockGitService.fetchAll).toHaveBeenCalledTimes(1);
    });

    it("should retry indefinitely when configured", async () => {
      const unlimitedConfig: Config = {
        ...retryConfig,
        retry: {
          maxAttempts: "unlimited",
          initialDelayMs: 1,
          maxDelayMs: 5,
        },
      };

      const unlimitedSyncService = new WorktreeSyncService(unlimitedConfig);
      await unlimitedSyncService.initialize();

      let attempts = 0;
      mockGitService.fetchAll.mockImplementation(() => {
        attempts++;
        if (attempts < 5) {
          const error = new Error("Network error");
          (error as any).code = "ECONNREFUSED";
          return Promise.reject(error);
        }
        return Promise.resolve(undefined);
      });

      mockGitService.getRemoteBranches.mockResolvedValue(["main"]);
      mockGitService.getWorktrees.mockResolvedValue([]);
      mockGitService.getCurrentBranch.mockResolvedValue("main");
      mockGitService.pruneWorktrees.mockResolvedValue(undefined);

      await unlimitedSyncService.sync();

      expect(mockGitService.fetchAll).toHaveBeenCalledTimes(5);
    });

    it("should log retry attempts", async () => {
      const error = new Error("Network timeout");
      (error as any).code = "ETIMEDOUT";

      mockGitService.fetchAll
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(undefined);

      mockGitService.getRemoteBranches.mockResolvedValue(["main"]);
      mockGitService.getWorktrees.mockResolvedValue([]);
      mockGitService.getCurrentBranch.mockResolvedValue("main");
      mockGitService.pruneWorktrees.mockResolvedValue(undefined);

      await retrySyncService.sync();

      expect(mockRetryLogger.info).toHaveBeenCalledWith(expect.stringContaining("⚠️  Sync attempt 1 failed"));
      expect(mockRetryLogger.info).toHaveBeenCalledWith(expect.stringContaining("🔄 Retrying synchronization"));
      expect(mockRetryLogger.info).toHaveBeenCalledWith(expect.stringContaining("⚠️  Sync attempt 2 failed"));
    });

    it("should complete sync if only non-critical operations fail", async () => {
      mockGitService.fetchAll.mockResolvedValue(undefined);
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "develop"]);
      mockGitService.getWorktrees.mockResolvedValue([{ path: path.join("/test/worktrees", "main"), branch: "main" }]);
      mockGitService.getCurrentBranch.mockResolvedValue("main");

      const pruneError = new Error("Prune failed");
      (pruneError as any).code = "EBUSY";
      mockGitService.pruneWorktrees
        .mockRejectedValueOnce(pruneError)
        .mockRejectedValueOnce(pruneError)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue(undefined);

      await retrySyncService.sync();

      expect(mockGitService.fetchAll).toHaveBeenCalled();
      expect(mockGitService.getRemoteBranches).toHaveBeenCalled();
      expect(mockGitService.pruneWorktrees).toHaveBeenCalledTimes(4);
    });
  });
});

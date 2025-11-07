import * as fs from "fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { createMockLogger } from "../test-utils";

import type { GitService } from "../../services/git.service";
import type { Logger } from "../../services/logger.service";
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

describe("Git States Edge Cases", () => {
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

    mockGitService = mockGitServiceInstance;

    service = new WorktreeSyncService(mockConfig);
  });

  describe("Detached HEAD state", () => {
    it("should not delete worktree in detached HEAD state", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["feature-detached"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/feature-detached", branch: "feature-detached" },
      ]);

      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: ref HEAD is not a symbolic ref");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Error checking worktree"),
        expect.any(Error),
      );
    });

    it("should handle worktree with HEAD pointing to non-existent branch", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["deleted-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/deleted-branch", branch: "deleted-branch" },
      ]);

      mockGitService.getFullWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: bad revision 'deleted-branch'");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Merge conflict states", () => {
    beforeEach(() => {
      // Reset mocks to prevent pollution from previous tests
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasUnpushedCommits.mockResolvedValue(false);
      mockGitService.hasStashedChanges.mockResolvedValue(false);
      mockGitService.hasOperationInProgress.mockResolvedValue(false);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(false);
      mockGitService.hasUpstreamGone.mockResolvedValue(false);
    });

    it("should not delete worktree with merge conflicts", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["feature-conflicts"];
      });

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/feature-conflicts", branch: "feature-conflicts" },
      ]);

      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: false,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: true,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        canRemove: false,
        reasons: ["uncommitted changes", "operation in progress"],
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      const allLogs = (mockLogger.info as Mock).mock.calls.map((call) => call.join(" "));
      expect(allLogs.some((log) => /uncommitted changes|operation in progress/.test(log))).toBe(true);
    });

    it("should detect MERGE_HEAD file indicating merge in progress", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["merging-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/merging-branch", branch: "merging-branch" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(false);
      mockGitService.hasOperationInProgress.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Rebase in progress", () => {
    beforeEach(() => {
      // Reset mocks to prevent pollution from previous tests
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasUnpushedCommits.mockResolvedValue(false);
      mockGitService.hasStashedChanges.mockResolvedValue(false);
      mockGitService.hasOperationInProgress.mockResolvedValue(false);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(false);
      mockGitService.hasUpstreamGone.mockResolvedValue(false);
    });

    it("should not delete worktree during rebase", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["rebasing-branch"];
      });

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
      const allLogs = (mockLogger.info as Mock).mock.calls.map((call) => call.join(" "));
      expect(allLogs.some((log) => /operation in progress/.test(log))).toBe(true);
    });

    it("should handle interactive rebase state", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["interactive-rebase"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/interactive-rebase", branch: "interactive-rebase" },
      ]);

      mockGitService.hasOperationInProgress.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Cherry-pick in progress", () => {
    it("should not delete worktree during cherry-pick", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["cherry-picking"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/cherry-picking", branch: "cherry-picking" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(false); // Has changes
      mockGitService.hasOperationInProgress.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle cherry-pick conflicts", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["cherry-pick-conflicts"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/cherry-pick-conflicts", branch: "cherry-pick-conflicts" },
      ]);

      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: false,
        hasUnpushedCommits: true,
        hasStashedChanges: false,
        hasOperationInProgress: true,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        canRemove: false,
        reasons: ["uncommitted changes", "unpushed commits", "operation in progress"],
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("uncommitted changes, unpushed commits, operation in progress"),
      );
    });
  });

  describe("Bisect in progress", () => {
    it("should not delete worktree during bisect", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["bisecting-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/bisecting-branch", branch: "bisecting-branch" },
      ]);

      mockGitService.hasOperationInProgress.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Revert in progress", () => {
    it("should not delete worktree during revert", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["reverting-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/reverting-branch", branch: "reverting-branch" },
      ]);

      mockGitService.hasOperationInProgress.mockResolvedValue(true);
      mockGitService.checkWorktreeStatus.mockResolvedValue(false);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Complex Git states", () => {
    it("should handle worktree with staged but uncommitted changes", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["staged-changes"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/staged-changes", branch: "staged-changes" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(false); // Has staged changes

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle worktree with amended commits not pushed", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["amended-commits"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/amended-commits", branch: "amended-commits" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasUnpushedCommits.mockResolvedValue(true); // Amended commits not pushed

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle worktree with commits ahead and behind remote", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["diverged-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/diverged-branch", branch: "diverged-branch" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasUnpushedCommits.mockResolvedValue(true); // Has local commits

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });
});

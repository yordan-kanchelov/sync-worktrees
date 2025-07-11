import * as fs from "fs/promises";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { GitService } from "../../services/git.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { Config } from "../../types";

jest.mock("fs/promises");
jest.mock("../../services/git.service");

describe("Git States Edge Cases", () => {
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

  describe("Detached HEAD state", () => {
    it("should not delete worktree in detached HEAD state", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["feature-detached"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/feature-detached", branch: "feature-detached" },
      ]);

      // Simulate detached HEAD by throwing specific error
      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: ref HEAD is not a symbolic ref");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Error checking worktree"), expect.any(Error));
    });

    it("should handle worktree with HEAD pointing to non-existent branch", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["deleted-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/deleted-branch", branch: "deleted-branch" },
      ]);

      // Branch exists locally but not in remote
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasUnpushedCommits.mockImplementation(async () => {
        throw new Error("fatal: bad revision 'deleted-branch'");
      });

      await service.sync();

      // Should handle error gracefully and not delete
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Merge conflict states", () => {
    it("should not delete worktree with merge conflicts", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["feature-conflicts"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/feature-conflicts", branch: "feature-conflicts" },
      ]);

      // Has uncommitted changes due to conflicts
      mockGitService.checkWorktreeStatus.mockResolvedValue(false);
      mockGitService.hasOperationInProgress.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("uncommitted changes"));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("operation in progress"));
    });

    it("should detect MERGE_HEAD file indicating merge in progress", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["merging-branch"]);

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
    it("should not delete worktree during rebase", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["rebasing-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/rebasing-branch", branch: "rebasing-branch" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(true); // May appear clean
      mockGitService.hasOperationInProgress.mockResolvedValue(true); // But rebase in progress

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("operation in progress"));
    });

    it("should handle interactive rebase state", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["interactive-rebase"]);

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
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["cherry-picking"]);

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
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["cherry-pick-conflicts"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/cherry-pick-conflicts", branch: "cherry-pick-conflicts" },
      ]);

      // Multiple indicators of unsafe state
      mockGitService.checkWorktreeStatus.mockResolvedValue(false);
      mockGitService.hasOperationInProgress.mockResolvedValue(true);
      mockGitService.hasUnpushedCommits.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("uncommitted changes, unpushed commits, operation in progress"),
      );
    });
  });

  describe("Bisect in progress", () => {
    it("should not delete worktree during bisect", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["bisecting-branch"]);

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
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["reverting-branch"]);

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
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["staged-changes"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/staged-changes", branch: "staged-changes" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(false); // Has staged changes

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle worktree with amended commits not pushed", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["amended-commits"]);

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
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["diverged-branch"]);

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

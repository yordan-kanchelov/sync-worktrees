import * as fs from "fs/promises";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { GitService } from "../../services/git.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { Config } from "../../types";

jest.mock("fs/promises");
jest.mock("../../services/git.service");

describe("Complex Mixed State Scenarios", () => {
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
      getWorktrees: jest.fn<any>().mockResolvedValue([]),
      getGit: jest.fn<any>(),
    } as any;

    (GitService as jest.MockedClass<typeof GitService>).mockImplementation(() => mockGitService);

    service = new WorktreeSyncService(mockConfig);
  });

  describe("All unsafe conditions combined", () => {
    it("should not delete worktree with all types of changes", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["everything-dirty"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/everything-dirty", branch: "everything-dirty" },
      ]);

      // Everything is dirty/unsafe
      mockGitService.checkWorktreeStatus.mockResolvedValue(false); // Uncommitted changes
      mockGitService.hasUnpushedCommits.mockResolvedValue(true); // Unpushed commits
      mockGitService.hasStashedChanges.mockResolvedValue(true); // Stashed changes
      mockGitService.hasOperationInProgress.mockResolvedValue(true); // Operation in progress
      mockGitService.hasModifiedSubmodules.mockResolvedValue(true); // Modified submodules

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining(
          "uncommitted changes, unpushed commits, stashed changes, operation in progress, modified submodules",
        ),
      );
    });
  });

  describe("Partial commit states", () => {
    it("should handle staged but uncommitted changes with stash", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["staged-stash"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/staged-stash", branch: "staged-stash" }]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(false); // Staged changes
      mockGitService.hasStashedChanges.mockResolvedValue(true); // Also has stash

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle partially staged files with unpushed commits", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["partial-stage"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/partial-stage", branch: "partial-stage" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(false); // Partially staged
      mockGitService.hasUnpushedCommits.mockResolvedValue(true); // Unpushed commits

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Interrupted operations with multiple issues", () => {
    it("should handle interrupted merge with stash and unpushed", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["complex-merge"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/complex-merge", branch: "complex-merge" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(false); // Merge conflicts
      mockGitService.hasUnpushedCommits.mockResolvedValue(true); // Previous commits
      mockGitService.hasStashedChanges.mockResolvedValue(true); // Stashed work
      mockGitService.hasOperationInProgress.mockResolvedValue(true); // Merge in progress

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle interrupted rebase with dirty submodules", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["complex-rebase"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/complex-rebase", branch: "complex-rebase" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(false); // Rebase conflicts
      mockGitService.hasOperationInProgress.mockResolvedValue(true); // Rebase in progress
      mockGitService.hasModifiedSubmodules.mockResolvedValue(true); // Submodules dirty

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle cherry-pick with stash and submodule changes", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["complex-cherry"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/complex-cherry", branch: "complex-cherry" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(false); // Cherry-pick conflicts
      mockGitService.hasStashedChanges.mockResolvedValue(true); // Has stash
      mockGitService.hasOperationInProgress.mockResolvedValue(true); // Cherry-pick in progress
      mockGitService.hasModifiedSubmodules.mockResolvedValue(true); // Submodules modified

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Edge case combinations", () => {
    it("should handle detached HEAD with unpushed and stash", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["detached-complex"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/detached-complex", branch: "detached-complex" },
      ]);

      // Detached HEAD causes status check to fail
      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: ref HEAD is not a symbolic ref");
      });
      mockGitService.hasUnpushedCommits.mockResolvedValue(true);
      mockGitService.hasStashedChanges.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle corrupted state with ongoing operations", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["corrupt-complex"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/corrupt-complex", branch: "corrupt-complex" },
      ]);

      // Multiple failures due to corruption
      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("fatal: bad object HEAD");
      });
      mockGitService.hasOperationInProgress.mockResolvedValue(true); // Lock files exist
      mockGitService.hasStashedChanges.mockResolvedValue(true); // Assume unsafe

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Real-world complex scenarios", () => {
    it("should handle developer workflow with WIP changes", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["wip-feature"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/wip-feature", branch: "wip-feature" }]);

      // Typical WIP state: uncommitted changes, stash, unpushed commits
      mockGitService.checkWorktreeStatus.mockResolvedValue(false); // Working on changes
      mockGitService.hasUnpushedCommits.mockResolvedValue(true); // Local commits
      mockGitService.hasStashedChanges.mockResolvedValue(true); // Stashed experiments

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle hotfix branch with emergency changes", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["hotfix-urgent"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/hotfix-urgent", branch: "hotfix-urgent" },
      ]);

      // Hotfix in progress: changes, commits, possible conflicts
      mockGitService.checkWorktreeStatus.mockResolvedValue(false); // Active changes
      mockGitService.hasUnpushedCommits.mockResolvedValue(true); // Fix commits
      mockGitService.hasOperationInProgress.mockResolvedValue(true); // Merging upstream

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle long-running feature branch with all states", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["long-feature"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/long-feature", branch: "long-feature" }]);

      // Long-running branch accumulates various states
      mockGitService.checkWorktreeStatus.mockResolvedValue(false); // Current work
      mockGitService.hasUnpushedCommits.mockResolvedValue(true); // Many local commits
      mockGitService.hasStashedChanges.mockResolvedValue(true); // Multiple stashes
      mockGitService.hasModifiedSubmodules.mockResolvedValue(true); // Updated dependencies

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Performance under mixed conditions", () => {
    it("should handle large repo with multiple unsafe conditions", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["large-mixed"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/large-mixed", branch: "large-mixed" }]);

      // Simulate slow operations due to repo size
      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return false;
      });
      mockGitService.hasUnpushedCommits.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return true;
      });
      mockGitService.hasStashedChanges.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return true;
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Recovery and cleanup scenarios", () => {
    it("should process multiple worktrees with different mixed states", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["mixed1", "mixed2", "mixed3"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/mixed1", branch: "mixed1" },
        { path: "/test/worktrees/mixed2", branch: "mixed2" },
        { path: "/test/worktrees/mixed3", branch: "mixed3" },
      ]);

      // Different combinations for each worktree
      // mixed1: only uncommitted changes
      mockGitService.checkWorktreeStatus
        .mockResolvedValueOnce(false) // mixed1
        .mockResolvedValueOnce(true) // mixed2
        .mockResolvedValueOnce(true); // mixed3

      // mixed2: only unpushed commits
      mockGitService.hasUnpushedCommits
        .mockResolvedValueOnce(false) // mixed1
        .mockResolvedValueOnce(true) // mixed2
        .mockResolvedValueOnce(false); // mixed3

      // mixed3: only stashed changes
      mockGitService.hasStashedChanges
        .mockResolvedValueOnce(false) // mixed1
        .mockResolvedValueOnce(false) // mixed2
        .mockResolvedValueOnce(true); // mixed3

      mockGitService.hasOperationInProgress.mockResolvedValue(false);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(false);

      await service.sync();

      // None should be removed due to their various unsafe conditions
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("uncommitted changes"));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("unpushed commits"));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("stashed changes"));
    });
  });
});

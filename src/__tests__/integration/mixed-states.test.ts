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

describe("Complex Mixed State Scenarios", () => {
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

  describe("All unsafe conditions combined", () => {
    it("should not delete worktree with all types of changes", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["everything-dirty"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/everything-dirty", branch: "everything-dirty" },
      ]);

      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: false,
        hasUnpushedCommits: true,
        hasStashedChanges: true,
        hasOperationInProgress: true,
        hasModifiedSubmodules: true,
        upstreamGone: false,
        canRemove: false,
        reasons: [
          "uncommitted changes",
          "unpushed commits",
          "stashed changes",
          "operation in progress",
          "modified submodules",
        ],
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          "uncommitted changes, unpushed commits, stashed changes, operation in progress, modified submodules",
        ),
      );
    });
  });

  describe("Partial commit states", () => {
    it("should handle staged but uncommitted changes with stash", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["staged-stash"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/staged-stash", branch: "staged-stash" }]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(false); // Staged changes
      mockGitService.hasStashedChanges.mockResolvedValue(true); // Also has stash

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle partially staged files with unpushed commits", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["partial-stage"]);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["complex-merge"]);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["complex-rebase"]);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["complex-cherry"]);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["detached-complex"]);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["corrupt-complex"]);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["wip-feature"]);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["hotfix-urgent"]);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["long-feature"]);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["large-mixed"]);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["mixed1", "mixed2", "mixed3"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/mixed1", branch: "mixed1" },
        { path: "/test/worktrees/mixed2", branch: "mixed2" },
        { path: "/test/worktrees/mixed3", branch: "mixed3" },
      ]);

      // Different combinations for each worktree
      mockGitService.getFullWorktreeStatus
        .mockResolvedValueOnce({
          // mixed1: only uncommitted changes
          isClean: false,
          hasUnpushedCommits: false,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: false,
          reasons: ["uncommitted changes"],
        })
        .mockResolvedValueOnce({
          // mixed2: only unpushed commits
          isClean: true,
          hasUnpushedCommits: true,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: false,
          reasons: ["unpushed commits"],
        })
        .mockResolvedValueOnce({
          // mixed3: only stashed changes
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

      // None should be removed due to their various unsafe conditions
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("uncommitted changes"));
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("unpushed commits"));
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("stashed changes"));
    });
  });
});

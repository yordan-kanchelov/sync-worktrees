import * as fs from "fs/promises";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { GitService } from "../../services/git.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { Config } from "../../types";

jest.mock("fs/promises");
jest.mock("../../services/git.service");

describe("Stash Detection Edge Cases", () => {
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

  describe("Basic stash detection", () => {
    it("should not delete worktree with stashed changes", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["feature-with-stash"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/feature-with-stash", branch: "feature-with-stash" },
      ]);

      // Clean working directory but has stashed changes
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasStashedChanges.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("stashed changes"));
    });

    it("should not delete worktree with multiple stash entries", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["multi-stash"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/multi-stash", branch: "multi-stash" }]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasStashedChanges.mockResolvedValue(true); // Multiple stashes

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Stash with clean working directory", () => {
    it("should detect stash even when working directory is clean", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["clean-but-stashed"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/clean-but-stashed", branch: "clean-but-stashed" },
      ]);

      // All appear clean except stash
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasUnpushedCommits.mockResolvedValue(false);
      mockGitService.hasStashedChanges.mockResolvedValue(true);
      mockGitService.hasOperationInProgress.mockResolvedValue(false);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(false);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("stashed changes"));
    });
  });

  describe("Stash error handling", () => {
    it("should assume unsafe when stash check fails", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["stash-error"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/stash-error", branch: "stash-error" }]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      // Stash check throws error - should return true (unsafe)
      mockGitService.hasStashedChanges.mockImplementation(async () => {
        throw new Error("Failed to check stash");
      });

      await service.sync();

      // Should not delete due to error (treated as unsafe)
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle corrupted stash gracefully", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["corrupted-stash"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/corrupted-stash", branch: "corrupted-stash" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      // Simulate corrupted stash error
      mockGitService.hasStashedChanges.mockImplementation(async () => {
        throw new Error("fatal: bad revision 'stash@{0}'");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Combined stash scenarios", () => {
    it("should handle stash with uncommitted changes", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["stash-and-dirty"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/stash-and-dirty", branch: "stash-and-dirty" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(false); // Has uncommitted changes
      mockGitService.hasStashedChanges.mockResolvedValue(true); // Also has stash

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("uncommitted changes, stashed changes"));
    });

    it("should handle stash with unpushed commits", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["stash-and-unpushed"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/stash-and-unpushed", branch: "stash-and-unpushed" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasUnpushedCommits.mockResolvedValue(true);
      mockGitService.hasStashedChanges.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("unpushed commits, stashed changes"));
    });

    it("should handle stash during merge conflict", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["stash-merge-conflict"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/stash-merge-conflict", branch: "stash-merge-conflict" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(false);
      mockGitService.hasStashedChanges.mockResolvedValue(true);
      mockGitService.hasOperationInProgress.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("uncommitted changes, stashed changes, operation in progress"),
      );
    });
  });

  describe("Stash with branch-specific scenarios", () => {
    it("should preserve worktree with stash when branch deleted from remote", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["deleted-with-stash"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/deleted-with-stash", branch: "deleted-with-stash" },
      ]);

      // Branch deleted from remote but has stashed work
      mockGitService.getRemoteBranches.mockResolvedValue(["main"]); // deleted-with-stash not in remote
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasStashedChanges.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("stashed changes"));
    });

    it("should handle stash created from different branch", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["cross-branch-stash"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/cross-branch-stash", branch: "cross-branch-stash" },
      ]);

      // Stash exists but may have been created from different branch
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasStashedChanges.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });
});

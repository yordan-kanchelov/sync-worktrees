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

  describe("Basic stash detection", () => {
    it("should not delete worktree with stashed changes", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["feature-with-stash"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/feature-with-stash", branch: "feature-with-stash" },
      ]);

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
      mockGitService.hasStashedChanges.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Stash error handling", () => {
    it("should assume unsafe when stash check fails", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["stash-error"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/stash-error", branch: "stash-error" }]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasStashedChanges.mockImplementation(async () => {
        throw new Error("Failed to check stash");
      });

      await service.sync();

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

      mockGitService.checkWorktreeStatus.mockResolvedValue(false);
      mockGitService.hasStashedChanges.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("uncommitted changes, stashed changes"));
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

      mockGitService.getRemoteBranches.mockResolvedValue(["main"]);
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasStashedChanges.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("stashed changes"));
    });
  });
});

import * as fs from "fs/promises";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { GitService } from "../../services/git.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { Config } from "../../types";

jest.mock("fs/promises");
jest.mock("../../services/git.service");

describe("Submodule Edge Cases", () => {
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

  describe("Modified submodules", () => {
    it("should not delete worktree with modified submodules", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["feature-dirty-submodule"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/feature-dirty-submodule", branch: "feature-dirty-submodule" },
      ]);

      // Main worktree is clean but submodules are dirty
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("modified submodules"));
    });

    it("should detect submodules with uncommitted changes", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["submodule-changes"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/submodule-changes", branch: "submodule-changes" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(true); // + prefix in status

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should detect submodules with different commits", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["submodule-commits"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/submodule-commits", branch: "submodule-commits" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(true); // - prefix in status

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Uninitialized submodules", () => {
    it("should handle worktree with uninitialized submodules", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["uninit-submodules"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/uninit-submodules", branch: "uninit-submodules" },
      ]);

      // Uninitialized submodules might not show as modified
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(false);

      await service.sync();

      // Can be removed if all checks pass
      expect(mockGitService.removeWorktree).toHaveBeenCalled();
    });

    it("should handle partially initialized submodules", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["partial-submodules"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/partial-submodules", branch: "partial-submodules" },
      ]);

      // Some submodules initialized, some not
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Detached HEAD in submodules", () => {
    it("should not delete worktree with detached HEAD in submodule", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["submodule-detached"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/submodule-detached", branch: "submodule-detached" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(true); // Detached HEAD shows as modified

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Nested submodules", () => {
    it("should detect changes in nested submodules", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["nested-submodules"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/nested-submodules", branch: "nested-submodules" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(true); // Nested submodule changes

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Submodule conflicts", () => {
    it("should handle submodules with merge conflicts", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["submodule-conflicts"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/submodule-conflicts", branch: "submodule-conflicts" },
      ]);

      // Both main repo and submodules have issues
      mockGitService.checkWorktreeStatus.mockResolvedValue(false);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(true);
      mockGitService.hasOperationInProgress.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("uncommitted changes, operation in progress, modified submodules"),
      );
    });
  });

  describe("Submodule errors", () => {
    it("should handle missing .gitmodules file", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["missing-gitmodules"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/missing-gitmodules", branch: "missing-gitmodules" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      // No submodules file means no submodules
      mockGitService.hasModifiedSubmodules.mockResolvedValue(false);

      await service.sync();

      // Can be removed if no submodules
      expect(mockGitService.removeWorktree).toHaveBeenCalled();
    });

    it("should handle corrupted submodule metadata", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["corrupted-submodule"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/corrupted-submodule", branch: "corrupted-submodule" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasUnpushedCommits.mockResolvedValue(false);
      mockGitService.hasStashedChanges.mockResolvedValue(false);
      mockGitService.hasOperationInProgress.mockResolvedValue(false);
      // Corrupted submodule might cause check to fail - GitService returns false on error
      mockGitService.hasModifiedSubmodules.mockResolvedValue(false);

      await service.sync();

      // Should handle error gracefully - hasModifiedSubmodules returns false (no modifications)
      expect(mockGitService.removeWorktree).toHaveBeenCalled();
    });
  });

  describe("Submodule URL changes", () => {
    it("should detect submodules with changed URLs", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["submodule-url-change"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/submodule-url-change", branch: "submodule-url-change" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(true); // URL change shows as modification

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Combined submodule scenarios", () => {
    it("should handle submodules with stash and changes", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["submodule-complex"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/submodule-complex", branch: "submodule-complex" },
      ]);

      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasStashedChanges.mockResolvedValue(true);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("stashed changes, modified submodules"));
    });

    it("should handle main repo clean but submodules dirty", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue(["clean-main-dirty-sub"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/clean-main-dirty-sub", branch: "clean-main-dirty-sub" },
      ]);

      // Everything clean except submodules
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasUnpushedCommits.mockResolvedValue(false);
      mockGitService.hasStashedChanges.mockResolvedValue(false);
      mockGitService.hasOperationInProgress.mockResolvedValue(false);
      mockGitService.hasModifiedSubmodules.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("modified submodules"));
    });
  });
});

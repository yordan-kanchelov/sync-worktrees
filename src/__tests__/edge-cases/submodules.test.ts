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

describe("Submodule Edge Cases", () => {
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

  describe("Modified submodules", () => {
    it("should not delete worktree with modified submodules", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["feature-dirty-submodule"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/feature-dirty-submodule", branch: "feature-dirty-submodule" },
      ]);

      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: true,
        upstreamGone: false,
        canRemove: false,
        reasons: ["modified submodules"],
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("modified submodules"));
    });

    it("should detect submodules with uncommitted changes", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["submodule-changes"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/submodule-changes", branch: "submodule-changes" },
      ]);

      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: true,
        upstreamGone: false,
        canRemove: false,
        reasons: ["modified submodules"],
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should detect submodules with different commits", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["submodule-commits"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/submodule-commits", branch: "submodule-commits" },
      ]);

      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: true,
        upstreamGone: false,
        canRemove: false,
        reasons: ["modified submodules"],
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Uninitialized submodules", () => {
    it("should handle worktree with uninitialized submodules", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["uninit-submodules"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/uninit-submodules", branch: "uninit-submodules" },
      ]);

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

      await service.sync();

      expect(mockGitService.removeWorktree).toHaveBeenCalled();
    });

    it("should handle partially initialized submodules", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["partial-submodules"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/partial-submodules", branch: "partial-submodules" },
      ]);

      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: true,
        upstreamGone: false,
        canRemove: false,
        reasons: ["modified submodules"],
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Detached HEAD in submodules", () => {
    it("should not delete worktree with detached HEAD in submodule", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["submodule-detached"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/submodule-detached", branch: "submodule-detached" },
      ]);

      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: true,
        upstreamGone: false,
        canRemove: false,
        reasons: ["modified submodules"],
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Nested submodules", () => {
    it("should detect changes in nested submodules", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["nested-submodules"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/nested-submodules", branch: "nested-submodules" },
      ]);

      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: true,
        upstreamGone: false,
        canRemove: false,
        reasons: ["modified submodules"],
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Submodule conflicts", () => {
    it("should handle submodules with merge conflicts", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["submodule-conflicts"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/submodule-conflicts", branch: "submodule-conflicts" },
      ]);

      // Both main repo and submodules have issues
      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: false,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: true,
        upstreamGone: false,
        canRemove: false,
        reasons: ["uncommitted changes", "modified submodules"],
      });
      mockGitService.hasOperationInProgress.mockResolvedValue(true);

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("uncommitted changes, modified submodules"));
    });
  });

  describe("Submodule errors", () => {
    it("should handle missing .gitmodules file", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["missing-gitmodules"];
      });

      // Branch was deleted from remote
      mockGitService.getRemoteBranches.mockResolvedValue(["main"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/missing-gitmodules", branch: "missing-gitmodules" },
      ]);

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

      await service.sync();

      expect(mockGitService.removeWorktree).toHaveBeenCalled();
    });

    it("should handle corrupted submodule metadata", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["corrupted-submodule"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/corrupted-submodule", branch: "corrupted-submodule" },
      ]);

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

      await service.sync();

      expect(mockGitService.removeWorktree).toHaveBeenCalled();
    });
  });

  describe("Submodule URL changes", () => {
    it("should detect submodules with changed URLs", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["submodule-url-change"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/submodule-url-change", branch: "submodule-url-change" },
      ]);

      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: true,
        upstreamGone: false,
        canRemove: false,
        reasons: ["modified submodules"],
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Combined submodule scenarios", () => {
    it("should handle submodules with stash and changes", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["submodule-complex"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/submodule-complex", branch: "submodule-complex" },
      ]);

      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: true,
        hasOperationInProgress: false,
        hasModifiedSubmodules: true,
        upstreamGone: false,
        canRemove: false,
        reasons: ["stashed changes", "modified submodules"],
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("stashed changes, modified submodules"));
    });

    it("should handle main repo clean but submodules dirty", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["clean-main-dirty-sub"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/clean-main-dirty-sub", branch: "clean-main-dirty-sub" },
      ]);

      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: true,
        upstreamGone: false,
        canRemove: false,
        reasons: ["modified submodules"],
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("modified submodules"));
    });
  });
});

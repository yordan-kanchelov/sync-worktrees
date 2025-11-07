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

describe("File System Edge Cases", () => {
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

  describe("Permission errors", () => {
    it("should not delete worktree with read-only files", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["readonly-branch"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/readonly-branch", branch: "readonly-branch" },
      ]);

      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("EACCES: permission denied");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Error checking worktree"),
        expect.any(Error),
      );
    });
  });

  describe("Symbolic links", () => {
    it("should handle broken symbolic links", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["broken-symlinks"]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/broken-symlinks", branch: "broken-symlinks" },
      ]);

      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("ENOENT: no such file or directory");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Large files and timeouts", () => {
    it("should handle timeout when checking large repository", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["large-repo"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/large-repo", branch: "large-repo" }]);

      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("Command failed: timeout");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Filesystem limits", () => {
    it("should handle very long file paths", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);

      const longBranchName = "feature/" + "a".repeat(200);
      (fs.readdir as Mock<any>).mockResolvedValue([longBranchName]);

      mockGitService.getWorktrees.mockResolvedValue([
        { path: `/test/worktrees/${longBranchName}`, branch: longBranchName },
      ]);

      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("ENAMETOOLONG: name too long");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should handle filesystem running out of space", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue(["no-space"]);

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/no-space", branch: "no-space" }]);

      mockGitService.checkWorktreeStatus.mockImplementation(async () => {
        throw new Error("ENOSPC: no space left on device");
      });

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });
  });
});

import * as fs from "fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorktreeSyncService } from "../services/worktree-sync.service";

import { createMockLogger } from "./test-utils";

import type { GitService } from "../services/git.service";
import type { Logger } from "../services/logger.service";
import type { Config } from "../types";
import type { Mock, Mocked } from "vitest";

vi.mock("fs/promises");

const { mockGitServiceInstance } = vi.hoisted(() => {
  return {
    mockGitServiceInstance: {
      initialize: vi.fn<any>().mockResolvedValue(undefined),
      isInitialized: vi.fn().mockReturnValue(true),
      ensureAnchorWorktree: vi.fn<any>().mockResolvedValue(false),
      getMainWorktreePath: vi.fn(() => "/test/worktrees/main"),
      fetchAll: vi.fn<any>().mockResolvedValue(undefined),
      getRemoteBranches: vi.fn<any>().mockResolvedValue(["main", "feature-ahead"]),
      addWorktree: vi.fn<any>().mockResolvedValue({ status: "created", head: "def456" }),
      removeWorktree: vi.fn<any>().mockResolvedValue(undefined),
      checkWorktreeStatus: vi.fn<any>().mockResolvedValue(true),
      hasStashedChanges: vi.fn<any>().mockResolvedValue(false),
      hasOperationInProgress: vi.fn<any>().mockResolvedValue(false),
      getDefaultBranch: vi.fn().mockReturnValue("main"),
      getBareRepoPath: vi.fn().mockReturnValue("/test/.bare/repo.git"),
      readWorktreeMetadataOwner: vi.fn<any>().mockResolvedValue(null),
      getWorktrees: vi.fn<any>().mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature-ahead", branch: "feature-ahead" },
      ]),
      updateWorktree: vi.fn<any>().mockResolvedValue({ updated: true, before: "old111", after: "new222" }),
      compareTreeContent: vi.fn<any>().mockResolvedValue(false),
      resetToUpstream: vi.fn<any>().mockResolvedValue(true),
      getCurrentCommit: vi.fn<any>().mockResolvedValue("abc123"),
      getRemoteCommit: vi.fn<any>().mockResolvedValue("def456"),
      getWorktreeMetadata: vi.fn<any>().mockResolvedValue(null),
      getAheadBehindCounts: vi.fn<any>().mockResolvedValue({ ahead: 0, behind: 0 }),
      getRemoteBranchTips: vi.fn<any>().mockResolvedValue(new Map()),
      recordRemoteTip: vi.fn<any>().mockResolvedValue(undefined),
      updateRef: vi.fn<any>().mockResolvedValue(undefined),
      deleteLocalBranch: vi.fn<any>().mockResolvedValue(undefined),
      getGit: vi.fn<any>(),
    } as any,
  };
});

vi.mock("../services/git.service", () => ({
  GitService: vi.fn(function (this: any) {
    return mockGitServiceInstance;
  }),
}));

describe("Local Branch Ahead of Remote", () => {
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
      runOnce: true,
      updateExistingWorktrees: true,
      logger: mockLogger,
      trash: { enabled: false },
    };

    mockGitService = mockGitServiceInstance;

    service = new WorktreeSyncService(mockConfig);
  });

  describe("Branch with unpushed commits (ahead of remote)", () => {
    it("should skip worktree when local is ahead of remote (has unpushed commits)", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue([]);
      (fs.access as Mock<any>).mockResolvedValue(undefined);

      mockGitService.getAheadBehindCounts.mockImplementation(async (path: string) =>
        path.includes("feature-ahead") ? { ahead: 2, behind: 0 } : { ahead: 0, behind: 0 },
      );

      await service.sync();

      expect(fs.rename).not.toHaveBeenCalled();
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(mockGitService.resetToUpstream).not.toHaveBeenCalled();
      expect(mockGitService.addWorktree).not.toHaveBeenCalledWith("feature-ahead", "/test/worktrees/feature-ahead");
    });

    it("should log skip message when local is ahead of remote", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue([]);
      (fs.access as Mock<any>).mockResolvedValue(undefined);

      mockGitService.getAheadBehindCounts.mockImplementation(async (path: string) =>
        path.includes("feature-ahead") ? { ahead: 2, behind: 0 } : { ahead: 0, behind: 0 },
      );

      await service.sync();

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringMatching(/skipping.*feature-ahead.*unpushed/i));
    });

    it("should handle case where local is ahead with uncommitted changes too", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue([]);
      (fs.access as Mock<any>).mockResolvedValue(undefined);

      mockGitService.checkWorktreeStatus.mockImplementation(async (path) => {
        return !path.includes("feature-ahead");
      });

      mockGitService.getAheadBehindCounts.mockImplementation(async (path: string) =>
        path.includes("feature-ahead") ? { ahead: 2, behind: 0 } : { ahead: 0, behind: 0 },
      );

      await service.sync();

      expect(fs.rename).not.toHaveBeenCalled();
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(mockGitService.getAheadBehindCounts).not.toHaveBeenCalledWith(
        "/test/worktrees/feature-ahead",
        "feature-ahead",
      );
    });
  });
});

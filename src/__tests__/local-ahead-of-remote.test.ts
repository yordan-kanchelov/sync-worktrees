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
      fetchAll: vi.fn<any>().mockResolvedValue(undefined),
      getRemoteBranches: vi.fn<any>().mockResolvedValue(["main", "feature-ahead"]),
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
      getWorktrees: vi.fn<any>().mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature-ahead", branch: "feature-ahead" },
      ]),
      isWorktreeBehind: vi.fn<any>().mockResolvedValue(false),
      updateWorktree: vi.fn<any>().mockResolvedValue(undefined),
      hasDivergedHistory: vi.fn<any>().mockResolvedValue(false),
      canFastForward: vi.fn<any>().mockResolvedValue(true),
      compareTreeContent: vi.fn<any>().mockResolvedValue(false),
      resetToUpstream: vi.fn<any>().mockResolvedValue(undefined),
      getCurrentCommit: vi.fn<any>().mockResolvedValue("abc123"),
      getRemoteCommit: vi.fn<any>().mockResolvedValue("def456"),
      getWorktreeMetadata: vi.fn<any>().mockResolvedValue(null),
      isLocalAheadOfRemote: vi.fn<any>().mockResolvedValue(false),
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

      // feature-ahead cannot fast-forward because it's ahead of remote
      mockGitService.canFastForward.mockImplementation(async (path) => {
        return !path.includes("feature-ahead");
      });

      // But it's not truly diverged - local is ahead of remote
      mockGitService.isLocalAheadOfRemote.mockImplementation(async (path) => {
        return path.includes("feature-ahead");
      });

      await service.sync();

      // Should NOT move to diverged
      expect(fs.rename).not.toHaveBeenCalled();
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(mockGitService.resetToUpstream).not.toHaveBeenCalled();
      // Should NOT create fresh worktree
      expect(mockGitService.addWorktree).not.toHaveBeenCalledWith("feature-ahead", "/test/worktrees/feature-ahead");
    });

    it("should log skip message when local is ahead of remote", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue([]);
      (fs.access as Mock<any>).mockResolvedValue(undefined);

      mockGitService.canFastForward.mockImplementation(async (path) => {
        return !path.includes("feature-ahead");
      });

      mockGitService.isLocalAheadOfRemote.mockImplementation(async (path) => {
        return path.includes("feature-ahead");
      });

      await service.sync();

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringMatching(/skipping.*feature-ahead.*unpushed/i));
    });

    it("should handle diverged branches when local is NOT ahead", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue([]);
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      (fs.rename as Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as Mock<any>).mockResolvedValue(undefined);

      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-diverged"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature-diverged", branch: "feature-diverged" },
      ]);

      // Cannot fast-forward
      mockGitService.canFastForward.mockImplementation(async (path) => {
        return !path.includes("feature-diverged");
      });

      // NOT ahead - truly diverged
      mockGitService.isLocalAheadOfRemote.mockResolvedValue(false);

      // Trees are different
      mockGitService.compareTreeContent.mockResolvedValue(false);

      // Has local changes (different commit than last sync)
      mockGitService.getWorktreeMetadata.mockResolvedValue({
        lastSyncCommit: "abc123",
        lastSyncDate: "2024-01-01T00:00:00.000Z",
        upstreamBranch: "origin/feature-diverged",
        createdFrom: { branch: "main", commit: "xyz789" },
        syncHistory: [],
      });
      mockGitService.getCurrentCommit.mockResolvedValue("local456");

      await service.sync();

      // Should move to diverged (normal diverged behavior)
      expect(fs.mkdir).toHaveBeenCalledWith("/test/worktrees/.diverged", { recursive: true });
      expect(fs.rename).toHaveBeenCalledWith(
        "/test/worktrees/feature-diverged",
        expect.stringMatching(/\/test\/worktrees\/\.diverged\/\d{4}-\d{2}-\d{2}-feature-diverged-[a-z0-9]+$/),
      );
    });

    it("should handle case where local is ahead with uncommitted changes too", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue([]);
      (fs.access as Mock<any>).mockResolvedValue(undefined);

      // Has uncommitted changes - should skip before even checking fast-forward
      mockGitService.checkWorktreeStatus.mockImplementation(async (path) => {
        return !path.includes("feature-ahead");
      });

      mockGitService.canFastForward.mockImplementation(async (path) => {
        return !path.includes("feature-ahead");
      });

      mockGitService.isLocalAheadOfRemote.mockImplementation(async (path) => {
        return path.includes("feature-ahead");
      });

      await service.sync();

      // Should NOT move to diverged - uncommitted changes check should skip first
      expect(fs.rename).not.toHaveBeenCalled();
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      // isLocalAheadOfRemote should not be called because we exit early due to uncommitted changes
      expect(mockGitService.isLocalAheadOfRemote).not.toHaveBeenCalled();
    });
  });
});

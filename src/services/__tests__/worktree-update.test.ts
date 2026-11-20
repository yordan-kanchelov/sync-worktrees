import * as fs from "fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { WorktreeSyncService } from "../worktree-sync.service";
import { RefScanScope } from "../worktree-status.service";

import type { Config, SyncResult } from "../../types";
import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { Mock, Mocked } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");

describe("WorktreeSyncService - Update Existing Worktrees", () => {
  let service: WorktreeSyncService;
  let mockConfig: Config;
  let mockGitService: Mocked<GitService>;
  let mockLogger: Logger;

  function attachMockGitService(): void {
    (service as any).gitService = mockGitService;
    (service as any).worktreeModeSyncRunner.gitService = mockGitService;
  }

  beforeEach(() => {
    vi.clearAllMocks();

    (fs.readdir as Mock<any>).mockResolvedValue([]);

    mockLogger = createMockLogger();

    mockConfig = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/test/worktrees",
      cronSchedule: "0 * * * *",
      runOnce: true,
      updateExistingWorktrees: true,
      logger: mockLogger,
    };

    service = new WorktreeSyncService(mockConfig);

    mockGitService = {
      initialize: vi.fn().mockResolvedValue(undefined),
      isInitialized: vi.fn().mockReturnValue(true),
      fetchAll: vi.fn().mockResolvedValue(undefined),
      getRemoteBranches: vi.fn().mockResolvedValue(["main", "feature", "develop"]),
      getRemoteBranchesWithActivity: vi.fn().mockResolvedValue([
        { branch: "main", lastActivity: new Date() },
        { branch: "feature", lastActivity: new Date() },
        { branch: "develop", lastActivity: new Date() },
      ]),
      getBareRepoPath: vi.fn().mockReturnValue("/test/.bare/repo.git"),
      readWorktreeMetadataOwner: vi.fn().mockResolvedValue(null),
      getWorktrees: vi.fn().mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main", head: "main-head" },
        { path: "/test/worktrees/feature", branch: "feature", head: "feature-head" },
        { path: "/test/worktrees/develop", branch: "develop", head: "develop-head" },
      ]),
      checkWorktreeStatus: vi.fn().mockResolvedValue(true),
      getAheadBehindCounts: vi.fn().mockResolvedValue({ ahead: 0, behind: 0 }),
      getRemoteBranchTips: vi.fn().mockResolvedValue(new Map()),
      recordRemoteTip: vi.fn().mockResolvedValue(undefined),
      updateWorktree: vi.fn().mockResolvedValue({ updated: true, before: "old111", after: "new222" }),
      addWorktree: vi.fn().mockResolvedValue({ status: "created", head: "def456" }),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      hasStashedChanges: vi.fn().mockResolvedValue(false),
      hasOperationInProgress: vi.fn().mockResolvedValue(false),
      getDefaultBranch: vi.fn().mockReturnValue("main"),
      ensureAnchorWorktree: vi.fn().mockResolvedValue(false),
      getMainWorktreePath: vi.fn().mockReturnValue("/test/worktrees/main"),
      refreshDefaultBranch: vi.fn().mockResolvedValue({
        previous: "main",
        defaultBranch: "main",
        mainWorktreePath: "/test/worktrees/main",
        created: false,
      }),
      getFullWorktreeStatus: vi.fn().mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        fullyPushedUpstreamDeleted: false,
        canRemove: true,
        reasons: [],
      }),
    } as any;

    attachMockGitService();
  });

  describe("Update functionality enabled (default)", () => {
    it("should update worktrees that are behind", async () => {
      mockGitService.getAheadBehindCounts.mockImplementation(async (path: string) =>
        path.includes("feature") ? { ahead: 0, behind: 1 } : { ahead: 0, behind: 0 },
      );

      const result = await service.sync();

      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledTimes(3);
      expect(mockGitService.getAheadBehindCounts).toHaveBeenCalledTimes(3);

      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(1);
      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/feature", "feature");
      expect(result).toMatchObject({
        started: true,
        outcome: {
          mode: "worktree",
          counts: expect.objectContaining({ updated: 1, noop: 2 }),
          actions: expect.arrayContaining([
            { kind: "updated", branch: "feature", path: "/test/worktrees/feature", reason: "fast_forward" },
          ]),
        },
      });
    });

    it("should skip updating worktrees with an operation in progress", async () => {
      mockGitService.hasOperationInProgress.mockImplementation(async (p) => p.includes("feature"));
      mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });

      const result = await service.sync();

      expect(mockGitService.updateWorktree).not.toHaveBeenCalledWith("/test/worktrees/feature", "feature");
      expect(result).toMatchObject({
        started: true,
        outcome: {
          counts: expect.objectContaining({ skipped: 1 }),
          actions: expect.arrayContaining([
            {
              kind: "skipped",
              scope: "worktree",
              reason: "operation_in_progress",
              branch: "feature",
              path: "/test/worktrees/feature",
            },
          ]),
        },
      });
    });

    it("should skip updating worktrees with local changes", async () => {
      mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });

      mockGitService.checkWorktreeStatus.mockImplementation(async (path) => {
        return !path.includes("feature");
      });

      await service.sync();

      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledTimes(3);

      expect(mockGitService.getAheadBehindCounts).toHaveBeenCalledTimes(2);

      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(2);
      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/main", "main");
      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/develop", "develop");
      expect(mockGitService.updateWorktree).not.toHaveBeenCalledWith("/test/worktrees/feature", "feature");
    });

    it("should handle update failures gracefully", async () => {
      mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });

      mockGitService.updateWorktree.mockImplementation(async (path) => {
        if (path.includes("feature")) {
          throw new Error("Fast-forward merge failed");
        }
        return { updated: true, before: "old111", after: "new222" };
      });

      await service.sync();

      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(3);
    });

    it("should handle errors when checking worktree status", async () => {
      mockGitService.checkWorktreeStatus.mockImplementation(async (path) => {
        if (path.includes("feature")) {
          throw new Error("Git status failed");
        }
        return true;
      });

      mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });

      const result = await service.sync();

      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(2);
      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/main", "main");
      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/develop", "develop");

      expect(result.started).toBe(true);
      if (!result.started) throw new Error("sync did not start");
      expect(result.outcome?.counts.failed ?? 0).toBe(0);
      expect(result.outcome?.counts.skipped ?? 0).toBeGreaterThanOrEqual(1);
      const actions = result.outcome?.actions ?? [];
      expect(actions).toContainEqual(
        expect.objectContaining({
          kind: "skipped",
          scope: "worktree",
          reason: "update_check_failed",
          branch: "feature",
          path: "/test/worktrees/feature",
        }),
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        "  - Error checking worktree 'feature' (/test/worktrees/feature):",
        expect.any(Error),
      );
    });

    it("hands the branch to the ahead/behind probe and fast-forwards a worktree whose branch has no upstream", async () => {
      mockGitService.getAheadBehindCounts.mockImplementation(async (_worktreePath: string, branch: string) =>
        branch === "feature" ? { ahead: 0, behind: 1 } : { ahead: 0, behind: 0 },
      );

      const result = await service.sync();

      expect(mockGitService.getAheadBehindCounts).toHaveBeenCalledWith("/test/worktrees/feature", "feature");
      expect(mockGitService.getAheadBehindCounts).toHaveBeenCalledWith("/test/worktrees/main", "main");
      expect(mockGitService.getAheadBehindCounts).toHaveBeenCalledWith("/test/worktrees/develop", "develop");
      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(1);
      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/feature", "feature");

      expect(result.started).toBe(true);
      if (!result.started) throw new Error("sync did not start");
      const featureActions = result.outcome.actions.filter((action) => action.branch === "feature");
      expect(featureActions).toEqual([
        { kind: "updated", branch: "feature", path: "/test/worktrees/feature", reason: "fast_forward" },
      ]);
      expect(result.outcome.actions).toContainEqual(
        expect.objectContaining({ kind: "noop", reason: "already_up_to_date", branch: "main" }),
      );
    });

    describe("an ahead/behind probe that throws", () => {
      const runner = (): any => (service as any).worktreeModeSyncRunner;

      beforeEach(() => {
        vi.spyOn(runner(), "handleDivergedBranch");
        vi.spyOn(runner().trashService, "trashAndUnregisterWorktree");
        mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });
      });

      function expectFeatureLeftAlone(result: SyncResult, message: string): void {
        expect(runner().handleDivergedBranch).not.toHaveBeenCalled();
        expect(runner().trashService.trashAndUnregisterWorktree).not.toHaveBeenCalled();
        expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
        expect(fs.rename).not.toHaveBeenCalled();
        expect(mockGitService.updateWorktree).not.toHaveBeenCalledWith("/test/worktrees/feature", "feature");
        expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(2);
        expect(mockLogger.error).toHaveBeenCalledWith(
          "  - Error checking worktree 'feature' (/test/worktrees/feature):",
          expect.any(Error),
        );

        expect(result.started).toBe(true);
        if (!result.started) throw new Error("sync did not start");
        expect(result.outcome.counts.failed).toBe(0);
        expect(result.outcome.counts.preserved).toBe(0);
        expect(result.outcome.actions.filter((action) => action.branch === "feature")).toEqual([
          {
            kind: "skipped",
            scope: "worktree",
            reason: "update_check_failed",
            branch: "feature",
            path: "/test/worktrees/feature",
            message,
          },
        ]);
      }

      it("records update_check_failed and never starts diverged handling when the probe throws", async () => {
        const message =
          "Git operation 'rev-list' failed: could not count ahead/behind for 'feature' in '/test/worktrees/feature': spawn git EMFILE";
        mockGitService.getAheadBehindCounts.mockImplementation(async (worktreePath: string) => {
          if (worktreePath.includes("feature")) throw new Error(message);
          return { ahead: 0, behind: 1 };
        });

        const result = await service.sync();

        expectFeatureLeftAlone(result, message);
      });
    });

    it("records already_up_to_date, not an update, when the fast-forward finds HEAD already at the remote tip", async () => {
      mockGitService.getAheadBehindCounts.mockImplementation(async (_worktreePath: string, branch: string) =>
        branch === "feature" ? { ahead: 0, behind: 1 } : { ahead: 0, behind: 0 },
      );
      mockGitService.updateWorktree.mockResolvedValue({ updated: false, before: "abc123", after: "abc123" });

      const result = await service.sync();

      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(1);
      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/feature", "feature");
      expect(mockLogger.info).toHaveBeenCalledWith("  - Updating worktree 'feature'...");
      expect(mockLogger.info).toHaveBeenCalledWith(
        "    ℹ️  'feature' was already up to date; nothing to fast-forward.",
      );
      expect(mockLogger.info).not.toHaveBeenCalledWith(expect.stringContaining("Successfully updated"));

      expect(result.started).toBe(true);
      if (!result.started) throw new Error("sync did not start");
      expect(result.outcome.counts).toEqual(expect.objectContaining({ updated: 0, noop: 3, failed: 0 }));
      expect(result.outcome.actions.filter((action) => action.branch === "feature")).toEqual([
        {
          kind: "noop",
          scope: "worktree",
          reason: "already_up_to_date",
          branch: "feature",
          path: "/test/worktrees/feature",
        },
      ]);
    });

    describe("worktrees whose HEAD already sits at origin's tip", () => {
      const tips = new Map([
        ["main", "main-head"],
        ["feature", "feature-remote-tip"],
        ["develop", "develop-head"],
      ]);

      beforeEach(() => {
        mockGitService.getRemoteBranchTips.mockResolvedValue(tips);
        mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 3 });
      });

      afterEach(() => {
        (fs.access as Mock<any>).mockReset();
      });

      it("probes only the worktree whose remote tip moved and reports the rest as noops", async () => {
        const result = await service.sync();

        expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledTimes(1);
        expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledWith("/test/worktrees/feature");
        expect(mockGitService.getAheadBehindCounts).toHaveBeenCalledTimes(1);
        expect(mockGitService.getAheadBehindCounts).toHaveBeenCalledWith("/test/worktrees/feature", "feature");

        expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(1);
        expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/feature", "feature");

        expect(result.started).toBe(true);
        if (!result.started) throw new Error("sync did not start");
        expect(result.outcome.counts).toEqual(expect.objectContaining({ updated: 1, noop: 2, failed: 0, skipped: 0 }));
        expect(result.outcome.actions).toContainEqual({
          kind: "updated",
          branch: "feature",
          path: "/test/worktrees/feature",
          reason: "fast_forward",
        });
        for (const branch of ["main", "develop"]) {
          expect(result.outcome.actions).toContainEqual({
            kind: "noop",
            scope: "worktree",
            reason: "already_up_to_date",
            branch,
            path: `/test/worktrees/${branch}`,
          });
        }
      });

      it("keeps the git commands per attempt constant as the worktree count grows", async () => {
        const spawningCalls = async (worktreeCount: number): Promise<Record<string, number>> => {
          const branches = Array.from({ length: worktreeCount }, (_, index) => `b${index}`);
          mockGitService.getRemoteBranches.mockResolvedValue(branches);
          mockGitService.getWorktrees.mockResolvedValue(
            branches.map((branch) => ({ path: `/test/worktrees/${branch}`, branch, head: `${branch}-head` })),
          );
          mockGitService.getRemoteBranchTips.mockResolvedValue(
            new Map(branches.map((branch) => [branch, `${branch}-head`])),
          );
          mockGitService.getDefaultBranch.mockReturnValue("b0");
          mockGitService.getMainWorktreePath.mockReturnValue("/test/worktrees/b0");

          service = new WorktreeSyncService(mockConfig);
          attachMockGitService();
          vi.clearAllMocks();
          (fs.readdir as Mock<any>).mockResolvedValue([]);

          const result = await service.sync();
          expect(result.started).toBe(true);
          if (!result.started) throw new Error("sync did not start");
          expect(result.outcome.counts).toEqual(
            expect.objectContaining({ noop: worktreeCount, updated: 0, skipped: 0, failed: 0 }),
          );

          return {
            fetchAll: mockGitService.fetchAll.mock.calls.length,
            getRemoteBranches: mockGitService.getRemoteBranches.mock.calls.length,
            getWorktrees: mockGitService.getWorktrees.mock.calls.length,
            getRemoteBranchTips: mockGitService.getRemoteBranchTips.mock.calls.length,
            checkWorktreeStatus: mockGitService.checkWorktreeStatus.mock.calls.length,
            getAheadBehindCounts: mockGitService.getAheadBehindCounts.mock.calls.length,
            updateWorktree: mockGitService.updateWorktree.mock.calls.length,
            getFullWorktreeStatus: mockGitService.getFullWorktreeStatus.mock.calls.length,
          };
        };

        const small = await spawningCalls(3);
        const large = await spawningCalls(30);

        expect(small).toEqual({
          fetchAll: 1,
          getRemoteBranches: 1,
          getWorktrees: 1,
          getRemoteBranchTips: 1,
          checkWorktreeStatus: 0,
          getAheadBehindCounts: 0,
          updateWorktree: 0,
          getFullWorktreeStatus: 0,
        });
        expect(large).toEqual(small);
        const total = Object.values(large).reduce((sum, count) => sum + count, 0);
        expect(total).toBeLessThanOrEqual(5);
      });

      it("falls back to the per-worktree probes when the tip listing could not be read", async () => {
        mockGitService.getRemoteBranchTips.mockRejectedValue(new Error("fatal: not a git repository"));
        mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 0 });

        const result = await service.sync();

        expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledTimes(3);
        expect(mockGitService.getAheadBehindCounts).toHaveBeenCalledTimes(3);
        expect(result.started).toBe(true);
        if (!result.started) throw new Error("sync did not start");
        expect(result.outcome.counts).toEqual(expect.objectContaining({ noop: 3, updated: 0, failed: 0 }));
      });

      it("falls back to the per-worktree probes for a registration listed without a HEAD", async () => {
        mockGitService.getWorktrees.mockResolvedValue([
          { path: "/test/worktrees/main", branch: "main", head: "main-head" },
          { path: "/test/worktrees/feature", branch: "feature", head: "feature-head" },
          { path: "/test/worktrees/develop", branch: "develop" },
        ]);
        mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 0 });

        const result = await service.sync();

        expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledTimes(2);
        expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledWith("/test/worktrees/develop");
        expect(mockGitService.getAheadBehindCounts).toHaveBeenCalledWith("/test/worktrees/develop", "develop");
        expect(result.started).toBe(true);
        if (!result.started) throw new Error("sync did not start");
        expect(result.outcome.counts).toEqual(expect.objectContaining({ noop: 3, failed: 0 }));
      });

      it("still reports an operation in progress rather than up to date", async () => {
        mockGitService.hasOperationInProgress.mockImplementation(async (p: string) => p.includes("develop"));

        const result = await service.sync();

        expect(result.started).toBe(true);
        if (!result.started) throw new Error("sync did not start");
        expect(result.outcome.actions).toContainEqual({
          kind: "skipped",
          scope: "worktree",
          reason: "operation_in_progress",
          branch: "develop",
          path: "/test/worktrees/develop",
        });
      });

      it("still reports a worktree directory it cannot reach rather than up to date", async () => {
        (fs.access as Mock<any>).mockImplementation(async (target: unknown) => {
          if (String(target) === "/test/worktrees/develop") {
            throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
          }
        });

        const result = await service.sync();

        expect(result.started).toBe(true);
        if (!result.started) throw new Error("sync did not start");
        expect(result.outcome.actions).toContainEqual({
          kind: "skipped",
          scope: "worktree",
          reason: "missing_worktree_path",
          branch: "develop",
          path: "/test/worktrees/develop",
        });
      });
    });
  });

  describe("Default branch retention with branchMaxAge", () => {
    it("should not prune default branch even if filtered by age", async () => {
      mockConfig.branchMaxAge = "1d";
      service = new WorktreeSyncService(mockConfig);
      attachMockGitService();

      (mockGitService.getRemoteBranches as Mock).mockResolvedValue(["feature", "develop"]);

      (fs.readdir as Mock<any>).mockImplementation(async (dirPath: unknown) =>
        String(dirPath).endsWith(".trash") ? [] : ["main"],
      );

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalledWith("/test/worktrees/main");
    });
  });

  describe("Branch name filtering with branchInclude", () => {
    it("should only create worktrees for branches matching include patterns", async () => {
      mockConfig.branchInclude = ["feature*"];
      service = new WorktreeSyncService(mockConfig);
      attachMockGitService();

      (mockGitService.getRemoteBranches as Mock).mockResolvedValue([
        "main",
        "feature/login",
        "feature/signup",
        "bugfix/typo",
      ]);
      (mockGitService.getWorktrees as Mock).mockResolvedValue([]);
      (fs.readdir as Mock<any>).mockResolvedValue([]);

      await service.sync();

      expect(mockGitService.addWorktree).toHaveBeenCalledTimes(2);
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature/login", expect.any(String));
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature/signup", expect.any(String));
    });
  });

  describe("Branch name filtering with branchExclude", () => {
    it("should exclude branches matching exclude patterns", async () => {
      mockConfig.branchExclude = ["bugfix/*", "wip-*"];
      service = new WorktreeSyncService(mockConfig);
      attachMockGitService();

      (mockGitService.getRemoteBranches as Mock).mockResolvedValue([
        "main",
        "feature/login",
        "bugfix/typo",
        "wip-test",
      ]);
      (mockGitService.getWorktrees as Mock).mockResolvedValue([]);
      (fs.readdir as Mock<any>).mockResolvedValue([]);

      await service.sync();

      expect(mockGitService.addWorktree).toHaveBeenCalledTimes(1);
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature/login", expect.any(String));
      expect(mockGitService.addWorktree).not.toHaveBeenCalledWith("bugfix/typo", expect.anything());
      expect(mockGitService.addWorktree).not.toHaveBeenCalledWith("wip-test", expect.anything());
    });
  });

  describe("Branch name filtering runs before age filtering", () => {
    it("should apply name filter then age filter", async () => {
      const now = new Date();
      const oldDate = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

      mockConfig.branchInclude = ["feature/*", "main"];
      mockConfig.branchMaxAge = "30d";
      service = new WorktreeSyncService(mockConfig);
      attachMockGitService();

      (mockGitService.getRemoteBranchesWithActivity as Mock).mockResolvedValue([
        { branch: "main", lastActivity: now },
        { branch: "feature/new", lastActivity: now },
        { branch: "feature/old", lastActivity: oldDate },
        { branch: "bugfix/typo", lastActivity: now },
      ]);
      (mockGitService.getWorktrees as Mock).mockResolvedValue([]);
      (fs.readdir as Mock<any>).mockResolvedValue([]);

      await service.sync();

      expect(mockGitService.addWorktree).toHaveBeenCalledTimes(1);
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature/new", expect.any(String));
    });
  });

  describe("Default branch retained even if excluded by name filter", () => {
    it("should retain default branch regardless of branchExclude", async () => {
      mockConfig.branchExclude = ["main"];
      service = new WorktreeSyncService(mockConfig);
      attachMockGitService();

      (mockGitService.getRemoteBranches as Mock).mockResolvedValue(["main", "feature/login"]);
      (mockGitService.getWorktrees as Mock).mockResolvedValue([]);
      (fs.readdir as Mock<any>).mockResolvedValue([]);

      await service.sync();

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Ensuring default branch"));
      expect(mockGitService.refreshDefaultBranch).not.toHaveBeenCalled();
    });
  });

  describe("Default branch that origin no longer has", () => {
    beforeEach(() => {
      mockConfig.trash = { enabled: false };
      service = new WorktreeSyncService(mockConfig);
      attachMockGitService();
      (fs.open as Mock<any>).mockResolvedValue({
        appendFile: vi.fn().mockResolvedValue(undefined),
        sync: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      });
      (mockGitService.getRemoteBranches as Mock).mockResolvedValue(["trunk", "feature"]);
      (mockGitService.getWorktrees as Mock).mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature", branch: "feature" },
        { path: "/test/worktrees/trunk", branch: "trunk" },
      ]);
      (fs.readdir as Mock<any>).mockResolvedValue([]);
    });

    it("re-resolves the default, records its new worktree and prunes the old default instead of retaining it", async () => {
      (mockGitService.refreshDefaultBranch as Mock).mockImplementation(async () => {
        (mockGitService.getMainWorktreePath as Mock).mockReturnValue("/test/worktrees/trunk");
        return { previous: "main", defaultBranch: "trunk", mainWorktreePath: "/test/worktrees/trunk", created: true };
      });

      const result = await service.sync();

      expect(mockGitService.refreshDefaultBranch).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).not.toHaveBeenCalledWith(expect.stringContaining("Ensuring default branch 'main'"));
      expect(mockGitService.getFullWorktreeStatus).toHaveBeenCalledWith(
        "/test/worktrees/main",
        undefined,
        expect.any(RefScanScope),
      );
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith("/test/worktrees/main");
      expect(mockGitService.getAheadBehindCounts).not.toHaveBeenCalledWith("/test/worktrees/main", "main");
      expect(mockGitService.addWorktree).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        started: true,
        outcome: {
          counts: expect.objectContaining({ created: 1, removed: 1, failed: 0 }),
          actions: expect.arrayContaining([
            { kind: "created", branch: "trunk", path: "/test/worktrees/trunk" },
            { kind: "removed", branch: "main", path: "/test/worktrees/main" },
          ]),
        },
      });
    });

    it("retains the default only while origin has it, even when re-resolution keeps the same name", async () => {
      (mockGitService.getRemoteBranches as Mock).mockResolvedValue(["feature"]);

      await service.sync();

      expect(mockGitService.refreshDefaultBranch).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).not.toHaveBeenCalledWith(expect.stringContaining("Ensuring default branch"));
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Default branch 'main' does not exist on origin; not retaining its worktree"),
      );
      expect(mockGitService.getFullWorktreeStatus).toHaveBeenCalledWith(
        "/test/worktrees/main",
        undefined,
        expect.any(RefScanScope),
      );
      expect(mockGitService.addWorktree).not.toHaveBeenCalledWith("main", expect.any(String));
    });

    it("fails the sync before pruning anything when the default cannot be re-resolved", async () => {
      (mockGitService.refreshDefaultBranch as Mock).mockRejectedValue(new Error("origin/main does not exist"));

      await expect(service.sync()).rejects.toThrow("origin/main does not exist");

      expect(mockGitService.getFullWorktreeStatus).not.toHaveBeenCalled();
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(mockGitService.addWorktree).not.toHaveBeenCalled();
      expect(mockGitService.updateWorktree).not.toHaveBeenCalled();
    });
  });

  describe("Update functionality disabled", () => {
    beforeEach(() => {
      mockConfig.updateExistingWorktrees = false;
      service = new WorktreeSyncService(mockConfig);
      attachMockGitService();
    });

    it("should not update any worktrees when disabled", async () => {
      mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });

      await service.sync();

      expect(mockGitService.checkWorktreeStatus).not.toHaveBeenCalled();
      expect(mockGitService.getAheadBehindCounts).not.toHaveBeenCalled();
      expect(mockGitService.updateWorktree).not.toHaveBeenCalled();
    });
  });

  describe("No worktrees need updating", () => {
    it("should log that all worktrees are up to date", async () => {
      mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 0 });

      await service.sync();

      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledTimes(3);
      expect(mockGitService.getAheadBehindCounts).toHaveBeenCalledTimes(3);
      expect(mockGitService.updateWorktree).not.toHaveBeenCalled();

      expect(mockLogger.info).toHaveBeenCalledWith("  - All worktrees are up to date.");
    });
  });

  describe("skipUpdateWhenOutsideSparse (cone mode)", () => {
    let getChangedPathsInRange: Mock;
    let sparseService: { resolveMode: Mock; pathsTouchSparse: Mock };

    function setup(skipFlag: boolean | undefined) {
      mockConfig = {
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "/test/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: true,
        updateExistingWorktrees: true,
        sparseCheckout:
          skipFlag === undefined ? { include: ["src"] } : { include: ["src"], skipUpdateWhenOutsideSparse: skipFlag },
        logger: mockLogger,
      };

      service = new WorktreeSyncService(mockConfig);

      getChangedPathsInRange = vi.fn().mockResolvedValue([]);
      sparseService = {
        resolveMode: vi.fn().mockReturnValue("cone"),
        pathsTouchSparse: vi.fn().mockReturnValue(true),
        buildPatterns: vi.fn().mockReturnValue(["src"]),
        readCurrent: vi.fn().mockResolvedValue(["src"]),
        readCurrentMode: vi.fn().mockResolvedValue("cone"),
        patternsEqual: vi.fn().mockReturnValue(true),
        isNarrowing: vi.fn().mockReturnValue(false),
        applyToWorktree: vi.fn().mockResolvedValue(undefined),
      } as any;

      mockGitService = {
        ...mockGitService,
        getSparseCheckoutService: vi.fn().mockReturnValue(sparseService),
        getChangedPathsInRange,
      } as any;

      attachMockGitService();
    }

    it("skips update when diff has no paths inside sparse include", async () => {
      setup(true);
      mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });
      getChangedPathsInRange.mockResolvedValue(["lib/x.ts"]);
      sparseService.pathsTouchSparse.mockReturnValue(false);

      await service.sync();

      expect(getChangedPathsInRange).toHaveBeenCalled();
      expect(mockGitService.updateWorktree).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("upstream changes outside sparse paths"));
    });

    it("proceeds with update when diff includes a path inside sparse", async () => {
      setup(true);
      mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });
      getChangedPathsInRange.mockResolvedValue(["src/foo.ts"]);
      sparseService.pathsTouchSparse.mockReturnValue(true);

      await service.sync();

      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(3);
    });

    it("does not consult diff when flag is explicitly disabled", async () => {
      setup(false);
      mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });

      await service.sync();

      expect(getChangedPathsInRange).not.toHaveBeenCalled();
      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(3);
    });

    it("defaults to enabled when sparseCheckout is set without an explicit flag", async () => {
      setup(undefined);
      mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });
      getChangedPathsInRange.mockResolvedValue(["lib/x.ts"]);
      sparseService.pathsTouchSparse.mockReturnValue(false);

      await service.sync();

      expect(getChangedPathsInRange).toHaveBeenCalled();
      expect(mockGitService.updateWorktree).not.toHaveBeenCalled();
    });

    it("skips diff and updates normally in no-cone mode", async () => {
      setup(true);
      sparseService.resolveMode.mockReturnValue("no-cone");
      mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });

      await service.sync();

      expect(getChangedPathsInRange).not.toHaveBeenCalled();
      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(3);
    });

    it("forces update when diff fails (returns null) so a behind worktree is never silently left stale", async () => {
      setup(true);
      mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });
      getChangedPathsInRange.mockResolvedValue(null);

      await service.sync();

      expect(getChangedPathsInRange).toHaveBeenCalled();
      expect(sparseService.pathsTouchSparse).not.toHaveBeenCalled();
      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(3);
    });
  });
});

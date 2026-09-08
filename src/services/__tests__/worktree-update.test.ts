import * as fs from "fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { WorktreeSyncService } from "../worktree-sync.service";

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

    // `readdir` resolves to an array or throws; it never resolves to undefined.
    // These suites reach it through the trash listing even when they only care
    // about update behaviour.
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

    // Mock GitService methods
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
      getWorktrees: vi.fn().mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main", head: "main-head" },
        { path: "/test/worktrees/feature", branch: "feature", head: "feature-head" },
        { path: "/test/worktrees/develop", branch: "develop", head: "develop-head" },
      ]),
      checkWorktreeStatus: vi.fn().mockResolvedValue(true), // All clean by default
      // Nothing on either side by default: every worktree is up to date.
      getAheadBehindCounts: vi.fn().mockResolvedValue({ ahead: 0, behind: 0 }),
      // No tips by default, so no worktree takes the "nothing changed" fast
      // path and every one of them reaches the probes.
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
      // Mock that feature branch is behind
      mockGitService.getAheadBehindCounts.mockImplementation(async (path: string) =>
        path.includes("feature") ? { ahead: 0, behind: 1 } : { ahead: 0, behind: 0 },
      );

      const result = await service.sync();

      // Should check all worktrees
      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledTimes(3);
      expect(mockGitService.getAheadBehindCounts).toHaveBeenCalledTimes(3);

      // Should update only the feature branch
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
      // feature has an operation in progress
      mockGitService.hasOperationInProgress.mockImplementation(async (p) => p.includes("feature"));
      mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });

      const result = await service.sync();

      // Should not call update on feature
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
      // Mock that all branches are behind
      mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });

      // Mock that feature branch has local changes
      mockGitService.checkWorktreeStatus.mockImplementation(async (path) => {
        return !path.includes("feature"); // feature is not clean
      });

      await service.sync();

      // Should check all worktrees
      expect(mockGitService.checkWorktreeStatus).toHaveBeenCalledTimes(3);

      // Should only count ahead/behind for clean worktrees
      expect(mockGitService.getAheadBehindCounts).toHaveBeenCalledTimes(2);

      // Should update only the clean worktrees that are behind
      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(2);
      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/main", "main");
      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/develop", "develop");
      expect(mockGitService.updateWorktree).not.toHaveBeenCalledWith("/test/worktrees/feature", "feature");
    });

    it("should handle update failures gracefully", async () => {
      // Mock that all branches are behind
      mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });

      // Mock update failure for feature branch
      mockGitService.updateWorktree.mockImplementation(async (path) => {
        if (path.includes("feature")) {
          throw new Error("Fast-forward merge failed");
        }
        return { updated: true, before: "old111", after: "new222" };
      });

      await service.sync();

      // Should attempt to update all worktrees
      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(3);
    });

    it("should handle errors when checking worktree status", async () => {
      // Mock error when checking feature branch
      mockGitService.checkWorktreeStatus.mockImplementation(async (path) => {
        if (path.includes("feature")) {
          throw new Error("Git status failed");
        }
        return true;
      });

      mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });

      const result = await service.sync();

      // Should only update worktrees that could be checked
      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(2);
      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/main", "main");
      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/develop", "develop");

      // A probe-only failure must NOT become a hard `recordFailed` (which would
      // poison the exit code). It is recorded as `update_check_failed` skip.
      if (result.started) {
        expect(result.outcome?.counts.failed ?? 0).toBe(0);
        expect(result.outcome?.counts.skipped ?? 0).toBeGreaterThanOrEqual(1);
        const actions = result.outcome?.actions ?? [];
        expect(actions).toContainEqual(
          expect.objectContaining({
            kind: "skipped",
            scope: "worktree",
            reason: "update_check_failed",
          }),
        );
      }
    });

    // The ahead/behind probe names origin/<branch> explicitly, so it gets the
    // branch from the runner: a worktree whose branch has no upstream
    // configured (trash restore, create_worktree push:false) is fast-forwarded
    // like any other once origin's tip differs, instead of passing as up to date.
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

    it("records update_check_failed for the worktree whose ahead/behind probe throws, and updates the others", async () => {
      mockGitService.getAheadBehindCounts.mockImplementation(async (worktreePath: string) => {
        if (worktreePath.includes("feature")) {
          throw new Error("fatal: bad revision 'HEAD...refs/remotes/origin/feature'");
        }
        return { ahead: 0, behind: 1 };
      });

      const result = await service.sync();

      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(2);
      expect(mockGitService.updateWorktree).not.toHaveBeenCalledWith("/test/worktrees/feature", "feature");
      expect(mockLogger.error).toHaveBeenCalledWith("  - Error checking worktree 'feature':", expect.any(Error));

      expect(result.started).toBe(true);
      if (!result.started) throw new Error("sync did not start");
      expect(result.outcome.counts.failed).toBe(0);
      expect(result.outcome.actions.filter((action) => action.branch === "feature")).toEqual([
        {
          kind: "skipped",
          scope: "worktree",
          reason: "update_check_failed",
          branch: "feature",
          path: "/test/worktrees/feature",
          message: "fatal: bad revision 'HEAD...refs/remotes/origin/feature'",
        },
      ]);
      expect(result.outcome.actions).not.toContainEqual(
        expect.objectContaining({ reason: "already_up_to_date", branch: "feature" }),
      );
    });

    // getAheadBehindCounts throws when its rev-list could not run (EMFILE,
    // ENOMEM, a `fatal:`) rather than answering with counts: zero ahead and
    // zero behind would read as up to date, and any other invented pair could
    // read as diverged — and diverged handling can move a healthy, fully
    // pushed worktree to trash and recreate it.
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
        // The other two worktrees are still updated.
        expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(2);
        expect(mockLogger.error).toHaveBeenCalledWith("  - Error checking worktree 'feature':", expect.any(Error));

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

      // Commits on both sides — which is also what unrelated histories look
      // like to rev-list, since it counts every commit on each side when there
      // is no common ancestor — still reach diverged handling.
      it("still hands a worktree with commits on both sides to diverged handling", async () => {
        mockGitService.getAheadBehindCounts.mockImplementation(async (worktreePath: string) =>
          worktreePath.includes("feature") ? { ahead: 1, behind: 1 } : { ahead: 0, behind: 1 },
        );
        runner().handleDivergedBranch.mockResolvedValue(false);

        await service.sync();

        expect(runner().handleDivergedBranch).toHaveBeenCalledTimes(1);
        expect(runner().handleDivergedBranch).toHaveBeenCalledWith(
          { path: "/test/worktrees/feature", branch: "feature" },
          expect.objectContaining({ lfsSkipEnabled: false }),
          expect.anything(),
        );
      });
    });

    // Phase 4a saw origin/feature ahead of HEAD, but by the time Phase 4b ran
    // the fast-forward there was nothing left to merge (HEAD reached the
    // remote tip in between). That is not an update: the outcome records
    // already_up_to_date and no "Successfully updated" line is logged.
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

    // The comparison that keeps a tick where nothing changed off the
    // repository's back: git's own registration listing already resolved every
    // worktree's HEAD, and one for-each-ref gave origin's tip for every branch,
    // so a worktree whose HEAD is that tip is settled before a single
    // per-worktree git process runs.
    describe("worktrees whose HEAD already sits at origin's tip", () => {
      // Only 'feature' moved on the remote.
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
        // fs/promises is module-mocked and `vi.clearAllMocks()` keeps
        // implementations, so an access stub set here would otherwise follow
        // every later test in the file.
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

      // The whole point of the item: the per-worktree work is what used to grow
      // with the number of registered worktrees. With nothing changed, the calls
      // that spawn git are the same handful whether there are three worktrees
      // or thirty.
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
            // Repo-level: one fetch, one branch listing, one worktree listing,
            // one tip listing.
            fetchAll: mockGitService.fetchAll.mock.calls.length,
            getRemoteBranches: mockGitService.getRemoteBranches.mock.calls.length,
            getWorktrees: mockGitService.getWorktrees.mock.calls.length,
            getRemoteBranchTips: mockGitService.getRemoteBranchTips.mock.calls.length,
            // Per-worktree: none of these may run.
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

      // A listing that failed answers nothing about any branch, so every
      // worktree goes back through the probes rather than passing as up to date.
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

      // A registration git listed without a HEAD line (a prunable entry, an
      // unborn branch) has nothing to compare, so it is probed like any other.
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

      // Skipping the probes must not skip the two answers that do not cost a
      // git process: an unfinished merge/rebase and a directory that is gone
      // are still reported for a worktree that is at the remote tip.
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

      // Not ENOENT: a directory that is provably gone is dropped from the
      // inventory earlier in the sync and rebuilt as a create. What Phase 4a
      // still has to answer for is a path it cannot verify.
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
      // Recreate service with branchMaxAge configured
      mockConfig.branchMaxAge = "1d";
      service = new WorktreeSyncService(mockConfig);
      attachMockGitService();

      // Simulate that age filtering removed all but (intentionally) not returning main
      (mockGitService.getRemoteBranches as Mock).mockResolvedValue(["feature", "develop"]);

      // Pretend worktreeDir contains main only. The trash root is read with
      // `withFileTypes` and must not be handed these plain names.
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath: unknown) =>
        String(dirPath).endsWith(".trash") ? [] : ["main"],
      );

      await service.sync();

      // Ensure we did not try to remove the main worktree
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
      const oldDate = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000); // 60 days ago

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

      // bugfix/typo excluded by name filter, feature/old excluded by age
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

  // Retaining the default branch is only right while origin still has it.
  // After the remote renamed or deleted it, keeping it in the inventory left
  // its worktree a permanent update candidate (failing every sync, since
  // origin/<old> no longer exists) that was never pruned, while the new
  // default was created as an ordinary hashed peer directory.
  describe("Default branch that origin no longer has", () => {
    beforeEach(() => {
      // Trash off so a prune ends in a plain removeWorktree; the audit record
      // written before it needs a file handle from the mocked fs.
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
      (mockGitService.refreshDefaultBranch as Mock).mockResolvedValue({
        previous: "main",
        defaultBranch: "trunk",
        mainWorktreePath: "/test/worktrees/trunk",
        created: true,
      });

      const result = await service.sync();

      expect(mockGitService.refreshDefaultBranch).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).not.toHaveBeenCalledWith(expect.stringContaining("Ensuring default branch 'main'"));
      // main went through the prune pipeline, never the update phase.
      expect(mockGitService.getFullWorktreeStatus).toHaveBeenCalledWith("/test/worktrees/main", undefined);
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith("/test/worktrees/main");
      expect(mockGitService.getAheadBehindCounts).not.toHaveBeenCalledWith("/test/worktrees/main", "main");
      // trunk's worktree was created by the switch, not planned again.
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
      expect(mockGitService.getFullWorktreeStatus).toHaveBeenCalledWith("/test/worktrees/main", undefined);
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
      // Mock that all branches are behind
      mockGitService.getAheadBehindCounts.mockResolvedValue({ ahead: 0, behind: 1 });

      await service.sync();

      // Should not check or update any worktrees
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

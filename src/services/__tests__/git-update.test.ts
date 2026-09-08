import simpleGit from "simple-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GitService } from "../git.service";

import type { Config } from "../../types";
import type { SimpleGit } from "simple-git";
import type { Mock, Mocked } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");

describe("GitService - Update Methods", () => {
  let service: GitService;
  let mockGit: Mocked<SimpleGit>;
  let mockConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/test/worktrees",
      cronSchedule: "0 * * * *",
      runOnce: true,
    };

    mockGit = {
      branch: vi.fn(),
      raw: vi.fn(),
      merge: vi.fn(),
      revparse: vi.fn(),
      env: vi.fn().mockReturnThis(),
    } as any;

    (simpleGit as Mock).mockReturnValue(mockGit);

    service = new GitService(mockConfig);
  });

  describe("getAheadBehindCounts", () => {
    // One explicit-ref probe answers the whole classification. The remote ref
    // comes from the branch argument, never from `<branch>@{upstream}`, so a
    // worktree whose branch has no upstream configured (trash restore,
    // create_worktree push:false, the no-tracking fallback) is classified
    // exactly like a tracking one — and no `git branch` is spawned to find out
    // which branch is checked out.
    it("reads both sides of one left-right rev-list against refs/remotes/origin/<branch>", async () => {
      mockGit.raw.mockResolvedValueOnce("2\t3\n");

      await expect(service.getAheadBehindCounts("/test/worktrees/feature", "feature-branch")).resolves.toEqual({
        ahead: 2,
        behind: 3,
      });
      expect(mockGit.raw).toHaveBeenCalledTimes(1);
      expect(mockGit.raw).toHaveBeenCalledWith([
        "rev-list",
        "--left-right",
        "--count",
        "HEAD...refs/remotes/origin/feature-branch",
      ]);
      expect(mockGit.branch).not.toHaveBeenCalled();
    });

    it("is up to date when HEAD equals the remote tip", async () => {
      mockGit.raw.mockResolvedValueOnce("0\t0\n");

      await expect(service.getAheadBehindCounts("/test/worktrees/main", "main")).resolves.toEqual({
        ahead: 0,
        behind: 0,
      });
    });

    // Unrelated histories are no error to rev-list: every commit lands on one
    // side or the other, which is the genuine diverged shape.
    it("counts unrelated histories on both sides", async () => {
      mockGit.raw.mockResolvedValueOnce("1\t1\n");

      await expect(service.getAheadBehindCounts("/test/worktrees/feature", "feature-branch")).resolves.toEqual({
        ahead: 1,
        behind: 1,
      });
    });

    it("throws when the probe fails instead of answering", async () => {
      mockGit.raw.mockRejectedValueOnce(
        new Error("fatal: ambiguous argument 'HEAD...refs/remotes/origin/feature-branch': unknown revision"),
      );

      await expect(service.getAheadBehindCounts("/test/worktrees/feature", "feature-branch")).rejects.toThrow(
        "unknown revision",
      );
    });

    it("throws on output it cannot read as an ahead/behind pair", async () => {
      mockGit.raw.mockResolvedValueOnce("\n");

      await expect(service.getAheadBehindCounts("/test/worktrees/feature", "feature-branch")).rejects.toThrow(
        /unexpected ahead\/behind output for 'feature-branch' in '\/test\/worktrees\/feature'/,
      );
    });
  });

  describe("updateWorktree", () => {
    // The metadata service is stubbed so its "no metadata yet" fallback does
    // not read HEAD on its own; what it is told is asserted directly.
    let updateLastSync: Mock;
    const stubMetadata = (): void => {
      updateLastSync = vi.fn().mockResolvedValue(undefined);
      (service as any).metadataService = { updateLastSyncFromPath: updateLastSync };
    };
    beforeEach(stubMetadata);

    it("fast-forwards to origin/<branch> and reports the HEAD move from the shas around the merge", async () => {
      mockGit.revparse.mockResolvedValueOnce("aaa111\n").mockResolvedValueOnce("bbb222\n");
      mockGit.merge.mockResolvedValue({} as any);

      const result = await service.updateWorktree("/test/worktrees/feature", "feature-branch");

      expect(mockGit.merge).toHaveBeenCalledWith(["origin/feature-branch", "--ff-only"]);
      // The branch comes from the caller's registration: no `git branch` is
      // spawned just to re-derive a name the caller already holds.
      expect(mockGit.branch).not.toHaveBeenCalled();
      expect(result).toEqual({ updated: true, before: "aaa111", after: "bbb222" });
      // HEAD is read once on each side of the merge.
      expect(mockGit.revparse).toHaveBeenCalledTimes(2);
      expect(mockGit.revparse).toHaveBeenCalledWith(["HEAD"]);
      const [beforeRead, afterRead] = mockGit.revparse.mock.invocationCallOrder;
      const [mergeCall] = mockGit.merge.mock.invocationCallOrder;
      expect(beforeRead).toBeLessThan(mergeCall);
      expect(mergeCall).toBeLessThan(afterRead);
      // The sync metadata records the commit HEAD moved to.
      expect(updateLastSync).toHaveBeenCalledWith(
        expect.any(String),
        "/test/worktrees/feature",
        "bbb222",
        "updated",
        expect.any(String),
      );
    });

    it("reports updated:false with equal shas, and writes no metadata, when the fast-forward had nothing to merge", async () => {
      mockGit.revparse.mockResolvedValue("ccc333\n");
      mockGit.merge.mockResolvedValue({} as any);

      const result = await service.updateWorktree("/test/worktrees/feature", "feature-branch");

      expect(mockGit.merge).toHaveBeenCalledWith(["origin/feature-branch", "--ff-only"]);
      expect(result).toEqual({ updated: false, before: "ccc333", after: "ccc333" });
      expect(updateLastSync).not.toHaveBeenCalled();
    });

    it("should use LFS skip when configured", async () => {
      mockConfig.skipLfs = true;
      service = new GitService(mockConfig);
      stubMetadata();

      mockGit.revparse.mockResolvedValueOnce("aaa111\n").mockResolvedValueOnce("bbb222\n");
      mockGit.merge.mockResolvedValue({} as any);

      await service.updateWorktree("/test/worktrees/main", "main");

      expect(mockGit.env).toHaveBeenCalledWith(expect.objectContaining({ GIT_LFS_SKIP_SMUDGE: "1" }));
      expect(mockGit.merge).toHaveBeenCalledWith(["origin/main", "--ff-only"]);
    });

    it("should throw error when fast-forward merge fails", async () => {
      mockGit.revparse.mockResolvedValue("aaa111\n");
      mockGit.merge.mockRejectedValue(new Error("Not possible to fast-forward"));

      await expect(service.updateWorktree("/test/worktrees/diverged", "diverged-branch")).rejects.toThrow(
        "Not possible to fast-forward",
      );
      // HEAD was read before the merge only; nothing is reported for a failed one.
      expect(mockGit.revparse).toHaveBeenCalledTimes(1);
    });
  });

  describe("getChangedPathsInRange", () => {
    it("invokes git diff with core.quotePath=false and the requested range", async () => {
      mockGit.raw.mockResolvedValue("src/foo.ts\nlib/bar.ts\n");

      const result = await service.getChangedPathsInRange("/test/worktrees/feature", "HEAD", "origin/feature");

      expect(mockGit.raw).toHaveBeenCalledWith([
        "-c",
        "core.quotePath=false",
        "diff",
        "--name-only",
        "--no-renames",
        "HEAD..origin/feature",
      ]);
      expect(result).toEqual(["src/foo.ts", "lib/bar.ts"]);
    });

    it("returns null on git error so caller can force a safe update", async () => {
      mockGit.raw.mockRejectedValue(new Error("bad ref"));

      const result = await service.getChangedPathsInRange("/wt", "HEAD", "origin/missing");

      expect(result).toBeNull();
    });

    it("preserves leading/trailing whitespace, strips CRLF, drops blanks", async () => {
      mockGit.raw.mockResolvedValue("\n  src/foo.ts  \r\n\nlib/bar.ts\r\n");

      const result = await service.getChangedPathsInRange("/wt", "HEAD", "origin/main");

      expect(result).toEqual(["  src/foo.ts  ", "lib/bar.ts"]);
    });
  });
});

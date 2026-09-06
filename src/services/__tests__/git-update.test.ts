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
      env: vi.fn().mockReturnThis(),
    } as any;

    (simpleGit as Mock).mockReturnValue(mockGit);

    service = new GitService(mockConfig);
  });

  describe("isWorktreeBehind", () => {
    // One explicit-ref probe. The remote ref comes from the branch argument,
    // never from `<branch>@{upstream}`, so a worktree whose branch has no
    // upstream configured (trash restore, create_worktree push:false, the
    // no-tracking fallback) is classified exactly like a tracking one.
    it("counts commits behind refs/remotes/origin/<branch> with one left-right rev-list", async () => {
      mockGit.raw.mockResolvedValueOnce("0\t3\n"); // ahead 0, behind 3

      const result = await service.isWorktreeBehind("/test/worktrees/feature", "feature-branch");

      expect(result).toBe(true);
      expect(mockGit.raw).toHaveBeenCalledTimes(1);
      expect(mockGit.raw).toHaveBeenCalledWith([
        "rev-list",
        "--left-right",
        "--count",
        "HEAD...refs/remotes/origin/feature-branch",
      ]);
      expect(mockGit.branch).not.toHaveBeenCalled();
    });

    it("is not behind when HEAD equals the remote tip", async () => {
      mockGit.raw.mockResolvedValueOnce("0\t0\n");

      await expect(service.isWorktreeBehind("/test/worktrees/main", "main")).resolves.toBe(false);
    });

    it("is not behind when the worktree is only ahead of the remote", async () => {
      mockGit.raw.mockResolvedValueOnce("2\t0\n");

      await expect(service.isWorktreeBehind("/test/worktrees/feature", "feature-branch")).resolves.toBe(false);
    });

    it("throws when the probe fails instead of reporting 'not behind'", async () => {
      mockGit.raw.mockRejectedValueOnce(new Error("fatal: bad revision 'HEAD...refs/remotes/origin/feature-branch'"));

      await expect(service.isWorktreeBehind("/test/worktrees/feature", "feature-branch")).rejects.toThrow(
        "bad revision",
      );
    });

    it("throws on output it cannot read as an ahead/behind pair", async () => {
      mockGit.raw.mockResolvedValueOnce("origin/feature-branch\n");

      await expect(service.isWorktreeBehind("/test/worktrees/feature", "feature-branch")).rejects.toThrow(
        /unexpected ahead\/behind output for 'feature-branch'/,
      );
    });
  });

  describe("updateWorktree", () => {
    it("should perform fast-forward merge", async () => {
      mockGit.branch.mockResolvedValue({
        current: "feature-branch",
        all: ["feature-branch"],
        branches: {},
        detached: false,
      } as any);

      mockGit.merge.mockResolvedValue({} as any);

      await service.updateWorktree("/test/worktrees/feature");

      expect(mockGit.merge).toHaveBeenCalledWith(["origin/feature-branch", "--ff-only"]);
    });

    it("should use LFS skip when configured", async () => {
      mockConfig.skipLfs = true;
      service = new GitService(mockConfig);

      mockGit.branch.mockResolvedValue({
        current: "main",
        all: ["main"],
        branches: {},
        detached: false,
      } as any);

      mockGit.merge.mockResolvedValue({} as any);

      await service.updateWorktree("/test/worktrees/main");

      expect(mockGit.env).toHaveBeenCalledWith(expect.objectContaining({ GIT_LFS_SKIP_SMUDGE: "1" }));
      expect(mockGit.merge).toHaveBeenCalledWith(["origin/main", "--ff-only"]);
    });

    it("should throw error when fast-forward merge fails", async () => {
      mockGit.branch.mockResolvedValue({
        current: "diverged-branch",
        all: ["diverged-branch"],
        branches: {},
        detached: false,
      } as any);

      mockGit.merge.mockRejectedValue(new Error("Not possible to fast-forward"));

      await expect(service.updateWorktree("/test/worktrees/diverged")).rejects.toThrow("Not possible to fast-forward");
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

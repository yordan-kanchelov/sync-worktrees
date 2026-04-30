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
    it("should return true when worktree is behind upstream", async () => {
      mockGit.branch.mockResolvedValue({
        current: "feature-branch",
        all: ["feature-branch", "main"],
        branches: {},
        detached: false,
      } as any);

      // Mock upstream exists
      mockGit.raw.mockResolvedValueOnce("origin/feature-branch\n");

      // Mock 3 commits behind
      mockGit.raw.mockResolvedValueOnce("3\n");

      const result = await service.isWorktreeBehind("/test/worktrees/feature");

      expect(result).toBe(true);
      expect(mockGit.raw).toHaveBeenCalledWith(["rev-parse", "--abbrev-ref", "feature-branch@{upstream}"]);
      expect(mockGit.raw).toHaveBeenCalledWith(["rev-list", "--count", "HEAD..origin/feature-branch"]);
    });

    it("should return false when worktree is up to date", async () => {
      mockGit.branch.mockResolvedValue({
        current: "main",
        all: ["main"],
        branches: {},
        detached: false,
      } as any);

      // Mock upstream exists
      mockGit.raw.mockResolvedValueOnce("origin/main\n");

      // Mock 0 commits behind
      mockGit.raw.mockResolvedValueOnce("0\n");

      const result = await service.isWorktreeBehind("/test/worktrees/main");

      expect(result).toBe(false);
    });

    it("should return false when no upstream is configured", async () => {
      mockGit.branch.mockResolvedValue({
        current: "local-only",
        all: ["local-only"],
        branches: {},
        detached: false,
      } as any);

      // Mock no upstream
      mockGit.raw.mockResolvedValueOnce("");

      const result = await service.isWorktreeBehind("/test/worktrees/local-only");

      expect(result).toBe(false);
      expect(mockGit.raw).toHaveBeenCalledTimes(1); // Only upstream check, no commit count
    });

    it("should return false when error occurs", async () => {
      mockGit.branch.mockRejectedValue(new Error("Git error"));

      const result = await service.isWorktreeBehind("/test/worktrees/error");

      expect(result).toBe(false);
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

      expect(mockGit.env).toHaveBeenCalledWith({ GIT_LFS_SKIP_SMUDGE: "1" });
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
      expect(result).not.toBeNull();
      expect(result!.paths).toEqual(["src/foo.ts", "lib/bar.ts"]);
      expect(result!.rootFilesTouched).toBe(false);
    });

    it("flags rootFilesTouched when a path has no slash", async () => {
      mockGit.raw.mockResolvedValue("README.md\nsrc/foo.ts\n");

      const result = await service.getChangedPathsInRange("/wt", "HEAD", "origin/main");

      expect(result).not.toBeNull();
      expect(result!.paths).toEqual(["README.md", "src/foo.ts"]);
      expect(result!.rootFilesTouched).toBe(true);
    });

    it("returns null on git error so caller can force a safe update", async () => {
      mockGit.raw.mockRejectedValue(new Error("bad ref"));

      const result = await service.getChangedPathsInRange("/wt", "HEAD", "origin/missing");

      expect(result).toBeNull();
    });

    it("trims and drops blank lines", async () => {
      mockGit.raw.mockResolvedValue("\n  src/foo.ts  \n\n  lib/bar.ts\n");

      const result = await service.getChangedPathsInRange("/wt", "HEAD", "origin/main");

      expect(result).not.toBeNull();
      expect(result!.paths).toEqual(["src/foo.ts", "lib/bar.ts"]);
    });
  });
});

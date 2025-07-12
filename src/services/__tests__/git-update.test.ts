import simpleGit from "simple-git";

import { GitService } from "../git.service";

import type { Config } from "../../types";
import type { SimpleGit } from "simple-git";

jest.mock("fs/promises");
jest.mock("simple-git");

describe("GitService - Update Methods", () => {
  let service: GitService;
  let mockGit: jest.Mocked<SimpleGit>;
  let mockConfig: Config;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConfig = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/test/worktrees",
      cronSchedule: "0 * * * *",
      runOnce: true,
    };

    mockGit = {
      branch: jest.fn(),
      raw: jest.fn(),
      merge: jest.fn(),
      env: jest.fn().mockReturnThis(),
    } as any;

    (simpleGit as jest.Mock).mockReturnValue(mockGit);

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
});

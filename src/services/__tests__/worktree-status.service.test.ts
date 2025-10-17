import * as fs from "fs/promises";
import * as path from "path";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import simpleGit from "simple-git";

import { WorktreeNotCleanError } from "../../errors";
import { WorktreeStatusService } from "../worktree-status.service";

import type { SimpleGit } from "simple-git";

jest.mock("fs/promises");
jest.mock("simple-git");

describe("WorktreeStatusService", () => {
  let service: WorktreeStatusService;
  let mockGit: jest.Mocked<SimpleGit>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new WorktreeStatusService();

    mockGit = {
      status: jest.fn<any>().mockResolvedValue({ isClean: () => true }),
      branch: jest.fn<any>().mockResolvedValue({ current: "main", detached: false }),
      raw: jest.fn<any>().mockResolvedValue("0\n"),
      stashList: jest.fn<any>().mockResolvedValue({ total: 0 }),
      env: jest.fn<any>().mockReturnThis(),
    } as any;

    (simpleGit as unknown as jest.Mock).mockReturnValue(mockGit);
  });

  describe("checkWorktreeStatus", () => {
    it("should return true for clean worktree", async () => {
      mockGit.status.mockResolvedValue({ isClean: () => true } as any);

      const result = await service.checkWorktreeStatus("/test/worktree");

      expect(result).toBe(true);
      expect(simpleGit).toHaveBeenCalledWith("/test/worktree");
    });

    it("should return false for dirty worktree", async () => {
      mockGit.status.mockResolvedValue({ isClean: () => false } as any);

      const result = await service.checkWorktreeStatus("/test/worktree");

      expect(result).toBe(false);
    });
  });

  describe("getFullWorktreeStatus", () => {
    it("should return complete status for clean worktree", async () => {
      mockGit.status.mockResolvedValue({ isClean: () => true } as any);
      mockGit.raw.mockResolvedValue("0\n");
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as jest.Mock<any>).mockRejectedValue(new Error("Not found"));

      const result = await service.getFullWorktreeStatus("/test/worktree");

      expect(result).toEqual({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        canRemove: true,
        reasons: [],
      });
    });

    it("should return complete status for dirty worktree with reasons", async () => {
      mockGit.status.mockResolvedValue({ isClean: () => false } as any);
      mockGit.raw.mockResolvedValue("3\n");
      mockGit.stashList.mockResolvedValue({ total: 1 } as any);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.stat as jest.Mock<any>).mockResolvedValue({ isFile: () => false });

      const result = await service.getFullWorktreeStatus("/test/worktree");

      expect(result.canRemove).toBe(false);
      expect(result.reasons).toContain("uncommitted changes");
      expect(result.reasons).toContain("unpushed commits");
      expect(result.reasons).toContain("stashed changes");
      expect(result.reasons).toContain("operation in progress");
    });
  });

  describe("hasUnpushedCommits", () => {
    it("should return false for detached HEAD", async () => {
      mockGit.branch.mockResolvedValue({ current: "", detached: true } as any);

      const result = await service.hasUnpushedCommits("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return true when there are unpushed commits", async () => {
      mockGit.raw.mockResolvedValue("3\n");

      const result = await service.hasUnpushedCommits("/test/worktree");

      expect(result).toBe(true);
      expect(mockGit.raw).toHaveBeenCalledWith(["rev-list", "--count", "main", "--not", "--remotes"]);
    });

    it("should use lastSyncCommit when provided", async () => {
      mockGit.raw.mockResolvedValue("2\n");

      const result = await service.hasUnpushedCommits("/test/worktree", "abc123");

      expect(result).toBe(true);
      expect(mockGit.raw).toHaveBeenCalledWith(["rev-list", "--count", "abc123..HEAD"]);
    });

    it("should return false on error", async () => {
      mockGit.raw.mockRejectedValue(new Error("Git error"));
      const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      const result = await service.hasUnpushedCommits("/test/worktree");

      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("hasUpstreamGone", () => {
    it("should return false for detached HEAD", async () => {
      mockGit.branch.mockResolvedValue({ current: "", detached: true } as any);

      const result = await service.hasUpstreamGone("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return true when upstream is deleted", async () => {
      // First call: isDetachedHead check
      // Second call: getCurrentBranch
      // Third call: branch(["-r"]) for remote branches
      mockGit.branch
        .mockResolvedValueOnce({ current: "feature", detached: false } as any)
        .mockResolvedValueOnce({ current: "feature", detached: false } as any)
        .mockResolvedValueOnce({ all: ["origin/main"], current: "" } as any);
      mockGit.raw.mockResolvedValue("origin/feature\n");

      const result = await service.hasUpstreamGone("/test/worktree");

      expect(result).toBe(true);
    });

    it("should return false when no upstream is configured", async () => {
      mockGit.raw.mockRejectedValue(new Error("fatal: no upstream configured"));

      const result = await service.hasUpstreamGone("/test/worktree");

      expect(result).toBe(false);
    });
  });

  describe("hasStashedChanges", () => {
    it("should return true when stash exists", async () => {
      mockGit.stashList.mockResolvedValue({ total: 2 } as any);

      const result = await service.hasStashedChanges("/test/worktree");

      expect(result).toBe(true);
    });

    it("should return false when no stash exists", async () => {
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);

      const result = await service.hasStashedChanges("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return true on error (conservative)", async () => {
      mockGit.stashList.mockRejectedValue(new Error("Stash error"));
      const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      const result = await service.hasStashedChanges("/test/worktree");

      expect(result).toBe(true);
      consoleSpy.mockRestore();
    });
  });

  describe("hasModifiedSubmodules", () => {
    it("should return true for modified submodules", async () => {
      mockGit.raw.mockResolvedValue("+abc123 submodule1 (modified)\n abc456 submodule2");

      const result = await service.hasModifiedSubmodules("/test/worktree");

      expect(result).toBe(true);
    });

    it("should return false for clean submodules", async () => {
      mockGit.raw.mockResolvedValue(" abc123 submodule1\n abc456 submodule2");

      const result = await service.hasModifiedSubmodules("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return false when no submodules", async () => {
      mockGit.raw.mockResolvedValue("");

      const result = await service.hasModifiedSubmodules("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return false on error", async () => {
      mockGit.raw.mockRejectedValue(new Error("No submodules"));

      const result = await service.hasModifiedSubmodules("/test/worktree");

      expect(result).toBe(false);
    });
  });

  describe("hasOperationInProgress", () => {
    it("should return true when merge is in progress", async () => {
      (fs.stat as jest.Mock<any>).mockResolvedValue({ isFile: () => false });
      (fs.access as jest.Mock<any>).mockRejectedValueOnce(new Error("Not found")).mockResolvedValueOnce(undefined);

      const result = await service.hasOperationInProgress("/test/worktree");

      expect(result).toBe(true);
      expect(fs.access).toHaveBeenCalledWith(path.join("/test/worktree", ".git", "MERGE_HEAD"));
    });

    it("should return false when no operation is in progress", async () => {
      (fs.stat as jest.Mock<any>).mockResolvedValue({ isFile: () => false });
      (fs.access as jest.Mock<any>).mockRejectedValue(new Error("Not found"));

      const result = await service.hasOperationInProgress("/test/worktree");

      expect(result).toBe(false);
    });

    it("should resolve .git file to actual git directory", async () => {
      (fs.stat as jest.Mock<any>).mockResolvedValue({ isFile: () => true });
      (fs.readFile as jest.Mock<any>).mockResolvedValue("gitdir: /real/git/dir\n");
      (fs.access as jest.Mock<any>).mockRejectedValue(new Error("Not found"));

      const result = await service.hasOperationInProgress("/test/worktree");

      expect(result).toBe(false);
      expect(fs.readFile).toHaveBeenCalledWith(path.join("/test/worktree", ".git"), "utf-8");
    });
  });

  describe("validateWorktreeForRemoval", () => {
    it("should not throw for clean worktree", async () => {
      mockGit.status.mockResolvedValue({ isClean: () => true } as any);
      mockGit.raw.mockResolvedValue("0\n");
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as jest.Mock<any>).mockRejectedValue(new Error("Not found"));

      await expect(service.validateWorktreeForRemoval("/test/worktree")).resolves.not.toThrow();
    });

    it("should throw WorktreeNotCleanError for dirty worktree", async () => {
      mockGit.status.mockResolvedValue({ isClean: () => false } as any);
      mockGit.raw.mockResolvedValue("0\n");
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as jest.Mock<any>).mockRejectedValue(new Error("Not found"));

      await expect(service.validateWorktreeForRemoval("/test/worktree")).rejects.toThrow(WorktreeNotCleanError);
    });

    it("should throw with correct reasons", async () => {
      mockGit.status.mockResolvedValue({ isClean: () => false } as any);
      mockGit.raw.mockResolvedValue("3\n");
      mockGit.stashList.mockResolvedValue({ total: 1 } as any);
      (fs.access as jest.Mock<any>).mockRejectedValue(new Error("Not found"));

      try {
        await service.validateWorktreeForRemoval("/test/worktree");
        fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorktreeNotCleanError);
        expect((error as WorktreeNotCleanError).reasons).toContain("uncommitted changes");
        expect((error as WorktreeNotCleanError).reasons).toContain("unpushed commits");
        expect((error as WorktreeNotCleanError).reasons).toContain("stashed changes");
      }
    });
  });

  describe("LFS configuration", () => {
    it("should respect skipLfs configuration", () => {
      const lfsService = new WorktreeStatusService({ skipLfs: true });

      lfsService.checkWorktreeStatus("/test/worktree");

      expect(mockGit.env).toHaveBeenCalledWith({ GIT_LFS_SKIP_SMUDGE: "1" });
    });

    it("should not set LFS env when skipLfs is false", () => {
      const lfsService = new WorktreeStatusService({ skipLfs: false });

      lfsService.checkWorktreeStatus("/test/worktree");

      expect(mockGit.env).not.toHaveBeenCalled();
    });
  });
});

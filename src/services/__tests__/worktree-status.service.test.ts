import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorktreeNotCleanError } from "../../errors";
import { WorktreeStatusService } from "../worktree-status.service";

import type { SimpleGit } from "simple-git";
import type { Mock, Mocked } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");

describe("WorktreeStatusService", () => {
  let service: WorktreeStatusService;
  let mockGit: Mocked<SimpleGit>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new WorktreeStatusService();

    mockGit = {
      status: vi.fn<any>().mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      }),
      branch: vi.fn<any>().mockResolvedValue({ current: "main", detached: false }),
      raw: vi.fn<any>().mockResolvedValue("0\n"),
      stashList: vi.fn<any>().mockResolvedValue({ total: 0 }),
      env: vi.fn<any>().mockReturnThis(),
    } as any;

    (simpleGit as unknown as Mock).mockReturnValue(mockGit);
  });

  describe("checkWorktreeStatus", () => {
    it("should return true for clean worktree", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);

      const result = await service.checkWorktreeStatus("/test/worktree");

      expect(result).toBe(true);
      expect(simpleGit).toHaveBeenCalledWith("/test/worktree");
    });

    it("should return false for worktree with modified files", async () => {
      mockGit.status.mockResolvedValue({
        modified: ["file.ts"],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);

      const result = await service.checkWorktreeStatus("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return false for worktree with deleted files", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: ["old-file.ts"],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);

      const result = await service.checkWorktreeStatus("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return false for worktree with renamed files", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [{ from: "old.ts", to: "new.ts" }],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);

      const result = await service.checkWorktreeStatus("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return false for worktree with staged files", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: ["new-file.ts"],
        conflicted: [],
        not_added: [],
      } as any);

      const result = await service.checkWorktreeStatus("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return false for worktree with conflicts", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: ["conflicted.ts"],
        not_added: [],
      } as any);

      const result = await service.checkWorktreeStatus("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return true when only gitignored untracked files exist", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [".DS_Store", "node_modules/file.js"],
      } as any);
      mockGit.raw.mockResolvedValue(".DS_Store\nnode_modules/file.js\n");

      const result = await service.checkWorktreeStatus("/test/worktree");

      expect(result).toBe(true);
      expect(mockGit.raw).toHaveBeenCalledWith(["check-ignore", "--", ".DS_Store", "node_modules/file.js"]);
    });

    it("should return false when untracked files are not gitignored", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: ["new-file.ts", ".DS_Store"],
      } as any);
      mockGit.raw.mockResolvedValue(".DS_Store\n");

      const result = await service.checkWorktreeStatus("/test/worktree");

      expect(result).toBe(false);
      expect(mockGit.raw).toHaveBeenCalledWith(["check-ignore", "--", "new-file.ts", ".DS_Store"]);
    });

    it("should handle git check-ignore returning all files not ignored", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: ["file1.ts", "file2.ts"],
      } as any);
      mockGit.raw.mockRejectedValue(new Error("Command failed: exit code: 1"));

      const result = await service.checkWorktreeStatus("/test/worktree");

      expect(result).toBe(false);
    });

    it("should handle git check-ignore errors gracefully", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: ["file.txt"],
      } as any);
      mockGit.raw.mockRejectedValue(new Error("check-ignore failed"));
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await service.checkWorktreeStatus("/test/worktree");

      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Warning: Could not check gitignore status"));
      consoleSpy.mockRestore();
    });
  });

  describe("getFullWorktreeStatus", () => {
    it("should return complete status for clean worktree", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockResolvedValue("0\n");
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as Mock<any>).mockRejectedValue(new Error("Not found"));

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
      mockGit.status.mockResolvedValue({
        modified: ["file.ts"],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockResolvedValue("3\n");
      mockGit.stashList.mockResolvedValue({ total: 1 } as any);
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });

      const result = await service.getFullWorktreeStatus("/test/worktree");

      expect(result.canRemove).toBe(false);
      expect(result.reasons).toContain("uncommitted changes");
      expect(result.reasons).toContain("unpushed commits");
      expect(result.reasons).toContain("stashed changes");
      expect(result.reasons).toContain("operation in progress");
    });

    it("should treat worktree as clean when only gitignored files exist", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [".DS_Store"],
      } as any);
      mockGit.raw.mockResolvedValueOnce(".DS_Store\n").mockResolvedValueOnce("0\n");
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as Mock<any>).mockRejectedValue(new Error("Not found"));

      const result = await service.getFullWorktreeStatus("/test/worktree");

      expect(result.isClean).toBe(true);
      expect(result.canRemove).toBe(true);
      expect(result.reasons).toEqual([]);
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
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });
      (fs.access as Mock<any>).mockRejectedValueOnce(new Error("Not found")).mockResolvedValueOnce(undefined);

      const result = await service.hasOperationInProgress("/test/worktree");

      expect(result).toBe(true);
      expect(fs.access).toHaveBeenCalledWith(path.join("/test/worktree", ".git", "MERGE_HEAD"));
    });

    it("should return false when no operation is in progress", async () => {
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });
      (fs.access as Mock<any>).mockRejectedValue(new Error("Not found"));

      const result = await service.hasOperationInProgress("/test/worktree");

      expect(result).toBe(false);
    });

    it("should resolve .git file to actual git directory", async () => {
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => true });
      (fs.readFile as Mock<any>).mockResolvedValue("gitdir: /real/git/dir\n");
      (fs.access as Mock<any>).mockRejectedValue(new Error("Not found"));

      const result = await service.hasOperationInProgress("/test/worktree");

      expect(result).toBe(false);
      expect(fs.readFile).toHaveBeenCalledWith(path.join("/test/worktree", ".git"), "utf-8");
    });
  });

  describe("validateWorktreeForRemoval", () => {
    it("should not throw for clean worktree", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockResolvedValue("0\n");
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as Mock<any>).mockRejectedValue(new Error("Not found"));

      await expect(service.validateWorktreeForRemoval("/test/worktree")).resolves.not.toThrow();
    });

    it("should throw WorktreeNotCleanError for dirty worktree", async () => {
      mockGit.status.mockResolvedValue({
        modified: ["file.ts"],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockResolvedValue("0\n");
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as Mock<any>).mockRejectedValue(new Error("Not found"));

      await expect(service.validateWorktreeForRemoval("/test/worktree")).rejects.toThrow(WorktreeNotCleanError);
    });

    it("should throw with correct reasons", async () => {
      mockGit.status.mockResolvedValue({
        modified: ["file.ts"],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockResolvedValue("3\n");
      mockGit.stashList.mockResolvedValue({ total: 1 } as any);
      (fs.access as Mock<any>).mockRejectedValue(new Error("Not found"));

      try {
        await service.validateWorktreeForRemoval("/test/worktree");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorktreeNotCleanError);
        expect((error as WorktreeNotCleanError).reasons).toContain("uncommitted changes");
        expect((error as WorktreeNotCleanError).reasons).toContain("unpushed commits");
        expect((error as WorktreeNotCleanError).reasons).toContain("stashed changes");
      }
    });

    it("should not throw for worktree with only gitignored files", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [".DS_Store"],
      } as any);
      mockGit.raw.mockResolvedValueOnce(".DS_Store\n").mockResolvedValueOnce("0\n");
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as Mock<any>).mockRejectedValue(new Error("Not found"));

      await expect(service.validateWorktreeForRemoval("/test/worktree")).resolves.not.toThrow();
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

  describe("getStatusDetails", () => {
    it("should return detailed status information", async () => {
      mockGit.status.mockResolvedValue({
        modified: ["file1.ts", "file2.ts"],
        deleted: ["file3.ts"],
        renamed: [{ from: "old.ts", to: "new.ts" }],
        created: ["file4.ts"],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockResolvedValueOnce("5\n");
      mockGit.stashList.mockResolvedValue({ total: 2 } as any);
      (fs.access as Mock<any>).mockRejectedValue(new Error("Not found"));

      const details = await service.getStatusDetails("/test/worktree");

      expect(details.modifiedFiles).toBe(2);
      expect(details.deletedFiles).toBe(1);
      expect(details.renamedFiles).toBe(1);
      expect(details.createdFiles).toBe(1);
      expect(details.conflictedFiles).toBe(0);
      expect(details.untrackedFiles).toBe(0);
      expect(details.unpushedCommitCount).toBe(5);
      expect(details.stashCount).toBe(2);
    });

    it("should include untracked files that are not ignored", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: ["tracked.ts", ".DS_Store"],
      } as any);
      mockGit.raw.mockResolvedValueOnce(".DS_Store\n").mockResolvedValueOnce("0\n");
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as Mock<any>).mockRejectedValue(new Error("Not found"));

      const details = await service.getStatusDetails("/test/worktree");

      expect(details.untrackedFiles).toBe(1);
    });

    it("should detect operation in progress", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockResolvedValueOnce("0\n");
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as Mock<any>).mockImplementation((p: unknown) => {
        if (typeof p === "string" && p.includes("MERGE_HEAD")) {
          return Promise.resolve();
        }
        return Promise.reject(new Error("Not found"));
      });
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });

      const details = await service.getStatusDetails("/test/worktree");

      expect(details.operationType).toBe("merge");
    });

    it("should detect modified submodules", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw
        .mockResolvedValueOnce("0\n")
        .mockResolvedValueOnce("+abc123 submodule1\n-def456 submodule2\n cba987 submodule3");
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as Mock<any>).mockRejectedValue(new Error("Not found"));

      const details = await service.getStatusDetails("/test/worktree");

      expect(details.modifiedSubmodules).toEqual(["abc123", "def456"]);
    });
  });

  describe("getFullWorktreeStatus with includeDetails", () => {
    it("should include details when includeDetails is true", async () => {
      mockGit.status.mockResolvedValue({
        modified: ["file1.ts"],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockResolvedValue("2\n");
      mockGit.stashList.mockResolvedValue({ total: 1 } as any);
      (fs.access as Mock<any>).mockRejectedValue(new Error("Not found"));

      const status = await service.getFullWorktreeStatus("/test/worktree", true);

      expect(status.details).toBeDefined();
      expect(status.details?.modifiedFiles).toBe(1);
      expect(status.details?.unpushedCommitCount).toBe(2);
      expect(status.details?.stashCount).toBe(1);
    });

    it("should not include details when includeDetails is false", async () => {
      mockGit.status.mockResolvedValue({
        modified: ["file1.ts"],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockResolvedValue("2\n");
      mockGit.stashList.mockResolvedValue({ total: 1 } as any);
      (fs.access as Mock<any>).mockRejectedValue(new Error("Not found"));

      const status = await service.getFullWorktreeStatus("/test/worktree", false);

      expect(status.details).toBeUndefined();
    });
  });
});

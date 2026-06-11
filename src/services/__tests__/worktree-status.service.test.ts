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

    it.each([
      { field: "modified", value: ["file.ts"] },
      { field: "deleted", value: ["old-file.ts"] },
      { field: "renamed", value: [{ from: "old.ts", to: "new.ts" }] },
      { field: "created", value: ["new-file.ts"] },
      { field: "conflicted", value: ["conflicted.ts"] },
    ])("should return false for worktree with $field files", async ({ field, value }) => {
      const status = {
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
        [field]: value,
      };
      mockGit.status.mockResolvedValue(status as any);

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

      await expect(service.checkWorktreeStatus("/test/worktree")).rejects.toThrow("check-ignore failed");
      consoleSpy.mockRestore();
    });
  });

  describe("getFullWorktreeStatus", () => {
    it("should return safe-to-remove status when directory does not exist", async () => {
      (fs.access as Mock<any>).mockRejectedValue(
        Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
      );

      const result = await service.getFullWorktreeStatus("/test/nonexistent-worktree");

      expect(result).toMatchObject({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        canRemove: true,
        reasons: [],
      });
      expect(simpleGit).not.toHaveBeenCalledWith("/test/nonexistent-worktree");
    });

    it("should return complete status for clean worktree", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg[0] === "rev-parse" && firstArg[1] === "--abbrev-ref") {
          return "origin/main\n";
        }
        if (firstArg[0] === "submodule") {
          return "";
        }
        return "0\n";
      }) as any);
      mockGit.branch.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg && firstArg[0] === "-r") {
          return { all: ["origin/main"] } as any;
        }
        return { current: "main", detached: false } as any;
      }) as any);
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      const result = await service.getFullWorktreeStatus("/test/worktree");

      expect(result).toMatchObject({
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
      expect(result.reasons).toContain("operation in progress");
    });

    it("should treat stashed changes as unsafe to remove", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg[0] === "rev-parse" && firstArg[1] === "--abbrev-ref") {
          return "origin/main\n";
        }
        if (firstArg[0] === "submodule") {
          return "";
        }
        return "0\n";
      }) as any);
      mockGit.branch.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg && firstArg[0] === "-r") {
          return { all: ["origin/main"] } as any;
        }
        return { current: "main", detached: false } as any;
      }) as any);
      mockGit.stashList.mockResolvedValue({ total: 1 } as any);
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });
      (fs.access as Mock<any>).mockImplementation(async (target: unknown) => {
        if (target === "/test/worktree") return undefined;
        throw Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" });
      });

      const result = await service.getFullWorktreeStatus("/test/worktree");

      expect(result.isClean).toBe(true);
      expect(result.hasStashedChanges).toBe(true);
      expect(result.canRemove).toBe(false);
      expect(result.reasons).toEqual(["stashed changes"]);
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
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg[0] === "check-ignore") return ".DS_Store\n";
        if (firstArg[0] === "submodule") return "";
        return "0\n";
      }) as any);
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      const result = await service.getFullWorktreeStatus("/test/worktree");

      expect(result.isClean).toBe(true);
      expect(result.canRemove).toBe(true);
      expect(result.reasons).toEqual([]);
    });
  });

  describe("hasUnpushedCommits", () => {
    it("should return true for detached HEAD (may sit on unreachable commits)", async () => {
      mockGit.branch.mockResolvedValue({ current: "", detached: true } as any);

      const result = await service.hasUnpushedCommits("/test/worktree");

      expect(result).toBe(true);
    });

    it("should return true when there are unpushed commits", async () => {
      mockGit.raw.mockResolvedValue("3\n");

      const result = await service.hasUnpushedCommits("/test/worktree");

      expect(result).toBe(true);
      expect(mockGit.raw).toHaveBeenCalledWith(["rev-list", "--count", "main", "--not", "--remotes"]);
    });

    it("should also check lastSyncCommit in addition to the any-remote check", async () => {
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg.includes("--remotes")) return "0\n";
        return "2\n";
      }) as any);

      const result = await service.hasUnpushedCommits("/test/worktree", "abc123");

      expect(result).toBe(true);
      expect(mockGit.raw).toHaveBeenCalledWith(["rev-list", "--count", "main", "--not", "--remotes"]);
      expect(mockGit.raw).toHaveBeenCalledWith(["rev-list", "--count", "abc123..HEAD"]);
    });

    it("should return true on error (conservative)", async () => {
      mockGit.raw.mockRejectedValue(new Error("Git error"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await service.hasUnpushedCommits("/test/worktree");

      expect(result).toBe(true);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should return true on unexpected hasUpstreamGone error (conservative)", async () => {
      mockGit.raw.mockRejectedValue(new Error("Unexpected git failure"));
      mockGit.branch
        .mockResolvedValueOnce({ current: "feature", detached: false } as any)
        .mockResolvedValueOnce({ current: "feature", detached: false } as any);

      const result = await service.hasUpstreamGone("/test/worktree");

      expect(result).toBe(true);
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

    it("should return true on error (conservative)", async () => {
      mockGit.raw.mockRejectedValue(new Error("No submodules"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await service.hasModifiedSubmodules("/test/worktree");

      expect(result).toBe(true);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("hasOperationInProgress", () => {
    it("should return true when merge is in progress", async () => {
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });
      (fs.access as Mock<any>)
        .mockRejectedValueOnce(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }))
        .mockResolvedValueOnce(undefined);

      const result = await service.hasOperationInProgress("/test/worktree");

      expect(result).toBe(true);
      expect(fs.access).toHaveBeenCalledWith(path.join("/test/worktree", ".git", "MERGE_HEAD"));
    });

    it("should return false when no operation is in progress", async () => {
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });
      (fs.access as Mock<any>).mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      const result = await service.hasOperationInProgress("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return true on outer error (conservative)", async () => {
      (fs.stat as Mock<any>).mockRejectedValue(new Error("Cannot access .git"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await service.hasOperationInProgress("/test/worktree");

      expect(result).toBe(true);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should resolve .git file to actual git directory", async () => {
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => true });
      (fs.readFile as Mock<any>).mockResolvedValue("gitdir: /real/git/dir\n");
      (fs.access as Mock<any>).mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

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
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

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
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

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
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      try {
        await service.validateWorktreeForRemoval("/test/worktree");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorktreeNotCleanError);
        expect((error as WorktreeNotCleanError).reasons).toContain("uncommitted changes");
        expect((error as WorktreeNotCleanError).reasons).toContain("unpushed commits");
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
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg[0] === "check-ignore") return ".DS_Store\n";
        if (firstArg[0] === "submodule") return "";
        return "0\n";
      }) as any);
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      await expect(service.validateWorktreeForRemoval("/test/worktree")).resolves.not.toThrow();
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
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

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
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      const status = await service.getFullWorktreeStatus("/test/worktree", false);

      expect(status.details).toBeUndefined();
    });

    it("should use lastSyncCommit parameter when provided", async () => {
      mockGit.status.mockResolvedValue({
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      } as any);
      mockGit.raw.mockResolvedValue("2\n");
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      const status = await service.getFullWorktreeStatus("/test/worktree", false, "abc123");

      expect(status.hasUnpushedCommits).toBe(true);
      expect(mockGit.raw).toHaveBeenCalledWith(["rev-list", "--count", "abc123..HEAD"]);
    });

    it("should not report false positive for stale branch with lastSyncCommit", async () => {
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
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      const status = await service.getFullWorktreeStatus("/test/worktree", false, "lastSyncCommit123");

      expect(status.hasUnpushedCommits).toBe(false);
      expect(status.canRemove).toBe(true);
      expect(mockGit.raw).toHaveBeenCalledWith(["rev-list", "--count", "lastSyncCommit123..HEAD"]);
    });
  });

  // Removal-safety regression tests: a worktree with an unpushed
  // commit was removed by the age-based prune. Every ambiguous probe result
  // must read as "cannot verify => cannot remove".
  describe("fail-closed removal safety", () => {
    const errnoError = (code: string): NodeJS.ErrnoException =>
      Object.assign(new Error(`${code}: probe failed`), { code });

    const cleanStatus = {
      modified: [],
      deleted: [],
      renamed: [],
      created: [],
      conflicted: [],
      not_added: [],
    };

    const setupCleanWorktreeMocks = (): void => {
      mockGit.status.mockResolvedValue(cleanStatus as any);
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg[0] === "rev-parse" && firstArg[1] === "--abbrev-ref") {
          return "origin/main\n";
        }
        if (firstArg[0] === "submodule") {
          return "";
        }
        return "0\n";
      }) as any);
      mockGit.branch.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg && firstArg[0] === "-r") {
          return { all: ["origin/main"] } as any;
        }
        return { current: "main", detached: false } as any;
      }) as any);
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });
      (fs.access as Mock<any>).mockResolvedValueOnce(undefined).mockRejectedValue(errnoError("ENOENT"));
    };

    it("must not report removable when the worktree path check fails with EMFILE", async () => {
      (fs.access as Mock<any>).mockRejectedValue(errnoError("EMFILE"));

      const result = await service.getFullWorktreeStatus("/test/worktree");

      expect(result.canRemove).toBe(false);
      expect(result.hasUnpushedCommits).toBe(true);
      expect(result.reasons.length).toBeGreaterThan(0);
    });

    it("still reports removable when the worktree path is genuinely missing (ENOENT)", async () => {
      (fs.access as Mock<any>).mockRejectedValue(errnoError("ENOENT"));

      const result = await service.getFullWorktreeStatus("/test/worktree");

      expect(result.canRemove).toBe(true);
    });

    it("must not report a detached-HEAD worktree as removable", async () => {
      setupCleanWorktreeMocks();
      mockGit.branch.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg && firstArg[0] === "-r") {
          return { all: ["origin/main"] } as any;
        }
        return { current: "", detached: true } as any;
      }) as any);

      const result = await service.getFullWorktreeStatus("/test/worktree");

      expect(result.canRemove).toBe(false);
      expect(result.reasons).toContain("detached HEAD");
    });

    it("must block removal when commits are missing from all remotes even if lastSyncCommit == HEAD", async () => {
      setupCleanWorktreeMocks();
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg[0] === "rev-parse" && firstArg[1] === "--abbrev-ref") {
          return "origin/main\n";
        }
        if (firstArg[0] === "submodule") {
          return "";
        }
        if (firstArg[0] === "rev-list" && firstArg.includes("--remotes")) {
          return "1\n";
        }
        return "0\n";
      }) as any);

      const status = await service.getFullWorktreeStatus("/test/worktree", false, "headCommitSha");

      expect(mockGit.raw).toHaveBeenCalledWith(["rev-list", "--count", "main", "--not", "--remotes"]);
      expect(status.hasUnpushedCommits).toBe(true);
      expect(status.canRemove).toBe(false);
    });

    it("must report an operation in progress when operation-file probes fail with EMFILE", async () => {
      setupCleanWorktreeMocks();
      (fs.access as Mock<any>).mockImplementation(async (target: unknown) => {
        if (target === "/test/worktree") return undefined;
        throw errnoError("EMFILE");
      });

      const result = await service.getFullWorktreeStatus("/test/worktree");

      expect(result.hasOperationInProgress).toBe(true);
      expect(result.canRemove).toBe(false);
    });

    it("still allows removal of a genuinely clean, fully pushed worktree with lastSyncCommit", async () => {
      setupCleanWorktreeMocks();

      const status = await service.getFullWorktreeStatus("/test/worktree", false, "abc123");

      expect(status.hasUnpushedCommits).toBe(false);
      expect(status.canRemove).toBe(true);
    });
  });

  // Squash-merge + remote branch deletion: commits read as "unpushed" via
  // rev-list, but metadata recorded the upstream tip while the ref existed.
  // HEAD being an ancestor of that tip proves every local commit was pushed.
  describe("fullyPushedUpstreamDeleted", () => {
    const recordedTip = { ref: "origin/feature", oid: "squashtip123", recordedAt: "2026-06-01T00:00:00.000Z" };

    const cleanStatus = {
      modified: [],
      deleted: [],
      renamed: [],
      created: [],
      conflicted: [],
      not_added: [],
    };

    const setupGoneUpstreamWorktree = (opts: { headIsAncestorOfTip: boolean; remoteBranches?: string[] }): void => {
      mockGit.status.mockResolvedValue(cleanStatus as any);
      mockGit.branch.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg && firstArg[0] === "-r") {
          return { all: opts.remoteBranches ?? ["origin/main"] } as any;
        }
        return { current: "feature", detached: false } as any;
      }) as any);
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg[0] === "rev-parse" && firstArg[1] === "--abbrev-ref") {
          throw new Error("fatal: ambiguous argument 'feature@{upstream}': unknown revision or path");
        }
        if (firstArg[0] === "rev-list" && firstArg[2] === "squashtip123..HEAD") {
          return opts.headIsAncestorOfTip ? "0\n" : "5\n";
        }
        if (firstArg[0] === "rev-list") return "39\n";
        if (firstArg[0] === "submodule") return "";
        return "0\n";
      }) as any);
      mockGit.stashList.mockResolvedValue({ total: 0 } as any);
      (fs.stat as Mock<any>).mockResolvedValue({ isFile: () => false });
      (fs.access as Mock<any>).mockImplementation(async (target: unknown) => {
        if (target === "/test/worktree") return undefined;
        throw Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" });
      });
    };

    it("allows removal when the recorded ref is gone and HEAD is an ancestor of the recorded tip", async () => {
      setupGoneUpstreamWorktree({ headIsAncestorOfTip: true });

      const status = await service.getFullWorktreeStatus("/test/worktree", false, undefined, recordedTip);

      expect(mockGit.raw).toHaveBeenCalledWith(["rev-list", "--count", "squashtip123..HEAD"]);
      expect(status.hasUnpushedCommits).toBe(true);
      expect(status.fullyPushedUpstreamDeleted).toBe(true);
      expect(status.canRemove).toBe(true);
      expect(status.reasons).not.toContain("unpushed commits");
    });

    it("blocks removal when no recorded tip exists (pre-feature worktree, lost metadata)", async () => {
      setupGoneUpstreamWorktree({ headIsAncestorOfTip: true });

      const status = await service.getFullWorktreeStatus("/test/worktree", false, undefined, undefined);

      expect(status.fullyPushedUpstreamDeleted).toBe(false);
      expect(status.canRemove).toBe(false);
      expect(status.reasons).toContain("unpushed commits");
    });

    it("blocks removal when commits were added after the upstream deletion (HEAD not an ancestor)", async () => {
      setupGoneUpstreamWorktree({ headIsAncestorOfTip: false });

      const status = await service.getFullWorktreeStatus("/test/worktree", false, undefined, recordedTip);

      expect(status.fullyPushedUpstreamDeleted).toBe(false);
      expect(status.canRemove).toBe(false);
      expect(status.reasons).toContain("unpushed commits");
    });

    it("fails closed when the recorded oid no longer resolves (gc'd away)", async () => {
      setupGoneUpstreamWorktree({ headIsAncestorOfTip: true });
      mockGit.raw.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg[0] === "rev-parse" && firstArg[1] === "--abbrev-ref") {
          throw new Error("fatal: ambiguous argument 'feature@{upstream}': unknown revision or path");
        }
        if (firstArg[0] === "rev-list" && firstArg[2] === "squashtip123..HEAD") {
          throw new Error("fatal: bad revision 'squashtip123..HEAD'");
        }
        if (firstArg[0] === "rev-list") return "39\n";
        if (firstArg[0] === "submodule") return "";
        return "0\n";
      }) as any);

      const status = await service.getFullWorktreeStatus("/test/worktree", false, undefined, recordedTip);

      expect(status.fullyPushedUpstreamDeleted).toBe(false);
      expect(status.canRemove).toBe(false);
    });

    it("does not apply the override while the recorded ref still exists on the remote (force-push case)", async () => {
      setupGoneUpstreamWorktree({ headIsAncestorOfTip: true, remoteBranches: ["origin/main", "origin/feature"] });

      const status = await service.getFullWorktreeStatus("/test/worktree", false, undefined, recordedTip);

      expect(status.fullyPushedUpstreamDeleted).toBe(false);
      expect(status.canRemove).toBe(false);
    });

    it("fails closed when the remote branch list is empty (fetch may have failed)", async () => {
      setupGoneUpstreamWorktree({ headIsAncestorOfTip: true, remoteBranches: [] });

      const status = await service.getFullWorktreeStatus("/test/worktree", false, undefined, recordedTip);

      expect(status.fullyPushedUpstreamDeleted).toBe(false);
      expect(status.canRemove).toBe(false);
    });

    it("never applies the override to a detached HEAD", async () => {
      setupGoneUpstreamWorktree({ headIsAncestorOfTip: true });
      mockGit.branch.mockImplementation((async (...args: any[]) => {
        const firstArg = Array.isArray(args[0]) ? args[0] : args;
        if (firstArg && firstArg[0] === "-r") {
          return { all: ["origin/main"] } as any;
        }
        return { current: "", detached: true } as any;
      }) as any);

      const status = await service.getFullWorktreeStatus("/test/worktree", false, undefined, recordedTip);

      expect(status.fullyPushedUpstreamDeleted).toBe(false);
      expect(status.canRemove).toBe(false);
      expect(status.reasons).toContain("detached HEAD");
    });

    it("validateWorktreeForRemoval accepts a fully-pushed worktree with the recorded tip", async () => {
      setupGoneUpstreamWorktree({ headIsAncestorOfTip: true });

      await expect(service.validateWorktreeForRemoval("/test/worktree", undefined, recordedTip)).resolves.not.toThrow();
    });

    it("validateWorktreeForRemoval still rejects without the recorded tip", async () => {
      setupGoneUpstreamWorktree({ headIsAncestorOfTip: true });

      await expect(service.validateWorktreeForRemoval("/test/worktree")).rejects.toThrow(WorktreeNotCleanError);
    });
  });
});

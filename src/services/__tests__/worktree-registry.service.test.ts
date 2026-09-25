import * as fs from "fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createWorktreeListOutput } from "../../__tests__/test-utils";
import { WorktreeNotCleanError } from "../../errors";

import { createGitServiceFixture } from "./helpers/git-service-fixture";

import type { GitService } from "../git.service";
import type { SimpleGit } from "simple-git";
import type { Mock, Mocked } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");
vi.mock("../worktree-metadata.service", async () =>
  (await import("./helpers/metadata-service-mock")).worktreeMetadataServiceModuleMock(),
);

describe("WorktreeRegistryService (through GitService)", () => {
  let gitService: GitService;
  let mockGit: Mocked<SimpleGit>;
  let mockMetadataService: any;

  beforeEach(() => {
    ({ gitService, mockGit, mockMetadataService } = createGitServiceFixture());
  });

  // Removal-safety regression tests: --force bypassed git's own
  // refusal to delete dirty worktrees, and stale-directory cleanup could
  // destroy a live checkout.
  describe("removeWorktree safety", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
      (mockGit.raw as Mock).mockClear();
    });

    it("removes without --force by default so git can refuse dirty worktrees", async () => {
      (mockGit.raw as Mock).mockResolvedValue("");

      await gitService.removeWorktree("/test/worktrees/feature-1");

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "remove", "/test/worktrees/feature-1"]);
    });

    it("passes --force only when explicitly requested", async () => {
      (mockGit.raw as Mock).mockResolvedValue("");

      await gitService.removeWorktree("/test/worktrees/feature-1", { force: true });

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "remove", "/test/worktrees/feature-1", "--force"]);
    });

    it("surfaces git's refusal as WorktreeNotCleanError and keeps metadata", async () => {
      (mockGit.raw as Mock).mockRejectedValue(
        new Error("fatal: '/test/worktrees/feature-1' contains modified or untracked files, use --force to delete it"),
      );

      await expect(gitService.removeWorktree("/test/worktrees/feature-1")).rejects.toBeInstanceOf(
        WorktreeNotCleanError,
      );
      expect(mockMetadataService.deleteMetadataFromPath).not.toHaveBeenCalled();
    });

    // A worktree the user locked is not a broken removal: git refuses it even
    // with a single --force, and `-f -f` would defeat the lock, so the caller
    // has to see a skip rather than a hard failure on every tick.
    it("classifies git's locked-worktree refusal as WorktreeNotCleanError, forced or not", async () => {
      (mockGit.raw as Mock).mockRejectedValue(
        new Error(
          "fatal: cannot remove a locked working tree, lock reason: demo box\nuse 'remove -f -f' to override or unlock first",
        ),
      );

      await expect(gitService.removeWorktree("/test/worktrees/feature-1")).rejects.toBeInstanceOf(
        WorktreeNotCleanError,
      );
      await expect(gitService.removeWorktree("/test/worktrees/feature-1", { force: true })).rejects.toBeInstanceOf(
        WorktreeNotCleanError,
      );
      expect(mockMetadataService.deleteMetadataFromPath).not.toHaveBeenCalled();
    });

    it("classifies git's submodule refusal as WorktreeNotCleanError", async () => {
      (mockGit.raw as Mock).mockRejectedValue(
        new Error("fatal: working trees containing submodules cannot be moved or removed"),
      );

      await expect(gitService.removeWorktree("/test/worktrees/feature-1")).rejects.toBeInstanceOf(
        WorktreeNotCleanError,
      );
      expect(mockMetadataService.deleteMetadataFromPath).not.toHaveBeenCalled();
    });

    it("still rethrows a genuine git failure untouched", async () => {
      (mockGit.raw as Mock).mockRejectedValue(new Error("fatal: not a git repository"));

      await expect(gitService.removeWorktree("/test/worktrees/feature-1")).rejects.toThrow("not a git repository");
      await expect(gitService.removeWorktree("/test/worktrees/feature-1")).rejects.not.toBeInstanceOf(
        WorktreeNotCleanError,
      );
    });
  });

  describe("getWorktrees", () => {
    it("should parse worktree list output correctly", async () => {
      await gitService.initialize();

      const worktreeData = [
        { path: "/path/to/repo", branch: "main", commit: "abc123" },
        { path: "/path/to/worktrees/feature-1", branch: "feature-1", commit: "def456" },
        { path: "/path/to/worktrees/feature-2", branch: "feature-2", commit: "ghi789" },
      ];
      mockGit.raw.mockResolvedValue(createWorktreeListOutput(worktreeData));

      const worktrees = await gitService.getWorktrees();

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "list", "--porcelain", "-z"]);
      // The HEAD oid git prints for each worktree is carried through: the
      // update phase compares it against origin's tip to decide, without a
      // per-worktree probe, that nothing changed.
      expect(worktrees).toEqual([
        { path: "/path/to/repo", branch: "main", isPrunable: false, locked: false, head: "abc123" },
        { path: "/path/to/worktrees/feature-1", branch: "feature-1", isPrunable: false, locked: false, head: "def456" },
        { path: "/path/to/worktrees/feature-2", branch: "feature-2", isPrunable: false, locked: false, head: "ghi789" },
      ]);
    });

    it("should handle worktree list with no trailing newline", async () => {
      await gitService.initialize();

      mockGit.raw.mockResolvedValue(`worktree /path/to/repo
branch refs/heads/main

worktree /path/to/worktrees/feature-1
branch refs/heads/feature-1`);

      const worktrees = await gitService.getWorktrees();

      expect(worktrees).toEqual([
        { path: "/path/to/repo", branch: "main", isPrunable: false, locked: false },
        { path: "/path/to/worktrees/feature-1", branch: "feature-1", isPrunable: false, locked: false },
      ]);
    });

    it("should handle empty worktree list", async () => {
      await gitService.initialize();

      mockGit.raw.mockResolvedValue("");

      const worktrees = await gitService.getWorktrees();

      expect(worktrees).toEqual([]);
    });

    it("should skip worktrees without branch info", async () => {
      await gitService.initialize();

      mockGit.raw.mockResolvedValue(`worktree /path/to/repo
branch refs/heads/main

worktree /path/to/worktrees/detached

worktree /path/to/worktrees/feature-1
branch refs/heads/feature-1
`);

      const worktrees = await gitService.getWorktrees();

      expect(worktrees).toEqual([
        { path: "/path/to/repo", branch: "main", isPrunable: false, locked: false },
        { path: "/path/to/worktrees/feature-1", branch: "feature-1", isPrunable: false, locked: false },
      ]);
    });

    it("should skip worktrees in detached HEAD state", async () => {
      await gitService.initialize();

      mockGit.raw.mockResolvedValue(`worktree /path/to/repo
branch refs/heads/main

worktree /path/to/worktrees/feature-1
branch refs/heads/feature-1

worktree /path/to/worktrees/detached
detached

worktree /path/to/worktrees/feature-2
branch refs/heads/feature-2`);

      const worktrees = await gitService.getWorktrees();

      expect(worktrees).toEqual([
        { path: "/path/to/repo", branch: "main", isPrunable: false, locked: false },
        { path: "/path/to/worktrees/feature-1", branch: "feature-1", isPrunable: false, locked: false },
        { path: "/path/to/worktrees/feature-2", branch: "feature-2", isPrunable: false, locked: false },
      ]);
    });

    it("should detect prunable worktrees", async () => {
      await gitService.initialize();

      mockGit.raw.mockResolvedValue(`worktree /path/to/repo
branch refs/heads/main

worktree /path/to/worktrees/feature-1
branch refs/heads/feature-1

worktree /path/to/worktrees/stale-worktree
branch refs/heads/stale-branch
prunable

worktree /path/to/worktrees/feature-2
branch refs/heads/feature-2`);

      const worktrees = await gitService.getWorktrees();

      expect(worktrees).toEqual([
        { path: "/path/to/repo", branch: "main", isPrunable: false, locked: false },
        { path: "/path/to/worktrees/feature-1", branch: "feature-1", isPrunable: false, locked: false },
        { path: "/path/to/worktrees/stale-worktree", branch: "stale-branch", isPrunable: true, locked: false },
        { path: "/path/to/worktrees/feature-2", branch: "feature-2", isPrunable: false, locked: false },
      ]);
    });

    it("should handle mixed prunable and valid worktrees", async () => {
      await gitService.initialize();

      mockGit.raw.mockResolvedValue(`worktree /path/to/repo
branch refs/heads/main

worktree /path/to/worktrees/incomplete
branch refs/heads/incomplete-branch
prunable
`);

      const worktrees = await gitService.getWorktrees();

      expect(worktrees).toEqual([
        { path: "/path/to/repo", branch: "main", isPrunable: false, locked: false },
        { path: "/path/to/worktrees/incomplete", branch: "incomplete-branch", isPrunable: true, locked: false },
      ]);
    });

    // The lock flag is what keeps a worktree the user protected out of the
    // prune pipeline entirely, so it has to survive the listing.
    it("should surface locked worktrees and their lock reason", async () => {
      await gitService.initialize();

      mockGit.raw.mockResolvedValue(`worktree /path/to/repo
branch refs/heads/main

worktree /path/to/worktrees/pinned
branch refs/heads/pinned
locked demo box

worktree /path/to/worktrees/held
branch refs/heads/held
locked
`);

      const worktrees = await gitService.getWorktrees();

      expect(worktrees).toEqual([
        { path: "/path/to/repo", branch: "main", isPrunable: false, locked: false },
        {
          path: "/path/to/worktrees/pinned",
          branch: "pinned",
          isPrunable: false,
          locked: true,
          lockReason: "demo box",
        },
        { path: "/path/to/worktrees/held", branch: "held", isPrunable: false, locked: true },
      ]);
    });

    // `includeDetached` exists for callers that must *find* a worktree rather
    // than act on its branch — MCP membership checks, which otherwise report a
    // registered detached path as one this repository does not have.
    it("returns detached worktrees, flagged and with their HEAD, when asked", async () => {
      await gitService.initialize();

      mockGit.raw.mockResolvedValue(`worktree /path/to/repo.git
bare

worktree /path/to/worktrees/feature-1
HEAD def456
branch refs/heads/feature-1

worktree /path/to/worktrees/loose
HEAD abc123
detached

worktree /path/to/worktrees/gone
HEAD 0ff123
detached
prunable gitdir file points to non-existent location
`);

      const worktrees = await gitService.getWorktrees({ includeDetached: true });

      // The bare repository's own row has neither a branch nor a detached
      // HEAD. It stays out: its `branch` would be the empty string, and a
      // caller that fetched or merged that would be fetching `origin/`. The
      // prunable detached row stays out too: its checkout is gone, so naming
      // it "detached, check out a branch" points at a directory that is not
      // there, and the rest of this service already reads prunable as absent.
      expect(worktrees).toEqual([
        { path: "/path/to/worktrees/feature-1", branch: "feature-1", isPrunable: false, locked: false, head: "def456" },
        {
          path: "/path/to/worktrees/loose",
          branch: "",
          isPrunable: false,
          locked: false,
          detached: true,
          head: "abc123",
        },
      ]);

      // Default and explicit-false stay the branch-only listing.
      expect(await gitService.getWorktrees()).toEqual(await gitService.getWorktrees({ includeDetached: false }));
      expect((await gitService.getWorktrees()).map((w) => w.path)).toEqual(["/path/to/worktrees/feature-1"]);
    });
  });

  describe("getWorktreeLock", () => {
    beforeEach(async () => {
      await gitService.initialize();
    });

    it("reports the lock and its reason for a locked registration", async () => {
      mockGit.raw.mockResolvedValue(`worktree /path/to/worktrees/pinned
branch refs/heads/pinned
locked demo box
`);

      await expect(gitService.getWorktreeLock("/path/to/worktrees/pinned")).resolves.toEqual({
        locked: true,
        reason: "demo box",
      });
    });

    it("reports unlocked for an unregistered path and for a listing that fails", async () => {
      mockGit.raw.mockResolvedValue(`worktree /path/to/worktrees/pinned
branch refs/heads/pinned
locked
`);
      await expect(gitService.getWorktreeLock("/path/to/worktrees/other")).resolves.toEqual({ locked: false });

      mockGit.raw.mockRejectedValue(new Error("fatal: not a git repository"));
      await expect(gitService.getWorktreeLock("/path/to/worktrees/pinned")).resolves.toEqual({ locked: false });
    });
  });
});

import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TEST_PATHS, createWorktreeListOutput } from "../../__tests__/test-utils";
import { WorktreeMetadataError } from "../../errors";

import { createGitServiceFixture, mockShowRef as mockShowRefOn } from "./helpers/git-service-fixture";

import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { SimpleGit } from "simple-git";
import type { Mock, Mocked } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");
vi.mock("../worktree-metadata.service", async () =>
  (await import("./helpers/metadata-service-mock")).worktreeMetadataServiceModuleMock(),
);

describe("WorktreeCreationService (through GitService)", () => {
  let gitService: GitService;
  let mockGit: Mocked<SimpleGit>;
  let mockMetadataService: any;
  let mockLogger: Logger;

  const mockShowRef = (opts: Parameters<typeof mockShowRefOn>[1]): void => mockShowRefOn(mockGit, opts);

  beforeEach(() => {
    ({ gitService, mockGit, mockMetadataService, mockLogger } = createGitServiceFixture());
  });

  describe("addWorktree - parent directories", () => {
    it("should create parent directories for nested branch paths", async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      mockGit.raw
        .mockRejectedValueOnce(new Error("config not found"))
        .mockResolvedValueOnce(
          createWorktreeListOutput([{ path: TEST_PATHS.worktree + "/main", branch: "main", commit: "abc123" }]) as any,
        );

      await gitService.initialize();

      const nestedPath = path.join(TEST_PATHS.worktree, "feature", "nested");
      await gitService.addWorktree("feature/nested", nestedPath);

      expect(fs.mkdir).toHaveBeenCalledWith(path.dirname(path.resolve(nestedPath)), { recursive: true });
      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", path.resolve(nestedPath), "feature/nested"]);
    });
  });

  describe("addWorktree", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should add worktree with tracking when branch doesn't exist locally", async () => {
      mockShowRef({ local: false, remote: true });

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(mockGit.raw).toHaveBeenCalledWith([
        "worktree",
        "add",
        "--track",
        "-b",
        "feature-1",
        "/test/worktrees/feature-1",
        "origin/feature-1",
      ]);
    });

    // A bare clone copies every remote branch into refs/heads/* and the fetch
    // refspec never updates those copies, so a local ref with no worktree is a
    // stale snapshot. When it is only behind origin/<branch>, the worktree is
    // created from it as before and then fast-forwarded to origin's tip.
    it("should fast-forward a local branch that is only behind to origin's tip when it exists locally", async () => {
      mockShowRef({ local: true, remote: true, localOnlyCommits: 0 });

      const worktreeGitMock = {
        branch: vi.fn<any>().mockResolvedValue(undefined),
        raw: vi.fn<any>().mockResolvedValue(""),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
        env: vi.fn<any>().mockReturnThis(),
      };

      // Store original implementation
      const originalImplementation = (simpleGit as unknown as Mock).getMockImplementation();

      // Mock simpleGit to return worktreeGitMock for the worktree path, but mockGit for other paths
      (simpleGit as unknown as Mock).mockImplementation((path?: any) => {
        if (path && path.includes("feature-1")) {
          return worktreeGitMock;
        }
        return mockGit;
      });

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(mockGit.raw).toHaveBeenCalledWith([
        "rev-list",
        "--count",
        "refs/remotes/origin/feature-1..refs/heads/feature-1",
      ]);
      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", "/test/worktrees/feature-1", "feature-1"]);
      expect(worktreeGitMock.branch).toHaveBeenCalledWith(["--set-upstream-to", "origin/feature-1", "feature-1"]);
      expect(worktreeGitMock.raw).toHaveBeenCalledWith(["merge", "--ff-only", "origin/feature-1"]);

      // Probed before the add; fast-forwarded once the upstream is set.
      const callOrder = (fn: Mock, matches: (args: string[]) => boolean): number =>
        fn.mock.invocationCallOrder[fn.mock.calls.findIndex((call) => matches(call[0] as unknown as string[]))];
      const revListOrder = callOrder(mockGit.raw as Mock, (args) => args[0] === "rev-list");
      const addOrder = callOrder(mockGit.raw as Mock, (args) => args[0] === "worktree" && args[1] === "add");
      const mergeOrder = callOrder(worktreeGitMock.raw as Mock, (args) => args[0] === "merge");
      expect(revListOrder).toBeLessThan(addOrder);
      expect(worktreeGitMock.branch.mock.invocationCallOrder[0]).toBeLessThan(mergeOrder);

      // Restore original implementation
      if (originalImplementation) {
        (simpleGit as unknown as Mock).mockImplementation(originalImplementation);
      }
    });

    // Commits not on origin/<branch> cannot be told apart from a copy whose
    // history was rebased away on the remote, and only never-pushed work would
    // be lost by a reset: the local tip is kept as before, with the upstream
    // set, and the log says why it was not moved.
    it("should keep the local tip when the local branch has commits not on origin", async () => {
      mockShowRef({ local: true, remote: true, localOnlyCommits: 2 });

      const worktreeGitMock = {
        branch: vi.fn<any>().mockResolvedValue(undefined),
        raw: vi.fn<any>().mockResolvedValue(""),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
        p && p.includes("feature-1") ? worktreeGitMock : mockGit,
      );

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", "/test/worktrees/feature-1", "feature-1"]);
      expect(worktreeGitMock.branch).toHaveBeenCalledWith(["--set-upstream-to", "origin/feature-1", "feature-1"]);
      expect(worktreeGitMock.raw).not.toHaveBeenCalledWith(expect.arrayContaining(["merge"]));
      expect(worktreeGitMock.raw).not.toHaveBeenCalledWith(expect.arrayContaining(["reset"]));
      expect(mockLogger.info).toHaveBeenCalledWith(
        "  - Local branch 'feature-1' has 2 commit(s) not on origin/feature-1; keeping its current tip instead of resetting it",
      );
    });

    it("should keep the local tip when the local-only commit probe fails", async () => {
      mockShowRef({ local: true, remote: true, localOnlyCommits: "unknown" });

      const worktreeGitMock = {
        branch: vi.fn<any>().mockResolvedValue(undefined),
        raw: vi.fn<any>().mockResolvedValue(""),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
        p && p.includes("feature-1") ? worktreeGitMock : mockGit,
      );

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", "/test/worktrees/feature-1", "feature-1"]);
      expect(worktreeGitMock.branch).toHaveBeenCalledWith(["--set-upstream-to", "origin/feature-1", "feature-1"]);
      expect(worktreeGitMock.raw).not.toHaveBeenCalledWith(expect.arrayContaining(["merge"]));
      expect(mockLogger.info).toHaveBeenCalledWith(
        "  - Could not tell whether local branch 'feature-1' has commits not on origin/feature-1; keeping its current tip",
      );
    });

    // A failed fast-forward is not a failed create: the worktree exists at the
    // local tip, which the next sync's update phase fast-forwards.
    it("should keep the worktree and warn when the fast-forward fails", async () => {
      mockShowRef({ local: true, remote: true, localOnlyCommits: 0 });

      const worktreeGitMock = {
        branch: vi.fn<any>().mockResolvedValue(undefined),
        raw: vi
          .fn<any>()
          .mockImplementation((args: unknown) =>
            Array.isArray(args) && args[0] === "merge"
              ? Promise.reject(new Error("index.lock exists"))
              : Promise.resolve(""),
          ),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
        p && p.includes("feature-1") ? worktreeGitMock : mockGit,
      );

      await expect(gitService.addWorktree("feature-1", "/test/worktrees/feature-1")).resolves.toEqual({
        status: "created",
        head: "abc123",
      });

      expect(mockGit.raw).not.toHaveBeenCalledWith(expect.arrayContaining(["worktree", "remove"]));
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "  - ⚠️ Could not fast-forward the new worktree for 'feature-1' to origin/feature-1: index.lock exists",
      );
    });

    // The runner compares this against origin/<branch> after each create.
    it("reports the created worktree's HEAD, and an already-registered path as no creation", async () => {
      mockShowRef({ local: false, remote: true });
      const worktreeGitMock = {
        branch: vi.fn<any>().mockResolvedValue(undefined),
        raw: vi.fn<any>().mockResolvedValue(""),
        revparse: vi.fn<any>().mockResolvedValue("f00dfeed\n"),
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
        p && p.includes("feature-1") ? worktreeGitMock : mockGit,
      );

      await expect(gitService.addWorktree("feature-1", "/test/worktrees/feature-1")).resolves.toEqual({
        status: "created",
        head: "f00dfeed",
      });
      expect(mockMetadataService.createInitialMetadataFromPath).toHaveBeenCalledWith(
        expect.any(String),
        "/test/worktrees/feature-1",
        "f00dfeed",
        "origin/feature-1",
        "main",
        expect.any(String),
      );

      (fs.access as Mock<any>).mockResolvedValueOnce(undefined);
      mockGit.raw.mockReset();
      mockGit.raw.mockResolvedValueOnce(
        "worktree /test/worktrees/feature-1\n" + "HEAD abc123\n" + "branch refs/heads/feature-1\n\n",
      );

      await expect(gitService.addWorktree("feature-1", "/test/worktrees/feature-1")).resolves.toEqual({
        status: "already_registered",
        detached: false,
      });
    });

    it("should resolve relative paths to absolute paths when adding worktrees", async () => {
      mockShowRef({ local: false, remote: true });

      await gitService.addWorktree("feature-1", "./test/worktrees/feature-1");

      const expectedAbsolutePath = path.resolve("./test/worktrees/feature-1");
      expect(mockGit.raw).toHaveBeenCalledWith([
        "worktree",
        "add",
        "--track",
        "-b",
        "feature-1",
        expectedAbsolutePath,
        "origin/feature-1",
      ]);
    });

    it("should fallback to simple add when tracking setup fails with tracking error", async () => {
      let trackingAddCalled = false;
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (Array.isArray(args)) {
          if (args[0] === "show-ref" && args[1] === "--verify") {
            const ref = args[args.length - 1];
            if (typeof ref === "string" && ref.startsWith("refs/heads/")) {
              return Promise.reject(new Error("show-ref: not found"));
            }
            if (typeof ref === "string" && ref.startsWith("refs/remotes/origin/")) {
              return Promise.resolve("");
            }
          }
          if (args[0] === "worktree" && args[1] === "add" && args.includes("--track") && !trackingAddCalled) {
            trackingAddCalled = true;
            return Promise.reject(new Error("cannot set up tracking"));
          }
        }
        return Promise.resolve("");
      });

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      const rawCalls = mockGit.raw.mock.calls.filter((call) => Array.isArray(call[0]) && call[0][1] === "add");
      expect(rawCalls[rawCalls.length - 1]).toEqual([["worktree", "add", "/test/worktrees/feature-1", "feature-1"]]);
    });

    // The plain add of the fallback sets no upstream. origin/<branch> is looked
    // up again afterwards: `remoteAfterAdd` is what that lookup finds (the
    // first lookup must say it exists, or the tracking add is never tried).
    const mockFallbackAdd = (opts: { remoteAfterAdd: boolean }): void => {
      let trackingAddCalled = false;
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (!Array.isArray(args)) return Promise.resolve("");
        if (args[0] === "show-ref" && args[1] === "--verify") {
          const ref = args[args.length - 1] as string;
          if (ref.startsWith("refs/heads/")) return Promise.reject(new Error("show-ref: not found"));
          return !trackingAddCalled || opts.remoteAfterAdd
            ? Promise.resolve("")
            : Promise.reject(new Error("show-ref: not found"));
        }
        if (args[0] === "worktree" && args[1] === "add" && args.includes("--track") && !trackingAddCalled) {
          trackingAddCalled = true;
          return Promise.reject(new Error("cannot set up tracking"));
        }
        return Promise.resolve("");
      });
    };

    it("sets origin/<branch> as the upstream after the no-tracking fallback when the remote branch exists", async () => {
      mockFallbackAdd({ remoteAfterAdd: true });

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      const upstreamCalls = (mockGit.raw as Mock).mock.calls.filter(
        (call) => Array.isArray(call[0]) && call[0][0] === "branch",
      );
      expect(upstreamCalls).toEqual([[["branch", "--set-upstream-to=origin/feature-1", "--", "feature-1"]]]);
      expect(mockLogger.info).toHaveBeenCalledWith("  - Set upstream of 'feature-1' to origin/feature-1");
      expect(mockLogger.info).toHaveBeenCalledWith("  - Created worktree for 'feature-1'");
      expect(mockLogger.info).not.toHaveBeenCalledWith(expect.stringContaining("(without tracking)"));
    });

    it("leaves the fallback worktree without an upstream when origin/<branch> is gone", async () => {
      mockFallbackAdd({ remoteAfterAdd: false });

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(mockGit.raw).not.toHaveBeenCalledWith(expect.arrayContaining(["branch"]));
      expect(mockLogger.info).toHaveBeenCalledWith("  - Created worktree for 'feature-1' (without tracking)");
    });

    it("should NOT fallback to simple add when a non-tracking error occurs", async () => {
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (Array.isArray(args)) {
          if (args[0] === "show-ref" && args[1] === "--verify") {
            const ref = args[args.length - 1];
            if (typeof ref === "string" && ref.startsWith("refs/heads/")) {
              return Promise.reject(new Error("show-ref: not found"));
            }
            if (typeof ref === "string" && ref.startsWith("refs/remotes/origin/")) {
              return Promise.resolve("");
            }
          }
          if (args[0] === "worktree" && args[1] === "add") {
            return Promise.reject(new Error("Permission denied"));
          }
        }
        return Promise.resolve("");
      });

      await expect(gitService.addWorktree("feature-1", "/test/worktrees/feature-1")).rejects.toThrow(
        "Permission denied",
      );
    });

    it("should clean up orphaned directory before creating worktree", async () => {
      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined) // directory exists
        .mockResolvedValueOnce(undefined) // still there when clearing
        .mockRejectedValueOnce(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" })); // no .git inside

      mockGit.raw.mockReset();
      mockGit.raw
        .mockResolvedValueOnce("") // worktree list - empty (directory is not a valid worktree)
        .mockRejectedValueOnce(new Error("show-ref: not found")) // refs/heads/feature-1 missing
        .mockResolvedValueOnce("") // refs/remotes/origin/feature-1 exists
        .mockResolvedValueOnce(""); // worktree add command

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(fs.access).toHaveBeenCalledWith("/test/worktrees/feature-1");
      expect(fs.rm).not.toHaveBeenCalled();
      expect(fs.rename).toHaveBeenCalledWith("/test/worktrees/feature-1", expect.stringContaining(".removed"));
      expect(mockGit.raw).toHaveBeenCalledWith([
        "worktree",
        "add",
        "--track",
        "-b",
        "feature-1",
        "/test/worktrees/feature-1",
        "origin/feature-1",
      ]);
    });

    it("should skip if directory is already a valid worktree", async () => {
      // Mock - directory exists when checking in addWorktree
      (fs.access as Mock<any>).mockResolvedValueOnce(undefined);

      // Reset mockGit.raw and set up responses
      mockGit.raw.mockReset();
      mockGit.raw.mockResolvedValueOnce(
        "worktree /test/worktrees/feature-1\n" + "HEAD abc123\n" + "branch refs/heads/feature-1\n\n",
      ); // worktree list - shows the worktree exists

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(fs.access).toHaveBeenCalledWith("/test/worktrees/feature-1");
      expect(fs.rm).not.toHaveBeenCalled();
      // Should have called worktree list but not worktree add
      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "list", "--porcelain", "-z"]);
      expect(mockGit.raw).toHaveBeenCalledTimes(1); // Only the list call, no add call
    });

    it("should clean up orphaned directory in fallback path when tracking fails", async () => {
      (fs.access as Mock<any>)
        .mockRejectedValueOnce(new Error("Not found")) // First check - directory doesn't exist
        .mockResolvedValueOnce(undefined) // Second check in fallback - directory exists
        .mockResolvedValueOnce(undefined) // still there when clearing
        .mockRejectedValueOnce(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" })); // no .git inside

      mockGit.raw.mockReset();
      mockGit.raw
        .mockRejectedValueOnce(new Error("show-ref: not found")) // refs/heads missing
        .mockResolvedValueOnce("") // refs/remotes/origin exists
        .mockRejectedValueOnce(new Error("no such remote ref")) // tracking add fails
        .mockRejectedValueOnce(new Error("show-ref: not found")) // rollback probe: no branch was left behind
        .mockResolvedValueOnce("") // worktree list - empty (directory is not a valid worktree)
        .mockResolvedValueOnce("") // fallback worktree add succeeds
        .mockResolvedValueOnce("") // show-ref remotes (upstream lookup after the plain add)
        .mockResolvedValueOnce(""); // branch --set-upstream-to

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(fs.rm).not.toHaveBeenCalled();
      expect(fs.rename).toHaveBeenCalledWith("/test/worktrees/feature-1", expect.stringContaining(".removed"));
      // Calls: show-ref heads, show-ref remotes, tracking add (fail), rollback show-ref heads,
      // worktree list, fallback add, show-ref remotes, branch --set-upstream-to, then LFS
      // verification's three: the .gitattributes grep, the git-lfs probe, `lfs ls-files`
      expect(mockGit.raw).toHaveBeenCalledTimes(11);
    });

    it("should throw error when metadata creation fails", async () => {
      mockShowRef({ local: false, remote: true });

      const metadataError = new Error("Failed to write metadata file");
      mockMetadataService.createInitialMetadataFromPath.mockRejectedValueOnce(metadataError);

      await expect(gitService.addWorktree("feature-1", "/test/worktrees/feature-1")).rejects.toThrow(
        "Metadata creation failed for feature-1",
      );

      expect(mockGit.raw).toHaveBeenCalledWith([
        "worktree",
        "add",
        "--track",
        "-b",
        "feature-1",
        "/test/worktrees/feature-1",
        "origin/feature-1",
      ]);
      expect(mockMetadataService.createInitialMetadataFromPath).toHaveBeenCalled();
    });

    // The whole point of this recovery is a registration whose directory is
    // gone. Handing that missing path to the trasher fails with ENOENT and turns
    // a self-healing case into a worktree that can never be rebuilt.
    it("recreates a worktree for a stale registration whose directory is already gone", async () => {
      const worktreePath = "/test/worktrees/feature-1";
      const trasher = vi.fn<any>().mockRejectedValue(new Error("ENOENT: no such file or directory"));
      gitService.setStaleDirectoryTrasher(trasher as unknown as (dirPath: string) => Promise<string>);

      (fs.access as Mock<any>).mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));

      mockGit.raw.mockReset();
      mockGit.raw
        .mockRejectedValueOnce(new Error("show-ref: not found")) // refs/heads missing
        .mockResolvedValueOnce("") // refs/remotes/origin exists
        .mockRejectedValueOnce(new Error("fatal: 'feature-1' is already registered worktree"))
        .mockResolvedValueOnce(`worktree ${worktreePath}\nHEAD abc123\nbranch refs/heads/feature-1\nprunable\n\n`)
        .mockResolvedValueOnce("") // targeted registration removal succeeds
        .mockRejectedValueOnce(new Error("show-ref: not found")) // refs/heads missing on retry
        .mockResolvedValueOnce("") // refs/remotes/origin exists on retry
        .mockResolvedValueOnce("") // retry add succeeds
        .mockResolvedValueOnce(""); // LFS ls-files

      await expect(gitService.addWorktree("feature-1", worktreePath)).resolves.toEqual({
        status: "created",
        head: "abc123",
      });

      expect(trasher).not.toHaveBeenCalled();
      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "remove", "--force", worktreePath]);
    });

    it("clears the stale target directory and retries when targeted registration removal fails", async () => {
      const worktreePath = "/test/worktrees/feature-1";

      (fs.access as Mock<any>)
        .mockRejectedValueOnce(new Error("Not found")) // Directory doesn't exist initially
        .mockResolvedValueOnce(undefined) // a leftover directory now sits at the target
        .mockRejectedValueOnce(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" })); // no .git inside stale dir

      mockGit.raw.mockReset();
      mockGit.raw
        .mockRejectedValueOnce(new Error("show-ref: not found")) // refs/heads missing
        .mockResolvedValueOnce("") // refs/remotes/origin exists
        .mockRejectedValueOnce(new Error("fatal: 'feature-1' is already registered worktree")) // Initial add fails
        .mockResolvedValueOnce(`worktree ${worktreePath}\nHEAD abc123\nbranch refs/heads/feature-1\nprunable\n\n`) // Worktree list shows registered but prunable
        .mockRejectedValueOnce(new Error("registration locked")) // Targeted removal fails
        .mockRejectedValueOnce(new Error("show-ref: not found")) // refs/heads missing on retry
        .mockResolvedValueOnce("") // refs/remotes/origin exists on retry
        .mockResolvedValueOnce("") // Retry add succeeds
        .mockResolvedValueOnce(""); // LFS ls-files

      await gitService.addWorktree("feature-1", worktreePath);

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "list", "--porcelain", "-z"]);
      expect(mockGit.raw).not.toHaveBeenCalledWith(["worktree", "prune"]);
      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "remove", "--force", worktreePath]);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("registration locked"));
      expect(fs.rm).not.toHaveBeenCalled();
      expect(fs.rename).toHaveBeenCalledWith(worktreePath, expect.stringContaining(".removed"));
      expect(mockGit.raw).toHaveBeenCalledWith([
        "worktree",
        "add",
        "--track",
        "-b",
        "feature-1",
        worktreePath,
        "origin/feature-1",
      ]);
      expect(mockLogger.info).toHaveBeenCalledWith("  - Created worktree for 'feature-1' on retry");
    });

    it("should handle concurrent creation when worktree is registered AND not prunable", async () => {
      const worktreePath = "/test/worktrees/feature-1";

      (fs.access as Mock<any>).mockRejectedValueOnce(new Error("Not found")); // Directory doesn't exist initially

      mockGit.raw.mockReset();
      mockGit.raw
        .mockRejectedValueOnce(new Error("show-ref: not found")) // refs/heads missing
        .mockResolvedValueOnce("") // refs/remotes/origin exists
        .mockRejectedValueOnce(new Error("fatal: 'feature-1' is already registered worktree")) // Initial add fails
        .mockResolvedValueOnce(`worktree ${worktreePath}\nHEAD abc123\nbranch refs/heads/feature-1\n\n`); // Registered, NOT prunable

      await gitService.addWorktree("feature-1", worktreePath);

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "list", "--porcelain", "-z"]);
      expect(mockGit.raw).not.toHaveBeenCalledWith(["worktree", "prune"]);
      expect(fs.rm).not.toHaveBeenCalled();
    });

    // Detached is reported apart from a plain "already registered" so the
    // runner can record the skip it is instead of counting a creation that
    // never happened, on this and every later tick.
    it("treats a detached registration at the target path as occupied", async () => {
      const worktreePath = "/test/worktrees/feature-1";
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      (mockGit.raw as Mock).mockImplementation(async (args: unknown) => {
        const command = args as string[];
        if (command[0] === "worktree" && command[1] === "list") {
          return `worktree ${worktreePath}\nHEAD abc123\ndetached\n\n`;
        }
        return "";
      });
      mockGit.raw.mockClear();
      (fs.rename as Mock<any>).mockClear();

      await expect(gitService.addWorktree("feature-1", worktreePath)).resolves.toEqual({
        status: "already_registered",
        detached: true,
      });

      expect(fs.rm).not.toHaveBeenCalledWith(worktreePath, { recursive: true, force: true });
      expect(fs.rename).not.toHaveBeenCalled();
      expect(mockGit.raw).not.toHaveBeenCalledWith(expect.arrayContaining(["worktree", "add"]));
    });

    it("reports a registration on the branch itself as already registered but not detached", async () => {
      const worktreePath = "/test/worktrees/feature-1";
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      (mockGit.raw as Mock).mockImplementation(async (args: unknown) => {
        const command = args as string[];
        if (command[0] === "worktree" && command[1] === "list") {
          return `worktree ${worktreePath}\nHEAD abc123\nbranch refs/heads/feature-1\n\n`;
        }
        return "";
      });
      mockGit.raw.mockClear();

      await expect(gitService.addWorktree("feature-1", worktreePath)).resolves.toEqual({
        status: "already_registered",
        detached: false,
      });

      expect(mockGit.raw).not.toHaveBeenCalledWith(expect.arrayContaining(["worktree", "add"]));
    });
  });

  describe("addWorktree metadata failure cleanup", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should remove worktree when metadata creation fails", async () => {
      mockShowRef({ local: false, remote: true });

      mockMetadataService.createInitialMetadataFromPath.mockRejectedValueOnce(
        new Error("Failed to write metadata file"),
      );

      await expect(gitService.addWorktree("feature-1", "/test/worktrees/feature-1")).rejects.toThrow(
        "Metadata creation failed for feature-1",
      );

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "remove", "--force", "/test/worktrees/feature-1"]);
    });

    // Metadata is keyed by directory name: a record there for another branch
    // is refused by saveMetadata, and the worktree must not go on without one.
    it("rolls back when the metadata record under its name belongs to another branch", async () => {
      mockShowRef({ local: false, remote: true });
      mockMetadataService.createInitialMetadataFromPath.mockResolvedValueOnce(false);

      const error = await gitService.addWorktree("feature-1", "/test/worktrees/feature-1").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(WorktreeMetadataError);
      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "remove", "--force", "/test/worktrees/feature-1"]);
    });

    // Every raw call addWorktree spawned that was a `worktree <sub>` command.
    const worktreeCommands = (sub: string): string[][] =>
      (mockGit.raw as Mock).mock.calls
        .map((call: unknown[]) => call[0])
        .filter((args): args is string[] => Array.isArray(args) && args[0] === "worktree" && args[1] === sub);

    it("rejects with a typed WorktreeMetadataError and never falls back to a plain add", async () => {
      mockShowRef({ local: false, remote: true });
      const cause = new Error("Failed to write metadata file");
      mockMetadataService.createInitialMetadataFromPath.mockRejectedValueOnce(cause);

      const error = await gitService.addWorktree("feature-1", "/test/worktrees/feature-1").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(WorktreeMetadataError);
      expect((error as WorktreeMetadataError).branchName).toBe("feature-1");
      expect((error as WorktreeMetadataError).message).toBe(
        "Metadata creation failed for 'feature-1': Metadata creation failed for feature-1. This worktree cannot be auto-managed.",
      );
      expect(worktreeCommands("add")).toHaveLength(1);
      // The add created refs/heads/feature-1 (--track -b), so rollback deletes it too.
      expect(mockGit.raw).toHaveBeenCalledWith(["branch", "-D", "--", "feature-1"]);
    });

    it("rolls back and rethrows a metadata failure on the stale-registration retry path", async () => {
      const worktreePath = "/test/worktrees/feature-1";
      (fs.access as Mock<any>).mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));
      let trackingAdds = 0;
      (mockGit.raw as Mock).mockImplementation(async (args: unknown) => {
        const command = args as string[];
        if (command[0] === "show-ref" && command[command.length - 1].startsWith("refs/heads/")) {
          throw new Error("show-ref: not found");
        }
        if (command[0] === "worktree" && command[1] === "add" && command.includes("--track")) {
          trackingAdds += 1;
          if (trackingAdds === 1) throw new Error("fatal: 'feature-1' is already registered worktree");
        }
        if (command[0] === "worktree" && command[1] === "list") {
          return `worktree ${worktreePath}\nHEAD abc123\nbranch refs/heads/feature-1\nprunable\n\n`;
        }
        return "";
      });
      mockGit.raw.mockClear();
      mockMetadataService.createInitialMetadataFromPath.mockRejectedValueOnce(new Error("Failed to write metadata"));

      await expect(gitService.addWorktree("feature-1", worktreePath)).rejects.toBeInstanceOf(WorktreeMetadataError);

      expect(trackingAdds).toBe(2);
      // One removal clears the stale registration, the second rolls back the retry.
      expect(worktreeCommands("remove")).toHaveLength(2);
      expect(worktreeCommands("add").filter((args) => !args.includes("--track"))).toHaveLength(0);
    });

    it("rolls back and rethrows a metadata failure on the plain-add fallback path", async () => {
      const worktreePath = "/test/worktrees/feature-1";
      (fs.access as Mock<any>).mockRejectedValue(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" }));
      (mockGit.raw as Mock).mockImplementation(async (args: unknown) => {
        const command = args as string[];
        if (command[0] === "show-ref" && command[command.length - 1].startsWith("refs/heads/")) {
          throw new Error("show-ref: not found");
        }
        if (command[0] === "worktree" && command[1] === "add" && command.includes("--track")) {
          throw new Error("fatal: no such remote ref refs/remotes/origin/feature-1");
        }
        return "";
      });
      mockGit.raw.mockClear();
      mockMetadataService.createInitialMetadataFromPath.mockRejectedValueOnce(new Error("Failed to write metadata"));

      await expect(gitService.addWorktree("feature-1", worktreePath)).rejects.toBeInstanceOf(WorktreeMetadataError);

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", worktreePath, "feature-1"]);
      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "remove", "--force", worktreePath]);
      // The plain add reused an existing branch, so rollback must leave it alone.
      expect(mockGit.raw).not.toHaveBeenCalledWith(["branch", "-D", "--", "feature-1"]);
    });
  });

  describe("addWorktree - cascading fallback failures", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should throw when both tracking and fallback add fail", async () => {
      (fs.access as Mock<any>).mockRejectedValueOnce(new Error("Not found"));
      (fs.access as Mock<any>).mockRejectedValueOnce(new Error("Not found"));

      mockGit.raw.mockReset();
      mockGit.raw
        .mockRejectedValueOnce(new Error("show-ref: not found")) // refs/heads missing
        .mockResolvedValueOnce("") // refs/remotes/origin exists
        .mockRejectedValueOnce(new Error("no such remote ref")) // tracking add fails
        .mockRejectedValueOnce(new Error("show-ref: not found")) // rollback probe: no branch was left behind
        .mockRejectedValueOnce(new Error("simple add also failed")); // fallback add fails

      await expect(gitService.addWorktree("feature-1", "/test/worktrees/feature-1")).rejects.toThrow(
        "simple add also failed",
      );
    });

    it("should throw non-tracking errors immediately without fallback", async () => {
      (fs.access as Mock<any>).mockRejectedValueOnce(new Error("Not found"));

      mockGit.raw.mockReset();
      mockGit.raw
        .mockRejectedValueOnce(new Error("show-ref: not found")) // refs/heads missing
        .mockResolvedValueOnce("") // refs/remotes/origin exists
        .mockRejectedValueOnce(new Error("disk full")); // tracking add fails non-recoverably

      await expect(gitService.addWorktree("feature-1", "/test/worktrees/feature-1")).rejects.toThrow("disk full");
    });

    it("should throw metadata error even when worktree cleanup also fails", async () => {
      (fs.access as Mock<any>).mockRejectedValueOnce(new Error("Not found")); // target directory absent
      mockMetadataService.createInitialMetadataFromPath.mockRejectedValueOnce(new Error("Failed to write metadata"));

      mockGit.raw.mockReset();
      mockGit.raw
        .mockRejectedValueOnce(new Error("show-ref: not found")) // refs/heads missing
        .mockResolvedValueOnce("") // refs/remotes/origin exists
        .mockResolvedValueOnce("") // tracking add succeeds
        .mockResolvedValueOnce("") // LFS ls-files verification (no LFS files)
        .mockRejectedValueOnce(new Error("remove also failed")); // cleanup removal fails

      await expect(gitService.addWorktree("feature-1", "/test/worktrees/feature-1")).rejects.toThrow(
        "Metadata creation failed",
      );
    });
  });
});

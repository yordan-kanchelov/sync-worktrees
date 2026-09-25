import * as fs from "fs/promises";

import simpleGit from "simple-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TEST_PATHS, createRemoteRefListOutput, createWorktreeListOutput } from "../../__tests__/test-utils";

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

describe("BranchRefService (through GitService)", () => {
  let gitService: GitService;
  let mockGit: Mocked<SimpleGit>;
  let mockLogger: Logger;

  const mockShowRef = (opts: Parameters<typeof mockShowRefOn>[1]): void => mockShowRefOn(mockGit, opts);

  beforeEach(() => {
    ({ gitService, mockGit, mockLogger } = createGitServiceFixture());
  });

  describe("getRemoteCommit", () => {
    it("uses the bare repository to resolve refs", async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      mockGit.raw
        .mockRejectedValueOnce(new Error("config not found"))
        .mockResolvedValueOnce(
          createWorktreeListOutput([{ path: TEST_PATHS.worktree + "/main", branch: "main", commit: "abc123" }]) as any,
        );

      await gitService.initialize();

      const simpleGitMock = simpleGit as unknown as Mock;
      const bareCalls = simpleGitMock.mock.calls.filter((args) => args[0] === TEST_PATHS.bareRepo);
      expect(bareCalls.length).toBeGreaterThan(0);

      mockGit.revparse.mockResolvedValue("commitsha\n" as any);
      const commit = await gitService.getRemoteCommit("origin/main");
      expect(mockGit.revparse).toHaveBeenCalledWith(["origin/main"]);
      expect(commit).toBe("commitsha");
    });
  });

  describe("branchExists", () => {
    it("checks refs with non-quiet show-ref so missing refs are observable", async () => {
      const calls: string[][] = [];
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (Array.isArray(args)) {
          calls.push(args as string[]);
          return Promise.reject(new Error("show-ref: not found"));
        }
        return Promise.resolve("");
      });

      await expect(gitService.branchExists("feat/new")).resolves.toEqual({ local: false, remote: false });

      expect(calls).toEqual([
        ["show-ref", "--verify", "refs/heads/feat/new"],
        ["show-ref", "--verify", "refs/remotes/origin/feat/new"],
      ]);
      expect(calls.flat()).not.toContain("--quiet");
    });
  });

  describe("createBranch", () => {
    it("does not duplicate origin when baseBranch is already remote-qualified", async () => {
      mockGit.revparse.mockResolvedValue("abc123\n" as any);

      await gitService.createBranch("feat/new", "origin/main");

      expect(mockGit.revparse).toHaveBeenCalledWith(["--verify", "origin/main"]);
      expect(mockGit.raw).toHaveBeenCalledWith(["branch", "--no-track", "feat/new", "origin/main"]);
    });

    it("falls back to a local base branch when origin branch is missing", async () => {
      mockGit.revparse
        .mockRejectedValueOnce(new Error("fatal: Needed a single revision") as any)
        .mockResolvedValueOnce("abc123\n" as any);

      await gitService.createBranch("feat/new", "main");

      expect(mockGit.revparse).toHaveBeenNthCalledWith(1, ["--verify", "origin/main"]);
      expect(mockGit.revparse).toHaveBeenNthCalledWith(2, ["--verify", "main"]);
      expect(mockGit.raw).toHaveBeenCalledWith(["branch", "--no-track", "feat/new", "main"]);
    });

    // The branch filters (branchMaxAge/branchInclude/branchExclude) mean a
    // branch that is on origin very often has no local head here, so `git
    // branch` collides with nothing and the name is taken anyway. Origin is
    // asked directly, and the answer is phrased "already exists" because that
    // is the wording the TUI suffixes and retries on.
    it("refuses a name that is on origin even when no local head collides", async () => {
      mockGit.revparse.mockResolvedValue("abc123\n" as any);
      (mockGit.raw as Mock).mockImplementation((args: unknown) =>
        Array.isArray(args) && args[0] === "ls-remote"
          ? Promise.resolve(`deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\trefs/heads/feat/new\n`)
          : Promise.resolve(""),
      );

      await expect(gitService.createBranch("feat/new", "main")).rejects.toThrow(/already exists on origin/);

      expect(mockGit.raw).toHaveBeenCalledWith(["ls-remote", "--heads", "origin", "refs/heads/feat/new"]);
      expect(mockGit.raw).not.toHaveBeenCalledWith(["branch", "--no-track", "feat/new", "origin/main"]);
    });

    // A ref that merely starts with the name is a different branch: the
    // fully-qualified pattern must not be read as a prefix match.
    it("does not read a longer remote ref as a collision", async () => {
      mockGit.revparse.mockResolvedValue("abc123\n" as any);
      (mockGit.raw as Mock).mockImplementation((args: unknown) =>
        Array.isArray(args) && args[0] === "ls-remote"
          ? Promise.resolve(`deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\trefs/heads/feat/new-2\n`)
          : Promise.resolve(""),
      );

      await gitService.createBranch("feat/new", "main");

      expect(mockGit.raw).toHaveBeenCalledWith(["ls-remote", "--heads", "origin", "refs/heads/feat/new"]);
      expect(mockGit.raw).toHaveBeenCalledWith(["branch", "--no-track", "feat/new", "origin/main"]);
    });

    // `create_worktree` without a push works offline, and the create-only
    // lease is what actually protects the remote — so a probe that cannot
    // reach origin must not stop the branch being created.
    it("still creates the branch when origin cannot be reached", async () => {
      mockGit.revparse.mockResolvedValue("abc123\n" as any);
      (mockGit.raw as Mock).mockImplementation((args: unknown) =>
        Array.isArray(args) && args[0] === "ls-remote"
          ? Promise.reject(new Error("fatal: Could not read from remote repository"))
          : Promise.resolve(""),
      );

      await expect(gitService.createBranch("feat/new", "main")).resolves.toBeUndefined();

      expect(mockGit.raw).toHaveBeenCalledWith(["ls-remote", "--heads", "origin", "refs/heads/feat/new"]);
      expect(mockGit.raw).toHaveBeenCalledWith(["branch", "--no-track", "feat/new", "origin/main"]);
    });
  });

  describe("pushBranch", () => {
    // `--force-with-lease=<ref>:` with an EMPTY expectation is git's
    // create-only push: the remote ref must not exist. Without it the push
    // FAST-FORWARDS a branch that is already on origin whenever its tip is an
    // ancestor of the base — someone else's branch, and any PR or CI run
    // pinned to it, moved while the wizard reports a successful creation.
    it("sets the new branch upstream and refuses to advance a ref that already exists", async () => {
      await gitService.pushBranch("feat/new");

      expect(mockGit.push).toHaveBeenCalledWith([
        "origin",
        "refs/heads/feat/new:refs/heads/feat/new",
        "-u",
        "--force-with-lease=refs/heads/feat/new:",
      ]);
    });
  });

  describe("getRemoteBranches", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    // The listing comes from `for-each-ref` on full refnames, never
    // `branch -v -r`: nothing here has to resolve a commit to print a subject
    // line that is then thrown away, and no output is shaped by the reader's
    // color settings or by which short names happen to be ambiguous.
    const forEachRef = (entries: Array<string | { ref: string; oid: string }>): void => {
      (mockGit.raw as Mock).mockImplementation((args: unknown) =>
        Promise.resolve(Array.isArray(args) && args[0] === "for-each-ref" ? createRemoteRefListOutput(entries) : ""),
      );
    };

    it("should return only remote branches without origin prefix", async () => {
      const branches = await gitService.getRemoteBranches();

      expect(mockGit.raw).toHaveBeenCalledWith([
        "for-each-ref",
        "--format=%(refname)%00%(objectname)",
        "refs/remotes/origin",
      ]);
      expect(mockGit.branch).not.toHaveBeenCalled();
      expect(branches).toEqual(["main", "feature-1", "feature-2"]);
    });

    it("should handle empty branch list", async () => {
      forEachRef([]);

      const branches = await gitService.getRemoteBranches();

      expect(branches).toEqual([]);
    });

    it("should filter out origin/HEAD", async () => {
      forEachRef(["main", "feature-1", { ref: "refs/remotes/origin/HEAD", oid: "main-oid" }]);

      const branches = await gitService.getRemoteBranches();

      expect(branches).toEqual(["main", "feature-1"]);
      expect(branches).not.toContain("HEAD");
    });

    it("keeps a remote branch named 'feature/HEAD' and drops only the symref (#review)", async () => {
      forEachRef([{ ref: "refs/remotes/origin/HEAD", oid: "main-oid" }, "feature/HEAD", "main"]);

      const branches = await gitService.getRemoteBranches();

      expect(branches).toEqual(["feature/HEAD", "main"]);
    });

    // A branch literally named "origin" is a real branch; only the exact
    // origin/HEAD symref is dropped.
    it("keeps a remote branch literally named 'origin' (#review)", async () => {
      forEachRef(["origin", "main"]);

      const branches = await gitService.getRemoteBranches();

      expect(branches).toEqual(["origin", "main"]);
    });
  });

  describe("listRefs", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("returns trimmed refnames under the prefix and drops blank lines", async () => {
      mockGit.raw.mockResolvedValueOnce("refs/sync-worktrees/trash/a\nrefs/sync-worktrees/trash/b\n\n" as any);

      const refs = await gitService.listRefs("refs/sync-worktrees/trash");

      expect(mockGit.raw).toHaveBeenCalledWith(["for-each-ref", "--format=%(refname)", "refs/sync-worktrees/trash"]);
      expect(refs).toEqual(["refs/sync-worktrees/trash/a", "refs/sync-worktrees/trash/b"]);
    });
  });

  describe("getRemoteBranchesWithActivity", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should return branches with their last activity dates", async () => {
      const mockOutput = [
        "refs/remotes/origin/main 2024-01-15T10:30:00-05:00",
        "refs/remotes/origin/feature-1 2024-01-10T14:20:00-05:00",
        "refs/remotes/origin/feature-2 2023-12-25T08:15:00-05:00",
      ].join("\n");

      mockGit.raw.mockResolvedValueOnce(mockOutput as any);

      const branches = await gitService.getRemoteBranchesWithActivity();

      expect(mockGit.raw).toHaveBeenCalledWith([
        "for-each-ref",
        "--format=%(refname)%00%(committerdate:iso8601)",
        "refs/remotes/origin",
      ]);

      expect(branches).toHaveLength(3);
      expect(branches[0]).toEqual({
        branch: "main",
        lastActivity: new Date("2024-01-15T10:30:00-05:00"),
      });
      expect(branches[1]).toEqual({
        branch: "feature-1",
        lastActivity: new Date("2024-01-10T14:20:00-05:00"),
      });
      expect(branches[2]).toEqual({
        branch: "feature-2",
        lastActivity: new Date("2023-12-25T08:15:00-05:00"),
      });
    });

    it("should handle empty output", async () => {
      mockGit.raw.mockResolvedValueOnce("" as any);

      const branches = await gitService.getRemoteBranchesWithActivity();

      expect(branches).toEqual([]);
    });

    it("should skip invalid lines", async () => {
      const mockOutput = [
        "refs/remotes/origin/main 2024-01-15T10:30:00-05:00",
        "invalid-line",
        "refs/remotes/origin/feature-1 invalid-date",
        "refs/remotes/origin/feature-2 2024-01-10T14:20:00-05:00",
      ].join("\n");

      mockGit.raw.mockResolvedValueOnce(mockOutput as any);

      const branches = await gitService.getRemoteBranchesWithActivity();

      expect(branches).toHaveLength(2);
      expect(branches[0].branch).toBe("main");
      expect(branches[1].branch).toBe("feature-2");
    });

    it("should filter out origin/HEAD", async () => {
      const mockOutput = [
        "refs/remotes/origin/main 2024-01-15T10:30:00-05:00",
        "refs/remotes/origin/HEAD 2024-01-15T10:30:00-05:00",
        "refs/remotes/origin/feature-1 2024-01-14T09:15:00-05:00",
      ].join("\n");

      mockGit.raw.mockResolvedValueOnce(mockOutput as any);

      const branches = await gitService.getRemoteBranchesWithActivity();

      expect(branches).toHaveLength(2);
      expect(branches[0].branch).toBe("main");
      expect(branches[1].branch).toBe("feature-1");
      expect(branches.some((b) => b.branch === "HEAD")).toBe(false);
    });

    it("keeps branches whose names contain '|' (legal refname character) (#review)", async () => {
      const mockOutput = [
        "refs/remotes/origin/feature|wip 2024-01-15T10:30:00-05:00",
        "refs/remotes/origin/main 2024-01-10T14:20:00-05:00",
      ].join("\n");

      mockGit.raw.mockResolvedValueOnce(mockOutput as any);

      const branches = await gitService.getRemoteBranchesWithActivity();

      expect(branches).toHaveLength(2);
      expect(branches[0].branch).toBe("feature|wip");
      expect(branches[0].lastActivity).toEqual(new Date("2024-01-15T10:30:00-05:00"));
    });

    it("keeps a remote branch literally named 'origin' (#review)", async () => {
      const mockOutput = ["refs/remotes/origin/origin 2024-01-15T10:30:00-05:00"].join("\n");

      mockGit.raw.mockResolvedValueOnce(mockOutput as any);

      const branches = await gitService.getRemoteBranchesWithActivity();

      expect(branches).toHaveLength(1);
      expect(branches[0].branch).toBe("origin");
    });

    it("keeps a remote branch named 'feature/HEAD' and drops only the symref (#review)", async () => {
      const mockOutput = [
        "refs/remotes/origin/HEAD 2024-01-15T10:30:00-05:00",
        "refs/remotes/origin/feature/HEAD 2024-01-14T09:15:00-05:00",
        "refs/remotes/origin/main 2024-01-10T14:20:00-05:00",
      ].join("\n");

      mockGit.raw.mockResolvedValueOnce(mockOutput as any);

      const branches = await gitService.getRemoteBranchesWithActivity();

      expect(branches.map((b) => b.branch)).toEqual(["feature/HEAD", "main"]);
    });

    it("asks for %(refname), never the ambiguity-dependent %(refname:short) (#review)", async () => {
      // git shortens refs/remotes/origin/x to "remotes/origin/x" as soon as a
      // local branch literally named "origin/x" exists, and
      // refs/remotes/origin/feature/HEAD to "origin/feature" — both names this
      // parser would drop or misattribute. Full refnames never change shape.
      mockGit.raw.mockResolvedValueOnce("refs/remotes/origin/x 2024-01-15T10:30:00-05:00" as any);

      const branches = await gitService.getRemoteBranchesWithActivity();

      expect(mockGit.raw).toHaveBeenCalledWith([
        "for-each-ref",
        "--format=%(refname)%00%(committerdate:iso8601)",
        "refs/remotes/origin",
      ]);
      expect(branches.map((b) => b.branch)).toEqual(["x"]);
    });
  });

  describe("getRemoteBranchTips", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("maps full refnames to tips, keeping 'feature/HEAD' and dropping the symref (#review)", async () => {
      const mockOutput = [
        "refs/remotes/origin/HEAD aaaaaaa",
        "refs/remotes/origin/feature/HEAD bbbbbbb",
        "refs/remotes/origin/main ccccccc",
      ].join("\n");

      mockGit.raw.mockResolvedValueOnce(mockOutput as any);

      const tips = await gitService.getRemoteBranchTips();

      expect(mockGit.raw).toHaveBeenCalledWith([
        "for-each-ref",
        "--format=%(refname)%00%(objectname)",
        "refs/remotes/origin",
      ]);
      expect([...tips.entries()]).toEqual([
        ["feature/HEAD", "bbbbbbb"],
        ["main", "ccccccc"],
      ]);
    });

    it("keeps a remote branch named 'origin' and one whose name contains '|' (#review)", async () => {
      const mockOutput = ["refs/remotes/origin/origin ddddddd", "refs/remotes/origin/feature|wip eeeeeee"].join("\n");

      mockGit.raw.mockResolvedValueOnce(mockOutput as any);

      const tips = await gitService.getRemoteBranchTips();

      expect([...tips.entries()]).toEqual([
        ["origin", "ddddddd"],
        ["feature|wip", "eeeeeee"],
      ]);
    });
  });

  describe("trackRemoteBranchIfExists", () => {
    // Runs in the worktree (config-only, so a --no-checkout worktree is fine);
    // the remote ref is looked up in the bare repository.
    const useWorktreeGit = (): ReturnType<typeof makeUpstreamWorktreeGit> => {
      const worktreeGitMock = makeUpstreamWorktreeGit();
      (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
        p && p.includes("feature-1") ? worktreeGitMock : mockGit,
      );
      return worktreeGitMock;
    };
    const makeUpstreamWorktreeGit = () => ({
      raw: vi.fn<any>().mockResolvedValue("branch 'feature-1' set up to track 'origin/feature-1'.\n"),
      env: vi.fn<any>().mockReturnThis(),
    });

    it("sets the upstream in the worktree when refs/remotes/origin/<branch> exists", async () => {
      const worktreeGit = useWorktreeGit();
      mockShowRef({ local: true, remote: true });

      await expect(gitService.trackRemoteBranchIfExists("feature-1", "/test/worktrees/feature-1")).resolves.toBe(true);

      expect(mockGit.raw).toHaveBeenCalledWith(["show-ref", "--verify", "refs/remotes/origin/feature-1"]);
      expect(worktreeGit.raw).toHaveBeenCalledWith(["branch", "--set-upstream-to=origin/feature-1", "--", "feature-1"]);
      expect(mockLogger.info).toHaveBeenCalledWith("  - Set upstream of 'feature-1' to origin/feature-1");
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("does nothing when the remote branch is not known locally", async () => {
      const worktreeGit = useWorktreeGit();
      mockShowRef({ local: true, remote: false });

      await expect(gitService.trackRemoteBranchIfExists("feature-1", "/test/worktrees/feature-1")).resolves.toBe(false);

      expect(worktreeGit.raw).not.toHaveBeenCalled();
      expect(mockLogger.info).not.toHaveBeenCalledWith(expect.stringContaining("Set upstream"));
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("warns instead of throwing when git refuses to set the upstream", async () => {
      const worktreeGit = useWorktreeGit();
      worktreeGit.raw.mockRejectedValue(new Error("fatal: branch 'feature-1' does not exist"));
      mockShowRef({ local: true, remote: true });

      await expect(gitService.trackRemoteBranchIfExists("feature-1", "/test/worktrees/feature-1")).resolves.toBe(false);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "Could not set upstream of 'feature-1' to origin/feature-1: fatal: branch 'feature-1' does not exist",
        ),
      );
    });
  });

  describe("createBundleFromRef", () => {
    it("skips bundling when no commits are missing from remotes — emptiness pre-checked via rev-list, never localized stderr", async () => {
      (mockGit.raw as Mock).mockImplementation(async (args: unknown) => {
        if (Array.isArray(args) && args[0] === "rev-list") return "0\n";
        throw new Error(`unexpected git call: ${(args as string[]).join(" ")}`);
      });

      await expect(gitService.createBundleFromRef("/tmp/c.bundle", "refs/sync-worktrees/trash/id")).resolves.toBe(
        false,
      );
      // origin's refs, not every remote-tracking ref present: one left behind
      // by a removed remote survives `fetch --all --prune` and would make this
      // read zero for commits no remote has.
      expect(mockGit.raw).toHaveBeenCalledWith([
        "rev-list",
        "--count",
        "refs/sync-worktrees/trash/id",
        "--not",
        "--glob=refs/remotes/origin/",
      ]);
    });

    it("bundles when commits exist and lets bundle-create failures escape (fail-closed for keep-on-reap callers)", async () => {
      (mockGit.raw as Mock).mockImplementation(async (args: unknown) => {
        if (Array.isArray(args) && args[0] === "rev-list") return "3\n";
        return "";
      });
      await expect(gitService.createBundleFromRef("/tmp/c.bundle", "refs/sync-worktrees/trash/id")).resolves.toBe(true);
      expect(mockGit.raw).toHaveBeenCalledWith([
        "bundle",
        "create",
        "/tmp/c.bundle",
        "refs/sync-worktrees/trash/id",
        "--not",
        "--glob=refs/remotes/origin/",
      ]);

      (mockGit.raw as Mock).mockImplementation(async (args: unknown) => {
        if (Array.isArray(args) && args[0] === "rev-list") return "3\n";
        throw new Error("disk full");
      });
      await expect(gitService.createBundleFromRef("/tmp/c.bundle", "refs/sync-worktrees/trash/id")).rejects.toThrow(
        "disk full",
      );
    });
  });
});

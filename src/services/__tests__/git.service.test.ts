import * as fs from "fs/promises";
import * as path from "path";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import simpleGit from "simple-git";

import {
  TEST_PATHS,
  TEST_URLS,
  buildGitStatusResponse,
  createMockConfig,
  createMockGitService,
  createWorktreeListOutput,
} from "../../__tests__/test-utils";
import { GitService } from "../git.service";
import { WorktreeMetadataService } from "../worktree-metadata.service";

import type { Config } from "../../types";
import type { SimpleGit } from "simple-git";

// Mock the modules
jest.mock("fs/promises");
jest.mock("simple-git");
jest.mock("../worktree-metadata.service");

describe("GitService", () => {
  let gitService: GitService;
  let mockConfig: Config;
  let mockGit: jest.Mocked<SimpleGit>;
  let mockMetadataService: any;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Setup mock config
    mockConfig = createMockConfig();

    // Setup mock metadata service
    mockMetadataService = {
      createInitialMetadata: jest.fn<any>().mockResolvedValue(undefined),
      updateLastSync: jest.fn<any>().mockResolvedValue(undefined),
      loadMetadata: jest.fn<any>().mockResolvedValue(null),
      deleteMetadata: jest.fn<any>().mockResolvedValue(undefined),
      saveMetadata: jest.fn<any>().mockResolvedValue(undefined),
      getMetadataPath: jest.fn<any>().mockResolvedValue("/test/path"),
    };
    (WorktreeMetadataService as jest.MockedClass<typeof WorktreeMetadataService>).mockImplementation(
      () => mockMetadataService as any,
    );

    // Setup mock git instance with jest mocks
    mockGit = createMockGitService({
      fetch: jest.fn<any>().mockResolvedValue(undefined),
      branch: jest.fn<any>().mockResolvedValue({
        all: ["origin/main", "origin/feature-1", "origin/feature-2", "local-branch"],
        current: "main",
      }),
      raw: jest.fn<any>().mockResolvedValue(""),
      status: jest.fn<any>().mockResolvedValue(buildGitStatusResponse({ isClean: true })),
      clone: jest.fn<any>().mockResolvedValue(undefined),
      addConfig: jest.fn<any>().mockResolvedValue(undefined),
      revparse: jest.fn<any>().mockResolvedValue("abc123"),
    }) as jest.Mocked<SimpleGit>;

    // Mock simpleGit factory
    (simpleGit as unknown as jest.Mock).mockReturnValue(mockGit);

    gitService = new GitService(mockConfig);
  });

  describe("initialize", () => {
    it("should use existing bare repository when it exists", async () => {
      // Mock fs.access to succeed (bare repo exists)
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      // Mock fs.mkdir
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      // Mock config check to throw error (config doesn't exist)
      mockGit.raw
        .mockRejectedValueOnce(new Error("config not found")) // First call: config check throws
        .mockResolvedValueOnce(
          createWorktreeListOutput([{ path: TEST_PATHS.worktree + "/main", branch: "main", commit: "abc123" }]) as any,
        ); // Second call: worktree list

      const git = await gitService.initialize();

      expect(fs.access).toHaveBeenCalledWith(".bare/repo/HEAD");
      expect(simpleGit).toHaveBeenCalledWith(".bare/repo");
      expect(mockGit.raw).toHaveBeenCalledWith(["config", "--get-all", "remote.origin.fetch"]);
      expect(mockGit.addConfig).toHaveBeenCalledWith("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      expect(mockGit.fetch).toHaveBeenCalledWith(["--all"]);
      expect(git).toBe(mockGit);
    });

    it("should clone as bare repository when it doesn't exist", async () => {
      // Mock fs.access to fail (bare repo doesn't exist)
      (fs.access as jest.Mock<any>).mockRejectedValue(new Error("ENOENT"));
      // Mock fs.mkdir
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      // Mock config check and worktree list
      mockGit.raw
        .mockRejectedValueOnce(new Error("config not found")) // First call: config check throws
        .mockResolvedValueOnce("" as any) // Second call: getWorktreesFromBare returns empty
        .mockResolvedValueOnce("" as any); // Third call: worktree add

      await gitService.initialize();

      expect(fs.access).toHaveBeenCalledWith(".bare/repo/HEAD");
      expect(fs.mkdir).toHaveBeenCalled();
      expect(simpleGit).toHaveBeenCalledWith(); // Called without args for cloning
      expect(mockGit.clone).toHaveBeenCalledWith(TEST_URLS.github, ".bare/repo", ["--bare"]);
      expect(mockGit.raw).toHaveBeenCalledWith(["config", "--get-all", "remote.origin.fetch"]);
      expect(mockGit.addConfig).toHaveBeenCalledWith("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      expect(mockGit.fetch).toHaveBeenCalledWith(["--all"]);
    });

    it("should create main worktree if it doesn't exist", async () => {
      // Mock fs.access to succeed (bare repo exists)
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      // Mock fs.mkdir
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      // Mock config check and worktree list
      mockGit.raw
        .mockRejectedValueOnce(new Error("config not found")) // First call: config check throws
        .mockResolvedValueOnce("" as any) // Second call: getWorktreesFromBare returns empty
        .mockResolvedValueOnce("" as any); // Third call: worktree add
      mockGit.branch.mockResolvedValueOnce({
        all: [],
        current: "main",
      } as any);

      await gitService.initialize();

      expect(mockGit.fetch).toHaveBeenCalledWith(["--all"]);
      expect(fs.mkdir).toHaveBeenCalledWith(TEST_PATHS.worktree, { recursive: true });
      expect(mockGit.raw).toHaveBeenCalledWith([
        "worktree",
        "add",
        "--track",
        "-b",
        "main",
        TEST_PATHS.worktree + "/main",
        "origin/main",
      ]);
    });

    it("should resolve relative paths to absolute paths when creating worktrees", async () => {
      // Setup config with relative paths
      const relativeConfig: Config = {
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./test/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };
      const relativeGitService = new GitService(relativeConfig);

      // Mock fs.access to succeed (bare repo exists)
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      // Mock fs.mkdir
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      // Mock config check and worktree list
      mockGit.raw
        .mockRejectedValueOnce(new Error("config not found")) // First call: config check throws
        .mockResolvedValueOnce("" as any) // Second call: getWorktreesFromBare returns empty
        .mockResolvedValueOnce("" as any); // Third call: worktree add
      mockGit.branch.mockResolvedValueOnce({
        all: [],
        current: "main",
      } as any);

      await relativeGitService.initialize();

      expect(mockGit.fetch).toHaveBeenCalledWith(["--all"]);
      // Verify that the worktree add command received an absolute path
      const expectedAbsolutePath = path.resolve("./test/worktrees/main");
      expect(mockGit.raw).toHaveBeenCalledWith([
        "worktree",
        "add",
        "--track",
        "-b",
        "main",
        expectedAbsolutePath,
        "origin/main",
      ]);
    });

    it("should not add duplicate fetch config when it already exists", async () => {
      // Mock fs.access to succeed (bare repo exists)
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      // Mock fs.mkdir
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      // Mock config check to return existing fetch config
      mockGit.raw
        .mockResolvedValueOnce("+refs/heads/*:refs/remotes/origin/*") // First call: config exists
        .mockResolvedValueOnce(
          createWorktreeListOutput([{ path: TEST_PATHS.worktree + "/main", branch: "main", commit: "abc123" }]) as any,
        ); // Second call: worktree list

      const git = await gitService.initialize();

      expect(fs.access).toHaveBeenCalledWith(".bare/repo/HEAD");
      expect(simpleGit).toHaveBeenCalledWith(".bare/repo");
      expect(mockGit.raw).toHaveBeenCalledWith(["config", "--get-all", "remote.origin.fetch"]);
      expect(mockGit.addConfig).not.toHaveBeenCalled(); // Should not add config if it already exists
      expect(mockGit.fetch).toHaveBeenCalledWith(["--all"]);
      expect(git).toBe(mockGit);
    });
  });

  describe("getGit", () => {
    it("should throw error when service is not initialized", () => {
      expect(() => gitService.getGit()).toThrow("Git service not initialized. Call initialize() first.");
    });

    it("should return git instance when initialized", async () => {
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      mockGit.raw.mockResolvedValueOnce("worktree /test/worktrees/main\nbranch refs/heads/main\n\n" as any);
      await gitService.initialize();

      const git = gitService.getGit();
      expect(git).toBe(mockGit);
    });
  });

  describe("fetchAll", () => {
    beforeEach(async () => {
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should fetch with --all and --prune flags", async () => {
      await gitService.fetchAll();

      expect(mockGit.fetch).toHaveBeenCalledWith(["--all", "--prune"]);
    });
  });

  describe("getRemoteBranches", () => {
    beforeEach(async () => {
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should return only remote branches without origin prefix", async () => {
      const branches = await gitService.getRemoteBranches();

      expect(mockGit.branch).toHaveBeenCalledWith(["-r"]);
      expect(branches).toEqual(["main", "feature-1", "feature-2"]);
    });

    it("should handle empty branch list", async () => {
      mockGit.branch.mockResolvedValue({ all: [], current: "" } as any);

      const branches = await gitService.getRemoteBranches();

      expect(branches).toEqual([]);
    });

    it("should filter out origin/HEAD", async () => {
      mockGit.branch.mockResolvedValue({
        all: ["origin/main", "origin/feature-1", "origin/HEAD"],
        current: "main",
      } as any);

      const branches = await gitService.getRemoteBranches();

      expect(branches).toEqual(["main", "feature-1"]);
      expect(branches).not.toContain("HEAD");
    });
  });

  describe("getRemoteBranchesWithActivity", () => {
    beforeEach(async () => {
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should return branches with their last activity dates", async () => {
      const mockOutput = [
        "origin/main|2024-01-15T10:30:00-05:00",
        "origin/feature-1|2024-01-10T14:20:00-05:00",
        "origin/feature-2|2023-12-25T08:15:00-05:00",
      ].join("\n");

      mockGit.raw.mockResolvedValueOnce(mockOutput as any);

      const branches = await gitService.getRemoteBranchesWithActivity();

      expect(mockGit.raw).toHaveBeenCalledWith([
        "for-each-ref",
        "--format=%(refname:short)|%(committerdate:iso8601)",
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
        "origin/main|2024-01-15T10:30:00-05:00",
        "invalid-line",
        "origin/feature-1|invalid-date",
        "origin/feature-2|2024-01-10T14:20:00-05:00",
      ].join("\n");

      mockGit.raw.mockResolvedValueOnce(mockOutput as any);

      const branches = await gitService.getRemoteBranchesWithActivity();

      expect(branches).toHaveLength(2);
      expect(branches[0].branch).toBe("main");
      expect(branches[1].branch).toBe("feature-2");
    });

    it("should filter out origin/HEAD", async () => {
      const mockOutput = [
        "origin/main|2024-01-15T10:30:00-05:00",
        "origin/HEAD|2024-01-15T10:30:00-05:00",
        "origin/feature-1|2024-01-14T09:15:00-05:00",
      ].join("\n");

      mockGit.raw.mockResolvedValueOnce(mockOutput as any);

      const branches = await gitService.getRemoteBranchesWithActivity();

      expect(branches).toHaveLength(2);
      expect(branches[0].branch).toBe("main");
      expect(branches[1].branch).toBe("feature-1");
      expect(branches.some((b) => b.branch === "HEAD")).toBe(false);
    });
  });

  describe("addWorktree", () => {
    beforeEach(async () => {
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should add worktree with tracking when branch doesn't exist locally", async () => {
      mockGit.branch.mockResolvedValueOnce({
        all: [],
        current: "main",
      } as any);

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(mockGit.branch).toHaveBeenCalled();
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

    it("should add worktree and set upstream when branch exists locally", async () => {
      mockGit.branch.mockResolvedValueOnce({
        all: ["feature-1", "main"],
        current: "main",
      } as any);

      const worktreeGitMock = {
        branch: jest.fn<any>().mockResolvedValue(undefined),
      };

      // Store original implementation
      const originalImplementation = (simpleGit as unknown as jest.Mock).getMockImplementation();

      // Mock simpleGit to return worktreeGitMock for the worktree path, but mockGit for other paths
      (simpleGit as unknown as jest.Mock).mockImplementation((path?: any) => {
        if (path && path.includes("feature-1")) {
          return worktreeGitMock;
        }
        return mockGit;
      });

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(mockGit.branch).toHaveBeenCalled();
      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", "/test/worktrees/feature-1", "feature-1"]);
      expect(worktreeGitMock.branch).toHaveBeenCalledWith(["--set-upstream-to", "origin/feature-1", "feature-1"]);

      // Restore original implementation
      if (originalImplementation) {
        (simpleGit as unknown as jest.Mock).mockImplementation(originalImplementation);
      }
    });

    it("should resolve relative paths to absolute paths when adding worktrees", async () => {
      mockGit.branch.mockResolvedValueOnce({
        all: [],
        current: "main",
      } as any);

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

    it("should fallback to simple add when tracking setup fails", async () => {
      mockGit.branch.mockRejectedValueOnce(new Error("Branch check failed"));

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      // Should have two calls to raw - first failed attempt, then fallback
      const rawCalls = mockGit.raw.mock.calls.filter((call) => call[0][1] === "add");
      expect(rawCalls[rawCalls.length - 1]).toEqual([["worktree", "add", "/test/worktrees/feature-1", "feature-1"]]);
    });

    it("should clean up orphaned directory before creating worktree", async () => {
      // Mock - directory exists when checking in addWorktree
      (fs.access as jest.Mock<any>).mockResolvedValueOnce(undefined);

      // Reset mockGit.raw and set up responses
      mockGit.raw.mockReset();
      mockGit.raw
        .mockResolvedValueOnce("") // worktree list - empty (directory is not a valid worktree)
        .mockResolvedValueOnce(""); // worktree add command

      mockGit.branch.mockResolvedValueOnce({
        all: [],
        current: "main",
      } as any);

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(fs.access).toHaveBeenCalledWith("/test/worktrees/feature-1");
      expect(fs.rm).toHaveBeenCalledWith("/test/worktrees/feature-1", { recursive: true, force: true });
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
      (fs.access as jest.Mock<any>).mockResolvedValueOnce(undefined);

      // Reset mockGit.raw and set up responses
      mockGit.raw.mockReset();
      mockGit.raw.mockResolvedValueOnce(
        "worktree /test/worktrees/feature-1\n" + "HEAD abc123\n" + "branch refs/heads/feature-1\n\n",
      ); // worktree list - shows the worktree exists

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(fs.access).toHaveBeenCalledWith("/test/worktrees/feature-1");
      expect(fs.rm).not.toHaveBeenCalled();
      // Should have called worktree list but not worktree add
      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "list", "--porcelain"]);
      expect(mockGit.raw).toHaveBeenCalledTimes(1); // Only the list call, no add call
    });

    it("should clean up orphaned directory in fallback path when tracking fails", async () => {
      // Mock - directory exists when checking in addWorktree fallback
      (fs.access as jest.Mock<any>)
        .mockRejectedValueOnce(new Error("Not found")) // First check - directory doesn't exist
        .mockResolvedValueOnce(undefined); // Second check in fallback - directory exists

      // Reset mockGit.raw and set up responses
      mockGit.raw.mockReset();
      mockGit.raw
        .mockRejectedValueOnce(new Error("tracking setup failed")) // Initial add with tracking fails
        .mockResolvedValueOnce("") // worktree list - empty (directory is not a valid worktree)
        .mockResolvedValueOnce(""); // fallback worktree add succeeds

      mockGit.branch.mockResolvedValueOnce({
        all: [],
        current: "main",
      } as any);

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(fs.rm).toHaveBeenCalledWith("/test/worktrees/feature-1", { recursive: true, force: true });
      expect(mockGit.raw).toHaveBeenCalledTimes(3); // Failed tracking add, worktree list, successful fallback add
    });
  });

  describe("removeWorktree", () => {
    beforeEach(async () => {
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should remove worktree with force flag", async () => {
      await gitService.removeWorktree("feature-1");

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "remove", "feature-1", "--force"]);
    });
  });

  describe("pruneWorktrees", () => {
    beforeEach(async () => {
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should prune worktrees", async () => {
      await gitService.pruneWorktrees();

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "prune"]);
    });
  });

  describe("checkWorktreeStatus", () => {
    it("should return true when worktree is clean", async () => {
      const mockWorktreeGit = createMockGitService({
        status: jest.fn<any>().mockResolvedValue(buildGitStatusResponse({ isClean: true })),
      });
      (simpleGit as unknown as jest.Mock).mockReturnValue(mockWorktreeGit);

      const isClean = await gitService.checkWorktreeStatus(TEST_PATHS.worktree + "/feature-1");

      expect(simpleGit).toHaveBeenCalledWith(TEST_PATHS.worktree + "/feature-1");
      expect(isClean).toBe(true);
    });

    it("should return false when worktree has changes", async () => {
      const mockWorktreeGit = createMockGitService({
        status: jest.fn<any>().mockResolvedValue(buildGitStatusResponse({ isClean: false })),
      });
      (simpleGit as unknown as jest.Mock).mockReturnValue(mockWorktreeGit);

      const isClean = await gitService.checkWorktreeStatus(TEST_PATHS.worktree + "/feature-1");

      expect(isClean).toBe(false);
    });
  });

  describe("hasUnpushedCommits", () => {
    it("should return true when worktree has unpushed commits", async () => {
      await gitService.initialize();

      const mockWorktreeGit = {
        branch: jest.fn<any>().mockResolvedValue({
          current: "feature-1",
        }),
        raw: jest.fn<any>().mockResolvedValue("3\n"), // 3 unpushed commits
      };
      (simpleGit as unknown as jest.Mock).mockReturnValue(mockWorktreeGit);

      const hasUnpushed = await gitService.hasUnpushedCommits("/test/worktrees/feature-1");

      expect(hasUnpushed).toBe(true);
      expect(mockWorktreeGit.raw).toHaveBeenCalledWith(["rev-list", "--count", "feature-1", "--not", "--remotes"]);
    });

    it("should return false when worktree has no unpushed commits", async () => {
      await gitService.initialize();

      const mockWorktreeGit = {
        branch: jest.fn<any>().mockResolvedValue({
          current: "feature-1",
        }),
        raw: jest.fn<any>().mockResolvedValue("0\n"), // No unpushed commits
      };
      (simpleGit as unknown as jest.Mock).mockReturnValue(mockWorktreeGit);

      const hasUnpushed = await gitService.hasUnpushedCommits("/test/worktrees/feature-1");

      expect(hasUnpushed).toBe(false);
    });

    it("should handle errors and return false", async () => {
      await gitService.initialize();

      const mockWorktreeGit = {
        branch: jest.fn<any>().mockRejectedValue(new Error("Branch command failed")),
      };
      (simpleGit as unknown as jest.Mock).mockReturnValue(mockWorktreeGit);

      const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const hasUnpushed = await gitService.hasUnpushedCommits("/test/worktrees/feature-1");

      expect(hasUnpushed).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Error checking unpushed commits"));

      consoleSpy.mockRestore();
    });

    it("should use metadata when upstream is gone", async () => {
      await gitService.initialize();

      // Mock gitService methods
      jest.spyOn(gitService, "hasUpstreamGone").mockResolvedValue(true);

      // Mock metadata service to return saved metadata
      (mockMetadataService.loadMetadata as jest.Mock<any>).mockResolvedValue({
        lastSyncCommit: "abc123",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/feature-deleted",
        createdFrom: { branch: "main", commit: "def456" },
        syncHistory: [],
      });

      const mockWorktreeGit = {
        branch: jest.fn<any>().mockResolvedValue({
          current: "feature-deleted",
        }),
        raw: jest
          .fn<any>()
          .mockResolvedValueOnce("2\n") // 2 commits after last sync
          .mockResolvedValueOnce("5\n"), // 5 total unpushed (fallback, should not be called)
      };
      (simpleGit as unknown as jest.Mock).mockReturnValue(mockWorktreeGit);

      const hasUnpushed = await gitService.hasUnpushedCommits("/test/worktrees/feature-deleted");

      expect(hasUnpushed).toBe(true);
      expect(mockMetadataService.loadMetadata).toHaveBeenCalledWith(".bare/repo", "feature-deleted");
      expect(mockWorktreeGit.raw).toHaveBeenCalledWith(["rev-list", "--count", "abc123..HEAD"]);
      // Should not fall back to regular check
      expect(mockWorktreeGit.raw).toHaveBeenCalledTimes(1);
    });

    it("should return false when upstream is gone but no new commits since last sync", async () => {
      await gitService.initialize();

      jest.spyOn(gitService, "hasUpstreamGone").mockResolvedValue(true);

      (mockMetadataService.loadMetadata as jest.Mock<any>).mockResolvedValue({
        lastSyncCommit: "abc123",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/feature-deleted",
        createdFrom: { branch: "main", commit: "def456" },
        syncHistory: [],
      });

      const mockWorktreeGit = {
        branch: jest.fn<any>().mockResolvedValue({
          current: "feature-deleted",
        }),
        raw: jest.fn<any>().mockResolvedValue("0\n"), // 0 commits after last sync
      };
      (simpleGit as unknown as jest.Mock).mockReturnValue(mockWorktreeGit);

      const hasUnpushed = await gitService.hasUnpushedCommits("/test/worktrees/feature-deleted");

      expect(hasUnpushed).toBe(false);
    });
  });

  describe("hasUpstreamGone", () => {
    it("should return true when upstream branch is deleted", async () => {
      await gitService.initialize();

      const mockWorktreeGit = {
        branch: jest
          .fn<any>()
          .mockResolvedValueOnce({
            current: "feature-deleted",
          })
          .mockResolvedValueOnce({
            all: ["origin/main", "origin/feature-1"], // feature-deleted not in remotes
            current: "",
          }),
        raw: jest.fn<any>().mockResolvedValue("origin/feature-deleted\n"),
      };
      (simpleGit as unknown as jest.Mock).mockReturnValue(mockWorktreeGit);

      const upstreamGone = await gitService.hasUpstreamGone("/test/worktrees/feature-deleted");

      expect(upstreamGone).toBe(true);
      expect(mockWorktreeGit.raw).toHaveBeenCalledWith(["rev-parse", "--abbrev-ref", "feature-deleted@{upstream}"]);
      expect(mockWorktreeGit.branch).toHaveBeenCalledWith(["-r"]);
    });

    it("should return false when upstream branch exists", async () => {
      await gitService.initialize();

      const mockWorktreeGit = {
        branch: jest
          .fn<any>()
          .mockResolvedValueOnce({
            current: "feature-1",
          })
          .mockResolvedValueOnce({
            all: ["origin/main", "origin/feature-1"], // feature-1 exists in remotes
            current: "",
          }),
        raw: jest.fn<any>().mockResolvedValue("origin/feature-1\n"),
      };
      (simpleGit as unknown as jest.Mock).mockReturnValue(mockWorktreeGit);

      const upstreamGone = await gitService.hasUpstreamGone("/test/worktrees/feature-1");

      expect(upstreamGone).toBe(false);
      expect(mockWorktreeGit.raw).toHaveBeenCalledWith(["rev-parse", "--abbrev-ref", "feature-1@{upstream}"]);
      expect(mockWorktreeGit.branch).toHaveBeenCalledWith(["-r"]);
    });

    it("should return false when no upstream is configured", async () => {
      await gitService.initialize();

      const mockWorktreeGit = {
        branch: jest.fn<any>().mockResolvedValue({
          current: "local-only",
        }),
        raw: jest.fn<any>().mockRejectedValue(new Error("fatal: no upstream configured")),
      };
      (simpleGit as unknown as jest.Mock).mockReturnValue(mockWorktreeGit);

      const upstreamGone = await gitService.hasUpstreamGone("/test/worktrees/local-only");

      expect(upstreamGone).toBe(false);
      expect(mockWorktreeGit.raw).toHaveBeenCalledWith(["rev-parse", "--abbrev-ref", "local-only@{upstream}"]);
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

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "list", "--porcelain"]);
      expect(worktrees).toEqual([
        { path: "/path/to/repo", branch: "main" },
        { path: "/path/to/worktrees/feature-1", branch: "feature-1" },
        { path: "/path/to/worktrees/feature-2", branch: "feature-2" },
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
        { path: "/path/to/repo", branch: "main" },
        { path: "/path/to/worktrees/feature-1", branch: "feature-1" },
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
        { path: "/path/to/repo", branch: "main" },
        { path: "/path/to/worktrees/feature-1", branch: "feature-1" },
      ]);
    });
  });

  describe("hasStashedChanges", () => {
    beforeEach(async () => {
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should return true when worktree has stashed changes", async () => {
      const mockWorktreeGit = {
        stashList: jest.fn<any>().mockResolvedValue({ total: 2 }),
      } as any;
      (simpleGit as jest.MockedFunction<typeof simpleGit>).mockReturnValue(mockWorktreeGit);

      const result = await gitService.hasStashedChanges("/test/worktree");

      expect(result).toBe(true);
      expect(simpleGit).toHaveBeenCalledWith("/test/worktree");
    });

    it("should return false when worktree has no stashed changes", async () => {
      const mockWorktreeGit = {
        stashList: jest.fn<any>().mockResolvedValue({ total: 0 }),
      } as any;
      (simpleGit as jest.MockedFunction<typeof simpleGit>).mockReturnValue(mockWorktreeGit);

      const result = await gitService.hasStashedChanges("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return true when stash check fails", async () => {
      const mockWorktreeGit = {
        stashList: jest.fn<any>().mockRejectedValue(new Error("Failed to check stash")),
      } as any;
      (simpleGit as jest.MockedFunction<typeof simpleGit>).mockReturnValue(mockWorktreeGit);

      const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const result = await gitService.hasStashedChanges("/test/worktree");

      expect(result).toBe(true); // Conservative approach
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Error checking stash: Error: Failed to check stash"),
      );

      consoleSpy.mockRestore();
    });
  });

  describe("hasModifiedSubmodules", () => {
    beforeEach(async () => {
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should return true when submodules are modified", async () => {
      const mockWorktreeGit = {
        raw: jest.fn<any>().mockResolvedValue("+1234567 submodule1 (modified)"),
      } as any;
      (simpleGit as jest.MockedFunction<typeof simpleGit>).mockReturnValue(mockWorktreeGit);

      const result = await gitService.hasModifiedSubmodules("/test/worktree");

      expect(result).toBe(true);
      expect(mockWorktreeGit.raw).toHaveBeenCalledWith(["submodule", "status"]);
    });

    it("should return true when submodules have different commits", async () => {
      const mockWorktreeGit = {
        raw: jest.fn<any>().mockResolvedValue("-1234567 submodule1 (new commits)"),
      } as any;
      (simpleGit as jest.MockedFunction<typeof simpleGit>).mockReturnValue(mockWorktreeGit);

      const result = await gitService.hasModifiedSubmodules("/test/worktree");

      expect(result).toBe(true);
    });

    it("should return false when no submodules or all clean", async () => {
      const mockWorktreeGit = {
        raw: jest.fn<any>().mockResolvedValue(" 1234567 submodule1 (clean)"),
      } as any;
      (simpleGit as jest.MockedFunction<typeof simpleGit>).mockReturnValue(mockWorktreeGit);

      const result = await gitService.hasModifiedSubmodules("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return false when submodule command fails", async () => {
      const mockWorktreeGit = {
        raw: jest.fn<any>().mockRejectedValue(new Error("No submodules")),
      } as any;
      (simpleGit as jest.MockedFunction<typeof simpleGit>).mockReturnValue(mockWorktreeGit);

      const result = await gitService.hasModifiedSubmodules("/test/worktree");

      expect(result).toBe(false);
    });
  });

  describe("hasOperationInProgress", () => {
    let bareGit: jest.Mocked<SimpleGit>;

    beforeEach(async () => {
      bareGit = mockGit;
      const mainWorktreeExists = createWorktreeListOutput([
        { path: TEST_PATHS.worktree + "/main", branch: "main", commit: "abc123" },
      ]);

      (fs.access as jest.Mock<any>)
        .mockResolvedValueOnce(undefined) // bare repo exists
        .mockRejectedValueOnce(new Error("config not found")); // config check

      bareGit.raw.mockResolvedValueOnce(mainWorktreeExists as any);
      await gitService.initialize();
    });

    it("should return true when merge is in progress", async () => {
      (fs.access as jest.Mock<any>)
        .mockRejectedValueOnce(new Error("Not found")) // MERGE_HEAD
        .mockResolvedValueOnce(undefined); // MERGE_HEAD exists

      const result = await gitService.hasOperationInProgress("/test/worktree");

      expect(result).toBe(true);
      expect(fs.access).toHaveBeenCalledWith(path.join("/test/worktree", ".git", "MERGE_HEAD"));
    });

    it("should return true when rebase is in progress", async () => {
      (fs.access as jest.Mock<any>).mockRejectedValue(new Error("Not found"));
      (fs.access as jest.Mock<any>)
        .mockRejectedValueOnce(new Error("Not found")) // MERGE_HEAD
        .mockRejectedValueOnce(new Error("Not found")) // CHERRY_PICK_HEAD
        .mockRejectedValueOnce(new Error("Not found")) // REVERT_HEAD
        .mockRejectedValueOnce(new Error("Not found")) // BISECT_LOG
        .mockResolvedValueOnce(undefined); // rebase-merge exists

      const result = await gitService.hasOperationInProgress("/test/worktree");

      expect(result).toBe(true);
    });

    it("should return false when no operation is in progress", async () => {
      (fs.access as jest.Mock<any>).mockRejectedValue(new Error("Not found"));

      const result = await gitService.hasOperationInProgress("/test/worktree");

      expect(result).toBe(false);
      // Note: fs.access is called 7 times: 1 from beforeEach (bare repo check) + 6 operation files
      expect(fs.access).toHaveBeenCalledTimes(7);
    });
  });
});

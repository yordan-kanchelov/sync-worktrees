import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  TEST_PATHS,
  TEST_URLS,
  buildGitStatusResponse,
  createMockConfig,
  createMockGitService,
  createWorktreeListOutput,
} from "../../__tests__/test-utils";
import { GitService } from "../git.service";

import type { Config } from "../../types";
import type { SimpleGit } from "simple-git";
import type { Mock, Mocked, MockedFunction } from "vitest";

// Use vi.hoisted to create mock instance that can be accessed in both factory and tests
const { mockMetadataServiceInstance } = vi.hoisted(() => {
  return {
    mockMetadataServiceInstance: {
      createInitialMetadata: vi.fn<any>().mockResolvedValue(undefined),
      createInitialMetadataFromPath: vi.fn<any>().mockResolvedValue(undefined),
      updateLastSync: vi.fn<any>().mockResolvedValue(undefined),
      updateLastSyncFromPath: vi.fn<any>().mockResolvedValue(undefined),
      loadMetadata: vi.fn<any>().mockResolvedValue(null),
      loadMetadataFromPath: vi.fn<any>().mockResolvedValue(null),
      deleteMetadata: vi.fn<any>().mockResolvedValue(undefined),
      deleteMetadataFromPath: vi.fn<any>().mockResolvedValue(undefined),
      saveMetadata: vi.fn<any>().mockResolvedValue(undefined),
      getMetadataPath: vi.fn<any>().mockResolvedValue("/test/path"),
      getMetadataPathFromWorktreePath: vi.fn<any>().mockResolvedValue("/test/path"),
    },
  };
});

// Mock the modules
vi.mock("fs/promises");
vi.mock("simple-git");
vi.mock("../worktree-metadata.service", () => {
  return {
    WorktreeMetadataService: vi.fn(function (this: any) {
      return mockMetadataServiceInstance;
    }),
  };
});

describe("GitService", () => {
  let gitService: GitService;
  let mockConfig: Config;
  let mockGit: Mocked<SimpleGit>;
  let mockMetadataService: any;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Setup mock config
    mockConfig = createMockConfig();

    // Reference the hoisted mock instance
    mockMetadataService = mockMetadataServiceInstance;

    // Setup mock git instance
    mockGit = createMockGitService({
      fetch: vi.fn<any>().mockResolvedValue(undefined) as any,
      branch: vi.fn<any>().mockResolvedValue({
        all: ["origin/main", "origin/feature-1", "origin/feature-2", "local-branch"],
        current: "main",
      }) as any,
      raw: vi.fn<any>().mockResolvedValue("") as any,
      status: vi.fn<any>().mockResolvedValue(buildGitStatusResponse({ isClean: true })) as any,
      clone: vi.fn<any>().mockResolvedValue(undefined) as any,
      addConfig: vi.fn<any>().mockResolvedValue(undefined) as any,
      revparse: vi.fn<any>().mockResolvedValue("abc123") as any,
    }) as Mocked<SimpleGit>;

    // Mock simpleGit factory
    (simpleGit as unknown as Mock).mockReturnValue(mockGit);

    gitService = new GitService(mockConfig);
  });

  describe("initialize", () => {
    it("should use existing bare repository when it exists", async () => {
      // Mock fs.access to succeed (bare repo exists)
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      // Mock fs.mkdir
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
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
      (fs.access as Mock<any>).mockRejectedValue(new Error("ENOENT"));
      // Mock fs.mkdir
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
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
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      // Mock fs.mkdir
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
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
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      // Mock fs.mkdir
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
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
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      // Mock fs.mkdir
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
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

  describe("fetchBranch", () => {
    it("should fetch single branch and update remote refs (no LFS)", async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      mockGit.raw
        .mockRejectedValueOnce(new Error("config not found"))
        .mockResolvedValueOnce(
          createWorktreeListOutput([{ path: TEST_PATHS.worktree + "/main", branch: "main", commit: "abc123" }]) as any,
        );

      await gitService.initialize();

      await gitService.fetchBranch("feature-1");
      expect(mockGit.fetch).toHaveBeenCalledWith(["origin", "feature-1", "--prune"]);
    });

    it("should respect LFS skip when fetching branch", async () => {
      const cfg: Config = { ...mockConfig, skipLfs: true };
      const svc = new GitService(cfg);
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      mockGit.raw
        .mockRejectedValueOnce(new Error("config not found"))
        .mockResolvedValueOnce(
          createWorktreeListOutput([{ path: TEST_PATHS.worktree + "/main", branch: "main", commit: "abc123" }]) as any,
        );

      await svc.initialize();
      await svc.fetchBranch("feature-2");
      expect(mockGit.env).toHaveBeenCalledWith({ GIT_LFS_SKIP_SMUDGE: "1" });
      expect(mockGit.fetch).toHaveBeenCalledWith(["origin", "feature-2", "--prune"]);
    });
  });

  describe("hasOperationInProgress (worktree .git file)", () => {
    it("resolves gitdir from .git file and detects operation markers", async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      const worktreePath = "/test/worktree";
      const gitFilePath = path.join(worktreePath, ".git");
      // .git is a file
      (fs.stat as Mock<any>).mockResolvedValueOnce({ isFile: () => true });
      (fs.readFile as Mock<any>).mockResolvedValueOnce("gitdir: /real/git/dir\n");
      // MERGE_HEAD exists in resolved dir
      (fs.access as Mock<any>).mockResolvedValueOnce(undefined);

      const result = await gitService.hasOperationInProgress(worktreePath);
      expect(result).toBe(true);
      expect(fs.access).toHaveBeenCalledWith(path.join("/real/git/dir", "MERGE_HEAD"));
      // ensure we looked at .git file
      expect(fs.stat).toHaveBeenCalledWith(gitFilePath);
    });
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

      (simpleGit as unknown as Mock).mockClear();
      // next simpleGit() call should be with bare repo path
      await gitService.getRemoteCommit("origin/main");
      const calls = (simpleGit as unknown as Mock).mock.calls;
      expect(calls[calls.length - 1][0]).toBe(TEST_PATHS.bareRepo);
    });
  });

  describe("getGit", () => {
    it("should throw error when service is not initialized", () => {
      expect(() => gitService.getGit()).toThrow("Git service not initialized. Call initialize() first.");
    });

    it("should return git instance when initialized", async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      mockGit.raw.mockResolvedValueOnce("worktree /test/worktrees/main\nbranch refs/heads/main\n\n" as any);
      await gitService.initialize();

      const git = gitService.getGit();
      expect(git).toBe(mockGit);
    });
  });

  describe("fetchAll", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should fetch with --all and --prune flags", async () => {
      await gitService.fetchAll();

      expect(mockGit.fetch).toHaveBeenCalledWith(["--all", "--prune"]);
    });
  });

  describe("getRemoteBranches", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
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
      (fs.access as Mock<any>).mockResolvedValue(undefined);
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
      (fs.access as Mock<any>).mockResolvedValue(undefined);
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
        branch: vi.fn<any>().mockResolvedValue(undefined),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
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

      expect(mockGit.branch).toHaveBeenCalled();
      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", "/test/worktrees/feature-1", "feature-1"]);
      expect(worktreeGitMock.branch).toHaveBeenCalledWith(["--set-upstream-to", "origin/feature-1", "feature-1"]);

      // Restore original implementation
      if (originalImplementation) {
        (simpleGit as unknown as Mock).mockImplementation(originalImplementation);
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
      (fs.access as Mock<any>).mockResolvedValueOnce(undefined);

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
      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "list", "--porcelain"]);
      expect(mockGit.raw).toHaveBeenCalledTimes(1); // Only the list call, no add call
    });

    it("should clean up orphaned directory in fallback path when tracking fails", async () => {
      // Mock - directory exists when checking in addWorktree fallback
      (fs.access as Mock<any>)
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
      expect(mockGit.raw).toHaveBeenCalledTimes(4); // Failed tracking add, worktree list, successful fallback add, LFS ls-files
    });

    it("should throw error when metadata creation fails", async () => {
      mockGit.branch.mockResolvedValueOnce({
        all: [],
        current: "main",
      } as any);

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

    it("should handle stale worktree registration (registered but prunable)", async () => {
      const worktreePath = "/test/worktrees/feature-1";

      (fs.access as Mock<any>).mockRejectedValueOnce(new Error("Not found")); // Directory doesn't exist initially

      mockGit.raw.mockReset();
      mockGit.raw
        .mockRejectedValueOnce(new Error("fatal: 'feature-1' is already registered worktree")) // Initial add fails - already registered
        .mockResolvedValueOnce(`worktree ${worktreePath}\nHEAD abc123\nbranch refs/heads/feature-1\nprunable\n\n`) // Worktree list shows it's registered but prunable
        .mockResolvedValueOnce("") // Prune succeeds
        .mockResolvedValueOnce("") // Retry add succeeds
        .mockResolvedValueOnce(""); // LFS ls-files

      mockGit.branch.mockResolvedValueOnce({
        all: [],
        current: "main",
      } as any);

      await gitService.addWorktree("feature-1", worktreePath);

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "list", "--porcelain"]);
      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "prune"]);
      expect(fs.rm).toHaveBeenCalledWith(worktreePath, { recursive: true, force: true });
      expect(mockGit.raw).toHaveBeenCalledWith([
        "worktree",
        "add",
        "--track",
        "-b",
        "feature-1",
        worktreePath,
        "origin/feature-1",
      ]);
    });

    it("should handle concurrent creation when worktree is registered AND not prunable", async () => {
      const worktreePath = "/test/worktrees/feature-1";

      (fs.access as Mock<any>).mockRejectedValueOnce(new Error("Not found")); // Directory doesn't exist initially

      mockGit.raw.mockReset();
      mockGit.raw
        .mockRejectedValueOnce(new Error("fatal: 'feature-1' is already registered worktree")) // Initial add fails - already registered
        .mockResolvedValueOnce(`worktree ${worktreePath}\nHEAD abc123\nbranch refs/heads/feature-1\n\n`); // Worktree list shows it's registered and NOT prunable

      mockGit.branch.mockResolvedValueOnce({
        all: [],
        current: "main",
      } as any);

      await gitService.addWorktree("feature-1", worktreePath);

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "list", "--porcelain"]);
      expect(mockGit.raw).not.toHaveBeenCalledWith(["worktree", "prune"]);
      expect(fs.rm).not.toHaveBeenCalled();
    });
  });

  describe("addWorktree - LFS verification", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should verify LFS files are downloaded when LFS is not skipped", async () => {
      mockGit.branch.mockResolvedValueOnce({
        all: [],
        current: "main",
      } as any);

      const lfsFiles = "file1.png\nfile2.png\nfile3.png\n";
      const worktreeGitMock = {
        raw: vi.fn<any>().mockResolvedValue(lfsFiles),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
      };

      (simpleGit as unknown as Mock).mockImplementation((path?: any) => {
        if (path && path.includes("feature-1")) {
          return worktreeGitMock;
        }
        return mockGit;
      });

      const mockFileHandle = {
        read: vi.fn<any>().mockResolvedValue({
          bytesRead: 18,
        }),
        close: vi.fn<any>().mockResolvedValue(undefined),
      };

      (fs.open as Mock<any>).mockResolvedValue(mockFileHandle);

      const bufferSpy = vi.spyOn(Buffer, "alloc");

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(worktreeGitMock.raw).toHaveBeenCalledWith(["lfs", "ls-files", "--name-only"]);
      expect(fs.open).toHaveBeenCalled();
      expect(bufferSpy).toHaveBeenCalledWith(200);
      expect(mockFileHandle.close).toHaveBeenCalled();

      bufferSpy.mockRestore();
    });

    it("should skip LFS verification when skipLfs is enabled", async () => {
      const configWithSkipLfs = createMockConfig({ skipLfs: true });

      const gitServiceWithSkipLfs = new GitService(configWithSkipLfs);

      mockMetadataService.createInitialMetadataFromPath.mockResolvedValueOnce(undefined);

      await gitServiceWithSkipLfs.initialize();

      mockGit.branch.mockResolvedValueOnce({
        all: [],
        current: "main",
      } as any);

      const worktreeGitMock = {
        raw: vi.fn<any>().mockResolvedValue("file1.png\n"),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
        env: vi.fn<any>().mockReturnThis(),
      };

      (simpleGit as unknown as Mock).mockImplementation((path?: any) => {
        if (path && path.includes("feature-1")) {
          return worktreeGitMock;
        }
        return mockGit;
      });

      await gitServiceWithSkipLfs.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(worktreeGitMock.raw).not.toHaveBeenCalledWith(["lfs", "ls-files", "--name-only"]);
    });

    it("should wait for LFS files to be downloaded if they are pointers", async () => {
      mockGit.branch.mockResolvedValueOnce({
        all: [],
        current: "main",
      } as any);

      const lfsFiles = "file1.png\n";
      const worktreeGitMock = {
        raw: vi.fn<any>().mockResolvedValue(lfsFiles),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
      };

      (simpleGit as unknown as Mock).mockImplementation((path?: any) => {
        if (path && path.includes("feature-1")) {
          return worktreeGitMock;
        }
        return mockGit;
      });

      let callCount = 0;
      const mockFileHandle = {
        read: vi.fn().mockImplementation((buffer: Buffer) => {
          callCount++;
          if (callCount === 1) {
            buffer.write("version https://git-lfs.github.com/spec/v1", "utf8");
            return Promise.resolve({ bytesRead: 43 });
          }
          buffer.write("actual image data", "utf8");
          return Promise.resolve({ bytesRead: 17 });
        }),
        close: vi.fn<any>().mockResolvedValue(undefined),
      };

      (fs.open as Mock<any>).mockResolvedValue(mockFileHandle);

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(fs.open).toHaveBeenCalledTimes(2);
      expect(mockFileHandle.close).toHaveBeenCalledTimes(2);
    });

    it("should warn if LFS files are not downloaded after timeout", async () => {
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mockGit.branch.mockResolvedValueOnce({
        all: [],
        current: "main",
      } as any);

      const lfsFiles = "file1.png\n";
      const worktreeGitMock = {
        raw: vi.fn<any>().mockResolvedValue(lfsFiles),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
      };

      (simpleGit as unknown as Mock).mockImplementation((path?: any) => {
        if (path && path.includes("feature-1")) {
          return worktreeGitMock;
        }
        return mockGit;
      });

      const mockFileHandle = {
        read: vi.fn().mockImplementation((buffer: Buffer) => {
          buffer.write("version https://git-lfs.github.com/spec/v1", "utf8");
          return Promise.resolve({ bytesRead: 43 });
        }),
        close: vi.fn<any>().mockResolvedValue(undefined),
      };

      (fs.open as Mock<any>).mockResolvedValue(mockFileHandle);

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Some LFS files may not be fully downloaded"),
      );

      consoleWarnSpy.mockRestore();
    }, 40000);

    it("should skip verification if no LFS files exist", async () => {
      mockGit.branch.mockResolvedValueOnce({
        all: [],
        current: "main",
      } as any);

      const worktreeGitMock = {
        raw: vi.fn<any>().mockResolvedValue(""),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
      };

      (simpleGit as unknown as Mock).mockImplementation((path?: any) => {
        if (path && path.includes("feature-1")) {
          return worktreeGitMock;
        }
        return mockGit;
      });

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(worktreeGitMock.raw).toHaveBeenCalledWith(["lfs", "ls-files", "--name-only"]);
      expect(fs.readFile).not.toHaveBeenCalled();
    });
  });

  describe("removeWorktree", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should remove worktree with force flag", async () => {
      await gitService.removeWorktree("feature-1");

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "remove", "feature-1", "--force"]);
    });
  });

  describe("pruneWorktrees", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
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
        status: vi.fn<any>().mockResolvedValue(buildGitStatusResponse({ isClean: true })) as any,
      });
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const isClean = await gitService.checkWorktreeStatus(TEST_PATHS.worktree + "/feature-1");

      expect(simpleGit).toHaveBeenCalledWith(TEST_PATHS.worktree + "/feature-1");
      expect(isClean).toBe(true);
    });

    it("should return false when worktree has changes", async () => {
      const mockWorktreeGit = createMockGitService({
        status: vi.fn<any>().mockResolvedValue(buildGitStatusResponse({ isClean: false })) as any,
      });
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const isClean = await gitService.checkWorktreeStatus(TEST_PATHS.worktree + "/feature-1");

      expect(isClean).toBe(false);
    });
  });

  describe("hasUnpushedCommits", () => {
    it("should return true when worktree has unpushed commits", async () => {
      await gitService.initialize();

      const mockWorktreeGit = {
        branch: vi.fn<any>().mockResolvedValue({
          current: "feature-1",
        }),
        raw: vi.fn<any>().mockResolvedValue("3\n"), // 3 unpushed commits
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const hasUnpushed = await gitService.hasUnpushedCommits("/test/worktrees/feature-1");

      expect(hasUnpushed).toBe(true);
      expect(mockWorktreeGit.raw).toHaveBeenCalledWith(["rev-list", "--count", "feature-1", "--not", "--remotes"]);
    });

    it("should return false when worktree has no unpushed commits", async () => {
      await gitService.initialize();

      const mockWorktreeGit = {
        branch: vi.fn<any>().mockResolvedValue({
          current: "feature-1",
        }),
        raw: vi.fn<any>().mockResolvedValue("0\n"), // No unpushed commits
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const hasUnpushed = await gitService.hasUnpushedCommits("/test/worktrees/feature-1");

      expect(hasUnpushed).toBe(false);
    });

    it("should handle errors and return false", async () => {
      await gitService.initialize();

      const mockWorktreeGit = {
        branch: vi.fn<any>().mockResolvedValue({
          current: "feature-1",
          detached: false,
        }),
        raw: vi.fn<any>().mockRejectedValue(new Error("Command failed")),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const hasUnpushed = await gitService.hasUnpushedCommits("/test/worktrees/feature-1");

      expect(hasUnpushed).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Error checking unpushed commits"));

      consoleSpy.mockRestore();
    });

    it("should use metadata when upstream is gone", async () => {
      await gitService.initialize();

      // Mock gitService methods
      vi.spyOn(gitService, "hasUpstreamGone").mockResolvedValue(true);

      // Mock metadata service to return saved metadata (use path-based method)
      (mockMetadataService.loadMetadataFromPath as Mock<any>).mockResolvedValue({
        lastSyncCommit: "abc123",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/feature-deleted",
        createdFrom: { branch: "main", commit: "def456" },
        syncHistory: [],
      });

      const mockWorktreeGit = {
        branch: vi.fn<any>().mockResolvedValue({
          current: "feature-deleted",
        }),
        raw: vi
          .fn<any>()
          .mockResolvedValueOnce("2\n") // 2 commits after last sync
          .mockResolvedValueOnce("5\n"), // 5 total unpushed (fallback, should not be called)
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const hasUnpushed = await gitService.hasUnpushedCommits("/test/worktrees/feature-deleted");

      expect(hasUnpushed).toBe(true);
      expect(mockMetadataService.loadMetadataFromPath).toHaveBeenCalledWith(
        ".bare/repo",
        "/test/worktrees/feature-deleted",
      );
      expect(mockWorktreeGit.raw).toHaveBeenCalledWith(["rev-list", "--count", "abc123..HEAD"]);
      // Should not fall back to regular check
      expect(mockWorktreeGit.raw).toHaveBeenCalledTimes(1);
    });

    it("should return false when upstream is gone but no new commits since last sync", async () => {
      await gitService.initialize();

      vi.spyOn(gitService, "hasUpstreamGone").mockResolvedValue(true);

      (mockMetadataService.loadMetadata as Mock<any>).mockResolvedValue({
        lastSyncCommit: "abc123",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/feature-deleted",
        createdFrom: { branch: "main", commit: "def456" },
        syncHistory: [],
      });

      const mockWorktreeGit = {
        branch: vi.fn<any>().mockResolvedValue({
          current: "feature-deleted",
        }),
        raw: vi.fn<any>().mockResolvedValue("0\n"), // 0 commits after last sync
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const hasUnpushed = await gitService.hasUnpushedCommits("/test/worktrees/feature-deleted");

      expect(hasUnpushed).toBe(false);
    });

    it("should return false when worktree is in detached HEAD state", async () => {
      await gitService.initialize();

      const mockWorktreeGit = {
        branch: vi.fn<any>().mockResolvedValue({
          current: "",
          detached: true,
        }),
        raw: vi.fn<any>(),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const hasUnpushed = await gitService.hasUnpushedCommits("/test/worktrees/detached");

      expect(hasUnpushed).toBe(false);
      expect(mockWorktreeGit.branch).toHaveBeenCalled();
      expect(mockWorktreeGit.raw).not.toHaveBeenCalled();
    });
  });

  describe("hasUpstreamGone", () => {
    it("should return true when upstream branch is deleted", async () => {
      await gitService.initialize();

      const mockWorktreeGit = {
        branch: vi
          .fn<any>()
          .mockResolvedValueOnce({
            current: "feature-deleted",
            detached: false,
          })
          .mockResolvedValueOnce({
            current: "feature-deleted",
            detached: false,
          })
          .mockResolvedValueOnce({
            all: ["origin/main", "origin/feature-1"], // feature-deleted not in remotes
            current: "",
          }),
        raw: vi.fn<any>().mockResolvedValue("origin/feature-deleted\n"),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const upstreamGone = await gitService.hasUpstreamGone("/test/worktrees/feature-deleted");

      expect(upstreamGone).toBe(true);
      expect(mockWorktreeGit.raw).toHaveBeenCalledWith(["rev-parse", "--abbrev-ref", "feature-deleted@{upstream}"]);
      expect(mockWorktreeGit.branch).toHaveBeenCalledWith(["-r"]);
    });

    it("should return false when upstream branch exists", async () => {
      await gitService.initialize();

      const mockWorktreeGit = {
        branch: vi
          .fn<any>()
          .mockResolvedValueOnce({
            current: "feature-1",
            detached: false,
          })
          .mockResolvedValueOnce({
            current: "feature-1",
            detached: false,
          })
          .mockResolvedValueOnce({
            all: ["origin/main", "origin/feature-1"], // feature-1 exists in remotes
            current: "",
          }),
        raw: vi.fn<any>().mockResolvedValue("origin/feature-1\n"),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const upstreamGone = await gitService.hasUpstreamGone("/test/worktrees/feature-1");

      expect(upstreamGone).toBe(false);
      expect(mockWorktreeGit.raw).toHaveBeenCalledWith(["rev-parse", "--abbrev-ref", "feature-1@{upstream}"]);
      expect(mockWorktreeGit.branch).toHaveBeenCalledWith(["-r"]);
    });

    it("should return false when no upstream is configured", async () => {
      await gitService.initialize();

      const mockWorktreeGit = {
        branch: vi.fn<any>().mockResolvedValue({
          current: "local-only",
        }),
        raw: vi.fn<any>().mockRejectedValue(new Error("fatal: no upstream configured")),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const upstreamGone = await gitService.hasUpstreamGone("/test/worktrees/local-only");

      expect(upstreamGone).toBe(false);
      expect(mockWorktreeGit.raw).toHaveBeenCalledWith(["rev-parse", "--abbrev-ref", "local-only@{upstream}"]);
    });

    it("should return false when upstream reference is ambiguous and no config", async () => {
      await gitService.initialize();

      const mockWorktreeGit = {
        branch: vi.fn<any>().mockResolvedValue({
          current: "feat/autocue-frontend",
        }),
        raw: vi
          .fn<any>()
          .mockRejectedValue(
            new Error(
              "feat/autocue-frontend@{upstream}\nfatal: ambiguous argument 'feat/autocue-frontend@{upstream}': unknown revision or path not in the working tree.",
            ),
          ),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const upstreamGone = await gitService.hasUpstreamGone("/test/worktrees/feat/autocue-frontend");

      expect(upstreamGone).toBe(false);
      expect(mockWorktreeGit.raw).toHaveBeenCalledWith([
        "rev-parse",
        "--abbrev-ref",
        "feat/autocue-frontend@{upstream}",
      ]);
    });

    it("should return false when worktree is in detached HEAD state", async () => {
      await gitService.initialize();

      const mockWorktreeGit = {
        branch: vi.fn<any>().mockResolvedValue({
          current: "",
          detached: true,
        }),
        raw: vi.fn<any>(),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const upstreamGone = await gitService.hasUpstreamGone("/test/worktrees/detached");

      expect(upstreamGone).toBe(false);
      expect(mockWorktreeGit.branch).toHaveBeenCalled();
      expect(mockWorktreeGit.raw).not.toHaveBeenCalled();
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
        { path: "/path/to/repo", branch: "main", isPrunable: false },
        { path: "/path/to/worktrees/feature-1", branch: "feature-1", isPrunable: false },
        { path: "/path/to/worktrees/feature-2", branch: "feature-2", isPrunable: false },
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
        { path: "/path/to/repo", branch: "main", isPrunable: false },
        { path: "/path/to/worktrees/feature-1", branch: "feature-1", isPrunable: false },
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
        { path: "/path/to/repo", branch: "main", isPrunable: false },
        { path: "/path/to/worktrees/feature-1", branch: "feature-1", isPrunable: false },
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
        { path: "/path/to/repo", branch: "main", isPrunable: false },
        { path: "/path/to/worktrees/feature-1", branch: "feature-1", isPrunable: false },
        { path: "/path/to/worktrees/feature-2", branch: "feature-2", isPrunable: false },
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
        { path: "/path/to/repo", branch: "main", isPrunable: false },
        { path: "/path/to/worktrees/feature-1", branch: "feature-1", isPrunable: false },
        { path: "/path/to/worktrees/stale-worktree", branch: "stale-branch", isPrunable: true },
        { path: "/path/to/worktrees/feature-2", branch: "feature-2", isPrunable: false },
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
        { path: "/path/to/repo", branch: "main", isPrunable: false },
        { path: "/path/to/worktrees/incomplete", branch: "incomplete-branch", isPrunable: true },
      ]);
    });
  });

  describe("hasStashedChanges", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should return true when worktree has stashed changes", async () => {
      const mockWorktreeGit = {
        stashList: vi.fn<any>().mockResolvedValue({ total: 2 }),
      } as any;
      (simpleGit as MockedFunction<typeof simpleGit>).mockReturnValue(mockWorktreeGit);

      const result = await gitService.hasStashedChanges("/test/worktree");

      expect(result).toBe(true);
      expect(simpleGit).toHaveBeenCalledWith("/test/worktree");
    });

    it("should return false when worktree has no stashed changes", async () => {
      const mockWorktreeGit = {
        stashList: vi.fn<any>().mockResolvedValue({ total: 0 }),
      } as any;
      (simpleGit as MockedFunction<typeof simpleGit>).mockReturnValue(mockWorktreeGit);

      const result = await gitService.hasStashedChanges("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return true when stash check fails", async () => {
      const mockWorktreeGit = {
        stashList: vi.fn<any>().mockRejectedValue(new Error("Failed to check stash")),
      } as any;
      (simpleGit as MockedFunction<typeof simpleGit>).mockReturnValue(mockWorktreeGit);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should return true when submodules are modified", async () => {
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockResolvedValue("+1234567 submodule1 (modified)"),
      } as any;
      (simpleGit as MockedFunction<typeof simpleGit>).mockReturnValue(mockWorktreeGit);

      const result = await gitService.hasModifiedSubmodules("/test/worktree");

      expect(result).toBe(true);
      expect(mockWorktreeGit.raw).toHaveBeenCalledWith(["submodule", "status"]);
    });

    it("should return true when submodules have different commits", async () => {
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockResolvedValue("-1234567 submodule1 (new commits)"),
      } as any;
      (simpleGit as MockedFunction<typeof simpleGit>).mockReturnValue(mockWorktreeGit);

      const result = await gitService.hasModifiedSubmodules("/test/worktree");

      expect(result).toBe(true);
    });

    it("should return false when no submodules or all clean", async () => {
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockResolvedValue(" 1234567 submodule1 (clean)"),
      } as any;
      (simpleGit as MockedFunction<typeof simpleGit>).mockReturnValue(mockWorktreeGit);

      const result = await gitService.hasModifiedSubmodules("/test/worktree");

      expect(result).toBe(false);
    });

    it("should return false when submodule command fails", async () => {
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockRejectedValue(new Error("No submodules")),
      } as any;
      (simpleGit as MockedFunction<typeof simpleGit>).mockReturnValue(mockWorktreeGit);

      const result = await gitService.hasModifiedSubmodules("/test/worktree");

      expect(result).toBe(false);
    });
  });

  describe("hasOperationInProgress", () => {
    let bareGit: Mocked<SimpleGit>;

    beforeEach(async () => {
      bareGit = mockGit;
      const mainWorktreeExists = createWorktreeListOutput([
        { path: TEST_PATHS.worktree + "/main", branch: "main", commit: "abc123" },
      ]);

      (fs.access as Mock<any>)
        .mockResolvedValueOnce(undefined) // bare repo exists
        .mockRejectedValueOnce(new Error("config not found")); // config check

      bareGit.raw.mockResolvedValueOnce(mainWorktreeExists as any);
      await gitService.initialize();
    });

    it("should return true when merge is in progress", async () => {
      (fs.access as Mock<any>)
        .mockRejectedValueOnce(new Error("Not found")) // MERGE_HEAD
        .mockResolvedValueOnce(undefined); // MERGE_HEAD exists

      const result = await gitService.hasOperationInProgress("/test/worktree");

      expect(result).toBe(true);
      expect(fs.access).toHaveBeenCalledWith(path.join("/test/worktree", ".git", "MERGE_HEAD"));
    });

    it("should return true when rebase is in progress", async () => {
      (fs.access as Mock<any>).mockRejectedValue(new Error("Not found"));
      (fs.access as Mock<any>)
        .mockRejectedValueOnce(new Error("Not found")) // MERGE_HEAD
        .mockRejectedValueOnce(new Error("Not found")) // CHERRY_PICK_HEAD
        .mockRejectedValueOnce(new Error("Not found")) // REVERT_HEAD
        .mockRejectedValueOnce(new Error("Not found")) // BISECT_LOG
        .mockResolvedValueOnce(undefined); // rebase-merge exists

      const result = await gitService.hasOperationInProgress("/test/worktree");

      expect(result).toBe(true);
    });

    it("should return false when no operation is in progress", async () => {
      (fs.access as Mock<any>).mockRejectedValue(new Error("Not found"));

      const result = await gitService.hasOperationInProgress("/test/worktree");

      expect(result).toBe(false);
      // Note: fs.access is called 7 times: 1 from beforeEach (bare repo check) + 6 operation files
      expect(fs.access).toHaveBeenCalledTimes(7);
    });
  });

  describe("updateWorktree", () => {
    it("should update worktree and metadata for regular worktrees", async () => {
      await gitService.initialize();

      const mockWorktreeGit = {
        branch: vi.fn<any>().mockResolvedValue({
          current: "feature-1",
        }),
        merge: vi.fn<any>().mockResolvedValue(undefined),
        revparse: vi.fn<any>().mockResolvedValue("newcommit123\n"),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      await gitService.updateWorktree("/test/worktrees/feature-1");

      expect(mockWorktreeGit.merge).toHaveBeenCalledWith(["origin/feature-1", "--ff-only"]);
      expect(mockMetadataService.updateLastSyncFromPath).toHaveBeenCalledWith(
        ".bare/repo",
        "/test/worktrees/feature-1",
        "newcommit123",
        "updated",
        "main",
      );
    });

    it("should skip metadata update for main worktree", async () => {
      await gitService.initialize();

      const mockWorktreeGit = {
        branch: vi.fn<any>().mockResolvedValue({
          current: "main",
        }),
        merge: vi.fn<any>().mockResolvedValue(undefined),
        revparse: vi.fn<any>().mockResolvedValue("newcommit123\n"),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      await gitService.updateWorktree("/test/worktrees/main");

      expect(mockWorktreeGit.merge).toHaveBeenCalledWith(["origin/main", "--ff-only"]);
      expect(mockMetadataService.updateLastSync).not.toHaveBeenCalled();
    });
  });
});

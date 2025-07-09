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

import type { Config } from "../../types";
import type { SimpleGit } from "simple-git";

// Mock the modules
jest.mock("fs/promises");
jest.mock("simple-git");

describe("GitService", () => {
  let gitService: GitService;
  let mockConfig: Config;
  let mockGit: jest.Mocked<SimpleGit>;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Setup mock config
    mockConfig = createMockConfig();

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
        .mockResolvedValueOnce("") // First call: config check throws
        .mockResolvedValueOnce(
          createWorktreeListOutput([{ path: TEST_PATHS.worktree + "/main", branch: "main", commit: "abc123" }]) as any,
        ); // Second call: worktree list

      const git = await gitService.initialize();

      expect(fs.access).toHaveBeenCalledWith(".bare/repo/HEAD");
      expect(simpleGit).toHaveBeenCalledWith(".bare/repo");
      expect(mockGit.raw).toHaveBeenCalledWith(["config", "--get-all", "remote.origin.fetch"]);
      expect(mockGit.addConfig).toHaveBeenCalledWith("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      expect(git).toBe(mockGit);
    });

    it("should clone as bare repository when it doesn't exist", async () => {
      // Mock fs.access to fail (bare repo doesn't exist)
      (fs.access as jest.Mock<any>).mockRejectedValue(new Error("ENOENT"));
      // Mock fs.mkdir
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      // Mock config check and worktree list
      mockGit.raw
        .mockResolvedValueOnce("") // First call: config check throws
        .mockResolvedValueOnce("" as any); // Second call: getWorktreesFromBare returns empty

      await gitService.initialize();

      expect(fs.access).toHaveBeenCalledWith(".bare/repo/HEAD");
      expect(fs.mkdir).toHaveBeenCalled();
      expect(simpleGit).toHaveBeenCalledWith(); // Called without args for cloning
      expect(mockGit.clone).toHaveBeenCalledWith(TEST_URLS.github, ".bare/repo", ["--bare"]);
      expect(mockGit.raw).toHaveBeenCalledWith(["config", "--get-all", "remote.origin.fetch"]);
      expect(mockGit.addConfig).toHaveBeenCalledWith("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    });

    it("should create main worktree if it doesn't exist", async () => {
      // Mock fs.access to succeed (bare repo exists)
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      // Mock fs.mkdir
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      // Mock config check and worktree list
      mockGit.raw
        .mockResolvedValueOnce("") // First call: config check throws
        .mockResolvedValueOnce("" as any); // Second call: getWorktreesFromBare returns empty

      await gitService.initialize();

      expect(fs.mkdir).toHaveBeenCalledWith(TEST_PATHS.worktree, { recursive: true });
      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", TEST_PATHS.worktree + "/main", "main"]);
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
        .mockResolvedValueOnce("") // First call: config check throws
        .mockResolvedValueOnce("" as any); // Second call: getWorktreesFromBare returns empty

      await relativeGitService.initialize();

      // Verify that the worktree add command received an absolute path
      const expectedAbsolutePath = path.resolve("./test/worktrees/main");
      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", expectedAbsolutePath, "main"]);
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
      expect(git).toBe(mockGit);
    });

    it("should handle empty bareRepoDir by using default", async () => {
      // Setup config with empty bareRepoDir - should fall back to default
      const configWithEmptyBareRepo: Config = {
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "/test/worktrees",
        bareRepoDir: "",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };
      const gitServiceWithEmptyBareRepo = new GitService(configWithEmptyBareRepo);

      // Mock fs.access to fail (bare repo doesn't exist)
      (fs.access as jest.Mock<any>).mockRejectedValue(new Error("ENOENT"));
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      // Mock config check and worktree list
      mockGit.raw
        .mockResolvedValueOnce("") // First call: config check throws
        .mockResolvedValueOnce("" as any); // Second call: getWorktreesFromBare returns empty

      await gitServiceWithEmptyBareRepo.initialize();

      // Should use default bare repo path (.bare/repo) instead of empty string
      expect(fs.mkdir).toHaveBeenCalled();
      expect(mockGit.clone).toHaveBeenCalledWith("https://github.com/test/repo.git", ".bare/repo", ["--bare"]);
    });

    it("should throw error when bareRepoPath is whitespace only", async () => {
      // Setup config with whitespace-only bareRepoDir
      const invalidConfig: Config = {
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "/test/worktrees",
        bareRepoDir: "   ",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };
      const invalidGitService = new GitService(invalidConfig);

      // Mock fs.access to fail (bare repo doesn't exist)
      (fs.access as jest.Mock<any>).mockRejectedValue(new Error("ENOENT"));

      await expect(invalidGitService.initialize()).rejects.toThrow(
        "Invalid bare repository path: path cannot be empty",
      );
    });

    it("should throw error when bareRepoPath is a root directory", async () => {
      // Setup config with root directory
      const invalidConfig: Config = {
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "/test/worktrees",
        bareRepoDir: "/",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };
      const invalidGitService = new GitService(invalidConfig);

      // Mock fs.access to fail (bare repo doesn't exist)
      (fs.access as jest.Mock<any>).mockRejectedValue(new Error("ENOENT"));

      await expect(invalidGitService.initialize()).rejects.toThrow(
        'Invalid bare repository path: "/" is a root directory or has invalid parent directory',
      );
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
  });

  describe("addWorktree", () => {
    beforeEach(async () => {
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should add worktree with correct parameters", async () => {
      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", "/test/worktrees/feature-1", "feature-1"]);
    });

    it("should resolve relative paths to absolute paths when adding worktrees", async () => {
      await gitService.addWorktree("feature-1", "./test/worktrees/feature-1");

      const expectedAbsolutePath = path.resolve("./test/worktrees/feature-1");
      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", expectedAbsolutePath, "feature-1"]);
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
});

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
  createMockLogger,
  createWorktreeListOutput,
} from "../../__tests__/test-utils";
import { GitService } from "../git.service";

import type { Config } from "../../types";
import type { Logger } from "../logger.service";
import type { SimpleGit } from "simple-git";
import type { Mock, Mocked } from "vitest";

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
  let mockLogger: Logger;

  const mockShowRef = (opts: { local: boolean; remote: boolean }): void => {
    (mockGit.raw as Mock).mockImplementation((args: unknown) => {
      if (Array.isArray(args) && args[0] === "show-ref" && args[1] === "--verify") {
        const ref = args[3];
        if (typeof ref === "string" && ref.startsWith("refs/heads/")) {
          return opts.local ? Promise.resolve("") : Promise.reject(new Error("show-ref: not found"));
        }
        if (typeof ref === "string" && ref.startsWith("refs/remotes/origin/")) {
          return opts.remote ? Promise.resolve("") : Promise.reject(new Error("show-ref: not found"));
        }
      }
      return Promise.resolve("");
    });
  };

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Setup mock logger
    mockLogger = createMockLogger();

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

    gitService = new GitService(mockConfig, mockLogger);
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
      // Fetch is always called to ensure remote refs are up-to-date
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

      // Fetch is always called to ensure remote refs are up-to-date
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

      // Fetch is always called to ensure remote refs are up-to-date
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

    it("should gracefully handle existing directory when creating main worktree", async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      mockGit.raw
        .mockRejectedValueOnce(new Error("config not found")) // config check
        .mockResolvedValueOnce("" as any) // worktree list empty => needsMainWorktree = true
        .mockRejectedValueOnce(new Error("already exists")); // worktree add fails
      mockGit.branch.mockResolvedValueOnce({
        all: [],
        current: "main",
      } as any);

      await gitService.initialize();

      // Should NOT call fs.rm - handles the error gracefully instead
      expect(fs.rm).not.toHaveBeenCalled();
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
      // Fetch is always called to ensure remote refs are up-to-date
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

    it("should add worktree and set upstream when branch exists locally", async () => {
      mockShowRef({ local: true, remote: true });

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

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", "/test/worktrees/feature-1", "feature-1"]);
      expect(worktreeGitMock.branch).toHaveBeenCalledWith(["--set-upstream-to", "origin/feature-1", "feature-1"]);

      // Restore original implementation
      if (originalImplementation) {
        (simpleGit as unknown as Mock).mockImplementation(originalImplementation);
      }
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
            const ref = args[3];
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

    it("should NOT fallback to simple add when a non-tracking error occurs", async () => {
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (Array.isArray(args)) {
          if (args[0] === "show-ref" && args[1] === "--verify") {
            const ref = args[3];
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
      (fs.access as Mock<any>).mockResolvedValueOnce(undefined);

      mockGit.raw.mockReset();
      mockGit.raw
        .mockResolvedValueOnce("") // worktree list - empty (directory is not a valid worktree)
        .mockRejectedValueOnce(new Error("show-ref: not found")) // refs/heads/feature-1 missing
        .mockResolvedValueOnce("") // refs/remotes/origin/feature-1 exists
        .mockResolvedValueOnce(""); // worktree add command

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
      (fs.access as Mock<any>)
        .mockRejectedValueOnce(new Error("Not found")) // First check - directory doesn't exist
        .mockResolvedValueOnce(undefined); // Second check in fallback - directory exists

      mockGit.raw.mockReset();
      mockGit.raw
        .mockRejectedValueOnce(new Error("show-ref: not found")) // refs/heads missing
        .mockResolvedValueOnce("") // refs/remotes/origin exists
        .mockRejectedValueOnce(new Error("no such remote ref")) // tracking add fails
        .mockResolvedValueOnce("") // worktree list - empty (directory is not a valid worktree)
        .mockResolvedValueOnce(""); // fallback worktree add succeeds

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(fs.rm).toHaveBeenCalledWith("/test/worktrees/feature-1", { recursive: true, force: true });
      // Calls: show-ref heads, show-ref remotes, tracking add (fail), worktree list, fallback add, LFS ls-files
      expect(mockGit.raw).toHaveBeenCalledTimes(6);
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

    it("should handle stale worktree registration (registered but prunable)", async () => {
      const worktreePath = "/test/worktrees/feature-1";

      (fs.access as Mock<any>).mockRejectedValueOnce(new Error("Not found")); // Directory doesn't exist initially

      mockGit.raw.mockReset();
      mockGit.raw
        .mockRejectedValueOnce(new Error("show-ref: not found")) // refs/heads missing
        .mockResolvedValueOnce("") // refs/remotes/origin exists
        .mockRejectedValueOnce(new Error("fatal: 'feature-1' is already registered worktree")) // Initial add fails
        .mockResolvedValueOnce(`worktree ${worktreePath}\nHEAD abc123\nbranch refs/heads/feature-1\nprunable\n\n`) // Worktree list shows registered but prunable
        .mockResolvedValueOnce("") // Prune succeeds
        .mockRejectedValueOnce(new Error("show-ref: not found")) // refs/heads missing on retry
        .mockResolvedValueOnce("") // refs/remotes/origin exists on retry
        .mockResolvedValueOnce("") // Retry add succeeds
        .mockResolvedValueOnce(""); // LFS ls-files

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
        .mockRejectedValueOnce(new Error("show-ref: not found")) // refs/heads missing
        .mockResolvedValueOnce("") // refs/remotes/origin exists
        .mockRejectedValueOnce(new Error("fatal: 'feature-1' is already registered worktree")) // Initial add fails
        .mockResolvedValueOnce(`worktree ${worktreePath}\nHEAD abc123\nbranch refs/heads/feature-1\n\n`); // Registered, NOT prunable

      await gitService.addWorktree("feature-1", worktreePath);

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "list", "--porcelain"]);
      expect(mockGit.raw).not.toHaveBeenCalledWith(["worktree", "prune"]);
      expect(fs.rm).not.toHaveBeenCalled();
    });

    describe("addWorktree - ref existence matrix", () => {
      const makeWorktreeGitMock = () => ({
        branch: vi.fn<any>().mockResolvedValue(undefined),
        raw: vi.fn<any>().mockResolvedValue(""),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
      });

      it("should add worktree without upstream when local exists but remote does not (push:false flow)", async () => {
        const worktreeGitMock = makeWorktreeGitMock();
        (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
          p && p.includes("feat-new") ? worktreeGitMock : mockGit,
        );

        mockShowRef({ local: true, remote: false });
        mockGit.raw.mockClear();

        await gitService.addWorktree("feat-new", "/test/worktrees/feat-new");

        expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", "/test/worktrees/feat-new", "feat-new"]);
        expect(worktreeGitMock.branch).not.toHaveBeenCalled();
        expect(mockGit.raw).not.toHaveBeenCalledWith(
          expect.arrayContaining(["worktree", "add", "--track", "-b", "feat-new"]),
        );
        expect(mockLogger.warn).not.toHaveBeenCalledWith(
          expect.stringContaining("Failed to create worktree with tracking"),
        );
      });

      it("should add worktree with upstream when both local and remote exist", async () => {
        const worktreeGitMock = makeWorktreeGitMock();
        (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
          p && p.includes("feature-1") ? worktreeGitMock : mockGit,
        );

        mockShowRef({ local: true, remote: true });

        await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

        expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", "/test/worktrees/feature-1", "feature-1"]);
        expect(worktreeGitMock.branch).toHaveBeenCalledWith(["--set-upstream-to", "origin/feature-1", "feature-1"]);
      });

      it("should use --track when local missing but remote exists", async () => {
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

      it("should throw clear WorktreeError when neither local nor remote ref exists", async () => {
        mockShowRef({ local: false, remote: false });
        mockGit.raw.mockClear();

        await expect(gitService.addWorktree("nope", "/test/worktrees/nope")).rejects.toThrow(
          /does not exist locally or on origin/,
        );
        const worktreeAddCalls = mockGit.raw.mock.calls.filter(
          (call) => Array.isArray(call[0]) && call[0][0] === "worktree" && call[0][1] === "add",
        );
        expect(worktreeAddCalls).toHaveLength(0);
      });

      it("should rollback worktree add when --set-upstream-to fails", async () => {
        const worktreeGitMock = {
          branch: vi.fn<any>().mockRejectedValue(new Error("fatal: branch 'feature-1' does not point to a commit")),
          raw: vi.fn<any>().mockResolvedValue(""),
          revparse: vi.fn<any>().mockResolvedValue("abc123"),
        };
        (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
          p && p.includes("feature-1") ? worktreeGitMock : mockGit,
        );

        mockShowRef({ local: true, remote: true });
        mockGit.raw.mockClear();

        await expect(gitService.addWorktree("feature-1", "/test/worktrees/feature-1")).rejects.toThrow(
          /Failed to set upstream for 'feature-1'.*does not point to a commit/,
        );

        expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", "/test/worktrees/feature-1", "feature-1"]);
        expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "remove", "--force", "/test/worktrees/feature-1"]);
      });

      it("should still throw wrapped upstream error if rollback also fails", async () => {
        const worktreeGitMock = {
          branch: vi.fn<any>().mockRejectedValue(new Error("upstream-set-failure")),
          raw: vi.fn<any>().mockResolvedValue(""),
          revparse: vi.fn<any>().mockResolvedValue("abc123"),
        };
        (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
          p && p.includes("feature-1") ? worktreeGitMock : mockGit,
        );

        mockShowRef({ local: true, remote: true });
        mockGit.raw.mockClear();
        (mockGit.raw as Mock).mockImplementation((args: unknown) => {
          if (Array.isArray(args)) {
            if (args[0] === "show-ref" && args[1] === "--verify") {
              return Promise.resolve("");
            }
            if (args[0] === "worktree" && args[1] === "remove") {
              return Promise.reject(new Error("rollback-failure"));
            }
          }
          return Promise.resolve("");
        });

        await expect(gitService.addWorktree("feature-1", "/test/worktrees/feature-1")).rejects.toThrow(
          /Failed to set upstream.*upstream-set-failure.*rollback failed/,
        );
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Rollback failed"));
      });

      it("should not enter tracking-error fallback when upstream-set fails with tracking-classified message", async () => {
        // Fresh add: no existing dir.
        (fs.access as Mock<any>).mockRejectedValue(new Error("Not found"));

        const worktreeGitMock = {
          branch: vi.fn<any>().mockRejectedValue(new Error("fatal: no such remote ref refs/remotes/origin/feature-1")),
          raw: vi.fn<any>().mockResolvedValue(""),
          revparse: vi.fn<any>().mockResolvedValue("abc123"),
        };
        (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
          p && p.includes("feature-1") ? worktreeGitMock : mockGit,
        );

        mockShowRef({ local: true, remote: true });
        mockGit.raw.mockClear();
        (mockGit.raw as Mock).mockImplementation((args: unknown) => {
          if (Array.isArray(args)) {
            if (args[0] === "show-ref" && args[1] === "--verify") {
              return Promise.resolve("");
            }
            if (args[0] === "worktree" && args[1] === "remove") {
              return Promise.reject(new Error("rollback-failure"));
            }
            if (args[0] === "worktree" && args[1] === "list") {
              return Promise.resolve("");
            }
          }
          return Promise.resolve("");
        });

        await expect(gitService.addWorktree("feature-1", "/test/worktrees/feature-1")).rejects.toThrow(
          /Failed to set upstream/,
        );

        // Only the initial `worktree add <path> <branch>` should fire.
        // The fallback non-tracking add at addWorktree's L498 must NOT fire.
        const plainWorktreeAdds = (mockGit.raw as Mock).mock.calls.filter(
          (call) =>
            Array.isArray(call[0]) && call[0][0] === "worktree" && call[0][1] === "add" && !call[0].includes("--track"),
        );
        expect(plainWorktreeAdds).toHaveLength(1);
      });

      it("should not special-case slash branch names (feat/foo with both refs behaves like normal)", async () => {
        const worktreeGitMock = makeWorktreeGitMock();
        (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
          p && p.includes("feat-foo") ? worktreeGitMock : mockGit,
        );

        mockShowRef({ local: true, remote: true });

        await gitService.addWorktree("feat/foo", "/test/worktrees/feat-foo");

        expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", "/test/worktrees/feat-foo", "feat/foo"]);
        expect(worktreeGitMock.branch).toHaveBeenCalledWith(["--set-upstream-to", "origin/feat/foo", "feat/foo"]);
      });

      it("should reuse ref matrix in retry path after pruning (no remote → non-tracking add)", async () => {
        const worktreePath = "/test/worktrees/feat-new";
        (fs.access as Mock<any>).mockRejectedValueOnce(new Error("Not found"));

        const worktreeGitMock = makeWorktreeGitMock();
        (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
          p && p.includes("feat-new") ? worktreeGitMock : mockGit,
        );

        mockGit.raw.mockClear();

        let initialAddAttempted = false;
        (mockGit.raw as Mock).mockImplementation((args: unknown) => {
          if (Array.isArray(args)) {
            if (args[0] === "show-ref" && args[1] === "--verify") {
              const ref = args[3];
              if (typeof ref === "string" && ref.startsWith("refs/heads/")) return Promise.resolve("");
              if (typeof ref === "string" && ref.startsWith("refs/remotes/origin/")) {
                return Promise.reject(new Error("show-ref: not found"));
              }
            }
            if (args[0] === "worktree" && args[1] === "add" && !initialAddAttempted) {
              initialAddAttempted = true;
              return Promise.reject(new Error("fatal: 'feat-new' is already registered worktree"));
            }
            if (args[0] === "worktree" && args[1] === "list") {
              return Promise.resolve(`worktree ${worktreePath}\nHEAD abc123\nbranch refs/heads/feat-new\nprunable\n\n`);
            }
          }
          return Promise.resolve("");
        });

        await gitService.addWorktree("feat-new", worktreePath);

        const trackingAdds = mockGit.raw.mock.calls.filter(
          (call) => Array.isArray(call[0]) && call[0].includes("--track"),
        );
        expect(trackingAdds).toHaveLength(0);
        expect(mockLogger.warn).not.toHaveBeenCalledWith(
          expect.stringContaining("Failed to create worktree with tracking"),
        );
      });
    });
  });

  describe("addWorktree - LFS verification", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should verify LFS files are downloaded when LFS is not skipped", async () => {
      mockShowRef({ local: false, remote: true });

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

      mockShowRef({ local: false, remote: true });

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
      mockShowRef({ local: false, remote: true });

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
      mockShowRef({ local: false, remote: true });

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

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Some LFS files may not be fully downloaded"),
      );
    }, 40000);

    it("should skip verification if no LFS files exist", async () => {
      mockShowRef({ local: false, remote: true });

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

  describe("setLfsSkipEnabled", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should cause LFS-skipped git operations when enabled", async () => {
      gitService.setLfsSkipEnabled(true);

      await gitService.fetchAll();

      expect(mockGit.env).toHaveBeenCalledWith({ GIT_LFS_SKIP_SMUDGE: "1" });
    });

    it("should not affect git operations when disabled", async () => {
      gitService.setLfsSkipEnabled(false);

      await gitService.fetchAll();

      expect(mockGit.env).not.toHaveBeenCalled();
    });

    it("should be togglable at runtime", async () => {
      gitService.setLfsSkipEnabled(true);
      await gitService.fetchAll();
      expect(mockGit.env).toHaveBeenCalledWith({ GIT_LFS_SKIP_SMUDGE: "1" });

      vi.clearAllMocks();
      (simpleGit as unknown as Mock).mockReturnValue(mockGit);

      gitService.setLfsSkipEnabled(false);
      await gitService.fetchAll();
      expect(mockGit.env).not.toHaveBeenCalled();
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
  });

  describe("hasUnpushedCommits", () => {
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
        raw: vi.fn<any>().mockResolvedValue("0\n"), // 0 commits after last sync
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const hasUnpushed = await gitService.hasUnpushedCommits("/test/worktrees/feature-deleted");

      expect(hasUnpushed).toBe(false);
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

    it("should update metadata for main worktree", async () => {
      await gitService.initialize();

      mockGit.branch.mockResolvedValue({ current: "main" } as any);
      (mockGit as any).merge = vi.fn<any>().mockResolvedValue(undefined);
      mockGit.revparse.mockResolvedValue("newcommit123\n" as any);

      await gitService.updateWorktree("/test/worktrees/main");

      expect((mockGit as any).merge).toHaveBeenCalledWith(["origin/main", "--ff-only"]);
      expect(mockMetadataService.updateLastSyncFromPath).toHaveBeenCalledWith(
        ".bare/repo",
        "/test/worktrees/main",
        "newcommit123",
        "updated",
        "main",
      );
    });
  });

  describe("isLocalAheadOfRemote", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("should return true when local is ahead of remote", async () => {
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockResolvedValue("abc123\n"),
        revparse: vi.fn<any>().mockResolvedValue("abc123\n"),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const result = await gitService.isLocalAheadOfRemote("/test/worktrees/feature-1", "feature-1");

      expect(result).toBe(true);
      expect(mockWorktreeGit.raw).toHaveBeenCalledWith(["merge-base", "HEAD", "origin/feature-1"]);
      expect(mockWorktreeGit.revparse).toHaveBeenCalledWith(["origin/feature-1"]);
    });

    it("should return false when local is behind remote", async () => {
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockResolvedValue("abc123\n"),
        revparse: vi.fn<any>().mockResolvedValue("def456\n"),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const result = await gitService.isLocalAheadOfRemote("/test/worktrees/feature-1", "feature-1");

      expect(result).toBe(false);
    });

    it("should return false when merge-base differs from remote (truly diverged)", async () => {
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockResolvedValue("abc123\n"),
        revparse: vi.fn<any>().mockResolvedValue("xyz789\n"),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const result = await gitService.isLocalAheadOfRemote("/test/worktrees/feature-1", "feature-1");

      expect(result).toBe(false);
    });

    it("should return false when truly diverged (neither ancestor of other)", async () => {
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockResolvedValue("commonancestor\n"),
        revparse: vi.fn<any>().mockResolvedValue("remotecommit\n"),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const result = await gitService.isLocalAheadOfRemote("/test/worktrees/feature-1", "feature-1");

      expect(result).toBe(false);
    });

    it("should return false when merge-base fails", async () => {
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockRejectedValue(new Error("fatal: Not a valid object name")),
        revparse: vi.fn<any>().mockResolvedValue("abc123\n"),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const result = await gitService.isLocalAheadOfRemote("/test/worktrees/feature-1", "feature-1");

      expect(result).toBe(false);
    });

    it("should return false when revparse fails", async () => {
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockResolvedValue("abc123\n"),
        revparse: vi.fn<any>().mockRejectedValue(new Error("fatal: Not a valid object name")),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const result = await gitService.isLocalAheadOfRemote("/test/worktrees/feature-1", "feature-1");

      expect(result).toBe(false);
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

  describe("initialize - failure scenarios", () => {
    it("should throw when fetch fails during initialization", async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      mockGit.raw.mockRejectedValueOnce(new Error("config not found"));
      mockGit.fetch.mockRejectedValueOnce(new Error("Network unreachable"));

      await expect(gitService.initialize()).rejects.toThrow("Network unreachable");
    });

    it("should fallback to 'main' when all default branch detection methods fail", async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);

      // Sequence all raw calls in order of execution:
      // 1. config check → reject (triggers addConfig)
      // 2. symbolic-ref → reject (first detection attempt fails)
      // 3. set-head → reject (skips second symbolic-ref, falls to branch -r)
      // 4. worktree list → returns main worktree so no creation needed
      mockGit.raw.mockReset();
      mockGit.raw
        .mockRejectedValueOnce(new Error("config not found"))
        .mockRejectedValueOnce(new Error("not a symbolic ref"))
        .mockRejectedValueOnce(new Error("set-head failed"))
        .mockResolvedValueOnce(
          createWorktreeListOutput([{ path: TEST_PATHS.worktree + "/main", branch: "main", commit: "abc123" }]) as any,
        );

      // branch(-r) in detectDefaultBranch → also fails, so all detection methods exhausted
      mockGit.branch.mockRejectedValueOnce(new Error("branch list failed"));

      const git = await gitService.initialize();
      expect(git).toBe(mockGit);
    });
  });

  describe("addWorktree with sparseCheckout", () => {
    it("adds --no-checkout, runs sparse init/set, then checkout HEAD", async () => {
      const sparseConfig: Config = {
        ...createMockConfig(),
        sparseCheckout: { include: ["apps", "packages"] },
      };

      const worktreeRawCalls: string[][] = [];
      const worktreeGitMock: any = {
        branch: vi.fn<any>().mockResolvedValue(undefined),
        raw: vi.fn<any>().mockImplementation((...args: unknown[]) => {
          worktreeRawCalls.push(args[0] as string[]);
          return Promise.resolve("");
        }),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
      };
      worktreeGitMock.env = vi.fn(() => worktreeGitMock);

      (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
        p && p.includes("feature-1") ? worktreeGitMock : mockGit,
      );

      mockShowRef({ local: false, remote: true });

      const sparseGitService = new GitService(sparseConfig, mockLogger);
      mockGit.raw.mockClear();

      await sparseGitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(mockGit.raw).toHaveBeenCalledWith([
        "worktree",
        "add",
        "--no-checkout",
        "--track",
        "-b",
        "feature-1",
        "/test/worktrees/feature-1",
        "origin/feature-1",
      ]);
      expect(worktreeRawCalls).toEqual(
        expect.arrayContaining([
          ["sparse-checkout", "init", "--cone"],
          ["sparse-checkout", "set", "--cone", "apps", "packages"],
          ["checkout", "HEAD"],
        ]),
      );
    });

    it("uses --no-cone for excludes config", async () => {
      const sparseConfig: Config = {
        ...createMockConfig(),
        sparseCheckout: { include: ["/*"], exclude: ["docs"] },
      };

      const worktreeRawCalls: string[][] = [];
      const worktreeGitMock: any = {
        branch: vi.fn<any>().mockResolvedValue(undefined),
        raw: vi.fn<any>().mockImplementation((...args: unknown[]) => {
          worktreeRawCalls.push(args[0] as string[]);
          return Promise.resolve("");
        }),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
      };
      worktreeGitMock.env = vi.fn(() => worktreeGitMock);

      (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
        p && p.includes("feature-1") ? worktreeGitMock : mockGit,
      );

      mockShowRef({ local: true, remote: false });

      const sparseGitService = new GitService(sparseConfig, mockLogger);

      await sparseGitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(worktreeRawCalls).toEqual(
        expect.arrayContaining([
          ["sparse-checkout", "init", "--no-cone"],
          ["sparse-checkout", "set", "--no-cone", "/*", "!docs"],
          ["checkout", "HEAD"],
        ]),
      );
    });

    it("does not pass --no-checkout when sparseCheckout is unset", async () => {
      mockShowRef({ local: true, remote: false });
      mockGit.raw.mockClear();

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      const calls = (mockGit.raw as Mock).mock.calls.map((c) => (Array.isArray(c[0]) ? c[0] : []));
      const hasNoCheckout = calls.some(
        (args: any[]) => args[0] === "worktree" && args[1] === "add" && args.includes("--no-checkout"),
      );
      expect(hasNoCheckout).toBe(false);
    });

    it("rolls back worktree and deletes new branch when sparse apply fails (track-new variant)", async () => {
      const sparseConfig: Config = {
        ...createMockConfig(),
        sparseCheckout: { include: ["apps"] },
      };

      const worktreeGitMock = {
        branch: vi.fn<any>().mockResolvedValue(undefined),
        raw: vi
          .fn<any>()
          .mockImplementationOnce(() => Promise.reject(new Error("sparse-checkout init blew up")))
          .mockResolvedValue(""),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
      };

      (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
        p && p.includes("feat-new") ? worktreeGitMock : mockGit,
      );

      mockShowRef({ local: false, remote: true });

      const sparseGitService = new GitService(sparseConfig, mockLogger);
      mockGit.raw.mockClear();

      await expect(sparseGitService.addWorktree("feat-new", "/test/worktrees/feat-new")).rejects.toThrow(
        /Sparse-checkout setup failed/,
      );

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "remove", "--force", "/test/worktrees/feat-new"]);
      expect(mockGit.raw).toHaveBeenCalledWith(["branch", "-D", "feat-new"]);
    });
  });
});

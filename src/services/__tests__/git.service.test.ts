import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TEST_PATHS,
  TEST_URLS,
  buildGitStatusResponse,
  createMockConfig,
  createMockGitService,
  createMockLogger,
  createWorktreeListOutput,
  setEnvVar,
} from "../../__tests__/test-utils";
import { DEFAULT_CONFIG, ENV_CONSTANTS } from "../../constants";
import { ConfigError, WorktreeNotCleanError } from "../../errors";
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
        const ref = args[args.length - 1];
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
      reset: vi.fn<any>().mockResolvedValue(undefined) as any,
      clone: vi.fn<any>().mockResolvedValue(undefined) as any,
      addConfig: vi.fn<any>().mockResolvedValue(undefined) as any,
      push: vi.fn<any>().mockResolvedValue(undefined) as any,
      revparse: vi.fn<any>().mockResolvedValue("abc123") as any,
    }) as Mocked<SimpleGit>;

    // Mock simpleGit factory
    (simpleGit as unknown as Mock).mockReturnValue(mockGit);

    gitService = new GitService(mockConfig, mockLogger);
  });

  describe("inactivity timeouts", () => {
    const originalShortcut = process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT];
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      setEnvVar(ENV_CONSTANTS.UNIT_TEST_SHORTCUT, originalShortcut);
      setEnvVar("NODE_ENV", originalNodeEnv);
    });

    it("keeps the default timeouts when NODE_ENV=test but the unit-test shortcut is unset", async () => {
      // NODE_ENV is whatever the caller's shell or CI exported; it must never disable the timeouts.
      process.env.NODE_ENV = "test";
      delete process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT];
      const service = new GitService(createMockConfig(), mockLogger);

      expect((service as any).getFetchTimeoutMs()).toBe(DEFAULT_CONFIG.FETCH_TIMEOUT_MS);
      expect((service as any).getCloneTimeoutMs()).toBe(DEFAULT_CONFIG.CLONE_TIMEOUT_MS);

      (mockGit.raw as Mock).mockResolvedValue("ref: refs/heads/main\tHEAD\n");
      await service.getRemoteDefaultBranch(TEST_URLS.github);
      expect(simpleGit).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: { block: DEFAULT_CONFIG.FETCH_TIMEOUT_MS } }),
      );
    });

    it("prefers the configured timeouts when the unit-test shortcut is unset", () => {
      delete process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT];
      const service = new GitService(createMockConfig({ fetchTimeoutMs: 1_000, cloneTimeoutMs: 2_000 }), mockLogger);

      expect((service as any).getFetchTimeoutMs()).toBe(1_000);
      expect((service as any).getCloneTimeoutMs()).toBe(2_000);
    });

    it("disables the timeouts only while the unit-test shortcut is active for this process", async () => {
      process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT] = String(process.pid);
      const service = new GitService(createMockConfig(), mockLogger);

      expect((service as any).getFetchTimeoutMs()).toBe(0);
      expect((service as any).getCloneTimeoutMs()).toBe(0);

      (mockGit.raw as Mock).mockResolvedValue("ref: refs/heads/main\tHEAD\n");
      await service.getRemoteDefaultBranch(TEST_URLS.github);
      expect(simpleGit).toHaveBeenCalledWith(expect.not.objectContaining({ timeout: expect.anything() }));
    });

    it("ignores a shortcut value inherited from another process", () => {
      process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT] = String(process.pid + 1);
      const service = new GitService(createMockConfig(), mockLogger);

      expect((service as any).getFetchTimeoutMs()).toBe(DEFAULT_CONFIG.FETCH_TIMEOUT_MS);
      expect((service as any).getCloneTimeoutMs()).toBe(DEFAULT_CONFIG.CLONE_TIMEOUT_MS);
    });
  });

  describe("getRemoteDefaultBranch (#6)", () => {
    it("names the remote with credentials redacted when no default branch can be detected", async () => {
      const tokenUrl = "https://ci-bot:s3cr3t-token@github.com/test/repo.git";
      (mockGit.raw as Mock).mockImplementation(async () => ""); // no symref, no common branch

      await expect(gitService.getRemoteDefaultBranch(tokenUrl)).rejects.toThrow(
        "Unable to detect default branch for 'https://***@github.com/test/repo.git'.",
      );
      // git itself is still handed the working URL.
      expect(mockGit.raw).toHaveBeenCalledWith(["ls-remote", "--symref", tokenUrl, "HEAD"]);
    });

    it("returns the branch from ls-remote --symref HEAD", async () => {
      (mockGit.raw as Mock).mockImplementation(async (args: unknown) => {
        const a = args as string[];
        if (a[0] === "ls-remote" && a[1] === "--symref") return "ref: refs/heads/trunk\tHEAD\nabc\tHEAD\n";
        return "";
      });

      await expect(gitService.getRemoteDefaultBranch(TEST_URLS.github)).resolves.toBe("trunk");
    });

    it("falls back to the sole existing common branch when symref is unavailable", async () => {
      (mockGit.raw as Mock).mockImplementation(async (args: unknown) => {
        const a = args as string[];
        if (a[0] === "ls-remote" && a[1] === "--symref") return ""; // no symref line -> probe
        if (a[0] === "ls-remote" && a.includes("refs/heads/master")) return "sha\trefs/heads/master\n";
        return ""; // main/develop/trunk absent
      });

      await expect(gitService.getRemoteDefaultBranch(TEST_URLS.github)).resolves.toBe("master");
    });

    it("throws instead of guessing when symref is unavailable and multiple common branches exist", async () => {
      (mockGit.raw as Mock).mockImplementation(async (args: unknown) => {
        const a = args as string[];
        if (a[0] === "ls-remote" && a[1] === "--symref") return "";
        if (a[0] === "ls-remote" && (a.includes("refs/heads/main") || a.includes("refs/heads/master"))) {
          return `sha\t${a[a.length - 1]}\n`;
        }
        return "";
      });

      await expect(gitService.getRemoteDefaultBranch(TEST_URLS.github)).rejects.toThrow(
        /multiple common branches exist/,
      );
    });
  });

  describe("initialize", () => {
    it("logs the bare clone with credentials redacted while git receives the working URL", async () => {
      const tokenUrl = "https://ci-bot:s3cr3t-token@github.com/test/repo.git";
      gitService = new GitService(createMockConfig({ repoUrl: tokenUrl }), mockLogger);
      (fs.access as Mock<any>).mockRejectedValue(new Error("ENOENT"));
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      mockGit.raw
        .mockRejectedValueOnce(new Error("config not found"))
        .mockResolvedValueOnce("" as any)
        .mockResolvedValueOnce("" as any);

      await gitService.initialize();

      expect(mockGit.clone).toHaveBeenCalledWith(tokenUrl, ".bare/repo", ["--bare", "--progress"]);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Cloning from "https://***@github.com/test/repo.git" as bare repository into ".bare/repo"...',
      );
      expect(JSON.stringify((mockLogger.info as Mock).mock.calls)).not.toContain("s3cr3t-token");
    });

    it("should use existing bare repository when it exists", async () => {
      // Mock fs.access to succeed (bare repo exists)
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      // Mock fs.mkdir
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      // Mock origin check to match, config check to throw error (config doesn't exist)
      mockGit.raw
        .mockResolvedValueOnce(TEST_URLS.github as any) // First call: origin URL matches repoUrl
        .mockRejectedValueOnce(new Error("config not found")) // Second call: config check throws
        .mockResolvedValueOnce(
          createWorktreeListOutput([{ path: TEST_PATHS.worktree + "/main", branch: "main", commit: "abc123" }]) as any,
        ); // Third call: worktree list

      const git = await gitService.initialize();

      expect(fs.access).toHaveBeenCalledWith(".bare/repo/HEAD");
      expect(simpleGit).toHaveBeenCalledWith(".bare/repo", expect.objectContaining({ progress: expect.any(Function) }));
      expect(mockGit.raw).toHaveBeenCalledWith(["config", "--get-all", "remote.origin.fetch"]);
      expect(mockGit.addConfig).toHaveBeenCalledWith("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      // Fetch is always called to ensure remote refs are up-to-date
      expect(mockGit.fetch).toHaveBeenCalledWith(["--all", "--progress"]);
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
      expect(simpleGit).toHaveBeenCalledWith(expect.objectContaining({ progress: expect.any(Function) }));
      expect(mockGit.clone).toHaveBeenCalledWith(TEST_URLS.github, ".bare/repo", ["--bare", "--progress"]);
      // A fresh clone's origin is repoUrl by construction; only an existing bare repo is checked.
      expect(mockGit.raw).not.toHaveBeenCalledWith(["remote", "get-url", "origin"]);
      expect(mockGit.raw).toHaveBeenCalledWith(["config", "--get-all", "remote.origin.fetch"]);
      expect(mockGit.addConfig).toHaveBeenCalledWith("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      expect(mockGit.fetch).toHaveBeenCalledWith(["--all", "--progress"]);
    });

    it("should create main worktree if it doesn't exist", async () => {
      // Mock fs.access to succeed (bare repo exists)
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      // Mock fs.mkdir
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      // Mock origin check, config check and worktree list
      mockGit.raw
        .mockResolvedValueOnce(TEST_URLS.github as any) // First call: origin URL matches repoUrl
        .mockRejectedValueOnce(new Error("config not found")) // Second call: config check throws
        .mockResolvedValueOnce("" as any) // Third call: getWorktreesFromBare returns empty
        .mockResolvedValueOnce("" as any); // Fourth call: worktree add
      mockGit.branch.mockResolvedValueOnce({
        all: [],
        current: "main",
      } as any);

      await gitService.initialize();

      // Fetch is always called to ensure remote refs are up-to-date
      expect(mockGit.fetch).toHaveBeenCalledWith(["--all", "--progress"]);
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
      // Mock origin check, config check and worktree list
      mockGit.raw
        .mockResolvedValueOnce(TEST_URLS.github as any) // First call: origin URL matches repoUrl
        .mockRejectedValueOnce(new Error("config not found")) // Second call: config check throws
        .mockResolvedValueOnce("" as any) // Third call: getWorktreesFromBare returns empty
        .mockResolvedValueOnce("" as any); // Fourth call: worktree add
      mockGit.branch.mockResolvedValueOnce({
        all: [],
        current: "main",
      } as any);

      await relativeGitService.initialize();

      // Fetch is always called to ensure remote refs are up-to-date
      expect(mockGit.fetch).toHaveBeenCalledWith(["--all", "--progress"]);
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
        .mockResolvedValueOnce(TEST_URLS.github as any) // origin URL matches repoUrl
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
      // Mock origin check to match, config check to return existing fetch config
      mockGit.raw
        .mockResolvedValueOnce(TEST_URLS.github as any) // First call: origin URL matches repoUrl
        .mockResolvedValueOnce("+refs/heads/*:refs/remotes/origin/*") // Second call: config exists
        .mockResolvedValueOnce(
          createWorktreeListOutput([{ path: TEST_PATHS.worktree + "/main", branch: "main", commit: "abc123" }]) as any,
        ); // Third call: worktree list

      const git = await gitService.initialize();

      expect(fs.access).toHaveBeenCalledWith(".bare/repo/HEAD");
      expect(simpleGit).toHaveBeenCalledWith(".bare/repo", expect.objectContaining({ progress: expect.any(Function) }));
      expect(mockGit.raw).toHaveBeenCalledWith(["config", "--get-all", "remote.origin.fetch"]);
      expect(mockGit.addConfig).not.toHaveBeenCalled(); // Should not add config if it already exists
      // Fetch is always called to ensure remote refs are up-to-date
      expect(mockGit.fetch).toHaveBeenCalledWith(["--all", "--progress"]);
      expect(git).toBe(mockGit);
    });

    // An existing bare repo is found by path alone, and the default bareRepoDir
    // (`.bare/<repo-name>`) is the same directory for old-org/repo and
    // new-org/repo, so its origin must be the configured repoUrl before anything
    // is fetched from it.
    describe("existing bare repository origin", () => {
      const bareRepoPath = path.resolve(".bare/repo");
      const mainWorktreeList = createWorktreeListOutput([
        { path: TEST_PATHS.worktree + "/main", branch: "main", commit: "abc123" },
      ]);

      beforeEach(() => {
        (fs.access as Mock<any>).mockResolvedValue(undefined);
        (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      });

      it("rejects with both URLs and the set-url remedy when origin differs from repoUrl, before any fetch", async () => {
        gitService = new GitService(createMockConfig({ repoUrl: "https://gitlab.com/new-org/repo.git" }), mockLogger);
        mockGit.raw.mockResolvedValueOnce("https://github.com/old-org/repo.git\n" as any); // remote get-url origin

        await expect(gitService.initialize()).rejects.toMatchObject({
          constructor: ConfigError,
          code: "CONFIG_ORIGIN_MISMATCH",
          message:
            `Existing bare repository at '${bareRepoPath}' has origin 'https://github.com/old-org/repo.git', expected 'https://gitlab.com/new-org/repo.git'. ` +
            `Update the remote (git -C "${bareRepoPath}" remote set-url origin "https://gitlab.com/new-org/repo.git") or point bareRepoDir at a fresh directory.`,
        });

        expect(mockGit.raw).toHaveBeenCalledWith(["remote", "get-url", "origin"]);
        expect(mockGit.fetch).not.toHaveBeenCalled();
        expect(mockGit.clone).not.toHaveBeenCalled();
        expect(mockGit.addConfig).not.toHaveBeenCalled();
        expect(gitService.isInitialized()).toBe(false);
      });

      it("redacts credentials in both URLs of the mismatch message", async () => {
        gitService = new GitService(
          createMockConfig({ repoUrl: "https://ci-bot:new-token@github.com/new-org/repo.git" }),
          mockLogger,
        );
        mockGit.raw.mockResolvedValueOnce("https://old-bot:old-token@github.com/old-org/repo.git\n" as any);

        await expect(gitService.initialize()).rejects.toMatchObject({
          constructor: ConfigError,
          code: "CONFIG_ORIGIN_MISMATCH",
          message: expect.stringContaining(
            "has origin 'https://***@github.com/old-org/repo.git', expected 'https://***@github.com/new-org/repo.git'. " +
              `Update the remote (git -C "${bareRepoPath}" remote set-url origin "https://***@github.com/new-org/repo.git")`,
          ),
        });

        expect(mockGit.fetch).not.toHaveBeenCalled();
      });

      it.each([
        ["without the .git suffix", "https://github.com/test/repo"],
        ["with a trailing slash", "https://github.com/test/repo.git/"],
        ["with a different host case", "HTTPS://GitHub.COM/test/repo.git"],
      ])("proceeds to fetch when origin is repoUrl %s", async (_variant, originUrl) => {
        mockGit.raw
          .mockResolvedValueOnce(`${originUrl}\n` as any) // remote get-url origin
          .mockResolvedValueOnce("+refs/heads/*:refs/remotes/origin/*" as any) // fetch refspec present
          .mockResolvedValueOnce("refs/remotes/origin/main\n" as any) // symbolic-ref origin/HEAD
          .mockResolvedValueOnce(mainWorktreeList as any); // worktree list

        await expect(gitService.initialize()).resolves.toBe(mockGit);

        expect(mockGit.fetch).toHaveBeenCalledWith(["--all", "--progress"]);
        expect(mockLogger.warn).not.toHaveBeenCalled();
      });

      it("warns and proceeds when the bare repository has no readable origin", async () => {
        mockGit.raw
          .mockRejectedValueOnce(new Error("error: No such remote 'origin'")) // remote get-url origin
          .mockResolvedValueOnce("+refs/heads/*:refs/remotes/origin/*" as any) // fetch refspec present
          .mockResolvedValueOnce("refs/remotes/origin/main\n" as any) // symbolic-ref origin/HEAD
          .mockResolvedValueOnce(mainWorktreeList as any); // worktree list

        await expect(gitService.initialize()).resolves.toBe(mockGit);

        expect(mockLogger.warn).toHaveBeenCalledWith(
          `Could not read 'origin' remote URL from existing bare repository at '${bareRepoPath}'.`,
        );
        expect(mockGit.fetch).toHaveBeenCalledWith(["--all", "--progress"]);
      });
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
      expect(mockGit.fetch).toHaveBeenCalledWith(["origin", "feature-1", "--prune", "--progress"]);
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
      expect(mockGit.env).toHaveBeenCalledWith(expect.objectContaining({ GIT_LFS_SKIP_SMUDGE: "1" }));
      expect(mockGit.fetch).toHaveBeenCalledWith(["origin", "feature-2", "--prune", "--progress"]);
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
  });

  describe("pushBranch", () => {
    it("sets the new branch upstream to the same branch on origin", async () => {
      await gitService.pushBranch("feat/new");

      expect(mockGit.push).toHaveBeenCalledWith(["origin", "feat/new:feat/new", "-u"]);
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
        "origin/main 2024-01-15T10:30:00-05:00",
        "origin/feature-1 2024-01-10T14:20:00-05:00",
        "origin/feature-2 2023-12-25T08:15:00-05:00",
      ].join("\n");

      mockGit.raw.mockResolvedValueOnce(mockOutput as any);

      const branches = await gitService.getRemoteBranchesWithActivity();

      expect(mockGit.raw).toHaveBeenCalledWith([
        "for-each-ref",
        "--format=%(refname:short)%00%(committerdate:iso8601)",
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
        "origin/main 2024-01-15T10:30:00-05:00",
        "invalid-line",
        "origin/feature-1 invalid-date",
        "origin/feature-2 2024-01-10T14:20:00-05:00",
      ].join("\n");

      mockGit.raw.mockResolvedValueOnce(mockOutput as any);

      const branches = await gitService.getRemoteBranchesWithActivity();

      expect(branches).toHaveLength(2);
      expect(branches[0].branch).toBe("main");
      expect(branches[1].branch).toBe("feature-2");
    });

    it("should filter out origin/HEAD", async () => {
      const mockOutput = [
        "origin/main 2024-01-15T10:30:00-05:00",
        "origin/HEAD 2024-01-15T10:30:00-05:00",
        "origin/feature-1 2024-01-14T09:15:00-05:00",
      ].join("\n");

      mockGit.raw.mockResolvedValueOnce(mockOutput as any);

      const branches = await gitService.getRemoteBranchesWithActivity();

      expect(branches).toHaveLength(2);
      expect(branches[0].branch).toBe("main");
      expect(branches[1].branch).toBe("feature-1");
      expect(branches.some((b) => b.branch === "HEAD")).toBe(false);
    });

    it("keeps branches whose names contain '|' (legal refname character) (#review)", async () => {
      const mockOutput = ["origin/feature|wip 2024-01-15T10:30:00-05:00", "origin/main 2024-01-10T14:20:00-05:00"].join(
        "\n",
      );

      mockGit.raw.mockResolvedValueOnce(mockOutput as any);

      const branches = await gitService.getRemoteBranchesWithActivity();

      expect(branches).toHaveLength(2);
      expect(branches[0].branch).toBe("feature|wip");
      expect(branches[0].lastActivity).toEqual(new Date("2024-01-15T10:30:00-05:00"));
    });

    it("keeps a remote branch literally named 'origin' (#review)", async () => {
      const mockOutput = ["origin/origin 2024-01-15T10:30:00-05:00"].join("\n");

      mockGit.raw.mockResolvedValueOnce(mockOutput as any);

      const branches = await gitService.getRemoteBranchesWithActivity();

      expect(branches).toHaveLength(1);
      expect(branches[0].branch).toBe("origin");
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
        .mockResolvedValueOnce(undefined) // Second check in fallback - directory exists
        .mockResolvedValueOnce(undefined) // still there when clearing
        .mockRejectedValueOnce(Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" })); // no .git inside

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

      await expect(gitService.addWorktree("feature-1", worktreePath)).resolves.toBeUndefined();

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

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "list", "--porcelain"]);
      expect(mockGit.raw).not.toHaveBeenCalledWith(["worktree", "prune"]);
      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "remove", "--force", worktreePath]);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("registration locked"));
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

      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "list", "--porcelain"]);
      expect(mockGit.raw).not.toHaveBeenCalledWith(["worktree", "prune"]);
      expect(fs.rm).not.toHaveBeenCalled();
    });

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

      await gitService.addWorktree("feature-1", worktreePath);

      expect(fs.rm).not.toHaveBeenCalledWith(worktreePath, { recursive: true, force: true });
      expect(fs.rename).not.toHaveBeenCalled();
      expect(mockGit.raw).not.toHaveBeenCalledWith(expect.arrayContaining(["worktree", "add"]));
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
              const ref = args[args.length - 1];
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

    it("samples distinct LFS files when at least five are available", async () => {
      mockShowRef({ local: false, remote: true });

      const worktreeGitMock = {
        raw: vi.fn<any>().mockResolvedValue("file1.png\nfile2.png\nfile3.png\nfile4.png\nfile5.png\nfile6.png\n"),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
      };

      (simpleGit as unknown as Mock).mockImplementation((gitPath?: any) => {
        if (gitPath && gitPath.includes("feature-1")) {
          return worktreeGitMock;
        }
        return mockGit;
      });

      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      const mockFileHandle = {
        read: vi.fn<any>().mockResolvedValue({ bytesRead: 18 }),
        close: vi.fn<any>().mockResolvedValue(undefined),
      };
      (fs.open as Mock<any>).mockResolvedValue(mockFileHandle);

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      const openedFiles = (fs.open as Mock<any>).mock.calls.map(([filePath]) => path.basename(String(filePath)));
      expect(openedFiles).toHaveLength(5);
      expect(new Set(openedFiles).size).toBe(5);

      randomSpy.mockRestore();
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

      expect(mockGit.env).toHaveBeenCalledWith(expect.objectContaining({ GIT_LFS_SKIP_SMUDGE: "1" }));
    });

    it("should not affect git operations when disabled", async () => {
      gitService.setLfsSkipEnabled(false);

      await gitService.fetchAll();

      expect(mockGit.env).not.toHaveBeenCalled();
    });

    it("should be togglable at runtime", async () => {
      gitService.setLfsSkipEnabled(true);
      await gitService.fetchAll();
      expect(mockGit.env).toHaveBeenCalledWith(expect.objectContaining({ GIT_LFS_SKIP_SMUDGE: "1" }));

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
  });

  describe("addWorktree stale directory safety", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("quarantines an existing non-worktree directory containing a .git instead of deleting it", async () => {
      const target = "/test/worktrees/feature-1";
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (Array.isArray(args) && args[0] === "worktree" && args[1] === "list") {
          return Promise.resolve(createWorktreeListOutput([{ path: "/test/repo", branch: "main", commit: "abc123" }]));
        }
        return Promise.resolve("");
      });
      (fs.rename as Mock<any>).mockResolvedValue(undefined);

      await gitService.addWorktree("feature-1", target);

      expect(fs.rm).not.toHaveBeenCalledWith(target, { recursive: true, force: true });
      expect(fs.rename).toHaveBeenCalledWith(target, expect.stringContaining(".removed"));
    });

    it("still deletes a stale directory that does not contain a .git", async () => {
      const target = "/test/worktrees/feature-1";
      (fs.access as Mock<any>).mockImplementation(async (p: unknown) => {
        if (p === path.join(target, ".git")) {
          throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
        }
        return undefined;
      });
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (Array.isArray(args) && args[0] === "worktree" && args[1] === "list") {
          return Promise.resolve(createWorktreeListOutput([{ path: "/test/repo", branch: "main", commit: "abc123" }]));
        }
        return Promise.resolve("");
      });

      await gitService.addWorktree("feature-1", target);

      expect(fs.rm).toHaveBeenCalledWith(target, { recursive: true, force: true });
      expect(fs.rename).not.toHaveBeenCalled();
    });

    it("refuses to clear the stale directory when the .git probe fails for unknown reasons", async () => {
      const target = "/test/worktrees/feature-1";
      (fs.access as Mock<any>).mockImplementation(async (p: unknown) => {
        if (p === path.join(target, ".git")) {
          throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
        }
        return undefined;
      });
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (Array.isArray(args) && args[0] === "worktree" && args[1] === "list") {
          return Promise.resolve(createWorktreeListOutput([{ path: "/test/repo", branch: "main", commit: "abc123" }]));
        }
        return Promise.resolve("");
      });

      await expect(gitService.addWorktree("feature-1", target)).rejects.toThrow();

      expect(fs.rm).not.toHaveBeenCalledWith(target, { recursive: true, force: true });
      expect(fs.rename).not.toHaveBeenCalled();
    });

    it("routes stale-directory cleanup through the injected trasher instead of deleting", async () => {
      const target = "/test/worktrees/feature-1";
      const trasher = vi.fn<any>().mockResolvedValue("/test/worktrees/.trash/id/payload");
      gitService.setStaleDirectoryTrasher(trasher as unknown as (dirPath: string) => Promise<string>);
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (Array.isArray(args) && args[0] === "worktree" && args[1] === "list") {
          return Promise.resolve(createWorktreeListOutput([{ path: "/test/repo", branch: "main", commit: "abc123" }]));
        }
        return Promise.resolve("");
      });

      await gitService.addWorktree("feature-1", target);

      expect(trasher).toHaveBeenCalledWith(target);
      expect(fs.rm).not.toHaveBeenCalledWith(target, { recursive: true, force: true });
      expect(fs.rename).not.toHaveBeenCalled();
    });

    it("fails the worktree creation when the trasher cannot preserve the stale directory", async () => {
      const target = "/test/worktrees/feature-1";
      gitService.setStaleDirectoryTrasher(
        vi.fn<any>().mockRejectedValue(new Error("EXDEV")) as unknown as (dirPath: string) => Promise<string>,
      );
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (Array.isArray(args) && args[0] === "worktree" && args[1] === "list") {
          return Promise.resolve(createWorktreeListOutput([{ path: "/test/repo", branch: "main", commit: "abc123" }]));
        }
        return Promise.resolve("");
      });

      await expect(gitService.addWorktree("feature-1", target)).rejects.toThrow(/trash/);

      expect(fs.rm).not.toHaveBeenCalledWith(target, { recursive: true, force: true });
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
          .mockResolvedValueOnce("2\n") // 2 commits not on any remote
          .mockResolvedValueOnce("5\n"), // commits since last sync (short-circuited, should not be called)
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const hasUnpushed = await gitService.hasUnpushedCommits("/test/worktrees/feature-deleted");

      expect(hasUnpushed).toBe(true);
      expect(mockMetadataService.loadMetadataFromPath).toHaveBeenCalledWith(
        ".bare/repo",
        "/test/worktrees/feature-deleted",
      );
      // The any-remote check runs first and is sufficient to block on its own
      expect(mockWorktreeGit.raw).toHaveBeenCalledWith([
        "rev-list",
        "--count",
        "feature-deleted",
        "--not",
        "--remotes",
      ]);
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

  describe("classifyRemoteRelationship", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    function buildClient(opts: { headSha: string; remoteSha: string; mergeBase?: string | Error; isShallow?: string }) {
      const revparse = vi
        .fn<any>()
        .mockResolvedValueOnce(`${opts.headSha}\n`)
        .mockResolvedValueOnce(`${opts.remoteSha}\n`);

      const raw = vi.fn<any>().mockImplementation(async (...rawArgs: unknown[]) => {
        const args = rawArgs[0] as string[];
        if (args[0] === "merge-base") {
          if (opts.mergeBase instanceof Error) throw opts.mergeBase;
          return `${opts.mergeBase ?? ""}\n`;
        }
        if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") {
          return `${opts.isShallow ?? "false"}\n`;
        }
        return "";
      });

      return { revparse, raw };
    }

    it("returns up_to_date when HEAD equals origin tip", async () => {
      const client = buildClient({ headSha: "aaa", remoteSha: "aaa" });
      (simpleGit as unknown as Mock).mockReturnValue(client);

      const result = await gitService.classifyRemoteRelationship("/test/worktrees/feature-1", "feature-1");

      expect(result).toBe("up_to_date");
      expect(client.raw).not.toHaveBeenCalledWith(expect.arrayContaining(["merge-base"]));
    });

    it("returns fast_forward when merge-base equals HEAD", async () => {
      const client = buildClient({
        headSha: "head",
        remoteSha: "tip",
        mergeBase: "head",
      });
      (simpleGit as unknown as Mock).mockReturnValue(client);

      const result = await gitService.classifyRemoteRelationship("/test/worktrees/feature-1", "feature-1");

      expect(result).toBe("fast_forward");
    });

    it("returns local_ahead when merge-base equals remote tip", async () => {
      const client = buildClient({
        headSha: "head",
        remoteSha: "tip",
        mergeBase: "tip",
      });
      (simpleGit as unknown as Mock).mockReturnValue(client);

      const result = await gitService.classifyRemoteRelationship("/test/worktrees/feature-1", "feature-1");

      expect(result).toBe("local_ahead");
    });

    it("returns diverged when merge-base is neither HEAD nor remote", async () => {
      const client = buildClient({
        headSha: "head",
        remoteSha: "tip",
        mergeBase: "ancestor",
      });
      (simpleGit as unknown as Mock).mockReturnValue(client);

      const result = await gitService.classifyRemoteRelationship("/test/worktrees/feature-1", "feature-1");

      expect(result).toBe("diverged");
    });

    it("returns indeterminate_shallow when merge-base throws on a shallow repo", async () => {
      const client = buildClient({
        headSha: "head",
        remoteSha: "tip",
        mergeBase: new Error("fatal: not a tree object"),
        isShallow: "true",
      });
      (simpleGit as unknown as Mock).mockReturnValue(client);

      const result = await gitService.classifyRemoteRelationship("/test/worktrees/feature-1", "feature-1");

      expect(result).toBe("indeterminate_shallow");
    });

    it("returns indeterminate_shallow when merge-base returns empty (simple-git swallowed exit 1) on a shallow repo", async () => {
      const client = buildClient({
        headSha: "head",
        remoteSha: "tip",
        mergeBase: "",
        isShallow: "true",
      });
      (simpleGit as unknown as Mock).mockReturnValue(client);

      const result = await gitService.classifyRemoteRelationship("/test/worktrees/feature-1", "feature-1");

      expect(result).toBe("indeterminate_shallow");
    });

    it("returns diverged when merge-base throws on a non-shallow repo", async () => {
      const client = buildClient({
        headSha: "head",
        remoteSha: "tip",
        mergeBase: new Error("fatal: not a tree object"),
        isShallow: "false",
      });
      (simpleGit as unknown as Mock).mockReturnValue(client);

      const result = await gitService.classifyRemoteRelationship("/test/worktrees/feature-1", "feature-1");

      expect(result).toBe("diverged");
    });

    it("returns diverged when revparse of HEAD or remote fails", async () => {
      const client = {
        revparse: vi.fn<any>().mockRejectedValue(new Error("bad ref")),
        raw: vi.fn<any>(),
      };
      (simpleGit as unknown as Mock).mockReturnValue(client);

      const result = await gitService.classifyRemoteRelationship("/test/worktrees/feature-1", "feature-1");

      expect(result).toBe("diverged");
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
    it("detects default branches whose names contain slashes", async () => {
      mockGit.raw.mockResolvedValueOnce("refs/remotes/origin/release/2024\n" as any);

      await expect((gitService as any).detectDefaultBranch(mockGit)).resolves.toBe("release/2024");
    });

    it("should throw when fetch fails during initialization", async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      mockGit.raw
        .mockResolvedValueOnce(TEST_URLS.github as any) // origin URL matches repoUrl
        .mockRejectedValueOnce(new Error("config not found"));
      mockGit.fetch.mockRejectedValueOnce(new Error("Network unreachable"));

      await expect(gitService.initialize()).rejects.toThrow("Network unreachable");
    });

    it("should fallback to 'main' when all default branch detection methods fail", async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);

      // Sequence all raw calls in order of execution:
      // 1. remote get-url origin → matches repoUrl
      // 2. config check → reject (triggers addConfig)
      // 3. symbolic-ref → reject (first detection attempt fails)
      // 4. set-head → reject (skips second symbolic-ref, falls to branch -r)
      // 5. worktree list → returns main worktree so no creation needed
      mockGit.raw.mockReset();
      mockGit.raw
        .mockResolvedValueOnce(TEST_URLS.github as any)
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

    // The GIT_ATTR_SOURCE=HEAD client used for `lfs ls-files` passes an explicit
    // env, and simple-git validates explicit envs (GIT_ASKPASS, GIT_CONFIG_COUNT)
    // that a default client inherits freely. Without the same allowances as
    // getCachedGit's clients, a VS Code askpass bridge or CI config-count in the
    // forwarded environment throws before `lfs ls-files` runs, and the LFS
    // verification is silently skipped.
    it("creates the LFS-verification client with the unsafe-env allowances", async () => {
      const sparseConfig: Config = {
        ...createMockConfig(),
        sparseCheckout: { include: ["apps"] },
      };

      // applySparseAndCheckout also creates a worktree client — through
      // getCachedGit, which already carries the allowances — so hand out a
      // fresh client per simpleGit() call and pair each .env() with the
      // options its own client was constructed with.
      const envClients: Array<{ options: unknown; env: NodeJS.ProcessEnv }> = [];
      (simpleGit as unknown as Mock).mockImplementation((p?: any, options?: unknown) => {
        if (!(p && p.includes("feature-1"))) return mockGit;
        const client: any = {
          branch: vi.fn<any>().mockResolvedValue(undefined),
          raw: vi.fn<any>().mockResolvedValue(""),
          revparse: vi.fn<any>().mockResolvedValue("abc123"),
        };
        client.env = vi.fn((env: NodeJS.ProcessEnv) => {
          envClients.push({ options, env });
          return client;
        });
        return client;
      });

      mockShowRef({ local: false, remote: true });

      const sparseGitService = new GitService(sparseConfig, mockLogger);

      await sparseGitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      const lfsClient = envClients.find(({ env }) => env[ENV_CONSTANTS.GIT_ATTR_SOURCE] === "HEAD");
      expect(lfsClient).toBeDefined();
      expect(lfsClient!.env).toMatchObject({ PATH: process.env.PATH });
      expect(lfsClient!.options).toEqual(
        expect.objectContaining({ unsafe: { allowUnsafeAskPass: true, allowUnsafeConfigEnvCount: true } }),
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

  describe("resetToUpstream", () => {
    it("refuses reset when HEAD moved after the caller's divergence check", async () => {
      mockGit.revparse.mockResolvedValue("new-local-commit");

      await expect(
        (gitService.resetToUpstream as (...args: string[]) => Promise<boolean>)(
          "/test/worktrees/feature-1",
          "feature-1",
          "previously-observed-commit",
        ),
      ).resolves.toBe(false);

      expect(mockGit.raw).not.toHaveBeenCalledWith(expect.arrayContaining(["checkout", "-B"]));
    });

    it("refuses reset when an ignored path would be replaced by an upstream tracked file", async () => {
      (mockGit.raw as Mock).mockImplementation(async (args: unknown) => {
        const command = args as string[];
        if (command[0] === "ls-files") return "generated/config.json\0";
        if (command[0] === "ls-tree") return "generated/config.json\0src/index.ts\0";
        return "";
      });

      await expect(gitService.resetToUpstream("/test/worktrees/feature-1", "feature-1")).resolves.toBe(false);

      expect(mockGit.reset).not.toHaveBeenCalled();
    });

    it("refuses reset when an upstream file sits inside a wholly-ignored directory", async () => {
      (mockGit.raw as Mock).mockImplementation(async (args: unknown) => {
        const command = args as string[];
        // `--directory` collapses the ignored tree to a single entry.
        if (command[0] === "ls-files") return "node_modules/\0";
        if (command[0] === "ls-tree") return "node_modules/vendored/index.js\0src/index.ts\0";
        return "";
      });

      await expect(gitService.resetToUpstream("/test/worktrees/feature-1", "feature-1")).resolves.toBe(false);
    });

    it("collapses ignored directories instead of enumerating every ignored file", async () => {
      const lsFilesCalls: string[][] = [];
      (mockGit.raw as Mock).mockImplementation(async (args: unknown) => {
        const command = args as string[];
        if (command[0] === "ls-files") {
          lsFilesCalls.push(command);
          return "node_modules/\0dist/\0";
        }
        if (command[0] === "ls-tree") return "src/index.ts\0";
        return "";
      });

      await expect(gitService.resetToUpstream("/test/worktrees/feature-1", "feature-1")).resolves.toBe(true);
      expect(lsFilesCalls[0]).toContain("--directory");
      expect(lsFilesCalls[0]).toContain("--no-empty-directory");
    });

    // The check used to compare every ignored path against every upstream path.
    // At monorepo scale that blocks the event loop for minutes while the repo
    // lock is held, so the shape of the algorithm is worth pinning.
    it("answers the ignored-path check in linear time on a monorepo-sized tree", async () => {
      const ignored = Array.from({ length: 60_000 }, (_, i) => `node_modules/pkg${i}/index.js`).join("\0");
      const upstream = Array.from({ length: 20_000 }, (_, i) => `src/module${i}/index.ts`).join("\0");
      (mockGit.raw as Mock).mockImplementation(async (args: unknown) => {
        const command = args as string[];
        if (command[0] === "ls-files") return ignored;
        if (command[0] === "ls-tree") return upstream;
        return "";
      });

      const startedAt = Date.now();
      await expect(gitService.resetToUpstream("/test/worktrees/feature-1", "feature-1")).resolves.toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(5000);
    });

    it("rechecks cleanliness immediately before a destructive reset", async () => {
      mockGit.status.mockResolvedValue(buildGitStatusResponse({ isClean: false }) as any);

      await expect(gitService.resetToUpstream("/test/worktrees/feature-1", "feature-1")).resolves.toBe(false);

      expect(mockGit.status).toHaveBeenCalledWith(["--ignore-submodules=none"]);
      expect(mockGit.reset).not.toHaveBeenCalled();
    });

    it("uses Git's native no-overwrite-ignore guard for the final checkout", async () => {
      await expect(gitService.resetToUpstream("/test/worktrees/feature-1", "feature-1")).resolves.toBe(true);

      expect(mockGit.raw).toHaveBeenCalledWith([
        "checkout",
        "-B",
        "feature-1",
        "origin/feature-1",
        "--no-overwrite-ignore",
      ]);
    });

    it("returns to preservation when Git catches a collision created after the preflight", async () => {
      (mockGit.raw as Mock).mockImplementation(async (args: unknown) => {
        if ((args as string[])[0] === "checkout") {
          throw new Error("untracked working tree files would be overwritten by checkout");
        }
        return "";
      });

      await expect(gitService.resetToUpstream("/test/worktrees/feature-1", "feature-1")).resolves.toBe(false);
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
      expect(mockGit.raw).toHaveBeenCalledWith([
        "rev-list",
        "--count",
        "refs/sync-worktrees/trash/id",
        "--not",
        "--remotes",
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
        "--remotes",
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

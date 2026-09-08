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
import { DEFAULT_CONFIG, ENV_CONSTANTS, PATH_CONSTANTS } from "../../constants";
import { ConfigError, WorktreeNotCleanError } from "../../errors";
import { GIT_UNSAFE_ALLOWANCES } from "../../utils/git-env";
import { GIT_LFS_MISSING_WARNING, resetGitLfsProbeForTests } from "../../utils/git-lfs-probe";
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

  const MAIN_WORKTREE_PATH = path.join(TEST_PATHS.worktree, "main");

  // Args-keyed stand-in for the bare repository during initialize(). The
  // worktree list reports the default-branch worktree from the start when
  // `mainRegistered`, otherwise only once `worktree add` has run (unless
  // `registersOnAdd` is false), so reuse, creation and a creation that never
  // registered can be told apart. Returns the `worktree add` invocations.
  const mockInitializeGit = (
    opts: {
      mainPath?: string;
      mainRegistered?: boolean;
      registersOnAdd?: boolean;
      addError?: Error;
      registersOnAddError?: boolean;
      local?: boolean;
      remote?: boolean;
    } = {},
  ): { addCalls: string[][] } => {
    const mainPath = opts.mainPath ?? MAIN_WORKTREE_PATH;
    let registered = opts.mainRegistered ?? false;
    const addCalls: string[][] = [];
    (mockGit.raw as Mock).mockImplementation((args: unknown) => {
      if (!Array.isArray(args)) return Promise.resolve("");
      const [command, subcommand] = args as string[];
      if (command === "remote" && subcommand === "get-url") return Promise.resolve(TEST_URLS.github);
      if (command === "symbolic-ref") return Promise.resolve("refs/remotes/origin/main");
      if (command === "worktree" && subcommand === "list") {
        return Promise.resolve(
          registered ? createWorktreeListOutput([{ path: mainPath, branch: "main", commit: "abc123" }]) : "",
        );
      }
      if (command === "worktree" && subcommand === "add") {
        addCalls.push(args as string[]);
        if (opts.addError) {
          registered = opts.registersOnAddError ?? false;
          return Promise.reject(opts.addError);
        }
        registered = opts.registersOnAdd ?? true;
        return Promise.resolve("");
      }
      if (command === "show-ref") {
        const ref = args[args.length - 1] as string;
        const exists = ref.startsWith("refs/heads/") ? (opts.local ?? false) : (opts.remote ?? true);
        return exists ? Promise.resolve("") : Promise.reject(new Error("show-ref: not found"));
      }
      return Promise.resolve("");
    });
    return { addCalls };
  };

  // Everything exists except the default-branch worktree directory.
  const mockMainWorktreeMissing = (mainPath: string = MAIN_WORKTREE_PATH): void => {
    (fs.access as Mock<any>).mockImplementation(async (p: unknown) => {
      if (typeof p === "string" && (p === mainPath || p.startsWith(mainPath + path.sep))) {
        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      }
    });
  };

  // `localOnlyCommits` answers the `rev-list --count origin/<b>..<b>` probe of
  // the local+remote path: 0 (the default) means the local ref is only behind
  // the remote, "unknown" makes the probe fail.
  const mockShowRef = (opts: { local: boolean; remote: boolean; localOnlyCommits?: number | "unknown" }): void => {
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
      if (Array.isArray(args) && args[0] === "rev-list" && args[1] === "--count") {
        const count = opts.localOnlyCommits ?? 0;
        return count === "unknown"
          ? Promise.reject(new Error("rev-list: bad revision"))
          : Promise.resolve(`${count}\n`);
      }
      return Promise.resolve("");
    });
  };

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // The git-lfs probe and its "not installed" warning are latched per process;
    // clearing them keeps every test's LFS expectations independent of order.
    resetGitLfsProbeForTests();

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
      // The default-branch worktree is registered by default, so initialize()
      // reuses it. Tests that exercise its creation install their own stand-in
      // with mockInitializeGit.
      raw: vi
        .fn<any>()
        .mockImplementation((args: unknown) =>
          Promise.resolve(
            Array.isArray(args) && args[0] === "worktree" && args[1] === "list"
              ? createWorktreeListOutput([{ path: MAIN_WORKTREE_PATH, branch: "main", commit: "abc123" }])
              : "",
          ),
        ) as any,
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
        .mockResolvedValueOnce("refs/heads/main\n" as any) // symbolic-ref HEAD of the fresh clone
        .mockResolvedValueOnce("refs/heads/main\n" as any) // for-each-ref refs/heads: only the default branch
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

    // Every client built through getCachedGit runs git non-interactively: the
    // env carries GIT_TERMINAL_PROMPT=0 (a credential prompt fails at once
    // instead of blocking the TUI until the inactivity timeout) and the
    // options carry the centralized unsafe-env allowances a forwarded shell
    // environment needs. GIT_TERMINAL_PROMPT is removed from process.env first
    // so only the sanitizer can be the source of the value.
    it("builds the default (non-LFS) client with the non-interactive env and the unsafe-env allowances", async () => {
      const previousPrompt = process.env.GIT_TERMINAL_PROMPT;
      setEnvVar("GIT_TERMINAL_PROMPT", undefined);
      try {
        (fs.access as Mock<any>).mockResolvedValue(undefined);
        (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
        mockGit.raw
          .mockResolvedValueOnce(TEST_URLS.github as any)
          .mockRejectedValueOnce(new Error("config not found"))
          .mockResolvedValueOnce(
            createWorktreeListOutput([
              { path: TEST_PATHS.worktree + "/main", branch: "main", commit: "abc123" },
            ]) as any,
          );

        await gitService.initialize();

        expect(simpleGit).toHaveBeenCalledWith(
          ".bare/repo",
          expect.objectContaining({ unsafe: GIT_UNSAFE_ALLOWANCES }),
        );
        const envs = (mockGit.env as Mock).mock.calls.map((call) => call[0] as NodeJS.ProcessEnv);
        expect(envs.length).toBeGreaterThan(0);
        for (const env of envs) {
          expect(env).toMatchObject({ PATH: process.env.PATH, GIT_TERMINAL_PROMPT: "0" });
          expect(env).not.toHaveProperty(ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE);
        }
      } finally {
        setEnvVar("GIT_TERMINAL_PROMPT", previousPrompt);
      }
    });

    it("should clone as bare repository when it doesn't exist", async () => {
      // Mock fs.access to fail (bare repo doesn't exist)
      (fs.access as Mock<any>).mockRejectedValue(new Error("ENOENT"));
      // Mock fs.mkdir
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      // Mock the clone-copy cleanup, config check and worktree list
      mockGit.raw
        .mockResolvedValueOnce("refs/heads/main\n" as any) // symbolic-ref HEAD of the fresh clone
        .mockResolvedValueOnce("refs/heads/main\n" as any) // for-each-ref refs/heads: only the default branch
        .mockRejectedValueOnce(new Error("config not found")) // config check throws
        .mockResolvedValueOnce("" as any) // getWorktreesFromBare returns empty
        .mockResolvedValueOnce("" as any); // worktree add

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
      // Only the default branch's copy was under refs/heads, so nothing to delete.
      expect(mockGit.raw).not.toHaveBeenCalledWith(expect.arrayContaining(["branch", "-D"]));
    });

    // `git clone --bare` copies every remote branch into refs/heads/*, and the
    // fetch refspec only updates refs/remotes/origin/*, so those copies stay
    // frozen at clone time and a worktree added later would check out the
    // frozen tip. They are dropped right after the clone — all but the branch
    // HEAD points at, which the default-branch worktree is created from — in
    // batches, since each `branch -D` call rewrites packed-refs once.
    describe("clone-time refs/heads copies", () => {
      // Args-keyed stand-in for a fresh clone whose refs/heads hold `branches`.
      const mockFreshClone = (branches: string[], opts: { headRefError?: Error } = {}): void => {
        (fs.access as Mock<any>).mockRejectedValue(new Error("ENOENT"));
        (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
        (mockGit.raw as Mock).mockImplementation((args: unknown) => {
          if (!Array.isArray(args)) return Promise.resolve("");
          const [command, subcommand] = args as string[];
          if (command === "symbolic-ref" && subcommand === "-q") {
            return opts.headRefError ? Promise.reject(opts.headRefError) : Promise.resolve("refs/heads/main\n");
          }
          if (command === "symbolic-ref") return Promise.resolve("refs/remotes/origin/main");
          if (command === "for-each-ref" && args[2] === "refs/heads/") {
            return Promise.resolve(branches.map((b) => `refs/heads/${b}\n`).join(""));
          }
          if (command === "worktree" && subcommand === "list") {
            return Promise.resolve(
              createWorktreeListOutput([{ path: MAIN_WORKTREE_PATH, branch: "main", commit: "abc123" }]),
            );
          }
          return Promise.resolve("");
        });
      };

      const branchDeleteCalls = (): string[][] =>
        mockGit.raw.mock.calls
          .map((call) => call[0] as unknown as string[])
          .filter((args) => Array.isArray(args) && args[0] === "branch" && args[1] === "-D");

      it("deletes every non-default refs/heads copy right after a fresh clone", async () => {
        mockFreshClone(["feature-1", "main", "release/2.0"]);

        await gitService.initialize();

        expect(mockGit.raw).toHaveBeenCalledWith(["for-each-ref", "--format=%(refname)", "refs/heads/"]);
        expect(branchDeleteCalls()).toEqual([["branch", "-D", "feature-1", "release/2.0"]]);
        expect(mockLogger.info).toHaveBeenCalledWith(
          "Removed 2 clone-time local branch copies; worktrees are created from origin/* instead.",
        );
        // The cleanup runs before the fetch refspec is configured and the remote refs fetched.
        const deleteOrder =
          mockGit.raw.mock.invocationCallOrder[
            mockGit.raw.mock.calls.findIndex((call) => (call[0] as unknown as string[])[0] === "branch")
          ];
        expect(deleteOrder).toBeLessThan(mockGit.fetch.mock.invocationCallOrder[0]);
      });

      it("deletes the copies in batches", async () => {
        const branches = Array.from({ length: 450 }, (_, i) => `b/${i}`);
        mockFreshClone(["main", ...branches]);

        await gitService.initialize();

        const calls = branchDeleteCalls();
        expect(calls.map((args) => args.length - 2)).toEqual([200, 200, 50]);
        expect(calls.flatMap((args) => args.slice(2))).toEqual(branches);
      });

      it("leaves the copies alone and continues when HEAD cannot be read", async () => {
        mockFreshClone(["feature-1", "main"], { headRefError: new Error("fatal: ref HEAD is not a symbolic ref") });

        await expect(gitService.initialize()).resolves.toBe(mockGit);

        expect(branchDeleteCalls()).toEqual([]);
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining("Could not remove clone-time local branch copies"),
        );
      });

      it("never deletes refs/heads of an existing bare repository", async () => {
        // Everything in the default fixture exists; the raw stand-in answers an
        // existing repository's origin check and lists a full refs/heads.
        (fs.access as Mock<any>).mockResolvedValue(undefined);
        (mockGit.raw as Mock).mockImplementation((args: unknown) => {
          if (!Array.isArray(args)) return Promise.resolve("");
          const [command, subcommand] = args as string[];
          if (command === "remote" && subcommand === "get-url") return Promise.resolve(TEST_URLS.github);
          if (command === "for-each-ref") return Promise.resolve("refs/heads/main\nrefs/heads/feature-1\n");
          if (command === "worktree" && subcommand === "list") {
            return Promise.resolve(
              createWorktreeListOutput([{ path: MAIN_WORKTREE_PATH, branch: "main", commit: "abc123" }]),
            );
          }
          return Promise.resolve("");
        });

        await gitService.initialize();

        expect(mockGit.clone).not.toHaveBeenCalled();
        expect(mockGit.raw).not.toHaveBeenCalledWith(["for-each-ref", "--format=%(refname)", "refs/heads/"]);
        expect(branchDeleteCalls()).toEqual([]);
      });
    });

    it("should create main worktree if it doesn't exist", async () => {
      const { addCalls } = mockInitializeGit({ local: false, remote: true });
      mockMainWorktreeMissing();

      await gitService.initialize();

      // Fetch is always called to ensure remote refs are up-to-date
      expect(mockGit.fetch).toHaveBeenCalledWith(["--all", "--progress"]);
      expect(fs.mkdir).toHaveBeenCalledWith(TEST_PATHS.worktree, { recursive: true });
      expect(addCalls).toEqual([["worktree", "add", "--track", "-b", "main", MAIN_WORKTREE_PATH, "origin/main"]]);
      expect(gitService.isInitialized()).toBe(true);
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
      const expectedAbsolutePath = path.resolve("./test/worktrees/main");
      const { addCalls } = mockInitializeGit({ mainPath: expectedAbsolutePath, local: false, remote: true });
      mockMainWorktreeMissing(expectedAbsolutePath);

      await relativeGitService.initialize();

      // Fetch is always called to ensure remote refs are up-to-date
      expect(mockGit.fetch).toHaveBeenCalledWith(["--all", "--progress"]);
      // Verify that the worktree add command received an absolute path
      expect(addCalls).toEqual([["worktree", "add", "--track", "-b", "main", expectedAbsolutePath, "origin/main"]]);
    });

    // A directory already sitting at the default-branch worktree path is
    // either the registered worktree (reuse it) or stale (the checkout left
    // behind after `.bare/` was deleted, an unrelated directory of the same
    // name). A stale one must go through the same trash/quarantine handling as
    // every other branch's stale directory and never be adopted: this.git
    // would point at a non-repository and every later fetch would fail.
    describe("existing directory at the default-branch worktree path", () => {
      const worktreeAddCallOrder = (): number => {
        const raw = mockGit.raw as Mock;
        const index = raw.mock.calls.findIndex(
          ([args]) => Array.isArray(args) && args[0] === "worktree" && args[1] === "add",
        );
        return raw.mock.invocationCallOrder[index];
      };

      it("reuses a registered default-branch worktree without touching it", async () => {
        const { addCalls } = mockInitializeGit({ mainRegistered: true });
        const trasher = vi.fn<any>().mockResolvedValue("/test/worktrees/.trash/id/payload");
        gitService.setStaleDirectoryTrasher(trasher as unknown as (dirPath: string) => Promise<string>);

        await gitService.initialize();

        expect(addCalls).toEqual([]);
        expect(trasher).not.toHaveBeenCalled();
        expect(fs.rename).not.toHaveBeenCalled();
        expect(fs.rm).not.toHaveBeenCalled();
        expect(gitService.isInitialized()).toBe(true);
      });

      it("moves an unregistered directory to trash before creating the worktree", async () => {
        const { addCalls } = mockInitializeGit({ local: false, remote: true });
        const trasher = vi.fn<any>().mockResolvedValue("/test/worktrees/.trash/id/payload");
        gitService.setStaleDirectoryTrasher(trasher as unknown as (dirPath: string) => Promise<string>);

        await gitService.initialize();

        expect(trasher).toHaveBeenCalledWith(MAIN_WORKTREE_PATH);
        expect(addCalls).toEqual([["worktree", "add", "--track", "-b", "main", MAIN_WORKTREE_PATH, "origin/main"]]);
        expect(trasher.mock.invocationCallOrder[0]).toBeLessThan(worktreeAddCallOrder());
        expect(fs.rm).not.toHaveBeenCalled();
        expect(fs.rename).not.toHaveBeenCalled();
        expect(gitService.isInitialized()).toBe(true);
      });

      it("quarantines an unregistered directory containing a .git instead of deleting it", async () => {
        const { addCalls } = mockInitializeGit({ local: false, remote: true });

        await gitService.initialize();

        expect(fs.rename).toHaveBeenCalledWith(MAIN_WORKTREE_PATH, expect.stringContaining(".removed"));
        expect(fs.rm).not.toHaveBeenCalled();
        expect(addCalls).toHaveLength(1);
        expect(gitService.isInitialized()).toBe(true);
      });

      it("deletes an unregistered directory without a .git before creating the worktree", async () => {
        const { addCalls } = mockInitializeGit({ local: false, remote: true });
        (fs.access as Mock<any>).mockImplementation(async (p: unknown) => {
          if (p === path.join(MAIN_WORKTREE_PATH, ".git")) {
            throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
          }
        });

        await gitService.initialize();

        expect(fs.rm).toHaveBeenCalledWith(MAIN_WORKTREE_PATH, { recursive: true, force: true });
        expect(fs.rename).not.toHaveBeenCalled();
        expect(addCalls).toHaveLength(1);
      });

      it("rejects naming the path when the worktree is still not registered after creation", async () => {
        const { addCalls } = mockInitializeGit({ local: false, remote: true, registersOnAdd: false });
        mockMainWorktreeMissing();

        await expect(gitService.initialize()).rejects.toMatchObject({
          code: "WORKTREE_NOT_REGISTERED",
          message: expect.stringContaining(MAIN_WORKTREE_PATH),
        });

        expect(addCalls).toHaveLength(1);
        expect(gitService.isInitialized()).toBe(false);
      });

      it("rejects git's 'already exists' when the directory is not a registered worktree", async () => {
        mockInitializeGit({
          local: false,
          remote: true,
          addError: new Error(`fatal: '${MAIN_WORKTREE_PATH}' already exists`),
        });
        mockMainWorktreeMissing();

        await expect(gitService.initialize()).rejects.toThrow("already exists");

        expect(fs.rm).not.toHaveBeenCalled();
        expect(fs.rename).not.toHaveBeenCalled();
        expect(gitService.isInitialized()).toBe(false);
      });

      it("reuses the worktree when git's 'already exists' comes from a concurrent registration", async () => {
        mockInitializeGit({
          local: false,
          remote: true,
          addError: new Error(`fatal: '${MAIN_WORKTREE_PATH}' already exists`),
          registersOnAddError: true,
        });
        mockMainWorktreeMissing();
        const trasher = vi.fn<any>().mockResolvedValue("/test/worktrees/.trash/id/payload");
        gitService.setStaleDirectoryTrasher(trasher as unknown as (dirPath: string) => Promise<string>);

        await gitService.initialize();

        expect(trasher).not.toHaveBeenCalled();
        expect(fs.rm).not.toHaveBeenCalled();
        expect(gitService.isInitialized()).toBe(true);
      });
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
    // `git clone --bare` runs init_db before any transfer, so HEAD exists
    // within milliseconds and a HEAD-less bareRepoDir is a leftover of a
    // half-finished cleanup or external damage rather than of a killed clone.
    // However it arose, "bare repo exists" is decided by `<bare>/HEAD`, so
    // every later initialize() re-ran `git clone --bare` into that directory
    // and git refused it ("destination path already exists and is not an empty
    // directory") until someone deleted it by hand. The pending marker records
    // that such a leftover is one this tool made — and it is written only for a
    // destination verified as absent or empty, so nothing else is ever deleted.
    describe("interrupted bare clone recovery", () => {
      const bareRepoPath = path.resolve(".bare/repo");
      const markerPath = path.join(
        path.dirname(bareRepoPath),
        `repo${PATH_CONSTANTS.BARE_CLONE_PENDING_MARKER_SUFFIX}`,
      );
      const mainWorktreeList = createWorktreeListOutput([
        { path: TEST_PATHS.worktree + "/main", branch: "main", commit: "abc123" },
      ]);

      const fsError = (code: string, message: string): NodeJS.ErrnoException =>
        Object.assign(new Error(message), { code });
      const enoent = (): NodeJS.ErrnoException => fsError("ENOENT", "ENOENT: no such file or directory");

      // fs stand-in keyed by path: only `<bare>/HEAD`, the bare directory and
      // the marker answer differently, every other probe reports "exists". The
      // marker is tracked for real — written by fs.writeFile, cleared by
      // fs.unlink — so the order the code writes and clears it in is observable,
      // and `setDir` lets a failing clone leave a partial directory behind.
      const mockBareRepoState = (opts: {
        head: boolean;
        marker: boolean;
        dir: boolean;
        entries?: string[];
        readdirError?: NodeJS.ErrnoException;
      }): {
        markerExists: () => boolean;
        setDir: (exists: boolean) => void;
        setReaddirError: (error: NodeJS.ErrnoException | undefined) => void;
      } => {
        let markerExists = opts.marker;
        let dirExists = opts.dir;
        let readdirError = opts.readdirError;
        (fs.access as Mock<any>).mockImplementation(async (p: unknown) => {
          const target = String(p);
          if (target === path.join(".bare/repo", "HEAD") && !opts.head) throw enoent();
          if (target === markerPath && !markerExists) throw enoent();
          if (target === ".bare/repo" && !dirExists) throw enoent();
        });
        (fs.readdir as Mock<any>).mockImplementation(async () => {
          if (readdirError) throw readdirError;
          return opts.entries ?? [];
        });
        (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
        (fs.rm as Mock<any>).mockResolvedValue(undefined);
        (fs.writeFile as Mock<any>).mockImplementation(async (p: unknown) => {
          if (String(p) === markerPath) markerExists = true;
        });
        (fs.unlink as Mock<any>).mockImplementation(async (p: unknown) => {
          if (String(p) === markerPath) markerExists = false;
        });
        return {
          markerExists: () => markerExists,
          setDir: (exists: boolean) => {
            dirExists = exists;
          },
          setReaddirError: (error: NodeJS.ErrnoException | undefined) => {
            readdirError = error;
          },
        };
      };

      const invocationOrderOf = (mock: Mock, target: string): number => {
        const index = mock.mock.calls.findIndex((call) => String(call[0]) === target);
        expect(index).toBeGreaterThanOrEqual(0);
        return mock.mock.invocationCallOrder[index];
      };

      it("removes a marked HEAD-less directory and clones again", async () => {
        mockInitializeGit({ local: false, remote: true });
        const marker = mockBareRepoState({ head: false, marker: true, dir: true, entries: ["objects", "config"] });

        await gitService.initialize();

        expect(fs.rm).toHaveBeenCalledWith(".bare/repo", { recursive: true, force: true });
        expect(mockGit.clone).toHaveBeenCalledWith(TEST_URLS.github, ".bare/repo", ["--bare", "--progress"]);
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining(bareRepoPath));
        // The retry re-arms the marker before cloning and settles it after, so
        // a kill during the retry is recoverable too and a later init adopts.
        const cloneOrder = (mockGit.clone as Mock).mock.invocationCallOrder[0];
        expect(invocationOrderOf(fs.rm as Mock, ".bare/repo")).toBeLessThan(cloneOrder);
        expect(invocationOrderOf(fs.writeFile as Mock, markerPath)).toBeLessThan(cloneOrder);
        expect(invocationOrderOf(fs.unlink as Mock, markerPath)).toBeGreaterThan(cloneOrder);
        expect(marker.markerExists()).toBe(false);
      });

      it("refuses an unmarked HEAD-less directory, names it, and deletes nothing", async () => {
        mockInitializeGit({ local: false, remote: true });
        mockBareRepoState({ head: false, marker: false, dir: true, entries: ["objects", "config"] });

        const error = await gitService.initialize().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).code).toBe("CONFIG_BARE_DESTINATION_NOT_EMPTY");
        expect((error as Error).message).toContain(bareRepoPath);
        expect((error as Error).message).toContain("point bareRepoDir at a fresh path");
        expect(fs.rm).not.toHaveBeenCalled();
        expect(mockGit.clone).not.toHaveBeenCalled();
        expect(gitService.isInitialized()).toBe(false);
      });

      it("clears a stale marker next to a bare repo that has a HEAD, and clones nothing", async () => {
        const marker = mockBareRepoState({ head: true, marker: true, dir: true });
        mockGit.raw
          .mockResolvedValueOnce(TEST_URLS.github as any) // remote get-url origin
          .mockResolvedValueOnce("+refs/heads/*:refs/remotes/origin/*" as any) // fetch refspec present
          .mockResolvedValueOnce("refs/remotes/origin/main\n" as any) // symbolic-ref origin/HEAD
          .mockResolvedValueOnce(mainWorktreeList as any); // worktree list

        await expect(gitService.initialize()).resolves.toBe(mockGit);

        expect(mockGit.clone).not.toHaveBeenCalled();
        expect(fs.rm).not.toHaveBeenCalled();
        expect(fs.unlink).toHaveBeenCalledWith(markerPath);
        expect(marker.markerExists()).toBe(false);
      });

      it("leaves an unmarked bare repo with a HEAD completely alone", async () => {
        mockBareRepoState({ head: true, marker: false, dir: true });
        mockGit.raw
          .mockResolvedValueOnce(TEST_URLS.github as any)
          .mockResolvedValueOnce("+refs/heads/*:refs/remotes/origin/*" as any)
          .mockResolvedValueOnce("refs/remotes/origin/main\n" as any)
          .mockResolvedValueOnce(mainWorktreeList as any);

        await expect(gitService.initialize()).resolves.toBe(mockGit);

        expect(mockGit.clone).not.toHaveBeenCalled();
        expect(fs.rm).not.toHaveBeenCalled();
        expect(fs.unlink).not.toHaveBeenCalled();
        expect(fs.writeFile).not.toHaveBeenCalledWith(markerPath, expect.anything());
      });

      it("marks a first-run clone into a missing directory and settles the marker after it", async () => {
        mockInitializeGit({ local: false, remote: true });
        const marker = mockBareRepoState({ head: false, marker: false, dir: false });

        await gitService.initialize();

        expect(fs.rm).not.toHaveBeenCalled();
        expect(mockGit.clone).toHaveBeenCalledWith(TEST_URLS.github, ".bare/repo", ["--bare", "--progress"]);
        const cloneOrder = (mockGit.clone as Mock).mock.invocationCallOrder[0];
        expect(invocationOrderOf(fs.writeFile as Mock, markerPath)).toBeLessThan(cloneOrder);
        expect(invocationOrderOf(fs.unlink as Mock, markerPath)).toBeGreaterThan(cloneOrder);
        expect(marker.markerExists()).toBe(false);
      });

      // The marker authorizes a deletion, so it may only ever be written for a
      // destination that was positively verified. A destination that exists but
      // cannot be listed — a transient EMFILE, or a path that is a file and not
      // a directory — is neither claimed nor cloned into: claiming it would
      // license deleting whatever is really there on the next run.
      it.each([
        ["the listing fails transiently", fsError("EMFILE", "EMFILE: too many open files, scandir")],
        ["the destination is a file, not a directory", fsError("ENOTDIR", "ENOTDIR: not a directory, scandir")],
      ])("refuses to claim or clone a destination that exists but cannot be inspected when %s", async (_case, err) => {
        mockInitializeGit({ local: false, remote: true });
        mockBareRepoState({ head: false, marker: false, dir: true, readdirError: err });

        const error = await gitService.initialize().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).code).toBe("CONFIG_BARE_DESTINATION_UNREADABLE");
        expect((error as Error).message).toContain(bareRepoPath);
        expect((error as Error).message).toContain(err.message);
        expect(fs.writeFile).not.toHaveBeenCalledWith(markerPath, expect.anything());
        expect(mockGit.clone).not.toHaveBeenCalled();

        // The next run finds the same directory, still unclaimed: it must not
        // delete it either.
        const second = new GitService(createMockConfig(), mockLogger);
        await expect(second.initialize()).rejects.toBeInstanceOf(ConfigError);
        expect(fs.rm).not.toHaveBeenCalled();
      });

      // The same sequence end to end: one transient listing failure over a
      // pre-existing user directory must not leave anything behind that lets
      // the next run — whose listing works again — delete it.
      it("does not let a transient listing failure authorize deleting a user directory later", async () => {
        mockInitializeGit({ local: false, remote: true });
        const state = mockBareRepoState({
          head: false,
          marker: false,
          dir: true,
          entries: ["notes.txt"],
          readdirError: fsError("EMFILE", "EMFILE: too many open files, scandir"),
        });

        await expect(gitService.initialize()).rejects.toMatchObject({ code: "CONFIG_BARE_DESTINATION_UNREADABLE" });

        state.setReaddirError(undefined);
        const second = new GitService(createMockConfig(), mockLogger);
        const error = await second.initialize().catch((e: unknown) => e);

        expect((error as ConfigError).code).toBe("CONFIG_BARE_DESTINATION_NOT_EMPTY");
        expect(fs.rm).not.toHaveBeenCalled();
        expect(fs.writeFile).not.toHaveBeenCalledWith(markerPath, expect.anything());
        expect(state.markerExists()).toBe(false);
      });

      // Same rule one step later: the clone itself can fail (auth, network) on
      // a destination we did claim. git removes the directory it created, so
      // the authorization must go with it.
      it("drops the marker when a failed clone left no directory behind", async () => {
        mockInitializeGit({ local: false, remote: true });
        const marker = mockBareRepoState({ head: false, marker: false, dir: false });
        mockGit.clone.mockRejectedValueOnce(new Error("fatal: could not read Username for 'https://github.com'"));

        await expect(gitService.initialize()).rejects.toThrow("could not read Username");

        expect(invocationOrderOf(fs.writeFile as Mock, markerPath)).toBeLessThan(
          (mockGit.clone as Mock).mock.invocationCallOrder[0],
        );
        expect(fs.unlink).toHaveBeenCalledWith(markerPath);
        expect(marker.markerExists()).toBe(false);
      });

      it("keeps the marker when a failed clone left a partial directory behind", async () => {
        mockInitializeGit({ local: false, remote: true });
        const marker = mockBareRepoState({ head: false, marker: false, dir: false, entries: ["objects"] });
        (mockGit.clone as Mock).mockImplementationOnce(async () => {
          marker.setDir(true);
          throw new Error("fatal: the remote end hung up unexpectedly");
        });

        await expect(gitService.initialize()).rejects.toThrow("the remote end hung up");

        // Still claimed, so the next run recovers it instead of erroring out.
        expect(fs.unlink).not.toHaveBeenCalledWith(markerPath);
        expect(marker.markerExists()).toBe(true);
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

      expect(mockGit.branch).toHaveBeenCalledWith(["-r", "--no-color"]);
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

    it("keeps a remote branch named 'feature/HEAD' and drops only the symref (#review)", async () => {
      mockGit.branch.mockResolvedValue({
        all: ["origin/HEAD", "origin/feature/HEAD", "origin/main"],
        current: "main",
      } as any);

      const branches = await gitService.getRemoteBranches();

      expect(branches).toEqual(["feature/HEAD", "main"]);
    });

    it("drops the 'origin/HEAD -> origin/main' arrow line git prints for the symref (#review)", async () => {
      mockGit.branch.mockResolvedValue({
        all: ["origin/HEAD -> origin/main", "origin/feature/HEAD", "origin/main"],
        current: "main",
      } as any);

      const branches = await gitService.getRemoteBranches();

      expect(branches).toEqual(["feature/HEAD", "main"]);
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
      expect(upstreamCalls).toEqual([[["branch", "--set-upstream-to=origin/feature-1", "feature-1"]]]);
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
        .mockRejectedValueOnce(new Error("show-ref: not found")) // rollback probe: no branch was left behind
        .mockResolvedValueOnce("") // worktree list - empty (directory is not a valid worktree)
        .mockResolvedValueOnce("") // fallback worktree add succeeds
        .mockResolvedValueOnce("") // show-ref remotes (upstream lookup after the plain add)
        .mockResolvedValueOnce(""); // branch --set-upstream-to

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(fs.rm).toHaveBeenCalledWith("/test/worktrees/feature-1", { recursive: true, force: true });
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

    describe("addWorktree - ref existence matrix", () => {
      const makeWorktreeGitMock = () => ({
        branch: vi.fn<any>().mockResolvedValue(undefined),
        raw: vi.fn<any>().mockResolvedValue(""),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
        env: vi.fn<any>().mockReturnThis(),
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
        expect(worktreeGitMock.raw).toHaveBeenCalledWith(["merge", "--ff-only", "origin/feature-1"]);
      });

      it("should not fast-forward when both exist and the local branch has commits not on origin", async () => {
        const worktreeGitMock = makeWorktreeGitMock();
        (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
          p && p.includes("feature-1") ? worktreeGitMock : mockGit,
        );

        mockShowRef({ local: true, remote: true, localOnlyCommits: 1 });

        await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

        expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", "/test/worktrees/feature-1", "feature-1"]);
        expect(worktreeGitMock.branch).toHaveBeenCalledWith(["--set-upstream-to", "origin/feature-1", "feature-1"]);
        expect(worktreeGitMock.raw).not.toHaveBeenCalledWith(expect.arrayContaining(["merge"]));
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
          env: vi.fn<any>().mockReturnThis(),
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
          env: vi.fn<any>().mockReturnThis(),
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
          env: vi.fn<any>().mockReturnThis(),
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
    const POINTER_HEADER = "version https://git-lfs.github.com/spec/v1";

    // Args-keyed stand-in for the new worktree's client: the attribute probe
    // (`git grep` over HEAD's .gitattributes), the git-lfs probe (`git lfs
    // version`) and `git lfs ls-files` all land on the same client.
    const mockWorktreeGit = (
      opts: { declaresLfs?: boolean; gitLfsInstalled?: boolean; lfsFiles?: string[]; treeOid?: string } = {},
    ): { raw: Mock; revparse: Mock; env: Mock } => {
      const worktreeGitMock = {
        raw: vi.fn<any>().mockImplementation((args: unknown) => {
          const argv = Array.isArray(args) ? (args as string[]) : [];
          if (argv[0] === "grep") {
            return Promise.resolve(opts.declaresLfs === false ? "" : "HEAD:.gitattributes\n");
          }
          if (argv[0] === "lfs" && argv[1] === "version") {
            return opts.gitLfsInstalled === false
              ? Promise.reject(new Error("git: 'lfs' is not a git command. See 'git --help'."))
              : Promise.resolve("git-lfs/3.4.0\n");
          }
          if (argv[0] === "lfs" && argv[1] === "ls-files") {
            return Promise.resolve(`${(opts.lfsFiles ?? ["file1.png"]).join("\n")}\n`);
          }
          return Promise.resolve("");
        }),
        revparse: vi
          .fn<any>()
          .mockImplementation((args: unknown) =>
            Promise.resolve(Array.isArray(args) && args[0] === "HEAD^{tree}" ? (opts.treeOid ?? "tree-abc") : "abc123"),
          ),
        env: vi.fn<any>().mockReturnThis(),
      };

      (simpleGit as unknown as Mock).mockImplementation((gitPath?: any) =>
        typeof gitPath === "string" && gitPath.includes("feature") ? worktreeGitMock : mockGit,
      );

      return worktreeGitMock as unknown as { raw: Mock; revparse: Mock; env: Mock };
    };

    // Every sampled file reads back as a git-lfs pointer.
    const mockPointerReads = (): { read: Mock; close: Mock } => {
      const handle = {
        read: vi.fn().mockImplementation((buffer: Buffer) => {
          buffer.write(POINTER_HEADER, "utf8");
          return Promise.resolve({ bytesRead: POINTER_HEADER.length });
        }),
        close: vi.fn<any>().mockResolvedValue(undefined),
      };
      (fs.open as Mock<any>).mockResolvedValue(handle);
      return handle as unknown as { read: Mock; close: Mock };
    };

    // These fixtures let the orphaned-directory cleanup warn on its own, so the
    // assertions below look only at the warnings LFS verification emits.
    const lfsWarnings = (): string[] =>
      (mockLogger.warn as Mock).mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.toLowerCase().includes("lfs"));

    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    // Restored from a hook, not a `finally`: a test body that never finishes
    // (a timeout) would otherwise leave the variable set for the whole file.
    const originalSkipSmudge = process.env[ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE];
    afterEach(() => {
      setEnvVar(ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE, originalSkipSmudge);
    });

    it("should verify LFS files are downloaded when LFS is not skipped", async () => {
      mockShowRef({ local: false, remote: true });

      const worktreeGitMock = mockWorktreeGit({ lfsFiles: ["file1.png", "file2.png", "file3.png"] });

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
      expect(lfsWarnings()).toEqual([]);

      bufferSpy.mockRestore();
    });

    it("samples distinct LFS files when at least five are available", async () => {
      mockShowRef({ local: false, remote: true });

      mockWorktreeGit({
        lfsFiles: ["file1.png", "file2.png", "file3.png", "file4.png", "file5.png", "file6.png"],
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

      const worktreeGitMock = mockWorktreeGit();

      await gitServiceWithSkipLfs.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(worktreeGitMock.raw).not.toHaveBeenCalledWith(["lfs", "ls-files", "--name-only"]);
    });

    // `git worktree add` returns only once its checkout (git-lfs delayed
    // checkout and the post-checkout hook included) has finished, so a pointer
    // file found now stays a pointer file: waiting for it cost up to 30 s per
    // created worktree and never changed the answer.
    it("warns once and never sleeps when the checkout left pointer files behind", async () => {
      mockShowRef({ local: false, remote: true });

      mockWorktreeGit({ lfsFiles: ["file1.png"] });
      const handle = mockPointerReads();

      vi.useFakeTimers();
      try {
        await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }

      expect(fs.open).toHaveBeenCalledTimes(1);
      expect(handle.close).toHaveBeenCalledTimes(1);
      expect(lfsWarnings()).toHaveLength(1);
      expect(lfsWarnings()[0]).toContain("LFS content was not downloaded into '/test/worktrees/feature-1'");
      expect(lfsWarnings()[0]).toContain("skipLfs");
      expect(lfsWarnings()[0]).toContain("GIT_LFS_SKIP_SMUDGE");
    });

    // The variable is exported by the shell or the CI job, not by us: with the
    // smudge filter off, pointer files are the expected outcome of the
    // checkout, so there is nothing to verify and nothing to warn about.
    it("skips verification when GIT_LFS_SKIP_SMUDGE is set in the environment", async () => {
      setEnvVar(ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE, "1");
      mockShowRef({ local: false, remote: true });
      const worktreeGitMock = mockWorktreeGit();
      mockPointerReads();

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(worktreeGitMock.raw).not.toHaveBeenCalledWith(["lfs", "ls-files", "--name-only"]);
      expect(worktreeGitMock.raw).not.toHaveBeenCalledWith(expect.arrayContaining(["grep"]));
      expect(fs.open).not.toHaveBeenCalled();
      expect(lfsWarnings()).toEqual([]);
    });

    // `git lfs ls-files` walks the whole index and spawns git-lfs; a repository
    // whose HEAD declares no `filter=lfs` never had LFS content to check.
    it("does not run 'lfs ls-files' when HEAD declares no LFS filter", async () => {
      mockShowRef({ local: false, remote: true });

      const worktreeGitMock = mockWorktreeGit({ declaresLfs: false });

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(worktreeGitMock.raw).toHaveBeenCalledWith([
        "grep",
        "--name-only",
        "-I",
        "--fixed-strings",
        "-e",
        "filter=lfs",
        "tree-abc",
        "--",
        "*.gitattributes",
      ]);
      expect(worktreeGitMock.raw).not.toHaveBeenCalledWith(["lfs", "ls-files", "--name-only"]);
      expect(fs.open).not.toHaveBeenCalled();
      expect(lfsWarnings()).toEqual([]);
    });

    // Whether git-lfs is installed is a machine-wide fact: probing and warning
    // per created worktree produced one warning per branch on such a machine.
    it("warns once per process when git-lfs is missing, not once per worktree", async () => {
      mockShowRef({ local: false, remote: true });

      const worktreeGitMock = mockWorktreeGit({ gitLfsInstalled: false });

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");
      await gitService.addWorktree("feature-2", "/test/worktrees/feature-2");

      const versionProbes = worktreeGitMock.raw.mock.calls.filter(
        ([args]) => Array.isArray(args) && args[0] === "lfs" && args[1] === "version",
      );
      expect(versionProbes).toHaveLength(1);
      expect(worktreeGitMock.raw).not.toHaveBeenCalledWith(["lfs", "ls-files", "--name-only"]);
      expect(
        (mockLogger.warn as Mock).mock.calls.filter(([message]) => message === GIT_LFS_MISSING_WARNING),
      ).toHaveLength(1);
    });

    // The verdict is keyed by the tree HEAD points at, so a tree's content
    // decides it — a cache entry can never be stale, and a second branch at the
    // same tree does not re-run the probe.
    it("reuses the attribute verdict per tree oid and re-probes a different tree", async () => {
      mockShowRef({ local: false, remote: true });

      const sameTree = mockWorktreeGit({ declaresLfs: false, treeOid: "tree-same" });
      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");
      await gitService.addWorktree("feature-2", "/test/worktrees/feature-2");

      const greps = (raw: Mock): unknown[] =>
        raw.mock.calls.filter(([args]) => Array.isArray(args) && args[0] === "grep");
      expect(greps(sameTree.raw)).toHaveLength(1);

      const otherTree = mockWorktreeGit({ declaresLfs: false, treeOid: "tree-other" });
      await gitService.addWorktree("feature-3", "/test/worktrees/feature-3");
      expect(greps(otherTree.raw)).toHaveLength(1);
    });

    it("should skip verification if no LFS files exist", async () => {
      mockShowRef({ local: false, remote: true });

      const worktreeGitMock = mockWorktreeGit({ lfsFiles: [] });

      await gitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(worktreeGitMock.raw).toHaveBeenCalledWith(["lfs", "ls-files", "--name-only"]);
      expect(fs.open).not.toHaveBeenCalled();
      expect(lfsWarnings()).toEqual([]);
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

      // Every client carries the sanitized process env; none of them may
      // carry the LFS skip.
      const envs = (mockGit.env as Mock).mock.calls.map((call) => call[0] as NodeJS.ProcessEnv);
      expect(envs.length).toBeGreaterThan(0);
      expect(envs.every((env) => env[ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE] === undefined)).toBe(true);
    });

    it("should be togglable at runtime", async () => {
      gitService.setLfsSkipEnabled(true);
      await gitService.fetchAll();
      expect(mockGit.env).toHaveBeenCalledWith(expect.objectContaining({ GIT_LFS_SKIP_SMUDGE: "1" }));

      vi.clearAllMocks();
      (simpleGit as unknown as Mock).mockReturnValue(mockGit);

      gitService.setLfsSkipEnabled(false);
      await gitService.fetchAll();
      const envs = (mockGit.env as Mock).mock.calls.map((call) => call[0] as NodeJS.ProcessEnv);
      expect(envs.every((env) => env[ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE] === undefined)).toBe(true);
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
        { path: "/path/to/repo", branch: "main", isPrunable: false, locked: false },
        { path: "/path/to/worktrees/feature-1", branch: "feature-1", isPrunable: false, locked: false },
        { path: "/path/to/worktrees/feature-2", branch: "feature-2", isPrunable: false, locked: false },
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

  describe("updateWorktree", () => {
    it("should update worktree and metadata for regular worktrees", async () => {
      await gitService.initialize();

      const mockWorktreeGit = {
        branch: vi.fn<any>().mockResolvedValue({
          current: "feature-1",
        }),
        merge: vi.fn<any>().mockResolvedValue(undefined),
        // HEAD before and after the fast-forward.
        revparse: vi.fn<any>().mockResolvedValueOnce("oldcommit456\n").mockResolvedValueOnce("newcommit123\n"),
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      await expect(gitService.updateWorktree("/test/worktrees/feature-1")).resolves.toEqual({
        updated: true,
        before: "oldcommit456",
        after: "newcommit123",
      });

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
      mockGit.revparse.mockResolvedValueOnce("oldcommit456\n" as any).mockResolvedValueOnce("newcommit123\n" as any);

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

    // HEAD already sat at origin/<branch> when the merge ran (it got there
    // between the runner's behind probe and the fast-forward), so nothing was
    // updated: lastSyncCommit/lastSyncDate and syncHistory must stay as they are.
    it("leaves the sync metadata alone when the fast-forward moved nothing", async () => {
      await gitService.initialize();
      mockMetadataService.updateLastSyncFromPath.mockClear();

      const mockWorktreeGit = {
        branch: vi.fn<any>().mockResolvedValue({ current: "feature-1" }),
        merge: vi.fn<any>().mockResolvedValue(undefined),
        revparse: vi.fn<any>().mockResolvedValue("samecommit789\n"),
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      await expect(gitService.updateWorktree("/test/worktrees/feature-1")).resolves.toEqual({
        updated: false,
        before: "samecommit789",
        after: "samecommit789",
      });

      expect(mockWorktreeGit.merge).toHaveBeenCalledWith(["origin/feature-1", "--ff-only"]);
      expect(mockMetadataService.updateLastSyncFromPath).not.toHaveBeenCalled();
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
        env: vi.fn<any>().mockReturnThis(),
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
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const result = await gitService.isLocalAheadOfRemote("/test/worktrees/feature-1", "feature-1");

      expect(result).toBe(false);
    });

    it("should return false when merge-base differs from remote (truly diverged)", async () => {
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockResolvedValue("abc123\n"),
        revparse: vi.fn<any>().mockResolvedValue("xyz789\n"),
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const result = await gitService.isLocalAheadOfRemote("/test/worktrees/feature-1", "feature-1");

      expect(result).toBe(false);
    });

    it("should return false when truly diverged (neither ancestor of other)", async () => {
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockResolvedValue("commonancestor\n"),
        revparse: vi.fn<any>().mockResolvedValue("remotecommit\n"),
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      const result = await gitService.isLocalAheadOfRemote("/test/worktrees/feature-1", "feature-1");

      expect(result).toBe(false);
    });

    // simple-git resolves merge-base's exit 1 (no common ancestor) to an
    // empty string. That is a genuine "not ahead" — unrelated histories — and
    // must not be confused with a probe that failed.
    it("returns false, without throwing, when merge-base finds no common ancestor", async () => {
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockResolvedValue(""),
        revparse: vi.fn<any>().mockResolvedValue("def456\n"),
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      await expect(gitService.isLocalAheadOfRemote("/test/worktrees/feature-1", "feature-1")).resolves.toBe(false);
    });

    // A probe that could not run must not answer "no": the runner reads
    // "cannot fast-forward, not ahead" as diverged and moves the worktree.
    it("throws when merge-base fails instead of reporting 'not ahead'", async () => {
      const cause = new Error("fatal: Not a valid object name");
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockRejectedValue(cause),
        revparse: vi.fn<any>().mockResolvedValue("abc123\n"),
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      await expect(gitService.isLocalAheadOfRemote("/test/worktrees/feature-1", "feature-1")).rejects.toMatchObject({
        name: "GitOperationError",
        code: "GIT_OPERATION_FAILED",
        message:
          "Git operation 'merge-base' failed: could not tell whether 'feature-1' in '/test/worktrees/feature-1' is ahead of origin/feature-1: fatal: Not a valid object name",
        cause,
      });
    });

    it("throws when revparse fails instead of reporting 'not ahead'", async () => {
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockResolvedValue("abc123\n"),
        revparse: vi.fn<any>().mockRejectedValue(new Error("spawn git EMFILE")),
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      await expect(gitService.isLocalAheadOfRemote("/test/worktrees/feature-1", "feature-1")).rejects.toThrow(
        /is ahead of origin\/feature-1: spawn git EMFILE$/,
      );
    });
  });

  describe("canFastForward", () => {
    beforeEach(async () => {
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      await gitService.initialize();
    });

    it("returns true when the merge base is HEAD (HEAD is an ancestor of the remote tip)", async () => {
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockResolvedValue("abc123\n"),
        revparse: vi.fn<any>().mockResolvedValue("abc123\n"),
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      await expect(gitService.canFastForward("/test/worktrees/feature-1", "feature-1")).resolves.toBe(true);
      expect(mockWorktreeGit.raw).toHaveBeenCalledWith(["merge-base", "HEAD", "origin/feature-1"]);
      expect(mockWorktreeGit.revparse).toHaveBeenCalledWith(["HEAD"]);
    });

    it("returns false when the merge base is not HEAD", async () => {
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockResolvedValue("ancestor\n"),
        revparse: vi.fn<any>().mockResolvedValue("head\n"),
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      await expect(gitService.canFastForward("/test/worktrees/feature-1", "feature-1")).resolves.toBe(false);
    });

    // Unrelated histories: merge-base exits 1 with nothing on stdout, which
    // simple-git resolves to "". A genuine "cannot fast-forward", not a failure.
    it("returns false, without throwing, when merge-base finds no common ancestor", async () => {
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockResolvedValue(""),
        revparse: vi.fn<any>().mockResolvedValue("head\n"),
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      await expect(gitService.canFastForward("/test/worktrees/feature-1", "feature-1")).resolves.toBe(false);
    });

    it("throws when merge-base fails instead of reporting 'cannot fast-forward'", async () => {
      const cause = new Error("spawn git EMFILE");
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockRejectedValue(cause),
        revparse: vi.fn<any>().mockResolvedValue("head\n"),
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      await expect(gitService.canFastForward("/test/worktrees/feature-1", "feature-1")).rejects.toMatchObject({
        name: "GitOperationError",
        code: "GIT_OPERATION_FAILED",
        message:
          "Git operation 'merge-base' failed: could not tell whether 'feature-1' in '/test/worktrees/feature-1' can fast-forward: spawn git EMFILE",
        cause,
      });
    });

    it("throws when revparse fails instead of reporting 'cannot fast-forward'", async () => {
      const mockWorktreeGit = {
        raw: vi.fn<any>().mockResolvedValue("abc123\n"),
        revparse: vi.fn<any>().mockRejectedValue(new Error("fatal: Not a valid object name HEAD")),
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockReturnValue(mockWorktreeGit);

      await expect(gitService.canFastForward("/test/worktrees/feature-1", "feature-1")).rejects.toThrow(
        /can fast-forward: fatal: Not a valid object name HEAD$/,
      );
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

      return { revparse, raw, env: vi.fn<any>().mockReturnThis() };
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
        env: vi.fn<any>().mockReturnThis(),
      };
      (simpleGit as unknown as Mock).mockReturnValue(client);

      const result = await gitService.classifyRemoteRelationship("/test/worktrees/feature-1", "feature-1");

      expect(result).toBe("diverged");
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
      expect(worktreeGit.raw).toHaveBeenCalledWith(["branch", "--set-upstream-to=origin/feature-1", "feature-1"]);
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

  // refs/remotes/origin/HEAD is only ever written by `remote set-head`, so
  // after the remote renamed or deleted its default branch, `fetch --prune`
  // leaves the symref naming a branch that no longer exists. Detection trusts
  // it only while its target is still one of the remote branches.
  describe("detectDefaultBranch after the remote renamed its default", () => {
    const detect = (): Promise<string> => (gitService as any).detectDefaultBranch(mockGit);

    // Args-keyed stand-in: origin/HEAD reads `symrefTargets` in order (the
    // last one repeats), `remote set-head origin -a` resolves unless
    // `setHeadError`, and `branch -r` lists `remoteBranches`.
    const mockOriginHead = (opts: {
      symrefTargets: string[];
      remoteBranches: string[];
      setHeadError?: Error;
    }): void => {
      const targets = [...opts.symrefTargets];
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (!Array.isArray(args)) return Promise.resolve("");
        const [command, subcommand] = args as string[];
        if (command === "symbolic-ref") {
          const target = targets.length > 1 ? targets.shift() : targets[0];
          return Promise.resolve(`refs/remotes/origin/${target}\n`);
        }
        if (command === "remote" && subcommand === "set-head") {
          return opts.setHeadError ? Promise.reject(opts.setHeadError) : Promise.resolve("");
        }
        return Promise.resolve("");
      });
      (mockGit.branch as Mock).mockResolvedValue({
        all: opts.remoteBranches.map((branch) => `origin/${branch}`),
        current: "",
      });
    };

    it("trusts origin/HEAD while its target is still a remote branch", async () => {
      mockOriginHead({ symrefTargets: ["main"], remoteBranches: ["main", "feature-1"] });

      await expect(detect()).resolves.toBe("main");

      expect(mockGit.raw).not.toHaveBeenCalledWith(["remote", "set-head", "origin", "-a"]);
    });

    it("asks origin again when origin/HEAD names a branch that is gone, and uses its answer", async () => {
      mockOriginHead({ symrefTargets: ["master", "main"], remoteBranches: ["main", "feature-1"] });

      await expect(detect()).resolves.toBe("main");

      expect(mockGit.raw).toHaveBeenCalledWith(["remote", "set-head", "origin", "-a"]);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("origin/HEAD points at 'master', which no longer exists on origin"),
      );
    });

    it("falls back to a common default name that exists when origin cannot be asked", async () => {
      mockOriginHead({
        symrefTargets: ["master"],
        remoteBranches: ["feature-1", "trunk"],
        setHeadError: new Error("Cannot determine remote HEAD"),
      });

      await expect(detect()).resolves.toBe("trunk");

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Could not read the default branch from origin: Cannot determine remote HEAD"),
      );
    });
  });

  // Fetches run from the default branch's worktree. When the remote renamed
  // its default, the switch has to create (or adopt) the new default's
  // worktree and re-point fetches at it before the old one can be pruned —
  // and leave the old one in place when that cannot be done.
  describe("refreshDefaultBranch", () => {
    const TRUNK_WORKTREE_PATH = path.join(TEST_PATHS.worktree, "trunk");

    // The bare repository after `fetch --prune` dropped origin/main: origin/HEAD
    // still names main until `remote set-head` runs (which then reports
    // `newHead`, or fails when null), origin has `remoteBranches`, and
    // `worktrees` are registered (a `worktree add` registers its worktree).
    const mockRenamedRemote = (
      opts: {
        remoteBranches?: string[];
        worktrees?: Array<{ path: string; branch: string }>;
        newHead?: string | null;
        addError?: Error;
      } = {},
    ): { addCalls: string[][] } => {
      const remoteBranches = opts.remoteBranches ?? ["trunk", "feature-1"];
      const newHead = opts.newHead === undefined ? "trunk" : opts.newHead;
      const worktrees = [...(opts.worktrees ?? [{ path: MAIN_WORKTREE_PATH, branch: "main" }])];
      const addCalls: string[][] = [];
      let headSet = false;
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (!Array.isArray(args)) return Promise.resolve("");
        const [command, subcommand] = args as string[];
        if (command === "symbolic-ref") {
          return Promise.resolve(`refs/remotes/origin/${headSet ? newHead : "main"}\n`);
        }
        if (command === "remote" && subcommand === "set-head") {
          if (newHead === null) return Promise.reject(new Error("Cannot determine remote HEAD"));
          headSet = true;
          return Promise.resolve("");
        }
        if (command === "worktree" && subcommand === "list") {
          return Promise.resolve(createWorktreeListOutput(worktrees.map((w) => ({ ...w, commit: "abc123" }))));
        }
        if (command === "worktree" && subcommand === "add") {
          addCalls.push(args as string[]);
          if (opts.addError) return Promise.reject(opts.addError);
          worktrees.push({ path: args[args.length - 2] as string, branch: args[args.length - 3] as string });
          return Promise.resolve("");
        }
        if (command === "show-ref") {
          const ref = args[args.length - 1] as string;
          const remotePrefix = "refs/remotes/origin/";
          return ref.startsWith(remotePrefix) && remoteBranches.includes(ref.slice(remotePrefix.length))
            ? Promise.resolve("")
            : Promise.reject(new Error("show-ref: not found"));
        }
        return Promise.resolve("");
      });
      (mockGit.branch as Mock).mockResolvedValue({
        all: remoteBranches.map((branch) => `origin/${branch}`),
        current: "",
      });
      return { addCalls };
    };

    it("switches to the renamed default, creates its worktree and fetches from it", async () => {
      await gitService.initialize();
      const { addCalls } = mockRenamedRemote();
      mockMainWorktreeMissing(TRUNK_WORKTREE_PATH);
      (simpleGit as unknown as Mock).mockClear();

      await expect(gitService.refreshDefaultBranch()).resolves.toEqual({
        previous: "main",
        defaultBranch: "trunk",
        mainWorktreePath: TRUNK_WORKTREE_PATH,
        created: true,
      });

      expect(gitService.getDefaultBranch()).toBe("trunk");
      expect(mockGit.raw).toHaveBeenCalledWith(["remote", "set-head", "origin", "-a"]);
      expect(addCalls).toEqual([["worktree", "add", "--track", "-b", "trunk", TRUNK_WORKTREE_PATH, "origin/trunk"]]);
      expect(mockLogger.info).toHaveBeenCalledWith("Default branch changed from 'main' to 'trunk' on origin.");
      // The primary client — where every fetch runs — is the new worktree's.
      expect(simpleGit).toHaveBeenCalledWith(
        TRUNK_WORKTREE_PATH,
        expect.objectContaining({ progress: expect.any(Function) }),
      );
      expect((gitService as any).mainWorktreePath).toBe(TRUNK_WORKTREE_PATH);
      await expect(gitService.fetchAll()).resolves.toBeUndefined();
    });

    it("adopts the worktree the new default already has under its hashed directory", async () => {
      await gitService.initialize();
      const hashedTrunkPath = path.join(TEST_PATHS.worktree, "trunk-0123abcd");
      const { addCalls } = mockRenamedRemote({
        worktrees: [
          { path: MAIN_WORKTREE_PATH, branch: "main" },
          { path: hashedTrunkPath, branch: "trunk" },
        ],
      });

      await expect(gitService.refreshDefaultBranch()).resolves.toEqual({
        previous: "main",
        defaultBranch: "trunk",
        mainWorktreePath: hashedTrunkPath,
        created: false,
      });

      expect(addCalls).toEqual([]);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining(`trunk is already checked out at "${hashedTrunkPath}"`),
      );
    });

    it("keeps the old default as the fetch anchor when the new default's worktree cannot be created", async () => {
      await gitService.initialize();
      mockRenamedRemote({ addError: new Error("disk full") });
      mockMainWorktreeMissing(TRUNK_WORKTREE_PATH);

      await expect(gitService.refreshDefaultBranch()).rejects.toThrow("disk full");

      expect(gitService.getDefaultBranch()).toBe("main");
      expect((gitService as any).mainWorktreePath).toBe(MAIN_WORKTREE_PATH);
    });

    it("fails instead of switching when no default that exists on origin can be resolved", async () => {
      await gitService.initialize();
      mockRenamedRemote({ remoteBranches: ["feature-1"], newHead: null });

      await expect(gitService.refreshDefaultBranch()).rejects.toThrow("origin/main does not exist");

      expect(gitService.getDefaultBranch()).toBe("main");
      expect(mockGit.raw).not.toHaveBeenCalledWith(expect.arrayContaining(["worktree", "add"]));
    });
  });

  describe("initialize - failure scenarios", () => {
    it("detects default branches whose names contain slashes", async () => {
      mockGit.raw.mockResolvedValueOnce("refs/remotes/origin/release/2024\n" as any);
      (mockGit.branch as Mock).mockResolvedValueOnce({ all: ["origin/release/2024"], current: "" } as any);

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
        env: vi.fn<any>().mockReturnThis(),
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

    // A --no-checkout worktree has no index or files yet, so the fast-forward
    // only moves the ref; the checkout after the sparse setup populates it.
    it("moves a behind local branch to origin's tip before the sparse checkout", async () => {
      const sparseConfig: Config = {
        ...createMockConfig(),
        sparseCheckout: { include: ["apps"] },
      };

      const worktreeRawCalls: string[][] = [];
      const worktreeGitMock: any = {
        branch: vi.fn<any>().mockResolvedValue(undefined),
        raw: vi.fn<any>().mockImplementation((...args: unknown[]) => {
          worktreeRawCalls.push(args[0] as string[]);
          return Promise.resolve("");
        }),
        revparse: vi.fn<any>().mockResolvedValue("abc123"),
        env: vi.fn<any>().mockReturnThis(),
      };
      worktreeGitMock.env = vi.fn(() => worktreeGitMock);

      (simpleGit as unknown as Mock).mockImplementation((p?: any) =>
        p && p.includes("feature-1") ? worktreeGitMock : mockGit,
      );

      mockShowRef({ local: true, remote: true, localOnlyCommits: 0 });

      const sparseGitService = new GitService(sparseConfig, mockLogger);
      mockGit.raw.mockClear();

      await sparseGitService.addWorktree("feature-1", "/test/worktrees/feature-1");

      expect(mockGit.raw).toHaveBeenCalledWith([
        "worktree",
        "add",
        "--no-checkout",
        "/test/worktrees/feature-1",
        "feature-1",
      ]);
      expect(worktreeGitMock.branch).toHaveBeenCalledWith(["--set-upstream-to", "origin/feature-1", "feature-1"]);
      expect(worktreeRawCalls).toEqual(
        expect.arrayContaining([
          ["reset", "--soft", "origin/feature-1"],
          ["sparse-checkout", "init", "--cone"],
          ["sparse-checkout", "set", "--cone", "apps"],
          ["checkout", "HEAD"],
        ]),
      );
      expect(worktreeRawCalls).not.toContainEqual(["merge", "--ff-only", "origin/feature-1"]);
      const resetIndex = worktreeRawCalls.findIndex((args) => args[0] === "reset");
      const sparseIndex = worktreeRawCalls.findIndex((args) => args[0] === "sparse-checkout");
      const checkoutIndex = worktreeRawCalls.findIndex((args) => args[0] === "checkout");
      expect(resetIndex).toBeLessThan(sparseIndex);
      expect(sparseIndex).toBeLessThan(checkoutIndex);
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
        env: vi.fn<any>().mockReturnThis(),
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
          env: vi.fn<any>().mockReturnThis(),
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
      expect(lfsClient!.options).toEqual(expect.objectContaining({ unsafe: GIT_UNSAFE_ALLOWANCES }));
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
        env: vi.fn<any>().mockReturnThis(),
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

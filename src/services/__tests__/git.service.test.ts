import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TEST_PATHS,
  TEST_URLS,
  buildGitStatusResponse,
  createMockConfig,
  createWorktreeListOutput,
  setEnvVar,
} from "../../__tests__/test-utils";
import { DEFAULT_CONFIG, ENV_CONSTANTS } from "../../constants";
import { GIT_UNSAFE_ALLOWANCES } from "../../utils/git-env";
import { GitService } from "../git.service";

import {
  MAIN_WORKTREE_PATH,
  createGitServiceFixture,
  mockInitializeGit as mockInitializeGitOn,
  mockMainWorktreeMissing,
} from "./helpers/git-service-fixture";

import type { Config } from "../../types";
import type { Logger } from "../logger.service";
import type { SimpleGit } from "simple-git";
import type { Mock, Mocked } from "vitest";

// GitService's own responsibilities: its git clients, initialize() and the
// default-branch worktree, fetches, and the per-worktree update/reset probes.
// What it delegates is tested next to the service that implements it
// (bare-repo, branch-ref, worktree-creation, worktree-registry and
// lfs-verification .test.ts files), still driven through GitService so the
// clients and settings it shares with them are part of every test.
vi.mock("fs/promises");
vi.mock("simple-git");
vi.mock("../worktree-metadata.service", async () =>
  (await import("./helpers/metadata-service-mock")).worktreeMetadataServiceModuleMock(),
);

describe("GitService", () => {
  let gitService: GitService;
  let mockConfig: Config;
  let mockGit: Mocked<SimpleGit>;
  let mockMetadataService: any;
  let mockLogger: Logger;

  const mockInitializeGit = (opts: Parameters<typeof mockInitializeGitOn>[1] = {}): { addCalls: string[][] } =>
    mockInitializeGitOn(mockGit, opts);

  beforeEach(() => {
    ({ gitService, mockConfig, mockGit, mockMetadataService, mockLogger } = createGitServiceFixture());
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

    it("keeps a configured 0 as 0 instead of falling back to the built-in window", async () => {
      // 0 is the documented way to turn an inactivity kill off, and it is
      // falsy: a `||` fallback here would quietly hand the repository the 5-
      // and 15-minute built-ins instead, so a config file that asked for no
      // kill would get the very window it was written to remove. The client
      // that runs the command must end up with no `timeout` option at all —
      // that, not a `{ block: 0 }`, is what makes 0 a disable rather than an
      // instant abort.
      delete process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT];
      const service = new GitService(createMockConfig({ fetchTimeoutMs: 0, cloneTimeoutMs: 0 }), mockLogger);

      expect((service as any).getFetchTimeoutMs()).toBe(0);
      expect((service as any).getCloneTimeoutMs()).toBe(0);

      (mockGit.raw as Mock).mockResolvedValue("ref: refs/heads/main\tHEAD\n");
      await service.getRemoteDefaultBranch(TEST_URLS.github);

      // Every client built during that call, not just one of them: asserting
      // that some call carried no timeout would pass even with a timed one
      // beside it.
      const optionsPerClient = (simpleGit as unknown as Mock).mock.calls.map((call) =>
        typeof call[0] === "string" ? call[1] : call[0],
      );
      expect(optionsPerClient.length).toBeGreaterThan(0);
      for (const options of optionsPerClient) {
        expect(options ?? {}).not.toHaveProperty("timeout");
      }
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

      it("quarantines an unregistered directory without a .git instead of deleting it", async () => {
        const { addCalls } = mockInitializeGit({ local: false, remote: true });
        (fs.access as Mock<any>).mockImplementation(async (p: unknown) => {
          if (p === path.join(MAIN_WORKTREE_PATH, ".git")) {
            throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
          }
        });
        (fs.readdir as Mock<any>).mockResolvedValueOnce(["notes.txt"]);

        await gitService.initialize();

        expect(fs.rename).toHaveBeenCalledWith(MAIN_WORKTREE_PATH, expect.stringContaining(".removed"));
        expect(fs.rm).not.toHaveBeenCalled();
        expect(fs.rmdir).not.toHaveBeenCalled();
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

      await expect(gitService.updateWorktree("/test/worktrees/feature-1", "feature-1")).resolves.toEqual({
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

      (mockGit as any).merge = vi.fn<any>().mockResolvedValue(undefined);
      mockGit.revparse.mockResolvedValueOnce("oldcommit456\n" as any).mockResolvedValueOnce("newcommit123\n" as any);

      await gitService.updateWorktree("/test/worktrees/main", "main");

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

      await expect(gitService.updateWorktree("/test/worktrees/feature-1", "feature-1")).resolves.toEqual({
        updated: false,
        before: "samecommit789",
        after: "samecommit789",
      });

      expect(mockWorktreeGit.merge).toHaveBeenCalledWith(["origin/feature-1", "--ff-only"]);
      expect(mockMetadataService.updateLastSyncFromPath).not.toHaveBeenCalled();
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

    // Clone mode's branch switch asks about a branch it has not switched to
    // yet, so the local side of the comparison is named rather than implied.
    it("compares the named local ref instead of HEAD", async () => {
      const client = buildClient({ headSha: "branchtip", remoteSha: "tip", mergeBase: "branchtip" });
      (simpleGit as unknown as Mock).mockReturnValue(client);

      const result = await gitService.classifyRemoteRelationship(
        "/test/worktrees/feature-1",
        "feature-1",
        "refs/heads/feature-1",
      );

      expect(result).toBe("fast_forward");
      expect(client.revparse).toHaveBeenNthCalledWith(1, ["refs/heads/feature-1"]);
      expect(client.revparse).toHaveBeenNthCalledWith(2, ["refs/remotes/origin/feature-1"]);
      expect(client.raw).toHaveBeenCalledWith(["merge-base", "refs/heads/feature-1", "refs/remotes/origin/feature-1"]);
    });

    it("returns indeterminate_shallow for a named local ref a shallow clone cannot reach", async () => {
      const client = buildClient({ headSha: "branchtip", remoteSha: "tip", mergeBase: "", isShallow: "true" });
      (simpleGit as unknown as Mock).mockReturnValue(client);

      const result = await gitService.classifyRemoteRelationship(
        "/test/worktrees/feature-1",
        "feature-1",
        "refs/heads/feature-1",
      );

      expect(result).toBe("indeterminate_shallow");
      expect(client.raw).toHaveBeenCalledWith(["merge-base", "refs/heads/feature-1", "refs/remotes/origin/feature-1"]);
    });

    it("returns diverged for a named local ref whose merge-base is a third commit", async () => {
      const client = buildClient({
        headSha: "branchtip",
        remoteSha: "tip",
        mergeBase: "ancestor",
        isShallow: "true",
      });
      (simpleGit as unknown as Mock).mockReturnValue(client);

      const result = await gitService.classifyRemoteRelationship(
        "/test/worktrees/feature-1",
        "feature-1",
        "refs/heads/feature-1",
      );

      expect(result).toBe("diverged");
      expect(client.raw).toHaveBeenCalledWith(["merge-base", "refs/heads/feature-1", "refs/remotes/origin/feature-1"]);
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
      // 3. for-each-ref → reject (the remote branch listing fails, so no
      //    common default name can be confirmed to exist either)
      // 4. symbolic-ref → reject (first detection attempt fails)
      // 5. set-head → reject (skips second symbolic-ref)
      // 6. worktree list → returns main worktree so no creation needed
      mockGit.raw.mockReset();
      mockGit.raw
        .mockResolvedValueOnce(TEST_URLS.github as any)
        .mockRejectedValueOnce(new Error("config not found"))
        .mockRejectedValueOnce(new Error("ref listing failed"))
        .mockRejectedValueOnce(new Error("not a symbolic ref"))
        .mockRejectedValueOnce(new Error("set-head failed"))
        .mockResolvedValueOnce(
          createWorktreeListOutput([{ path: TEST_PATHS.worktree + "/main", branch: "main", commit: "abc123" }]) as any,
        );

      const git = await gitService.initialize();
      expect(git).toBe(mockGit);
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
});

import * as fs from "fs/promises";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PRIMARY_CHECKOUT_GIT_DIRS,
  PRIMARY_CHECKOUT_GIT_DIR_PROBE,
  buildFsStats,
  setEnvVar,
} from "../../__tests__/test-utils";
import { DEFAULT_CONFIG, ENV_CONSTANTS } from "../../constants";
import { ConfigError, FastForwardError, GitOperationError, WorktreeNotCleanError } from "../../errors";
import { BranchCreatedActionsService } from "../branch-created-actions.service";
import { CloneSyncService } from "../clone-sync.service";
import { Logger } from "../logger.service";
import { SyncOutcomeAccumulator } from "../sync-outcome";

import type { Config } from "../../types";
import type { CloneSkipReason } from "../clone-sync.service";
import type { GitService } from "../git.service";
import type { Mock } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    repoUrl: "https://github.com/example/repo.git",
    worktreeDir: "/tmp/clone-demo",
    cronSchedule: "0 * * * *",
    runOnce: true,
    mode: "clone",
    branch: "main",
    ...overrides,
  };
}

interface FakeGitClient {
  clone: Mock;
  fetch: Mock;
  raw: Mock;
  merge: Mock;
  env: Mock;
  branch: Mock;
}

function buildGitMock(rawMap: Record<string, string> = {}): FakeGitClient {
  const env = vi.fn();
  const client: FakeGitClient = {
    clone: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockResolvedValue(undefined),
    raw: vi.fn().mockImplementation(async (args: string[]) => {
      const key = Array.isArray(args) ? args.join(" ") : String(args);
      if (rawMap[key] !== undefined) return rawMap[key];
      // The fake stands in for an ordinary clone: its own '.git', no owning
      // repository behind it.
      if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
      if (key.startsWith("rev-parse --abbrev-ref HEAD")) return "main";
      if (key.startsWith("remote get-url origin")) return "https://github.com/example/repo.git";
      if (key.startsWith("checkout HEAD")) return "";
      return "";
    }),
    merge: vi.fn().mockResolvedValue(undefined),
    env: env as Mock,
    branch: vi.fn().mockResolvedValue({ current: "main", all: [] }),
  };
  env.mockReturnValue(client);
  return client;
}

function buildGitService(overrides: Partial<Record<keyof GitService, Mock>> = {}): GitService {
  const sparseService = {
    applyToWorktree: vi.fn().mockResolvedValue(undefined),
    buildPatterns: vi.fn().mockReturnValue(["src"]),
    readCurrent: vi.fn().mockResolvedValue(null),
    patternsEqual: vi.fn().mockReturnValue(false),
    needsUpdate: vi.fn().mockResolvedValue(true),
    isNarrowing: vi.fn().mockReturnValue(false),
    resolveMode: vi.fn().mockReturnValue("cone"),
  };
  const stub: Partial<Record<keyof GitService | "getSparseCheckoutService", unknown>> = {
    getRemoteDefaultBranch: vi.fn().mockResolvedValue("main"),
    verifyLfs: vi.fn().mockResolvedValue(undefined),
    getSparseCheckoutService: vi.fn().mockReturnValue(sparseService),
    checkWorktreeStatus: vi.fn().mockResolvedValue(true),
    classifyRemoteRelationship: vi.fn().mockResolvedValue("fast_forward"),
    ...overrides,
  };
  return stub as unknown as GitService;
}

describe("CloneSyncService", () => {
  let gitMock: FakeGitClient;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks only drops call history, so an implementation set by one
    // test outlives it: a later test then passes (or fails) on a filesystem
    // some earlier test described. These three decide which branch of
    // initialize() runs — what the destination holds, whether a marker is
    // there, what the gitdir pointer says — so each test states its own, and
    // the baseline here is the automock's (every call resolves undefined).
    (fs.readdir as unknown as Mock).mockReset();
    (fs.access as unknown as Mock).mockReset();
    (fs.readFile as unknown as Mock).mockReset();
    gitMock = buildGitMock();
    (simpleGit as unknown as Mock).mockReturnValue(gitMock);
    (fs.lstat as unknown as Mock).mockResolvedValue(buildFsStats("directory"));
    // A fake filesystem with no symlinks in it: every path resolves to itself.
    // Tests that need a link say so by overriding this.
    (fs.realpath as unknown as Mock).mockImplementation(async (target: string) => target);
    logger = Logger.createDefault();
  });

  describe("inactivity timeouts", () => {
    const originalShortcut = process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT];
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      setEnvVar(ENV_CONSTANTS.UNIT_TEST_SHORTCUT, originalShortcut);
      setEnvVar("NODE_ENV", originalNodeEnv);
    });

    it("keeps the default timeouts when NODE_ENV=test but the unit-test shortcut is unset", () => {
      process.env.NODE_ENV = "test";
      delete process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT];
      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      expect((service as any).getFetchTimeoutMs()).toBe(DEFAULT_CONFIG.FETCH_TIMEOUT_MS);
      expect((service as any).getCloneTimeoutMs()).toBe(DEFAULT_CONFIG.CLONE_TIMEOUT_MS);
    });

    it("prefers the configured timeouts when the unit-test shortcut is unset", () => {
      delete process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT];
      const service = new CloneSyncService(
        makeConfig({ fetchTimeoutMs: 1_000, cloneTimeoutMs: 2_000 }),
        buildGitService(),
        logger,
      );

      expect((service as any).getFetchTimeoutMs()).toBe(1_000);
      expect((service as any).getCloneTimeoutMs()).toBe(2_000);
    });

    it("disables the timeouts only while the unit-test shortcut is active for this process", () => {
      process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT] = String(process.pid);
      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      expect((service as any).getFetchTimeoutMs()).toBe(0);
      expect((service as any).getCloneTimeoutMs()).toBe(0);
    });

    it("ignores a shortcut value inherited from another process", () => {
      process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT] = String(process.pid + 1);
      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      expect((service as any).getFetchTimeoutMs()).toBe(DEFAULT_CONFIG.FETCH_TIMEOUT_MS);
      expect((service as any).getCloneTimeoutMs()).toBe(DEFAULT_CONFIG.CLONE_TIMEOUT_MS);
    });
  });

  describe("initialize", () => {
    it("clones into an empty target with a single tracked remote branch", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([]); // worktreeDir exists empty
      (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
      (fs.stat as unknown as Mock).mockRejectedValue(new Error("ENOENT")); // .git missing
      (fs.access as unknown as Mock).mockRejectedValue(new Error("ENOENT")); // marker missing
      (fs.writeFile as unknown as Mock).mockResolvedValue(undefined);

      const config = makeConfig();
      const gitService = buildGitService();
      const service = new CloneSyncService(config, gitService, logger);
      const outcome = new SyncOutcomeAccumulator({ mode: "clone", repoName: "demo" });

      await service.initialize(outcome);

      expect(gitMock.clone).toHaveBeenCalledWith(
        config.repoUrl,
        config.worktreeDir,
        expect.arrayContaining(["--branch", "main", "--single-branch", "--no-tags", "--progress"]),
      );
      expect(gitMock.clone.mock.calls[0][2]).not.toContain("--depth");
      expect(gitMock.raw).toHaveBeenCalledWith([
        "config",
        "--replace-all",
        "remote.origin.fetch",
        "+refs/heads/main:refs/remotes/origin/main",
      ]);
      expect(gitMock.raw).toHaveBeenCalledWith(["config", "--replace-all", "remote.origin.tagOpt", "--no-tags"]);
      expect(service.isInitialized()).toBe(true);
      expect(outcome.toOutcome()).toMatchObject({
        counts: expect.objectContaining({ created: 1 }),
        actions: [{ kind: "created", branch: "main", path: config.worktreeDir }],
      });
    });

    // The recorded outcome is what the MCP `sync` result and the run summary
    // show, so a clone that git could not authenticate carries the remedy
    // hint there, not only on the rejection.
    it("records a clone-time authentication failure with the credential hint", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([]);
      (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
      (fs.access as unknown as Mock).mockRejectedValue(new Error("ENOENT"));
      (fs.rm as unknown as Mock).mockResolvedValue(undefined);
      const authError = new Error(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
      );
      gitMock.clone.mockRejectedValueOnce(authError);

      const outcome = new SyncOutcomeAccumulator({ mode: "clone", repoName: "demo" });
      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      await expect(service.initialize(outcome)).rejects.toBe(authError);

      const failed = outcome.toOutcome().actions.find((action) => action.kind === "failed");
      expect(failed).toMatchObject({ reason: "clone_failed" });
      expect(JSON.stringify(failed)).toMatch(/terminal prompts disabled\\nHint: .*credential helper/);
    });

    it("passes --depth for configured shallow clone depth", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([]);
      (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
      (fs.access as unknown as Mock).mockRejectedValue(new Error("ENOENT"));
      (fs.writeFile as unknown as Mock).mockResolvedValue(undefined);

      const config = makeConfig({ depth: 1 });
      const service = new CloneSyncService(config, buildGitService(), logger);

      await service.initialize();

      expect(gitMock.clone).toHaveBeenCalledWith(config.repoUrl, config.worktreeDir, [
        "--branch",
        "main",
        "--single-branch",
        "--no-tags",
        "--progress",
        "--depth",
        "1",
      ]);
    });

    it("emits progress while initializing a fresh clone", async () => {
      const progressEvents: Array<{ phase: string; message: string }> = [];
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([]);
      (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
      (fs.access as unknown as Mock).mockRejectedValue(new Error("ENOENT"));
      (fs.writeFile as unknown as Mock).mockResolvedValue(undefined);

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger, {
        progressEmitter: (event) => progressEvents.push(event),
      });

      await service.initialize();

      expect(progressEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ phase: "branch", message: "Using configured branch 'main'" }),
          expect.objectContaining({ phase: "clone", message: "Cloning 'https://github.com/example/repo.git' (main)" }),
          expect.objectContaining({
            phase: "clone",
            message: "Clone successful for 'https://github.com/example/repo.git'",
          }),
          expect.objectContaining({ phase: "lfs", message: "Verifying LFS for 'https://github.com/example/repo.git'" }),
          expect.objectContaining({ phase: "lfs", message: "LFS verified for 'https://github.com/example/repo.git'" }),
        ]),
      );
    });

    it("treats existing matching clone as initialized (no re-clone)", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git", "src"]);
      (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
      (fs.stat as unknown as Mock).mockResolvedValue({ isDirectory: () => true, isFile: () => false } as never);
      (fs.access as unknown as Mock).mockResolvedValue(undefined);
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "remote get-url origin") return "https://github.com/example/repo.git";
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        return "";
      });

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      await service.initialize();

      expect(gitMock.clone).not.toHaveBeenCalled();
      expect(gitMock.raw).toHaveBeenCalledWith([
        "config",
        "--replace-all",
        "remote.origin.fetch",
        "+refs/heads/main:refs/remotes/origin/main",
      ]);
      expect(service.isInitialized()).toBe(true);
    });

    it("narrows an existing all-branches clone refspec to the tracked branch", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git", "src"]);
      (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
      (fs.stat as unknown as Mock).mockResolvedValue({ isDirectory: () => true, isFile: () => false } as never);
      (fs.access as unknown as Mock).mockResolvedValue(undefined);
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "remote get-url origin") return "https://github.com/example/repo.git";
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        if (key === "config --get-all remote.origin.fetch") return "+refs/heads/*:refs/remotes/origin/*\n";
        return "";
      });

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      await service.initialize();

      expect(gitMock.raw).toHaveBeenCalledWith([
        "config",
        "--replace-all",
        "remote.origin.fetch",
        "+refs/heads/main:refs/remotes/origin/main",
      ]);
      expect(gitMock.raw).not.toHaveBeenCalledWith(["remote", "set-branches", "origin", "*"]);
      expect(service.isInitialized()).toBe(true);
    });

    it("replaces custom fetch refspecs with the tracked clone-mode branch", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git", "src"]);
      (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
      (fs.stat as unknown as Mock).mockResolvedValue({ isDirectory: () => true, isFile: () => false } as never);
      (fs.access as unknown as Mock).mockResolvedValue(undefined);
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "remote get-url origin") return "https://github.com/example/repo.git";
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        if (key === "config --get-all remote.origin.fetch") {
          return ["+refs/heads/main:refs/remotes/origin/main", "+refs/pull/*/head:refs/remotes/origin/pr/*"].join("\n");
        }
        return "";
      });

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      await service.initialize();

      expect(gitMock.raw).toHaveBeenCalledWith([
        "config",
        "--replace-all",
        "remote.origin.fetch",
        "+refs/heads/main:refs/remotes/origin/main",
      ]);
      expect(service.isInitialized()).toBe(true);
    });

    it("soft-skips and records branch_mismatch when existing clone is on a different branch", async () => {
      const progressEvents: Array<{ phase: string; message: string }> = [];
      const skips: CloneSkipReason[] = [];
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git"]);
      (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
      (fs.stat as unknown as Mock).mockResolvedValue({ isDirectory: () => true, isFile: () => false } as never);
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "rev-parse --abbrev-ref HEAD") return "develop";
        if (key === "remote get-url origin") return "https://github.com/example/repo.git";
        return "";
      });

      const warnSpy = vi.spyOn(logger, "warn");
      const service = new CloneSyncService(makeConfig({ branch: "main" }), buildGitService(), logger, {
        progressEmitter: (event) => progressEvents.push(event),
        onSkip: (reason) => skips.push(reason),
      });

      await expect(service.initialize()).resolves.toBeUndefined();

      expect(service.isInitialized()).toBe(true);
      expect(gitMock.clone).not.toHaveBeenCalled();
      expect(gitMock.raw).not.toHaveBeenCalledWith(["remote", "set-branches", "origin", "*"]);
      expect(skips).toEqual([
        { kind: "branch_mismatch", phase: "init", currentBranch: "develop", expectedBranch: "main" },
      ]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("is on branch 'develop', expected 'main'"));
      expect(progressEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "skip",
            message: expect.stringContaining("current branch 'develop' is not 'main'"),
          }),
        ]),
      );
      expect(progressEvents).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("validated") })]),
      );
    });

    it("records a wrong-branch skip exactly once across init + runSyncAttempt (#1)", async () => {
      const skips: CloneSkipReason[] = [];
      (fs.readdir as unknown as Mock).mockResolvedValue([".git"]);
      (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "rev-parse --abbrev-ref HEAD") return "develop";
        if (key === "remote get-url origin") return "https://github.com/example/repo.git";
        return "";
      });
      const service = new CloneSyncService(makeConfig({ branch: "main" }), buildGitService(), logger, {
        onSkip: (reason) => skips.push(reason),
      });
      const outcome = new SyncOutcomeAccumulator({ mode: "clone", repoName: "demo" });

      // init records the skip; the immediately following runSyncAttempt (same
      // sync operation) must NOT record it again — neither in the skip stream
      // nor in counts.skipped.
      await service.initialize(outcome);
      await service.runSyncAttempt(outcome);

      expect(skips).toEqual([
        { kind: "branch_mismatch", phase: "init", currentBranch: "develop", expectedBranch: "main" },
      ]);
      expect(outcome.toOutcome().counts.skipped).toBe(1);
      expect(gitMock.fetch).not.toHaveBeenCalled();
    });

    it("soft-skips with origin_mismatch when an existing clone's origin differs from repoUrl (#2)", async () => {
      const skips: CloneSkipReason[] = [];
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git"]);
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        if (key === "remote get-url origin") return "https://github.com/example/other.git";
        return "";
      });
      const service = new CloneSyncService(makeConfig({ branch: "main" }), buildGitService(), logger, {
        onSkip: (reason) => skips.push(reason),
      });

      await service.initialize();

      expect(skips).toEqual([
        {
          kind: "origin_mismatch",
          actual: "https://github.com/example/other.git",
          expected: "https://github.com/example/repo.git",
        },
      ]);
      expect(gitMock.clone).not.toHaveBeenCalled();
    });

    it("does not flag origin_mismatch for .git/trailing-slash-equivalent origin URLs (#2)", async () => {
      const skips: CloneSkipReason[] = [];
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git"]);
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        // config repoUrl is "...repo.git"; on-disk origin lacks the .git suffix.
        if (key === "remote get-url origin") return "https://github.com/example/repo";
        return "";
      });
      const service = new CloneSyncService(makeConfig({ branch: "main" }), buildGitService(), logger, {
        onSkip: (reason) => skips.push(reason),
      });

      await service.initialize();

      expect(skips).toEqual([]);
      expect(service.isInitialized()).toBe(true);
    });

    it("soft-skips and records head_unreadable when HEAD read fails on existing clone", async () => {
      const skips: CloneSkipReason[] = [];
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git"]);
      (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
      (fs.stat as unknown as Mock).mockResolvedValue({ isDirectory: () => true, isFile: () => false } as never);
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "rev-parse --abbrev-ref HEAD") throw new Error("fatal: not a git repository");
        if (key === "remote get-url origin") return "https://github.com/example/repo.git";
        return "";
      });

      const service = new CloneSyncService(makeConfig({ branch: "main" }), buildGitService(), logger, {
        onSkip: (reason) => skips.push(reason),
      });

      await expect(service.initialize()).resolves.toBeUndefined();

      expect(service.isInitialized()).toBe(true);
      expect(skips).toEqual([
        expect.objectContaining({
          kind: "head_unreadable",
          phase: "init",
          error: expect.stringContaining("not a git repository"),
        }),
      ]);
    });

    it("refuses to clone into a non-empty directory it didn't create", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce(["random-file.txt"]);
      (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
      (fs.stat as unknown as Mock).mockRejectedValue(new Error("ENOENT"));

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      await expect(service.initialize()).rejects.toThrow(/exists and is not empty/);
    });

    it("does not fire onBranchCreated hooks on the initial clone", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([]);
      (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
      (fs.access as unknown as Mock).mockRejectedValue(new Error("ENOENT"));
      (fs.writeFile as unknown as Mock).mockResolvedValue(undefined);

      const branchCreatedActions = new BranchCreatedActionsService();
      const copyFilesSpy = vi.spyOn(branchCreatedActions, "copyFiles").mockResolvedValue();
      const runHooksSpy = vi.spyOn(branchCreatedActions, "runHooks");

      const config = makeConfig({
        filesToCopyOnBranchCreate: ["CLAUDE.md"],
        hooks: { onBranchCreated: ["echo never-run"] },
      });
      const service = new CloneSyncService(config, buildGitService(), logger, {
        branchCreatedActions,
      });

      await service.initialize();

      expect(copyFilesSpy).toHaveBeenCalledTimes(1);
      expect(runHooksSpy).not.toHaveBeenCalled();
    });

    it("skips file copy when the clone-init marker already exists", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([]);
      (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
      (fs.access as unknown as Mock).mockResolvedValue(undefined);
      (fs.writeFile as unknown as Mock).mockResolvedValue(undefined);

      const branchCreatedActions = new BranchCreatedActionsService();
      const copyFilesSpy = vi.spyOn(branchCreatedActions, "copyFiles").mockResolvedValue();

      const service = new CloneSyncService(
        makeConfig({
          filesToCopyOnBranchCreate: ["CLAUDE.md"],
          hooks: { onBranchCreated: ["echo never-run"] },
        }),
        buildGitService(),
        logger,
        { branchCreatedActions },
      );

      await service.initialize();

      expect(copyFilesSpy).not.toHaveBeenCalled();
    });

    it("refuses to proceed when the pre-clone directory probe fails for a non-ENOENT reason (#review)", async () => {
      const eacces = new Error("permission denied") as NodeJS.ErrnoException;
      eacces.code = "EACCES";
      (fs.readdir as unknown as Mock).mockRejectedValueOnce(eacces);

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      // A transient probe failure must never be read as "directory did not
      // exist" — that authorization later lets a failed clone rm -rf a
      // pre-existing directory.
      await expect(service.initialize()).rejects.toBeInstanceOf(GitOperationError);
      expect(gitMock.clone).not.toHaveBeenCalled();
      expect(fs.rm).not.toHaveBeenCalled();
    });

    // A clone that fails AFTER its objects land ("Clone succeeded, but
    // checkout failed") leaves a complete `.git` on the tracked branch next to
    // a half-written tree. Nothing on disk tells that apart from a clone the
    // user made, so it used to be adopted as one and reported `dirty_tree`
    // forever at info level, with the run exiting 0.
    describe("clone that fails after its objects land (#T13)", () => {
      // ENOENT probe, git leaves `.git/HEAD` behind, nothing else exists.
      function mockFailedCheckoutClone(cloneError: Error): void {
        (fs.readdir as unknown as Mock).mockRejectedValueOnce(enoent());
        (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
        (fs.writeFile as unknown as Mock).mockResolvedValue(undefined);
        (fs.rm as unknown as Mock).mockResolvedValue(undefined);
        (fs.access as unknown as Mock).mockImplementation(async (p: unknown) => {
          if (String(p).endsWith(`.git/HEAD`)) return;
          throw enoent();
        });
        gitMock.clone.mockRejectedValueOnce(cloneError);
      }

      function enoent(): NodeJS.ErrnoException {
        return Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }

      const INCOMPLETE_MARKER = "/tmp/clone-demo/.git/.sync-worktrees-clone-incomplete";

      it("marks the directory instead of leaving it adoptable when the checkout cannot be repaired", async () => {
        const cloneError = new Error(
          "Cloning into '/tmp/clone-demo'...\nfatal: a.bin: smudge filter lfs failed\n" +
            "warning: Clone succeeded, but checkout failed.\n",
        );
        mockFailedCheckoutClone(cloneError);
        gitMock.raw.mockImplementation(async (args: string[]) => {
          const key = args.join(" ");
          if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
          if (key === "checkout -f HEAD") throw new Error("fatal: a.bin: smudge filter lfs failed");
          return "";
        });

        const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

        await expect(service.initialize()).rejects.toBe(cloneError);
        // The marker carries the failing line so the next run can quote it.
        expect(fs.writeFile).toHaveBeenCalledWith(
          INCOMPLETE_MARKER,
          expect.stringContaining("fatal: a.bin: smudge filter lfs failed"),
        );
        // A directory holding a fetched `.git` is never deleted, only marked.
        expect(fs.rm).not.toHaveBeenCalledWith("/tmp/clone-demo", expect.anything());
      });

      it("refuses to adopt a marked directory instead of syncing it as a user's own clone", async () => {
        // Both initialize() calls below describe the same on-disk state, so
        // this stub is not a `...Once`: a second call falling through to the
        // automock would prove nothing about the refusal.
        (fs.readdir as unknown as Mock).mockResolvedValue([".git", "README"]);
        (fs.readFile as unknown as Mock).mockImplementation(async (p: unknown) => {
          if (String(p) === INCOMPLETE_MARKER) {
            return "2026-01-01T00:00:00.000Z\nfatal: a.bin: smudge filter lfs failed\nfull git output\n";
          }
          throw enoent();
        });

        const skips: CloneSkipReason[] = [];
        const service = new CloneSyncService(makeConfig(), buildGitService(), logger, {
          onSkip: (reason) => skips.push(reason),
        });

        await expect(service.initialize()).rejects.toThrow(
          /previous clone of '\/tmp\/clone-demo' did not complete \(fatal: a\.bin: smudge filter lfs failed\)/,
        );
        await expect(service.initialize()).rejects.toBeInstanceOf(GitOperationError);
        // Loud, not a soft skip: no dirty_tree, no branch_mismatch, and the
        // run must not report the repo as merely skipped.
        expect(skips).toEqual([]);
        expect(service.isInitialized()).toBe(false);
        // Nothing was written to the refused directory.
        expect(gitMock.raw).not.toHaveBeenCalledWith(
          expect.arrayContaining(["config", "--replace-all", "remote.origin.fetch"]),
        );
      });

      it("retries the checkout with LFS smudging disabled and finishes the init", async () => {
        mockFailedCheckoutClone(new Error("fatal: a.bin: smudge filter lfs failed"));
        const gitService = buildGitService();
        const branchCreatedActions = new BranchCreatedActionsService();
        const copyFilesSpy = vi.spyOn(branchCreatedActions, "copyFiles").mockResolvedValue();

        const service = new CloneSyncService(
          makeConfig({ filesToCopyOnBranchCreate: ["CLAUDE.md"] }),
          gitService,
          logger,
          { branchCreatedActions },
        );

        await expect(service.initialize()).resolves.toBeUndefined();

        expect(gitMock.raw).toHaveBeenCalledWith(["checkout", "-f", "HEAD"]);
        expect(gitMock.env).toHaveBeenCalledWith(expect.objectContaining({ GIT_LFS_SKIP_SMUDGE: "1" }));
        // The marker is written before the retry (a kill mid-retry must still
        // leave the directory unadoptable) and removed once it succeeds.
        expect(fs.writeFile).toHaveBeenCalledWith(INCOMPLETE_MARKER, expect.any(String));
        expect(fs.rm).toHaveBeenCalledWith(INCOMPLETE_MARKER, { force: true });
        // The post-clone steps a silently adopted clone never got.
        expect(gitService.verifyLfs).toHaveBeenCalledWith("/tmp/clone-demo", "main");
        expect(copyFilesSpy).toHaveBeenCalledTimes(1);
        expect(service.isInitialized()).toBe(true);
      });

      it("applies sparse-checkout with LFS smudging disabled after a recovered clone", async () => {
        mockFailedCheckoutClone(new Error("fatal: a.bin: smudge filter lfs failed"));
        const gitService = buildGitService();

        const service = new CloneSyncService(makeConfig({ sparseCheckout: { include: ["src"] } }), gitService, logger);

        await expect(service.initialize()).resolves.toBeUndefined();

        // `sparse-checkout set` materializes everything the cone brings in, so
        // it runs the smudge filter too: handed the default client it would
        // die on the objects the retry just skipped, one statement before the
        // trailing checkout, and leave a half-narrowed tree behind.
        const sparseService = gitService.getSparseCheckoutService();
        const call = (sparseService.applyToWorktree as Mock).mock.calls.at(-1);
        expect(call?.[0]).toBe("/tmp/clone-demo");
        expect(call?.[1]).toEqual({ include: ["src"] });
        // A client must be handed over, and it must be one built with smudging
        // off: `expect.anything()` alone would pass for the default client,
        // which is the bug this test exists for.
        expect(call?.[2]).toBeDefined();
        expect(gitMock.env).toHaveBeenCalledWith(expect.objectContaining({ GIT_LFS_SKIP_SMUDGE: "1" }));
      });

      // The marker is the only thing that tells a clone of ours that never
      // finished from a clone the user made, so "cannot read it" must never
      // resolve to "there is no marker" — that is the adoption this guard
      // exists to prevent.
      it("fails closed when the marker cannot be read rather than adopting the clone", async () => {
        (fs.readdir as unknown as Mock).mockResolvedValue([".git", "README"]);
        (fs.readFile as unknown as Mock).mockImplementation(async (p: unknown) => {
          if (String(p) === INCOMPLETE_MARKER) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          throw enoent();
        });

        const skips: CloneSkipReason[] = [];
        const service = new CloneSyncService(makeConfig(), buildGitService(), logger, {
          onSkip: (reason) => skips.push(reason),
        });

        await expect(service.initialize()).rejects.toThrow(/could not be read \(permission denied\)/);
        expect(skips).toEqual([]);
        expect(service.isInitialized()).toBe(false);
      });

      // The other half of the same rule: maybeCleanupPartialClone's rm -rf arm
      // is live for a directory this init created, so a HEAD probe that merely
      // failed must not be read as "nothing was fetched here".
      it("marks rather than deletes when the '.git/HEAD' probe itself fails", async () => {
        const cloneError = new Error("fatal: a.bin: smudge filter lfs failed");
        mockFailedCheckoutClone(cloneError);
        (fs.access as unknown as Mock).mockImplementation(async (p: unknown) => {
          if (String(p).endsWith(`.git/HEAD`)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          throw enoent();
        });

        const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

        await expect(service.initialize()).rejects.toBe(cloneError);
        expect(fs.rm).not.toHaveBeenCalledWith("/tmp/clone-demo", expect.anything());
        expect(fs.writeFile).toHaveBeenCalledWith(INCOMPLETE_MARKER, expect.any(String));
        // Nothing may be checked out into a directory we cannot even probe.
        expect(gitMock.raw).not.toHaveBeenCalledWith(["checkout", "-f", "HEAD"]);
      });

      it("does not retry the checkout when the failure is not an LFS error", async () => {
        const cloneError = new Error("fatal: unable to write file README: No space left on device");
        mockFailedCheckoutClone(cloneError);

        const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

        await expect(service.initialize()).rejects.toBe(cloneError);
        expect(gitMock.raw).not.toHaveBeenCalledWith(["checkout", "-f", "HEAD"]);
        expect(fs.writeFile).toHaveBeenCalledWith(
          INCOMPLETE_MARKER,
          expect.stringContaining("No space left on device"),
        );
      });
    });

    it("completes an interrupted init's pending file copy when adopting the existing clone (#review)", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git", "src"]);
      (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
      (fs.writeFile as unknown as Mock).mockResolvedValue(undefined);
      (fs.rm as unknown as Mock).mockResolvedValue(undefined);
      // Pending marker present (init was interrupted after the clone), final
      // marker absent (the copy never ran).
      (fs.access as unknown as Mock).mockImplementation(async (p: unknown) => {
        if (String(p).endsWith(".pending")) return;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const branchCreatedActions = new BranchCreatedActionsService();
      const copyFilesSpy = vi.spyOn(branchCreatedActions, "copyFiles").mockResolvedValue();

      const service = new CloneSyncService(
        makeConfig({ filesToCopyOnBranchCreate: ["CLAUDE.md"] }),
        buildGitService(),
        logger,
        { branchCreatedActions },
      );

      await service.initialize();

      expect(copyFilesSpy).toHaveBeenCalledTimes(1);
      expect(fs.rm).toHaveBeenCalledWith(expect.stringContaining(".pending"), { force: true });
    });

    it("re-runs sparse-checkout setup when resuming an interrupted init (#review)", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git", "src"]);
      (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
      (fs.writeFile as unknown as Mock).mockResolvedValue(undefined);
      (fs.rm as unknown as Mock).mockResolvedValue(undefined);
      (fs.access as unknown as Mock).mockImplementation(async (p: unknown) => {
        if (String(p).endsWith(".pending")) return;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const branchCreatedActions = new BranchCreatedActionsService();
      const copyFilesSpy = vi.spyOn(branchCreatedActions, "copyFiles").mockResolvedValue();
      const gitService = buildGitService();

      const service = new CloneSyncService(
        makeConfig({
          filesToCopyOnBranchCreate: ["CLAUDE.md"],
          sparseCheckout: { include: ["src"] },
        }),
        gitService,
        logger,
        { branchCreatedActions },
      );

      await service.initialize();

      // The init that wrote the pending marker may have died inside sparse
      // setup, so resume must reapply it (idempotent) before the file copy.
      const sparseService = gitService.getSparseCheckoutService();
      expect(sparseService.applyToWorktree).toHaveBeenCalledTimes(1);
      expect(copyFilesSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("getWorktrees", () => {
    it("returns the direct clone checkout when it exists", async () => {
      (fs.access as unknown as Mock).mockResolvedValue(undefined);
      gitMock.raw.mockImplementation(async (args: string[]) => {
        if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return "main";
        return "";
      });

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      await expect(service.getWorktrees()).resolves.toEqual([{ path: "/tmp/clone-demo", branch: "main" }]);
    });

    it("returns an empty list before the clone directory exists", async () => {
      (fs.access as unknown as Mock).mockRejectedValue(new Error("ENOENT"));

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      await expect(service.getWorktrees()).resolves.toEqual([]);
      expect(simpleGit).not.toHaveBeenCalled();
    });
  });

  describe("getRemoteBranches", () => {
    it("discovers remote branch names through ls-remote without requiring local origin refs", async () => {
      (fs.access as unknown as Mock).mockResolvedValue(undefined);
      gitMock.raw.mockImplementation(async (args: string[]) => {
        if (args.join(" ") === "ls-remote --heads origin") {
          return [
            "1111111111111111111111111111111111111111\trefs/heads/main",
            "2222222222222222222222222222222222222222\trefs/heads/feature/nested",
          ].join("\n");
        }
        return "";
      });

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      await expect(service.getRemoteBranches()).resolves.toEqual(["main", "feature/nested"]);
    });
  });

  describe("checkoutBranch", () => {
    it("rejects checkout to a branch other than the configured one", async () => {
      const service = new CloneSyncService(makeConfig({ branch: "main" }), buildGitService(), logger);
      (service as unknown as { initialized: boolean }).initialized = true;

      await expect(service.checkoutBranch("feature/new")).rejects.toMatchObject({
        constructor: ConfigError,
        code: "CONFIG_CLONE_BRANCH_MISMATCH",
        message: expect.stringContaining("clone mode tracks the configured branch 'main'"),
      });

      expect(gitMock.fetch).not.toHaveBeenCalled();
      expect(gitMock.raw).not.toHaveBeenCalledWith(["switch", "-c", "feature/new", "--track", "origin/feature/new"]);
      expect(gitMock.raw).not.toHaveBeenCalledWith(["switch", "feature/new"]);
    });

    it("rejects checkout away from the remote default branch when no branch is configured", async () => {
      const service = new CloneSyncService(makeConfig({ branch: undefined }), buildGitService(), logger);
      (service as unknown as { initialized: boolean }).initialized = true;

      await expect(service.checkoutBranch("feature/new")).rejects.toMatchObject({
        constructor: ConfigError,
        code: "CONFIG_CLONE_BRANCH_MISMATCH",
        message: expect.stringContaining(
          "no 'branch' is configured, so this clone tracks the remote default branch 'main'",
        ),
      });

      expect(gitMock.fetch).not.toHaveBeenCalled();
    });

    it("refuses to switch branches from a detached HEAD before any fetch", async () => {
      const service = new CloneSyncService(makeConfig({ branch: "feature/new" }), buildGitService(), logger);
      (service as unknown as { initialized: boolean }).initialized = true;
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "remote get-url origin") return "https://github.com/example/repo.git";
        if (key === "rev-parse --abbrev-ref HEAD") return "HEAD";
        return "";
      });

      await expect(service.checkoutBranch("feature/new")).rejects.toMatchObject({
        constructor: GitOperationError,
        message: expect.stringContaining("detached HEAD"),
      });

      expect(gitMock.fetch).not.toHaveBeenCalled();
      expect(gitMock.raw).not.toHaveBeenCalledWith(["switch", "feature/new"]);
      expect(gitMock.raw).not.toHaveBeenCalledWith(["switch", "-c", "feature/new", "--track", "origin/feature/new"]);
    });

    it("allows intentional drift with allowConfigDrift and warns to update the config", async () => {
      // The TUI branch wizard creates+pushes a new branch and then switches to
      // it — that drift is deliberate, but config.branch is now stale, so the
      // user must be told or every sync after a restart soft-skips silently.
      const warnSpy = vi.spyOn(logger, "warn");
      const service = new CloneSyncService(makeConfig({ branch: "main" }), buildGitService(), logger);
      (service as unknown as { initialized: boolean }).initialized = true;
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "remote get-url origin") return "https://github.com/example/repo.git";
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        if (key === "rev-parse --is-shallow-repository") return "false";
        if (key === "show-ref --verify refs/heads/feature/new") throw new Error("missing local branch");
        return "";
      });

      await service.checkoutBranch("feature/new", { allowConfigDrift: true });

      expect(gitMock.raw).toHaveBeenCalledWith(["switch", "-c", "feature/new", "--track", "origin/feature/new"]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`Set branch: "feature/new" in the config file`));
    });

    it("does not fetch from a clone whose origin mismatches config during initialization", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git"]);
      const service = new CloneSyncService(makeConfig({ branch: "feature/new" }), buildGitService(), logger);
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "remote get-url origin") return "https://github.com/example/other.git";
        return "";
      });

      await expect(service.checkoutBranch("feature/new")).rejects.toMatchObject({
        constructor: ConfigError,
        code: "CONFIG_ORIGIN_MISMATCH",
        message: expect.stringContaining(
          "origin 'https://github.com/example/other.git' is not 'https://github.com/example/repo.git'",
        ),
      });

      expect(service.isInitialized()).toBe(true);
      expect(gitMock.fetch).not.toHaveBeenCalled();
      expect(gitMock.raw).not.toHaveBeenCalledWith(["switch", "-c", "feature/new", "--track", "origin/feature/new"]);
      expect(gitMock.raw).not.toHaveBeenCalledWith(["switch", "feature/new"]);
    });

    it("fetches only the requested branch and creates a safe tracking branch", async () => {
      const service = new CloneSyncService(makeConfig({ depth: 1, branch: "feature/new" }), buildGitService(), logger);
      (service as unknown as { initialized: boolean }).initialized = true;
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "remote get-url origin") return "https://github.com/example/repo.git";
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        if (key === "rev-parse --is-shallow-repository") return "true";
        if (key === "show-ref --verify refs/heads/feature/new") throw new Error("missing local branch");
        if (key === "for-each-ref --format=%(refname) refs/remotes/origin") {
          return [
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
            "refs/remotes/origin/feature/new",
            "refs/remotes/origin/old",
          ].join("\n");
        }
        return "";
      });

      await service.checkoutBranch("feature/new");

      expect(gitMock.fetch).toHaveBeenCalledWith([
        "origin",
        "--prune",
        "--no-tags",
        "--progress",
        "--depth",
        "1",
        "+refs/heads/feature/new:refs/remotes/origin/feature/new",
      ]);
      expect(gitMock.raw).toHaveBeenCalledWith(["switch", "-c", "feature/new", "--track", "origin/feature/new"]);
      expect(gitMock.raw).toHaveBeenCalledWith([
        "config",
        "--replace-all",
        "remote.origin.fetch",
        "+refs/heads/feature/new:refs/remotes/origin/feature/new",
      ]);
      expect(gitMock.raw).toHaveBeenCalledWith(["update-ref", "-d", "refs/remotes/origin/main"]);
      expect(gitMock.raw).toHaveBeenCalledWith(["update-ref", "-d", "refs/remotes/origin/old"]);
      expect(gitMock.raw).not.toHaveBeenCalledWith(["update-ref", "-d", "refs/remotes/origin/HEAD"]);
      expect(gitMock.raw).not.toHaveBeenCalledWith(["update-ref", "-d", "refs/remotes/origin/feature/new"]);
    });

    it("does not switch to an existing local branch that cannot fast-forward to origin", async () => {
      const service = new CloneSyncService(makeConfig({ branch: "feature/existing" }), buildGitService(), logger);
      (service as unknown as { initialized: boolean }).initialized = true;
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "remote get-url origin") return "https://github.com/example/repo.git";
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        if (key === "rev-parse --is-shallow-repository") return "false";
        if (key === "show-ref --verify refs/heads/feature/existing") return "";
        if (key === "rev-parse refs/heads/feature/existing") return "1111111";
        if (key === "rev-parse refs/remotes/origin/feature/existing") return "2222222";
        if (key === "merge-base refs/heads/feature/existing refs/remotes/origin/feature/existing") return "3333333";
        return "";
      });

      await expect(service.checkoutBranch("feature/existing")).rejects.toMatchObject({
        constructor: FastForwardError,
        branchName: "feature/existing",
      });

      expect(gitMock.raw).not.toHaveBeenCalledWith(["switch", "feature/existing"]);
      expect(gitMock.merge).not.toHaveBeenCalled();
    });

    it("restores the previous branch when merge fails after switching to an existing local branch", async () => {
      const service = new CloneSyncService(makeConfig({ branch: "feature/existing" }), buildGitService(), logger);
      (service as unknown as { initialized: boolean }).initialized = true;
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "remote get-url origin") return "https://github.com/example/repo.git";
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        if (key === "rev-parse --is-shallow-repository") return "false";
        if (key === "show-ref --verify refs/heads/feature/existing") return "";
        if (key === "rev-parse refs/heads/feature/existing") return "1111111";
        if (key === "rev-parse refs/remotes/origin/feature/existing") return "2222222";
        if (key === "merge-base refs/heads/feature/existing refs/remotes/origin/feature/existing") return "1111111";
        return "";
      });
      gitMock.merge.mockRejectedValueOnce(new Error("Not possible to fast-forward"));

      await expect(service.checkoutBranch("feature/existing")).rejects.toThrow("Not possible to fast-forward");

      expect(gitMock.raw).toHaveBeenCalledWith(["switch", "feature/existing"]);
      expect(gitMock.raw).toHaveBeenCalledWith(["switch", "main"]);
      expect(gitMock.raw).not.toHaveBeenCalledWith([
        "config",
        "--replace-all",
        "remote.origin.fetch",
        "+refs/heads/feature/existing:refs/remotes/origin/feature/existing",
      ]);
    });

    it("throws WorktreeNotCleanError without fetching when the working tree is dirty", async () => {
      const service = new CloneSyncService(
        makeConfig({ branch: "feature/new" }),
        buildGitService({ checkWorktreeStatus: vi.fn().mockResolvedValue(false) }),
        logger,
      );
      (service as unknown as { initialized: boolean }).initialized = true;

      await expect(service.checkoutBranch("feature/new")).rejects.toMatchObject({
        constructor: WorktreeNotCleanError,
        reasons: ["working tree has local changes"],
      });

      expect(gitMock.fetch).not.toHaveBeenCalled();
    });

    it("throws GitOperationError when origin no longer has the requested branch without recording a skip", async () => {
      const onSkip = vi.fn();
      const service = new CloneSyncService(makeConfig({ branch: "feature/new" }), buildGitService(), logger, {
        onSkip,
      });
      (service as unknown as { initialized: boolean }).initialized = true;
      gitMock.fetch.mockRejectedValueOnce(new Error("fatal: couldn't find remote ref refs/heads/feature/new"));

      await expect(service.checkoutBranch("feature/new")).rejects.toMatchObject({
        constructor: GitOperationError,
        message: expect.stringContaining("origin/feature/new is missing"),
      });

      // checkout reports the hard error itself; recording a missing_remote_ref
      // skip on top would double-report a user-initiated action as a sync skip
      expect(onSkip).not.toHaveBeenCalled();
      expect(gitMock.raw).not.toHaveBeenCalledWith(["switch", "-c", "feature/new", "--track", "origin/feature/new"]);
    });

    it("throws GitOperationError when the remote ref does not materialize after a successful fetch", async () => {
      const service = new CloneSyncService(makeConfig({ branch: "feature/new" }), buildGitService(), logger);
      (service as unknown as { initialized: boolean }).initialized = true;
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "remote get-url origin") return "https://github.com/example/repo.git";
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        if (key === "show-ref --verify refs/remotes/origin/feature/new") throw new Error("missing remote ref");
        return "";
      });

      await expect(service.checkoutBranch("feature/new")).rejects.toMatchObject({
        constructor: GitOperationError,
        message: expect.stringContaining("did not materialize after fetch"),
      });

      expect(gitMock.raw).not.toHaveBeenCalledWith(["switch", "-c", "feature/new", "--track", "origin/feature/new"]);
    });

    it("unshallows a shallow clone before the branch fetch when no depth is configured", async () => {
      const service = new CloneSyncService(makeConfig({ branch: "feature/new" }), buildGitService(), logger);
      (service as unknown as { initialized: boolean }).initialized = true;
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "remote get-url origin") return "https://github.com/example/repo.git";
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        if (key === "rev-parse --is-shallow-repository") return "true";
        if (key === "show-ref --verify refs/heads/feature/new") throw new Error("missing local branch");
        return "";
      });

      await service.checkoutBranch("feature/new");

      expect(gitMock.fetch).toHaveBeenNthCalledWith(1, ["--unshallow", "--no-tags"]);
      expect(gitMock.fetch).toHaveBeenNthCalledWith(2, [
        "origin",
        "--prune",
        "--no-tags",
        "--progress",
        "+refs/heads/feature/new:refs/remotes/origin/feature/new",
      ]);
    });
  });

  describe("runSyncAttempt", () => {
    function setInitialized(service: CloneSyncService): void {
      (service as unknown as { initialized: boolean }).initialized = true;
      (service as unknown as { resolvedBranch: string }).resolvedBranch = "main";
    }

    it("warns and skips when on wrong branch", async () => {
      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);
      setInitialized(service);

      gitMock.raw.mockImplementation(async (args: string[]) =>
        args.join(" ") === "rev-parse --abbrev-ref HEAD" ? "feature-x" : "",
      );

      await service.runSyncAttempt();

      expect(gitMock.fetch).not.toHaveBeenCalled();
      expect(gitMock.merge).not.toHaveBeenCalled();
    });

    it("logs 'tracked branch missing' when upstream ref is gone", async () => {
      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);
      setInitialized(service);

      gitMock.fetch.mockRejectedValueOnce(new Error("fatal: couldn't find remote ref refs/heads/main"));

      await service.runSyncAttempt();

      expect(gitMock.merge).not.toHaveBeenCalled();
    });

    it("skips ff-merge when working tree is dirty", async () => {
      const progressEvents: Array<{ phase: string; message: string }> = [];
      const gitService = buildGitService({
        checkWorktreeStatus: vi.fn().mockResolvedValue(false),
      });
      const service = new CloneSyncService(makeConfig(), gitService, logger, {
        progressEmitter: (event) => progressEvents.push(event),
      });
      setInitialized(service);

      await service.runSyncAttempt();

      expect(gitMock.fetch).toHaveBeenCalled();
      expect(gitMock.merge).not.toHaveBeenCalled();
      expect(progressEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "fetch",
            message: "Fetching origin/main for 'https://github.com/example/repo.git'",
          }),
          expect.objectContaining({
            phase: "skip",
            message: "Skipping merge for 'https://github.com/example/repo.git': working tree has local changes",
          }),
        ]),
      );
    });

    it("unshallows before normal fetch when depth was removed from config", async () => {
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        if (key === "rev-parse --is-shallow-repository") return "true\n";
        return "";
      });
      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);
      setInitialized(service);

      await service.runSyncAttempt();

      expect(gitMock.fetch).toHaveBeenNthCalledWith(1, ["--unshallow", "--no-tags"]);
      expect(gitMock.fetch).toHaveBeenNthCalledWith(2, [
        "origin",
        "--prune",
        "--no-tags",
        "--progress",
        "+refs/heads/main:refs/remotes/origin/main",
      ]);
    });

    it("soft-skips with missing_remote_ref when the unshallow fetch hits a deleted tracked branch (#review)", async () => {
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        if (key === "rev-parse --is-shallow-repository") return "true\n";
        if (key.startsWith("remote get-url origin")) return "https://github.com/example/repo.git";
        return "";
      });
      gitMock.fetch.mockRejectedValueOnce(new Error("fatal: couldn't find remote ref refs/heads/main"));
      const skips: CloneSkipReason[] = [];
      const service = new CloneSyncService(makeConfig(), buildGitService(), logger, {
        onSkip: (reason) => skips.push(reason),
      });
      setInitialized(service);

      // The unshallow fetch uses the narrowed refspec, so a deleted tracked
      // branch must become the same soft skip as the branch fetch — not a
      // hard sync failure unique to shallow clones.
      await expect(service.runSyncAttempt()).resolves.toBeUndefined();

      expect(skips).toEqual([{ kind: "missing_remote_ref", branch: "main", source: "fetch_error" }]);
      expect(gitMock.fetch).toHaveBeenCalledTimes(1);
      expect(gitMock.merge).not.toHaveBeenCalled();
    });

    it("does not unshallow when depth is configured", async () => {
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        if (key === "rev-parse --is-shallow-repository") return "true";
        return "";
      });
      const service = new CloneSyncService(makeConfig({ depth: 1 }), buildGitService(), logger);
      setInitialized(service);

      await service.runSyncAttempt();

      expect(gitMock.fetch).toHaveBeenCalledTimes(1);
      expect(gitMock.fetch).toHaveBeenCalledWith([
        "origin",
        "--prune",
        "--no-tags",
        "--progress",
        "--depth",
        "1",
        "+refs/heads/main:refs/remotes/origin/main",
      ]);
    });

    it("does not make a full existing clone shallow when depth is configured", async () => {
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        if (key === "rev-parse --is-shallow-repository") return "false";
        return "";
      });
      const service = new CloneSyncService(makeConfig({ depth: 1 }), buildGitService(), logger);
      setInitialized(service);

      await service.runSyncAttempt();

      expect(gitMock.fetch).toHaveBeenCalledTimes(1);
      expect(gitMock.fetch).toHaveBeenCalledWith([
        "origin",
        "--prune",
        "--no-tags",
        "--progress",
        "+refs/heads/main:refs/remotes/origin/main",
      ]);
    });

    it("does not unshallow full repositories without configured depth", async () => {
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        if (key === "rev-parse --is-shallow-repository") return "false\n";
        return "";
      });
      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);
      setInitialized(service);

      await service.runSyncAttempt();

      expect(gitMock.fetch).toHaveBeenCalledTimes(1);
      expect(gitMock.fetch).toHaveBeenCalledWith([
        "origin",
        "--prune",
        "--no-tags",
        "--progress",
        "+refs/heads/main:refs/remotes/origin/main",
      ]);
    });

    it("does not reset on diverged history", async () => {
      const gitService = buildGitService({
        classifyRemoteRelationship: vi.fn().mockResolvedValue("diverged"),
      });
      const service = new CloneSyncService(makeConfig(), gitService, logger);
      setInitialized(service);

      await service.runSyncAttempt();

      expect(gitMock.merge).not.toHaveBeenCalled();
    });

    it("deepens a shallow configured clone before classifying as fast-forward", async () => {
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        if (key === "rev-parse --is-shallow-repository") return "true";
        return "";
      });
      const classify = vi.fn().mockResolvedValueOnce("indeterminate_shallow").mockResolvedValueOnce("fast_forward");
      const gitService = buildGitService({ classifyRemoteRelationship: classify });
      const service = new CloneSyncService(makeConfig({ depth: 1 }), gitService, logger);
      setInitialized(service);

      await service.runSyncAttempt();

      expect(gitMock.fetch).toHaveBeenNthCalledWith(1, [
        "origin",
        "--prune",
        "--no-tags",
        "--progress",
        "--depth",
        "1",
        "+refs/heads/main:refs/remotes/origin/main",
      ]);
      expect(gitMock.fetch).toHaveBeenNthCalledWith(2, [
        "origin",
        "--depth",
        "50",
        "--prune",
        "--no-tags",
        "--progress",
        "+refs/heads/main:refs/remotes/origin/main",
      ]);
      expect(classify).toHaveBeenCalledTimes(2);
      expect(gitMock.merge).toHaveBeenCalledWith(["origin/main", "--ff-only"]);
    });

    it("walks 50 -> 200 -> 1000 depth targets before giving up on a shallow indeterminate clone", async () => {
      const classify = vi.fn().mockResolvedValue("indeterminate_shallow");
      const skips: CloneSkipReason[] = [];
      const gitService = buildGitService({ classifyRemoteRelationship: classify });
      const service = new CloneSyncService(makeConfig({ depth: 1 }), gitService, logger, {
        onSkip: (reason) => skips.push(reason),
      });
      setInitialized(service);

      await service.runSyncAttempt();

      const depthArgs = gitMock.fetch.mock.calls
        .map((call) => call[0] as string[])
        .filter((args) => args[1] === "--depth" && args.includes("+refs/heads/main:refs/remotes/origin/main"))
        .map((args) => Number(args[args.indexOf("--depth") + 1]));
      expect(depthArgs).toEqual([50, 200, 1000]);
      expect(classify).toHaveBeenCalledTimes(4);
      expect(gitMock.merge).not.toHaveBeenCalled();
      expect(skips).toEqual([{ kind: "indeterminate_shallow", branch: "main", deepenedTo: 1000 }]);
    });

    it("records deepenedTo:null when configured depth already meets or exceeds every deepen target", async () => {
      const classify = vi.fn().mockResolvedValue("indeterminate_shallow");
      const skips: CloneSkipReason[] = [];
      const gitService = buildGitService({ classifyRemoteRelationship: classify });
      const service = new CloneSyncService(makeConfig({ depth: 1000 }), gitService, logger, {
        onSkip: (reason) => skips.push(reason),
      });
      setInitialized(service);

      await service.runSyncAttempt();

      expect(gitMock.fetch).toHaveBeenCalledTimes(1);
      expect(classify).toHaveBeenCalledTimes(1);
      expect(gitMock.merge).not.toHaveBeenCalled();
      expect(skips).toEqual([{ kind: "indeterminate_shallow", branch: "main", deepenedTo: null }]);
    });

    it("skips deepen targets at or below configured depth", async () => {
      const classify = vi.fn().mockResolvedValueOnce("indeterminate_shallow").mockResolvedValueOnce("fast_forward");
      const gitService = buildGitService({ classifyRemoteRelationship: classify });
      const service = new CloneSyncService(makeConfig({ depth: 500 }), gitService, logger);
      setInitialized(service);

      await service.runSyncAttempt();

      const deepenFetches = gitMock.fetch.mock.calls
        .slice(1)
        .map((call) => call[0] as string[])
        .filter((args) => args.includes("+refs/heads/main:refs/remotes/origin/main"));
      expect(deepenFetches).toHaveLength(1);
      expect(deepenFetches[0]).toEqual([
        "origin",
        "--depth",
        "1000",
        "--prune",
        "--no-tags",
        "--progress",
        "+refs/heads/main:refs/remotes/origin/main",
      ]);
      expect(gitMock.merge).toHaveBeenCalledWith(["origin/main", "--ff-only"]);
    });

    it("records ahead_unpushed when classify returns local_ahead", async () => {
      const skips: CloneSkipReason[] = [];
      const gitService = buildGitService({
        classifyRemoteRelationship: vi.fn().mockResolvedValue("local_ahead"),
      });
      const service = new CloneSyncService(makeConfig(), gitService, logger, {
        onSkip: (reason) => skips.push(reason),
      });
      setInitialized(service);

      await service.runSyncAttempt();

      expect(gitMock.merge).not.toHaveBeenCalled();
      expect(skips).toEqual([{ kind: "ahead_unpushed", branch: "main" }]);
    });

    it("fast-forwards when clean, behind, and ff-able", async () => {
      const progressEvents: Array<{ phase: string; message: string }> = [];
      const service = new CloneSyncService(makeConfig(), buildGitService(), logger, {
        progressEmitter: (event) => progressEvents.push(event),
      });
      setInitialized(service);

      await service.runSyncAttempt();

      expect(gitMock.merge).toHaveBeenCalledWith(["origin/main", "--ff-only"]);
      expect(progressEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "merge",
            message: "Fast-forwarding 'https://github.com/example/repo.git' to origin/main",
          }),
          expect.objectContaining({
            phase: "merge",
            message: "Updated 'https://github.com/example/repo.git' to origin/main",
          }),
        ]),
      );
    });

    it("no-ops when already up to date", async () => {
      const gitService = buildGitService({
        classifyRemoteRelationship: vi.fn().mockResolvedValue("up_to_date"),
      });
      const service = new CloneSyncService(makeConfig(), gitService, logger);
      setInitialized(service);

      await service.runSyncAttempt();

      expect(gitMock.merge).not.toHaveBeenCalled();
    });

    it("reapplies sparse-checkout when needsUpdate returns true", async () => {
      const gitService = buildGitService();
      const config = makeConfig({ sparseCheckout: { include: ["src"] } });
      const service = new CloneSyncService(config, gitService, logger);
      setInitialized(service);

      await service.runSyncAttempt();

      const sparseService = (gitService.getSparseCheckoutService as unknown as Mock).mock.results[0]?.value;
      expect(sparseService.needsUpdate).toHaveBeenCalledWith(config.worktreeDir, config.sparseCheckout);
      expect(sparseService.applyToWorktree).toHaveBeenCalledWith(config.worktreeDir, config.sparseCheckout);
    });

    it("skips sparse-checkout reapply when needsUpdate returns false", async () => {
      const gitService = buildGitService();
      const sparseService = (gitService.getSparseCheckoutService as unknown as Mock)();
      (sparseService.needsUpdate as Mock).mockResolvedValue(false);
      (gitService.getSparseCheckoutService as unknown as Mock).mockReturnValue(sparseService);

      const config = makeConfig({ sparseCheckout: { include: ["src"] } });
      const service = new CloneSyncService(config, gitService, logger);
      setInitialized(service);

      await service.runSyncAttempt();

      expect(sparseService.needsUpdate).toHaveBeenCalledWith(config.worktreeDir, config.sparseCheckout);
      expect(sparseService.applyToWorktree).not.toHaveBeenCalled();
    });
  });

  describe("runSyncAttempt skip reasons", () => {
    function setInitialized(service: CloneSyncService): void {
      (service as unknown as { initialized: boolean }).initialized = true;
      (service as unknown as { resolvedBranch: string }).resolvedBranch = "main";
    }

    function buildServiceWithSkips(gitService: GitService): { service: CloneSyncService; skips: CloneSkipReason[] } {
      const skips: CloneSkipReason[] = [];
      const service = new CloneSyncService(makeConfig(), gitService, logger, {
        onSkip: (reason) => skips.push(reason),
      });
      setInitialized(service);
      return { service, skips };
    }

    it("records branch_mismatch with phase 'sync' when current branch differs", async () => {
      const { service, skips } = buildServiceWithSkips(buildGitService());
      gitMock.raw.mockImplementation(async (args: string[]) =>
        args.join(" ") === "rev-parse --abbrev-ref HEAD" ? "feature-x" : "",
      );

      await service.runSyncAttempt();

      expect(skips).toEqual([
        { kind: "branch_mismatch", phase: "sync", currentBranch: "feature-x", expectedBranch: "main" },
      ]);
      expect(gitMock.fetch).not.toHaveBeenCalled();
    });

    it("records head_unreadable with phase 'sync' when HEAD read fails", async () => {
      const { service, skips } = buildServiceWithSkips(buildGitService());
      gitMock.raw.mockImplementation(async (args: string[]) => {
        if (args.join(" ") === "rev-parse --abbrev-ref HEAD") throw new Error("ref read fail");
        return "";
      });

      await service.runSyncAttempt();

      expect(skips).toEqual([
        expect.objectContaining({
          kind: "head_unreadable",
          phase: "sync",
          error: expect.stringContaining("ref read fail"),
        }),
      ]);
      expect(gitMock.fetch).not.toHaveBeenCalled();
    });

    it("records missing_remote_ref source 'fetch_error' when fetch reports ref missing", async () => {
      const { service, skips } = buildServiceWithSkips(buildGitService());
      gitMock.fetch.mockRejectedValueOnce(new Error("fatal: couldn't find remote ref refs/heads/main"));

      await service.runSyncAttempt();

      expect(skips).toEqual([{ kind: "missing_remote_ref", branch: "main", source: "fetch_error" }]);
    });

    it("soft-skips when the LFS-disabled retry fetch hits a missing remote ref (#7)", async () => {
      const { service, skips } = buildServiceWithSkips(buildGitService());
      gitMock.fetch
        .mockRejectedValueOnce(new Error("smudge filter lfs failed"))
        .mockRejectedValueOnce(new Error("fatal: couldn't find remote ref refs/heads/main"));

      await service.runSyncAttempt();

      expect(skips).toEqual([{ kind: "missing_remote_ref", branch: "main", source: "fetch_error" }]);
      expect(gitMock.fetch).toHaveBeenCalledTimes(2);
      expect(gitMock.merge).not.toHaveBeenCalled();
    });

    it("propagates a non-missing-ref failure from the LFS-disabled retry fetch (#7)", async () => {
      const { service } = buildServiceWithSkips(buildGitService());
      gitMock.fetch
        .mockRejectedValueOnce(new Error("smudge filter lfs failed"))
        .mockRejectedValueOnce(new Error("network is unreachable"));

      await expect(service.runSyncAttempt()).rejects.toThrow("network is unreachable");
    });

    it("forces LC_ALL=C / LANG=C on git clients so error classification stays locale-stable (#4)", async () => {
      const { service } = buildServiceWithSkips(buildGitService());

      await service.runSyncAttempt();

      expect(gitMock.env).toHaveBeenCalledWith(expect.objectContaining({ LC_ALL: "C", LANG: "C" }));
    });

    it("records missing_remote_ref source 'post_fetch_verify' when fetch succeeds but ref is pruned", async () => {
      const { service, skips } = buildServiceWithSkips(buildGitService());
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        if (key.startsWith("show-ref --verify refs/remotes/origin/main")) {
          throw new Error("show-ref: ref not found");
        }
        return "";
      });

      await service.runSyncAttempt();

      expect(skips).toEqual([{ kind: "missing_remote_ref", branch: "main", source: "post_fetch_verify" }]);
      expect(gitMock.merge).not.toHaveBeenCalled();
    });

    it("records dirty_tree when working tree is dirty", async () => {
      const gitService = buildGitService({
        checkWorktreeStatus: vi.fn().mockResolvedValue(false),
      });
      const { service, skips } = buildServiceWithSkips(gitService);

      await service.runSyncAttempt();

      expect(skips).toEqual([{ kind: "dirty_tree" }]);
    });

    it("records ahead_unpushed when local is ahead of origin", async () => {
      const gitService = buildGitService({
        classifyRemoteRelationship: vi.fn().mockResolvedValue("local_ahead"),
      });
      const { service, skips } = buildServiceWithSkips(gitService);

      await service.runSyncAttempt();

      expect(skips).toEqual([{ kind: "ahead_unpushed", branch: "main" }]);
    });

    it("records diverged when local has diverged from origin", async () => {
      const gitService = buildGitService({
        classifyRemoteRelationship: vi.fn().mockResolvedValue("diverged"),
      });
      const { service, skips } = buildServiceWithSkips(gitService);

      await service.runSyncAttempt();

      expect(skips).toEqual([{ kind: "diverged", branch: "main" }]);
    });

    it("does not record a skip when already up to date", async () => {
      const gitService = buildGitService({
        classifyRemoteRelationship: vi.fn().mockResolvedValue("up_to_date"),
      });
      const { service, skips } = buildServiceWithSkips(gitService);

      await service.runSyncAttempt();

      expect(skips).toEqual([]);
    });

    it("does not record a skip when fast-forward succeeds", async () => {
      const { service, skips } = buildServiceWithSkips(buildGitService());

      await service.runSyncAttempt();

      expect(skips).toEqual([]);
      expect(gitMock.merge).toHaveBeenCalledWith(["origin/main", "--ff-only"]);
    });
  });

  describe("branch resolution", () => {
    it("falls back to remote HEAD when branch not configured", async () => {
      const gitService = buildGitService({
        getRemoteDefaultBranch: vi.fn().mockResolvedValue("trunk"),
      });
      const service = new CloneSyncService(makeConfig({ branch: undefined }), gitService, logger);

      const resolved = await service.resolveBranch();

      expect(resolved).toBe("trunk");
      expect(gitService.getRemoteDefaultBranch).toHaveBeenCalledWith("https://github.com/example/repo.git");
    });

    it("uses configured branch verbatim", async () => {
      const gitService = buildGitService();
      const service = new CloneSyncService(makeConfig({ branch: "develop" }), gitService, logger);

      const resolved = await service.resolveBranch();

      expect(resolved).toBe("develop");
      expect(gitService.getRemoteDefaultBranch).not.toHaveBeenCalled();
    });
  });

  describe("credential redaction", () => {
    const TOKEN_URL = "https://ci-bot:s3cr3t-token@github.com/example/repo.git";
    const REDACTED_URL = "https://***@github.com/example/repo.git";
    const OTHER_TOKEN_URL = "https://other-bot:0th3r-token@github.com/example/other.git";

    it("logs the clone with the URL redacted while git receives the working URL", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([]);
      (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
      (fs.access as unknown as Mock).mockRejectedValue(new Error("ENOENT"));
      (fs.writeFile as unknown as Mock).mockResolvedValue(undefined);
      const infoSpy = vi.spyOn(logger, "info");
      const config = makeConfig({ repoUrl: TOKEN_URL });
      const service = new CloneSyncService(config, buildGitService(), logger);

      await service.initialize();

      expect(gitMock.clone).toHaveBeenCalledWith(TOKEN_URL, config.worktreeDir, expect.any(Array));
      expect(infoSpy).toHaveBeenCalledWith(`Cloning '${REDACTED_URL}' (main) into '${config.worktreeDir}'...`);
      expect(JSON.stringify(infoSpy.mock.calls)).not.toContain("s3cr3t-token");
    });

    it("reports an origin mismatch with both URLs redacted in the skip, the warning and the progress event", async () => {
      const skips: CloneSkipReason[] = [];
      const progressEvents: Array<{ phase: string; message: string }> = [];
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git"]);
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        if (key === "remote get-url origin") return OTHER_TOKEN_URL;
        return "";
      });
      const warnSpy = vi.spyOn(logger, "warn");
      const service = new CloneSyncService(makeConfig({ repoUrl: TOKEN_URL }), buildGitService(), logger, {
        onSkip: (reason) => skips.push(reason),
        progressEmitter: (event) => progressEvents.push(event),
      });

      await service.initialize();

      expect(skips).toEqual([
        { kind: "origin_mismatch", actual: "https://***@github.com/example/other.git", expected: REDACTED_URL },
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`has origin 'https://***@github.com/example/other.git', expected '${REDACTED_URL}'`),
      );
      expect(progressEvents).toContainEqual(
        expect.objectContaining({
          phase: "skip",
          message: `Skipping '${REDACTED_URL}': origin 'https://***@github.com/example/other.git' is not '${REDACTED_URL}'`,
        }),
      );
      expect(JSON.stringify([skips, warnSpy.mock.calls, progressEvents])).not.toMatch(/s3cr3t-token|0th3r-token/);
      expect(gitMock.fetch).not.toHaveBeenCalled();
    });
  });

  // A clone-mode worktreeDir the user pointed us at may be a linked worktree
  // (`git worktree add`) or a submodule. Both share the config and refs of the
  // repository that owns their git dir, so narrowing `remote.origin.fetch`,
  // deleting `refs/remotes/origin/*` or fetching with --prune there rewrites
  // THAT repository — on the first sync and every tick after it.
  describe("primary-checkout guard", () => {
    const OWNING_GIT_DIR = "/other/repo/.git";
    const LINKED_GIT_DIRS = `${OWNING_GIT_DIR}/worktrees/app-main\n${OWNING_GIT_DIR}\n`;

    function mockRaw(responder: (key: string) => string | undefined): void {
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = Array.isArray(args) ? args.join(" ") : String(args);
        return responder(key) ?? "";
      });
    }

    function adoptedDirectoryWith(gitDirs: string): (key: string) => string | undefined {
      return (key) => {
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return gitDirs;
        if (key === "remote get-url origin") return "https://github.com/example/repo.git";
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        return "";
      };
    }

    function setInitialized(service: CloneSyncService): void {
      (service as unknown as { initialized: boolean }).initialized = true;
      (service as unknown as { resolvedBranch: string }).resolvedBranch = "main";
    }

    function repositoryWrites(): string[][] {
      return gitMock.raw.mock.calls
        .map((call) => (Array.isArray(call[0]) ? (call[0] as string[]) : []))
        .filter(
          (args) =>
            (args[0] === "config" && args[1] === "--replace-all") ||
            (args[0] === "update-ref" && args[1] === "-d") ||
            args[0] === "switch" ||
            args[0] === "remote",
        )
        .filter((args) => args[0] !== "remote" || args[1] !== "get-url");
    }

    function expectNothingWritten(): void {
      expect(repositoryWrites()).toEqual([]);
      expect(gitMock.fetch).not.toHaveBeenCalled();
      expect(gitMock.merge).not.toHaveBeenCalled();
    }

    it("refuses to adopt a checkout whose git dir belongs to another repository", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git"]);
      mockRaw(adoptedDirectoryWith(LINKED_GIT_DIRS));

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      await expect(service.initialize()).rejects.toMatchObject({
        constructor: ConfigError,
        code: "CONFIG_CLONE_DESTINATION_NOT_PRIMARY_CHECKOUT",
        message: expect.stringContaining(`Its shared git directory is '${OWNING_GIT_DIR}'`),
      });
      expectNothingWritten();
    });

    // A linked worktree whose git dir was relocated has a real `.git`
    // DIRECTORY holding a `commondir` file, so it passes the lstat gate and
    // only the common-dir comparison catches it. Without this case the whole
    // `--git-common-dir` half of the guard is untested.
    it("refuses a real '.git' directory that shares another repository's common dir", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git"]);
      (fs.lstat as unknown as Mock).mockResolvedValue(buildFsStats("directory"));
      mockRaw(adoptedDirectoryWith(`.git\n${OWNING_GIT_DIR}\n`));

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      await expect(service.initialize()).rejects.toMatchObject({
        code: "CONFIG_CLONE_DESTINATION_NOT_PRIMARY_CHECKOUT",
        message: expect.stringContaining(`Its shared git directory is '${OWNING_GIT_DIR}'`),
      });
      expectNothingWritten();
    });

    it("names the gitdir pointer when '.git' is a linked worktree's file", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git"]);
      (fs.lstat as unknown as Mock).mockResolvedValue(buildFsStats("file"));
      // Only '.git' itself reads back: it is a file here, so nothing else in
      // this checkout's git directory can be read at all.
      (fs.readFile as unknown as Mock).mockImplementation(async (p: unknown) => {
        if (String(p) === "/tmp/clone-demo/.git") return `gitdir: ${OWNING_GIT_DIR}/worktrees/app-main\n`;
        throw Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" });
      });
      mockRaw(adoptedDirectoryWith(LINKED_GIT_DIRS));

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      await expect(service.initialize()).rejects.toMatchObject({
        code: "CONFIG_CLONE_DESTINATION_NOT_PRIMARY_CHECKOUT",
        message: expect.stringContaining(`is a gitdir pointer to '${OWNING_GIT_DIR}/worktrees/app-main'`),
      });
      expectNothingWritten();
    });

    // git reports a symlinked `.git` exactly like a primary one, so a link
    // that relocates this repo's own git dir cannot be told apart from one
    // aimed at a git dir another checkout is still using.
    it("refuses a '.git' symlink it cannot prove is unshared", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git"]);
      (fs.lstat as unknown as Mock).mockResolvedValue(buildFsStats("symlink"));
      (fs.realpath as unknown as Mock).mockResolvedValue("/elsewhere/gitdir");
      mockRaw(adoptedDirectoryWith(PRIMARY_CHECKOUT_GIT_DIRS));

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      await expect(service.initialize()).rejects.toMatchObject({
        code: "CONFIG_CLONE_DESTINATION_NOT_PRIMARY_CHECKOUT",
        message: expect.stringContaining("is a symlink to '/elsewhere/gitdir'"),
      });
      expectNothingWritten();
    });

    it("fails closed when the git-dir probe itself fails", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git"]);
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) throw new Error("fatal: not a git repository");
        if (key === "remote get-url origin") return "https://github.com/example/repo.git";
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        return "";
      });

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      await expect(service.initialize()).rejects.toMatchObject({
        code: "CONFIG_CLONE_DESTINATION_NOT_PRIMARY_CHECKOUT",
        message: expect.stringContaining("its git directory could not be read"),
      });
      expectNothingWritten();
    });

    it("fails closed when git reports no git directory at all", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git"]);
      mockRaw(adoptedDirectoryWith(""));

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      await expect(service.initialize()).rejects.toMatchObject({
        code: "CONFIG_CLONE_DESTINATION_NOT_PRIMARY_CHECKOUT",
        message: expect.stringContaining("did not report its git directory"),
      });
      expectNothingWritten();
    });

    it("fails closed when '.git' cannot be stat'ed", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git"]);
      (fs.lstat as unknown as Mock).mockRejectedValue(
        Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
      );
      mockRaw(adoptedDirectoryWith(PRIMARY_CHECKOUT_GIT_DIRS));

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      await expect(service.initialize()).rejects.toMatchObject({
        code: "CONFIG_CLONE_DESTINATION_NOT_PRIMARY_CHECKOUT",
        message: expect.stringContaining("could not be read"),
      });
      expectNothingWritten();
    });

    // The daemon reuses one service across ticks, so a directory that becomes
    // a linked worktree after init must be refused on the next tick too.
    it("re-checks on every sync tick, not only at init", async () => {
      mockRaw(adoptedDirectoryWith(LINKED_GIT_DIRS));
      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);
      setInitialized(service);

      await expect(service.runSyncAttempt()).rejects.toMatchObject({
        code: "CONFIG_CLONE_DESTINATION_NOT_PRIMARY_CHECKOUT",
      });
      expectNothingWritten();
    });

    it("refuses in checkoutBranch before switching or rewriting the remote", async () => {
      mockRaw(adoptedDirectoryWith(LINKED_GIT_DIRS));
      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);
      setInitialized(service);

      await expect(service.checkoutBranch("main")).rejects.toMatchObject({
        code: "CONFIG_CLONE_DESTINATION_NOT_PRIMARY_CHECKOUT",
      });
      expectNothingWritten();
    });

    // Listing is read-only: a linked worktree is still reported, it just can't
    // be written to.
    it("still reports the checkout through getWorktrees", async () => {
      (fs.access as unknown as Mock).mockResolvedValue(undefined);
      mockRaw(adoptedDirectoryWith(LINKED_GIT_DIRS));

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      await expect(service.getWorktrees()).resolves.toEqual([{ path: "/tmp/clone-demo", branch: "main" }]);
      expectNothingWritten();
    });

    it("adopts a primary checkout whose git dir git reports as an absolute path", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git"]);
      mockRaw(adoptedDirectoryWith("/tmp/clone-demo/.git\n/tmp/clone-demo/.git\n"));

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      await service.initialize();

      expect(gitMock.raw).toHaveBeenCalledWith([
        "config",
        "--replace-all",
        "remote.origin.fetch",
        "+refs/heads/main:refs/remotes/origin/main",
      ]);
    });

    // A checkout reached through a symlinked parent (macOS '/tmp' ->
    // '/private/tmp') is the same directory spelled differently, not a
    // different repository.
    it("adopts a primary checkout reported through a symlinked parent path", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git"]);
      (fs.realpath as unknown as Mock).mockResolvedValue("/private/tmp/clone-demo/.git");
      mockRaw(adoptedDirectoryWith("/private/tmp/clone-demo/.git\n/private/tmp/clone-demo/.git\n"));

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      await service.initialize();

      expect(gitMock.raw).toHaveBeenCalledWith([
        "config",
        "--replace-all",
        "remote.origin.fetch",
        "+refs/heads/main:refs/remotes/origin/main",
      ]);
    });
  });
});

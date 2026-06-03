import * as fs from "fs/promises";

import simpleGit from "simple-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    gitMock = buildGitMock();
    (simpleGit as unknown as Mock).mockReturnValue(gitMock);
    logger = Logger.createDefault();
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
    it("fetches only the requested branch and creates a safe tracking branch", async () => {
      const service = new CloneSyncService(makeConfig({ depth: 1 }), buildGitService(), logger);
      (service as unknown as { initialized: boolean }).initialized = true;
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        if (key === "rev-parse --is-shallow-repository") return "true";
        if (key === "show-ref --verify refs/heads/feature/new") throw new Error("missing local branch");
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

    it("does not unshallow when depth is configured", async () => {
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
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
});

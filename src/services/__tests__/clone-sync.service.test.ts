import * as fs from "fs/promises";

import simpleGit from "simple-git";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { Logger } from "../logger.service";

import { CloneSyncService } from "../clone-sync.service";

import type { GitService } from "../git.service";
import type { Config } from "../../types";

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
    canFastForward: vi.fn().mockResolvedValue(true),
    isLocalAheadOfRemote: vi.fn().mockResolvedValue(false),
    isWorktreeBehind: vi.fn().mockResolvedValue(true),
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
    it("clones into an empty target with --single-branch", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([]); // worktreeDir exists empty
      (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
      (fs.stat as unknown as Mock).mockRejectedValue(new Error("ENOENT")); // .git missing
      (fs.access as unknown as Mock).mockRejectedValue(new Error("ENOENT")); // marker missing
      (fs.writeFile as unknown as Mock).mockResolvedValue(undefined);

      const config = makeConfig();
      const gitService = buildGitService();
      const service = new CloneSyncService(config, gitService, logger);

      await service.initialize();

      expect(gitMock.clone).toHaveBeenCalledWith(
        config.repoUrl,
        config.worktreeDir,
        expect.arrayContaining(["--branch", "main", "--single-branch", "--progress"]),
      );
      expect(service.isInitialized()).toBe(true);
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
      expect(service.isInitialized()).toBe(true);
    });

    it("errors out when existing clone is on a different branch", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce([".git"]);
      (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
      (fs.stat as unknown as Mock).mockResolvedValue({ isDirectory: () => true, isFile: () => false } as never);
      gitMock.raw.mockImplementation(async (args: string[]) => {
        const key = args.join(" ");
        if (key === "rev-parse --abbrev-ref HEAD") return "develop";
        if (key === "remote get-url origin") return "https://github.com/example/repo.git";
        return "";
      });

      const service = new CloneSyncService(makeConfig({ branch: "main" }), buildGitService(), logger);

      await expect(service.initialize()).rejects.toThrow(/branch 'develop', expected 'main'/);
    });

    it("refuses to clone into a non-empty directory it didn't create", async () => {
      (fs.readdir as unknown as Mock).mockResolvedValueOnce(["random-file.txt"]);
      (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
      (fs.stat as unknown as Mock).mockRejectedValue(new Error("ENOENT"));

      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

      await expect(service.initialize()).rejects.toThrow(/exists and is not empty/);
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
      const gitService = buildGitService({
        checkWorktreeStatus: vi.fn().mockResolvedValue(false),
      });
      const service = new CloneSyncService(makeConfig(), gitService, logger);
      setInitialized(service);

      await service.runSyncAttempt();

      expect(gitMock.fetch).toHaveBeenCalled();
      expect(gitMock.merge).not.toHaveBeenCalled();
    });

    it("does not reset on diverged history", async () => {
      const gitService = buildGitService({
        canFastForward: vi.fn().mockResolvedValue(false),
        isLocalAheadOfRemote: vi.fn().mockResolvedValue(false),
      });
      const service = new CloneSyncService(makeConfig(), gitService, logger);
      setInitialized(service);

      await service.runSyncAttempt();

      expect(gitMock.merge).not.toHaveBeenCalled();
    });

    it("fast-forwards when clean, behind, and ff-able", async () => {
      const service = new CloneSyncService(makeConfig(), buildGitService(), logger);
      setInitialized(service);

      await service.runSyncAttempt();

      expect(gitMock.merge).toHaveBeenCalledWith(["origin/main", "--ff-only"]);
    });

    it("no-ops when already up to date", async () => {
      const gitService = buildGitService({
        isWorktreeBehind: vi.fn().mockResolvedValue(false),
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

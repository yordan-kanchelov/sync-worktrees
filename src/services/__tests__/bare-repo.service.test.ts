import * as fs from "fs/promises";
import * as path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  TEST_PATHS,
  TEST_URLS,
  createMockConfig,
  createRemoteRefListOutput,
  createWorktreeListOutput,
} from "../../__tests__/test-utils";
import { PATH_CONSTANTS } from "../../constants";
import { ConfigError } from "../../errors";
import { GitService } from "../git.service";

import {
  createGitServiceFixture,
  MAIN_WORKTREE_PATH,
  mockInitializeGit as mockInitializeGitOn,
} from "./helpers/git-service-fixture";

import type { BareRepoService } from "../bare-repo.service";
import type { Logger } from "../logger.service";
import type { SimpleGit } from "simple-git";
import type { Mock, Mocked } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");
vi.mock("../worktree-metadata.service", async () =>
  (await import("./helpers/metadata-service-mock")).worktreeMetadataServiceModuleMock(),
);

describe("BareRepoService (through GitService)", () => {
  let gitService: GitService;
  let mockGit: Mocked<SimpleGit>;
  let mockLogger: Logger;

  const mockInitializeGit = (opts: Parameters<typeof mockInitializeGitOn>[1] = {}): { addCalls: string[][] } =>
    mockInitializeGitOn(mockGit, opts);

  beforeEach(() => {
    ({ gitService, mockGit, mockLogger } = createGitServiceFixture());
  });

  describe("getRemoteDefaultBranch (#6)", () => {
    it("names the remote with credentials redacted when no default branch can be detected", async () => {
      const tokenUrl = "https://ci-bot:s3cr3t-token@github.com/test/repo.git";
      (mockGit.raw as Mock).mockImplementation(async () => "");

      await expect(gitService.getRemoteDefaultBranch(tokenUrl)).rejects.toThrow(
        "Unable to detect default branch for 'https://***@github.com/test/repo.git'.",
      );
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
        if (a[0] === "ls-remote" && a[1] === "--symref") return "";
        if (a[0] === "ls-remote" && a.includes("refs/heads/master")) return "sha\trefs/heads/master\n";
        return "";
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

  describe("clone-time refs/heads copies", () => {
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
      expect(branchDeleteCalls()).toEqual([["branch", "-D", "--", "feature-1", "release/2.0"]]);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Removed 2 clone-time local branch copies; worktrees are created from origin/* instead.",
      );
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
      expect(calls.map((args) => args.length - 3)).toEqual([200, 200, 50]);
      expect(calls.flatMap((args) => args.slice(3))).toEqual(branches);
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
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      (mockGit.raw as Mock).mockImplementation((args: unknown) => {
        if (!Array.isArray(args)) return Promise.resolve("");
        const [command, subcommand] = args as string[];
        if (command === "config" && (args as string[])[3] === "remote.origin.url")
          return Promise.resolve(TEST_URLS.github);
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
      mockGit.raw.mockResolvedValueOnce("https://github.com/old-org/repo.git\n" as any);

      await expect(gitService.initialize()).rejects.toMatchObject({
        constructor: ConfigError,
        code: "CONFIG_ORIGIN_MISMATCH",
        message:
          `Existing bare repository at '${bareRepoPath}' has origin 'https://github.com/old-org/repo.git', expected 'https://gitlab.com/new-org/repo.git'. ` +
          `Update the remote (git -C "${bareRepoPath}" remote set-url origin <the repoUrl configured for this ` +
          `repository>) or point bareRepoDir at a fresh directory.`,
      });

      expect(mockGit.raw).toHaveBeenCalledWith(["config", "--local", "--get", "remote.origin.url"]);
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

      const error = await gitService.initialize().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe("CONFIG_ORIGIN_MISMATCH");
      expect((error as ConfigError).message).toContain(
        "has origin 'https://***@github.com/old-org/repo.git', expected 'https://***@github.com/new-org/repo.git'. ",
      );
      expect((error as ConfigError).message).not.toContain('set-url origin "https://***@');

      expect(mockGit.fetch).not.toHaveBeenCalled();
    });

    it.each([
      ["without the .git suffix", "https://github.com/test/repo"],
      ["with a trailing slash", "https://github.com/test/repo.git/"],
      ["with a different host case", "HTTPS://GitHub.COM/test/repo.git"],
    ])("proceeds to fetch when origin is repoUrl %s", async (_variant, originUrl) => {
      mockGit.raw
        .mockResolvedValueOnce(`${originUrl}\n` as any)
        .mockResolvedValueOnce("+refs/heads/*:refs/remotes/origin/*" as any)
        .mockResolvedValueOnce("" as any)
        .mockResolvedValueOnce("refs/remotes/origin/main\n" as any)
        .mockResolvedValueOnce(mainWorktreeList as any);

      await expect(gitService.initialize()).resolves.toBe(mockGit);

      expect(mockGit.fetch).toHaveBeenCalledWith(["--all", "--progress"]);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("warns and proceeds when the bare repository has no origin URL configured", async () => {
      mockGit.raw
        .mockResolvedValueOnce("" as any)
        .mockResolvedValueOnce("+refs/heads/*:refs/remotes/origin/*" as any)
        .mockResolvedValueOnce("" as any)
        .mockResolvedValueOnce("refs/remotes/origin/main\n" as any)
        .mockResolvedValueOnce(mainWorktreeList as any);

      await expect(gitService.initialize()).resolves.toBe(mockGit);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        `Could not read 'origin' remote URL from existing bare repository at '${bareRepoPath}'.`,
      );
      expect(mockGit.fetch).toHaveBeenCalledWith(["--all", "--progress"]);
    });

    it("warns and proceeds when the bare repository has no readable origin", async () => {
      mockGit.raw
        .mockRejectedValueOnce(new Error("error: No such remote 'origin'"))
        .mockResolvedValueOnce("+refs/heads/*:refs/remotes/origin/*" as any)
        .mockResolvedValueOnce("" as any)
        .mockResolvedValueOnce("refs/remotes/origin/main\n" as any)
        .mockResolvedValueOnce(mainWorktreeList as any);

      await expect(gitService.initialize()).resolves.toBe(mockGit);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        `Could not read 'origin' remote URL from existing bare repository at '${bareRepoPath}'.`,
      );
      expect(mockGit.fetch).toHaveBeenCalledWith(["--all", "--progress"]);
    });
  });

  describe("interrupted bare clone recovery", () => {
    const bareRepoPath = path.resolve(".bare/repo");
    const markerPath = path.join(path.dirname(bareRepoPath), `repo${PATH_CONSTANTS.BARE_CLONE_PENDING_MARKER_SUFFIX}`);
    const mainWorktreeList = createWorktreeListOutput([
      { path: TEST_PATHS.worktree + "/main", branch: "main", commit: "abc123" },
    ]);

    const fsError = (code: string, message: string): NodeJS.ErrnoException =>
      Object.assign(new Error(message), { code });
    const enoent = (): NodeJS.ErrnoException => fsError("ENOENT", "ENOENT: no such file or directory");

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
        .mockResolvedValueOnce(TEST_URLS.github as any)
        .mockResolvedValueOnce("+refs/heads/*:refs/remotes/origin/*" as any)
        .mockResolvedValueOnce("" as any)
        .mockResolvedValueOnce("refs/remotes/origin/main\n" as any)
        .mockResolvedValueOnce(mainWorktreeList as any);

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

      const second = new GitService(createMockConfig(), mockLogger);
      await expect(second.initialize()).rejects.toBeInstanceOf(ConfigError);
      expect(fs.rm).not.toHaveBeenCalled();
    });

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

      expect(fs.unlink).not.toHaveBeenCalledWith(markerPath);
      expect(marker.markerExists()).toBe(true);
    });
  });

  describe("detectDefaultBranch after the remote renamed its default", () => {
    const detect = (): Promise<string> =>
      (gitService as unknown as { bareRepo: BareRepoService }).bareRepo.detectDefaultBranch(mockGit);

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
        if (command === "for-each-ref") {
          return Promise.resolve(createRemoteRefListOutput(opts.remoteBranches));
        }
        return Promise.resolve("");
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

    it("detects default branches whose names contain slashes", async () => {
      mockOriginHead({ symrefTargets: ["release/2024"], remoteBranches: ["release/2024"] });

      await expect(detect()).resolves.toBe("release/2024");
    });
  });
});

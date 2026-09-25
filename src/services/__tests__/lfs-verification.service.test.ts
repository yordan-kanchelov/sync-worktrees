import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockConfig, setEnvVar } from "../../__tests__/test-utils";
import { ENV_CONSTANTS } from "../../constants";
import { GIT_LFS_MISSING_WARNING } from "../../utils/git-lfs-probe";
import { GitService } from "../git.service";

import { createGitServiceFixture, mockShowRef as mockShowRefOn } from "./helpers/git-service-fixture";

import type { Logger } from "../logger.service";
import type { SimpleGit } from "simple-git";
import type { Mock, Mocked } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");
vi.mock("../worktree-metadata.service", async () =>
  (await import("./helpers/metadata-service-mock")).worktreeMetadataServiceModuleMock(),
);

describe("LfsVerificationService (through GitService)", () => {
  let gitService: GitService;
  let mockGit: Mocked<SimpleGit>;
  let mockMetadataService: any;
  let mockLogger: Logger;

  const mockShowRef = (opts: Parameters<typeof mockShowRefOn>[1]): void => mockShowRefOn(mockGit, opts);

  beforeEach(() => {
    ({ gitService, mockGit, mockMetadataService, mockLogger } = createGitServiceFixture());
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
});

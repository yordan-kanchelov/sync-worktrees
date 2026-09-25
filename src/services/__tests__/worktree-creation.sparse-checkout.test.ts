import simpleGit from "simple-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockConfig } from "../../__tests__/test-utils";
import { ENV_CONSTANTS } from "../../constants";
import { GIT_UNSAFE_ALLOWANCES } from "../../utils/git-env";
import { GitService } from "../git.service";

import { createGitServiceFixture, mockShowRef as mockShowRefOn } from "./helpers/git-service-fixture";

import type { Config } from "../../types";
import type { Logger } from "../logger.service";
import type { SimpleGit } from "simple-git";
import type { Mock, Mocked } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");
vi.mock("../worktree-metadata.service", async () =>
  (await import("./helpers/metadata-service-mock")).worktreeMetadataServiceModuleMock(),
);

describe("WorktreeCreationService with sparse checkout (through GitService)", () => {
  let gitService: GitService;
  let mockGit: Mocked<SimpleGit>;
  let mockLogger: Logger;

  const mockShowRef = (opts: Parameters<typeof mockShowRefOn>[1]): void => mockShowRefOn(mockGit, opts);

  beforeEach(() => {
    ({ gitService, mockGit, mockLogger } = createGitServiceFixture());
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
          ["sparse-checkout", "set", "--cone", "--", "apps", "packages"],
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
          ["sparse-checkout", "set", "--cone", "--", "apps"],
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
          ["sparse-checkout", "set", "--no-cone", "--", "/*", "!docs"],
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
      expect(mockGit.raw).toHaveBeenCalledWith(["branch", "-D", "--", "feat-new"]);
    });
  });
});

import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";
import { vi } from "vitest";

import {
  TEST_PATHS,
  TEST_URLS,
  buildGitStatusResponse,
  createMockConfig,
  createMockGitService,
  createMockLogger,
  createRemoteRefListOutput,
  createWorktreeListOutput,
} from "../../../__tests__/test-utils";
import { resetGitLfsProbeForTests } from "../../../utils/git-lfs-probe";
import { GitService } from "../../git.service";

import { mockMetadataServiceInstance } from "./metadata-service-mock";

import type { Config } from "../../../types";
import type { Logger } from "../../logger.service";
import type { SimpleGit } from "simple-git";
import type { Mock, Mocked } from "vitest";

export const MAIN_WORKTREE_PATH = path.join(TEST_PATHS.worktree, "main");

export interface GitServiceFixture {
  gitService: GitService;
  mockConfig: Config;
  mockGit: Mocked<SimpleGit>;
  mockMetadataService: typeof mockMetadataServiceInstance;
  mockLogger: Logger;
}

export const createGitServiceFixture = (): GitServiceFixture => {
  vi.clearAllMocks();

  resetGitLfsProbeForTests();

  const mockLogger = createMockLogger();
  const mockConfig = createMockConfig();

  const mockGit = createMockGitService({
    fetch: vi.fn<any>().mockResolvedValue(undefined) as any,
    branch: vi.fn<any>().mockResolvedValue({
      all: ["origin/main", "origin/feature-1", "origin/feature-2", "local-branch"],
      current: "main",
    }) as any,
    raw: vi.fn<any>().mockImplementation((args: unknown) => {
      if (!Array.isArray(args)) return Promise.resolve("");
      if (args[0] === "worktree" && args[1] === "list") {
        return Promise.resolve(
          createWorktreeListOutput([{ path: MAIN_WORKTREE_PATH, branch: "main", commit: "abc123" }]),
        );
      }
      if (args[0] === "for-each-ref" && args[args.length - 1] === "refs/remotes/origin") {
        return Promise.resolve(createRemoteRefListOutput(["main", "feature-1", "feature-2"]));
      }
      return Promise.resolve("");
    }) as any,
    status: vi.fn<any>().mockResolvedValue(buildGitStatusResponse({ isClean: true })) as any,
    reset: vi.fn<any>().mockResolvedValue(undefined) as any,
    clone: vi.fn<any>().mockResolvedValue(undefined) as any,
    addConfig: vi.fn<any>().mockResolvedValue(undefined) as any,
    push: vi.fn<any>().mockResolvedValue(undefined) as any,
    revparse: vi.fn<any>().mockResolvedValue("abc123") as any,
  }) as Mocked<SimpleGit>;

  (simpleGit as unknown as Mock).mockReturnValue(mockGit);

  return {
    gitService: new GitService(mockConfig, mockLogger),
    mockConfig,
    mockGit,
    mockMetadataService: mockMetadataServiceInstance,
    mockLogger,
  };
};

export const mockInitializeGit = (
  mockGit: Mocked<SimpleGit>,
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
    if (command === "config" && (args as string[])[3] === "remote.origin.url") return Promise.resolve(TEST_URLS.github);
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

export const mockMainWorktreeMissing = (mainPath: string = MAIN_WORKTREE_PATH): void => {
  (fs.access as Mock<any>).mockImplementation(async (p: unknown) => {
    if (typeof p === "string" && (p === mainPath || p.startsWith(mainPath + path.sep))) {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    }
  });
};

export const mockShowRef = (
  mockGit: Mocked<SimpleGit>,
  opts: { local: boolean; remote: boolean; localOnlyCommits?: number | "unknown" },
): void => {
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
      return count === "unknown" ? Promise.reject(new Error("rev-list: bad revision")) : Promise.resolve(`${count}\n`);
    }
    return Promise.resolve("");
  });
};

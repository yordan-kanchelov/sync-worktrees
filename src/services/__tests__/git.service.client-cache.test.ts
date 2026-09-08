import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  TEST_PATHS,
  TEST_URLS,
  createMockConfig,
  createMockLogger,
  createWorktreeListOutput,
} from "../../__tests__/test-utils";
import { GIT_CONSTANTS } from "../../constants";
import { GitService } from "../git.service";

import type { Config } from "../../types";
import type { GitClientCache } from "../../utils/git-client-cache";
import type { Logger } from "../logger.service";
import type { Mock } from "vitest";

const { mockMetadataServiceInstance } = vi.hoisted(() => ({
  mockMetadataServiceInstance: {
    createInitialMetadataFromPath: vi.fn<any>().mockResolvedValue(undefined),
    updateLastSyncFromPath: vi.fn<any>().mockResolvedValue(undefined),
    loadMetadataFromPath: vi.fn<any>().mockResolvedValue(null),
    deleteMetadataFromPath: vi.fn<any>().mockResolvedValue(undefined),
    recordRemoteTip: vi.fn<any>().mockResolvedValue(undefined),
  },
}));

vi.mock("fs/promises");
vi.mock("simple-git");
vi.mock("../worktree-metadata.service", () => ({
  WorktreeMetadataService: vi.fn(function (this: any) {
    return mockMetadataServiceInstance;
  }),
}));

// A cached client costs ~7 KB — a simple-git instance plus its own copy of the
// sanitized environment — and both caches are keyed by worktree path, so a
// daemon on a repository whose branches come and go used to keep one client set
// per branch it had ever seen for as long as it ran. Every path that stops
// being a worktree must drop its clients: these tests pin that for the removal
// flows, and that the worktrees which stay keep theirs.
describe("GitService cached git clients", () => {
  const MAIN_WORKTREE_PATH = path.join(TEST_PATHS.worktree, "main");
  const FEATURE_WORKTREE_PATH = path.join(TEST_PATHS.worktree, "feature-1");
  const OTHER_WORKTREE_PATH = path.join(TEST_PATHS.worktree, "feature-2");

  let logger: Logger;
  let builtBaseDirs: (string | undefined)[];
  let registeredPaths: string[];
  let removalRefusal: string | null;
  /** Resolvers of the commands a test chose to hold open. */
  let pending: (() => void)[];
  let holdCommand: ((args: string[]) => boolean) | null;

  const rawOutput = (args: string[]): string => {
    const key = args.join(" ");
    if (key.startsWith("remote get-url origin")) return TEST_URLS.github;
    if (key.startsWith("config --get-all remote.origin.fetch")) return GIT_CONSTANTS.FETCH_CONFIG;
    if (key.startsWith("worktree list")) {
      return createWorktreeListOutput(
        registeredPaths.map((worktreePath) => ({
          path: worktreePath,
          branch: path.basename(worktreePath),
          commit: "abc123",
        })),
      );
    }
    if (key.startsWith("symbolic-ref")) return `${GIT_CONSTANTS.REFS.REMOTES}/main\n`;
    if (key.startsWith("rev-list --count")) return "0\n";
    return "";
  };

  const installGitFactory = (): void => {
    (simpleGit as unknown as Mock).mockImplementation((first?: unknown) => {
      builtBaseDirs.push(typeof first === "string" ? first : undefined);
      const settle = async <T>(args: string[], value: T): Promise<T> => {
        if (holdCommand?.(args) === true) {
          await new Promise<void>((resolve) => pending.push(resolve));
        }
        if (removalRefusal !== null && args[0] === "worktree" && args[1] === "remove") {
          throw new Error(removalRefusal);
        }
        return value;
      };
      const client: any = {
        env: vi.fn(() => client),
        raw: vi.fn((args: string[]) => settle(args, rawOutput(args))),
        revparse: vi.fn((args: string[] = []) => settle(["rev-parse", ...args], "abc123")),
        branch: vi.fn((args: string[] = []) =>
          settle(["branch", ...args], { current: "feature-1", all: ["origin/main"], detached: false }),
        ),
        status: vi.fn(() =>
          settle(["status"], {
            modified: [],
            deleted: [],
            renamed: [],
            created: [],
            conflicted: [],
            not_added: [],
          }),
        ),
        stashList: vi.fn(() => settle(["stash", "list"], { total: 0 })),
        fetch: vi.fn((args: string[] = []) => settle(["fetch", ...args], undefined)),
        addConfig: vi.fn(async () => undefined),
      };
      return client;
    });
  };

  const newService = (overrides: Partial<Config> = {}): GitService =>
    new GitService(createMockConfig({ bareRepoDir: TEST_PATHS.bareRepo, ...overrides }), logger);

  /** This service's own client cache; the status service keeps a second one. */
  const clientCache = (service: GitService): GitClientCache =>
    (service as unknown as { gitInstances: GitClientCache }).gitInstances;

  const statusClientCache = (service: GitService): GitClientCache =>
    (service as unknown as { statusService: { gitInstances: GitClientCache } }).statusService.gitInstances;

  /** Fills both caches for a worktree, in both of GitService's LFS variants. */
  const warmClientsFor = async (service: GitService, worktreePath: string): Promise<void> => {
    await service.checkoutHead(worktreePath); // LFS-skip variant
    await service.getCurrentCommit(worktreePath); // plain variant
    await service.checkWorktreeStatus(worktreePath); // the status service's client
  };

  const timesBuiltFor = (worktreePath: string): number =>
    builtBaseDirs.filter((baseDir) => baseDir === worktreePath).length;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
    builtBaseDirs = [];
    registeredPaths = [MAIN_WORKTREE_PATH, FEATURE_WORKTREE_PATH, OTHER_WORKTREE_PATH];
    removalRefusal = null;
    pending = [];
    holdCommand = null;
    (fs.access as unknown as Mock).mockResolvedValue(undefined);
    (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
    (fs.rm as unknown as Mock).mockResolvedValue(undefined);
    (fs.stat as unknown as Mock).mockResolvedValue({ isFile: () => false });
    installGitFactory();
  });

  it("drops every client cached for a worktree removeWorktree unregistered", async () => {
    const service = newService({ skipLfs: true });
    await warmClientsFor(service, FEATURE_WORKTREE_PATH);
    await warmClientsFor(service, OTHER_WORKTREE_PATH);
    expect(clientCache(service).countFor(FEATURE_WORKTREE_PATH)).toBe(2);
    expect(statusClientCache(service).countFor(FEATURE_WORKTREE_PATH)).toBe(1);

    await service.removeWorktree(FEATURE_WORKTREE_PATH);

    expect(clientCache(service).countFor(FEATURE_WORKTREE_PATH)).toBe(0);
    expect(statusClientCache(service).countFor(FEATURE_WORKTREE_PATH)).toBe(0);
    // The worktrees that remain keep theirs, and so does the bare repository —
    // the client `worktree remove` itself was issued through.
    expect(clientCache(service).countFor(OTHER_WORKTREE_PATH)).toBe(2);
    expect(statusClientCache(service).countFor(OTHER_WORKTREE_PATH)).toBe(1);
    expect(clientCache(service).countFor(TEST_PATHS.bareRepo)).toBeGreaterThan(0);
  });

  it("keeps the clients of a worktree git refused to remove", async () => {
    const service = newService({ skipLfs: true });
    await warmClientsFor(service, FEATURE_WORKTREE_PATH);
    removalRefusal = "fatal: 'feature-1' contains modified or untracked files, use --force to delete it";

    await expect(service.removeWorktree(FEATURE_WORKTREE_PATH)).rejects.toThrow(/git refused removal/);

    // The worktree is still there, so its clients are still the right ones.
    expect(clientCache(service).countFor(FEATURE_WORKTREE_PATH)).toBe(2);
    expect(statusClientCache(service).countFor(FEATURE_WORKTREE_PATH)).toBe(1);
  });

  it("builds a fresh client when a forgotten path is used again", async () => {
    const service = newService({ skipLfs: true });
    await service.getCurrentCommit(FEATURE_WORKTREE_PATH);
    const builtBefore = timesBuiltFor(FEATURE_WORKTREE_PATH);

    await service.removeWorktree(FEATURE_WORKTREE_PATH);
    await service.getCurrentCommit(FEATURE_WORKTREE_PATH);

    expect(timesBuiltFor(FEATURE_WORKTREE_PATH)).toBe(builtBefore + 1);
  });

  it("lets a command already running on an evicted client finish", async () => {
    const service = newService({ skipLfs: true });
    await warmClientsFor(service, FEATURE_WORKTREE_PATH);

    holdCommand = (args) => args[0] === "rev-parse";
    const inFlight = service.getCurrentCommit(FEATURE_WORKTREE_PATH);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    holdCommand = null;

    await service.removeWorktree(FEATURE_WORKTREE_PATH);
    pending.forEach((resolve) => resolve());

    // Eviction drops the map entry, never the instance the caller is holding.
    await expect(inFlight).resolves.toBe("abc123");
  });

  it("drops the clients of a stale directory moved to trash", async () => {
    const service = newService({ skipLfs: true });
    const trashed: string[] = [];
    service.setStaleDirectoryTrasher(async (dirPath) => {
      trashed.push(dirPath);
      return path.join(TEST_PATHS.worktree, GIT_CONSTANTS.TRASH_DIR_NAME, "abc", "payload");
    });
    await warmClientsFor(service, FEATURE_WORKTREE_PATH);
    const builtBefore = timesBuiltFor(FEATURE_WORKTREE_PATH);
    // The directory is there but registered to nothing — addWorktree hands it
    // to the trasher and then recreates the worktree at the same path.
    registeredPaths = [MAIN_WORKTREE_PATH];

    await service.addWorktree("feature-1", FEATURE_WORKTREE_PATH);

    expect(trashed).toEqual([FEATURE_WORKTREE_PATH]);
    // Every client that pointed at the trashed directory is gone; the ones the
    // recreated worktree uses were built after the move.
    expect(timesBuiltFor(FEATURE_WORKTREE_PATH)).toBeGreaterThan(builtBefore);
    expect(statusClientCache(service).countFor(FEATURE_WORKTREE_PATH)).toBe(0);
  });
});

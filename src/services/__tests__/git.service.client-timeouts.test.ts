import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TEST_PATHS,
  TEST_URLS,
  createMockConfig,
  createMockLogger,
  createWorktreeListOutput,
  setEnvVar,
} from "../../__tests__/test-utils";
import { DEFAULT_CONFIG, ENV_CONSTANTS, GIT_CONSTANTS } from "../../constants";
import { GIT_UNSAFE_ALLOWANCES } from "../../utils/git-env";
import { GitService } from "../git.service";

import type { Config } from "../../types";
import type { Logger } from "../logger.service";
import type { SimpleGitOptions } from "simple-git";
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

// simple-git's inactivity timeout (`timeout.block`) kills the child process
// when no stdout/stderr data arrives inside the window — with SIGINT, no
// matter what git was doing. `git worktree add` is silent for the whole
// checkout (its internal `reset --hard` prints nothing on a pipe), so a
// monorepo whose checkout takes longer than fetchTimeoutMs was killed on every
// tick and could never be created. The knob guards *network* stalls, so only
// the clients that run network commands carry it; every local command runs on
// a client built without it. These tests pin which client each operation is
// issued through, by inspecting the options every simple-git client was
// constructed with.
describe("GitService git client timeouts", () => {
  interface BuiltClient {
    baseDir: string | undefined;
    options: Partial<SimpleGitOptions>;
    env: NodeJS.ProcessEnv | undefined;
    commands: string[][];
  }

  const MAIN_WORKTREE_PATH = path.join(TEST_PATHS.worktree, "main");
  const FEATURE_WORKTREE_PATH = path.join(TEST_PATHS.worktree, "feature-1");
  const originalShortcut = process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT];

  let built: BuiltClient[];
  let logger: Logger;

  // Answers for the commands the flows under test issue; anything else is "".
  const defaultRawOutput = (args: string[]): string => {
    const key = args.join(" ");
    if (key.startsWith("remote get-url origin")) return TEST_URLS.github;
    if (key.startsWith("config --get-all remote.origin.fetch")) return GIT_CONSTANTS.FETCH_CONFIG;
    if (key.startsWith("worktree list")) {
      return createWorktreeListOutput([{ path: MAIN_WORKTREE_PATH, branch: "main", commit: "abc123" }]);
    }
    if (key.startsWith("symbolic-ref")) return `${GIT_CONSTANTS.REFS.REMOTES}/main\n`;
    if (key.startsWith("ls-remote --symref")) return "ref: refs/heads/main\tHEAD\n";
    if (key.startsWith("rev-list --count")) return "0\n";
    return "";
  };

  const installGitFactory = (rawOutput: (args: string[]) => string = defaultRawOutput): void => {
    (simpleGit as unknown as Mock).mockImplementation((first?: unknown, second?: unknown) => {
      const record: BuiltClient = {
        baseDir: typeof first === "string" ? first : undefined,
        options: ((typeof first === "string" ? second : first) ?? {}) as Partial<SimpleGitOptions>,
        env: undefined,
        commands: [],
      };
      built.push(record);
      const record_ = (args: string[]): void => void record.commands.push(args);
      const client: any = {
        env: vi.fn((env: NodeJS.ProcessEnv) => {
          record.env = env;
          return client;
        }),
        raw: vi.fn(async (args: string[]) => {
          record_(args);
          return rawOutput(args);
        }),
        fetch: vi.fn(async (args: string[] = []) => record_(["fetch", ...args])),
        push: vi.fn(async (args: string[] = []) => record_(["push", ...args])),
        clone: vi.fn(async (url: string, dir: string, args: string[] = []) => record_(["clone", url, dir, ...args])),
        merge: vi.fn(async (args: string[] = []) => record_(["merge", ...args])),
        branch: vi.fn(async (args: string[] = []) => {
          record_(["branch", ...args]);
          return { current: "feature-1", all: ["origin/main"], detached: false };
        }),
        status: vi.fn(async (args: string[] = []) => {
          record_(["status", ...args]);
          return { isClean: () => true };
        }),
        revparse: vi.fn(async (args: string[] = []) => {
          record_(["rev-parse", ...args]);
          return "abc123";
        }),
        addConfig: vi.fn(async (key: string, value: string) => record_(["config", key, value])),
      };
      return client;
    });
  };

  // Every client through which a command starting with `prefix` was issued.
  const clientsThatRan = (...prefix: string[]): BuiltClient[] =>
    built.filter((client) =>
      client.commands.some((command) => prefix.every((token, index) => command[index] === token)),
    );

  const onlyClientThatRan = (...prefix: string[]): BuiltClient => {
    const matches = clientsThatRan(...prefix);
    expect(matches, `expected exactly one client to run '${prefix.join(" ")}'`).toHaveLength(1);
    return matches[0];
  };

  const newService = (overrides: Partial<Config> = {}): GitService =>
    new GitService(
      { ...createMockConfig({ bareRepoDir: TEST_PATHS.bareRepo, ...overrides }) },
      logger,
    ) as unknown as GitService;

  // The bare repository (and every worktree) exists unless a test says otherwise.
  const markMissing = (...missing: string[]): void => {
    (fs.access as unknown as Mock).mockImplementation(async (probed: unknown) => {
      if (typeof probed === "string" && missing.some((m) => probed === m || probed.startsWith(m + path.sep))) {
        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      }
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    built = [];
    logger = createMockLogger();
    // The suite-wide shortcut zeroes both timeouts (see unit-test-shortcut.ts);
    // these tests need the real ones to tell the two client kinds apart.
    delete process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT];
    markMissing();
    (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
    (fs.rm as unknown as Mock).mockResolvedValue(undefined);
    installGitFactory();
  });

  afterEach(() => {
    setEnvVar(ENV_CONSTANTS.UNIT_TEST_SHORTCUT, originalShortcut);
  });

  describe("local commands run without an inactivity kill", () => {
    it("issues `worktree add` through a client with no block timeout", async () => {
      const service = newService();
      markMissing(FEATURE_WORKTREE_PATH);

      await service.addWorktree("feature-1", FEATURE_WORKTREE_PATH);

      const adder = onlyClientThatRan("worktree", "add");
      expect(adder.baseDir).toBe(TEST_PATHS.bareRepo);
      expect(adder.options.timeout).toBeUndefined();
    });

    it("issues the fast-forward merge through a client with no block timeout", async () => {
      const service = newService();

      await service.updateWorktree(FEATURE_WORKTREE_PATH);

      const merger = onlyClientThatRan("merge", "origin/feature-1");
      expect(merger.baseDir).toBe(FEATURE_WORKTREE_PATH);
      expect(merger.options.timeout).toBeUndefined();
    });

    it("issues `status` and the reset checkout through a client with no block timeout", async () => {
      const service = newService();

      await service.resetToUpstream(FEATURE_WORKTREE_PATH, "feature-1");

      for (const client of [onlyClientThatRan("status"), onlyClientThatRan("checkout", "-B")]) {
        expect(client.baseDir).toBe(FEATURE_WORKTREE_PATH);
        expect(client.options.timeout).toBeUndefined();
      }
    });

    it("issues `checkout HEAD` through a client with no block timeout", async () => {
      const service = newService();

      await service.checkoutHead(FEATURE_WORKTREE_PATH);

      expect(onlyClientThatRan("checkout", "HEAD").options.timeout).toBeUndefined();
    });

    it("issues `worktree remove` and `worktree list` through a client with no block timeout", async () => {
      const service = newService();

      await service.removeWorktree(FEATURE_WORKTREE_PATH);
      await service.getWorktrees();

      expect(onlyClientThatRan("worktree", "remove").options.timeout).toBeUndefined();
      expect(onlyClientThatRan("worktree", "list").options.timeout).toBeUndefined();
    });
  });

  describe("network commands keep fetchTimeoutMs", () => {
    it("fetches through a client carrying the fetch block timeout", async () => {
      const service = newService();
      await service.initialize();

      await service.fetchAll();
      await service.fetchBranch("feature-1");

      const fetchers = clientsThatRan("fetch", "--all", "--prune");
      expect(fetchers).toHaveLength(1);
      expect(fetchers[0].baseDir).toBe(MAIN_WORKTREE_PATH);
      expect(fetchers[0].options.timeout).toEqual({ block: DEFAULT_CONFIG.FETCH_TIMEOUT_MS });
      expect(onlyClientThatRan("fetch", "origin", "feature-1").options.timeout).toEqual({
        block: DEFAULT_CONFIG.FETCH_TIMEOUT_MS,
      });
    });

    it("clones with the clone timeout and fetches with the fetch timeout during initialize", async () => {
      markMissing(TEST_PATHS.bareRepo);
      const service = newService();

      await service.initialize();

      expect(onlyClientThatRan("clone").options.timeout).toEqual({ block: DEFAULT_CONFIG.CLONE_TIMEOUT_MS });
      expect(onlyClientThatRan("fetch", "--all", "--progress").options.timeout).toEqual({
        block: DEFAULT_CONFIG.FETCH_TIMEOUT_MS,
      });
    });

    it("runs ls-remote and push with the fetch block timeout", async () => {
      const service = newService();

      await service.getRemoteDefaultBranch(TEST_URLS.github);
      await service.pushBranch("feature-1");

      const lsRemote = onlyClientThatRan("ls-remote", "--symref");
      expect(lsRemote.baseDir).toBeUndefined();
      expect(lsRemote.options.timeout).toEqual({ block: DEFAULT_CONFIG.FETCH_TIMEOUT_MS });
      expect(onlyClientThatRan("push", "origin").options.timeout).toEqual({
        block: DEFAULT_CONFIG.FETCH_TIMEOUT_MS,
      });
    });

    it("asks the remote for its default branch with the fetch block timeout", async () => {
      // origin/HEAD unreadable: detectDefaultBranch falls through to
      // `remote set-head -a`, the one command there that talks to the remote.
      installGitFactory((args) => (args[0] === "symbolic-ref" ? "" : defaultRawOutput(args)));
      const service = newService();

      await service.initialize();

      expect(onlyClientThatRan("remote", "set-head").options.timeout).toEqual({
        block: DEFAULT_CONFIG.FETCH_TIMEOUT_MS,
      });
    });
  });

  describe("the two client kinds differ only in the timeout", () => {
    it("gives the local and network clients for one path the same env and unsafe allowances", async () => {
      const service = newService({ skipLfs: true });
      await service.initialize();
      await service.fetchAll();
      await service.checkoutHead(MAIN_WORKTREE_PATH);

      const networkClient = onlyClientThatRan("fetch", "--all", "--prune");
      const localClient = onlyClientThatRan("checkout", "HEAD");

      expect(localClient.baseDir).toBe(networkClient.baseDir);
      expect(localClient.env).toEqual(networkClient.env);
      expect(localClient.env).toMatchObject({ [ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE]: "1" });
      expect(localClient.options.unsafe).toEqual(GIT_UNSAFE_ALLOWANCES);
      expect(networkClient.options.unsafe).toEqual(GIT_UNSAFE_ALLOWANCES);
      // `progress` is a fresh closure per client, so compare the shape: the
      // network client's options are the local ones plus the block timeout.
      expect(Object.keys(localClient.options).sort()).toEqual(["progress", "unsafe"]);
      expect(Object.keys(networkClient.options).sort()).toEqual(["progress", "timeout", "unsafe"]);
    });

    it("never hands a local command the network client of the same path, or the other way round", async () => {
      const service = newService();
      await service.initialize();

      // Interleave both kinds on the anchor path: the cache keys them apart,
      // so neither kind can be served from the other's cache entry.
      await service.fetchAll();
      await service.checkoutHead(MAIN_WORKTREE_PATH);
      await service.fetchBranch("feature-1");
      await service.getCurrentCommit(MAIN_WORKTREE_PATH);

      const anchorClients = built.filter((client) => client.baseDir === MAIN_WORKTREE_PATH);
      const timedOut = anchorClients.filter((client) => client.options.timeout !== undefined);
      const untimed = anchorClients.filter((client) => client.options.timeout === undefined);

      // Exactly one client of each kind: both are cached and reused.
      expect(timedOut).toHaveLength(1);
      expect(untimed).toHaveLength(1);
      expect(timedOut[0].commands.every((command) => command[0] === "fetch")).toBe(true);
      expect(untimed[0].commands.some((command) => command[0] === "fetch")).toBe(false);
    });
  });
});

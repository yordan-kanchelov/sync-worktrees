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
import { CloneSyncService } from "../clone-sync.service";
import { Logger } from "../logger.service";

import type { Config } from "../../types";
import type { GitProgressEvent } from "../../utils/git-progress";
import type { GitService } from "../git.service";
import type { SimpleGitOptions } from "simple-git";
import type { Mock } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");

describe("CloneSyncService unshallow fetch", () => {
  interface BuiltClient {
    options: Partial<SimpleGitOptions>;
    commands: string[][];
  }

  const WORKTREE_DIR = "/tmp/clone-unshallow";
  const REPO_URL = "https://github.com/example/repo.git";
  const originalShortcut = process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT];

  let built: BuiltClient[];
  let progressEvents: GitProgressEvent[];
  let logger: Logger;

  const makeConfig = (overrides: Partial<Config> = {}): Config => ({
    repoUrl: REPO_URL,
    worktreeDir: WORKTREE_DIR,
    cronSchedule: "0 * * * *",
    runOnce: true,
    mode: "clone",
    branch: "main",
    ...overrides,
  });

  const buildGitService = (): GitService =>
    ({
      getRemoteDefaultBranch: vi.fn<any>().mockResolvedValue("main"),
      verifyLfs: vi.fn<any>().mockResolvedValue(undefined),
      getSparseCheckoutService: vi.fn().mockReturnValue({ applyToWorktree: vi.fn(), needsUpdate: vi.fn() }),
      checkWorktreeStatus: vi.fn<any>().mockResolvedValue(true),
      classifyRemoteRelationship: vi.fn<any>().mockResolvedValue("fast_forward"),
      isLfsSkipEnabled: vi.fn<any>().mockReturnValue(false),
    }) as unknown as GitService;

  const rawOutput = (args: string[]): string => {
    const key = args.join(" ");
    if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
    if (key.startsWith("config --local --get remote.origin.url")) return REPO_URL;
    if (key.startsWith("rev-parse --abbrev-ref HEAD")) return "main";
    if (key === "rev-parse --is-shallow-repository") return "true\n";
    return "";
  };

  const clientsThatRan = (...prefix: string[]): BuiltClient[] =>
    built.filter((client) =>
      client.commands.some((command) => prefix.every((token, index) => command[index] === token)),
    );

  const onlyClientThatRan = (...prefix: string[]): BuiltClient => {
    const matches = clientsThatRan(...prefix);
    expect(matches, `expected exactly one client to run '${prefix.join(" ")}'`).toHaveLength(1);
    return matches[0];
  };

  const runSyncOnShallowClone = async (): Promise<void> => {
    const service = new CloneSyncService(makeConfig(), buildGitService(), logger, {
      progressEmitter: (event) => progressEvents.push(event),
    });
    await service.initialize();
    await service.runSyncAttempt();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    built = [];
    progressEvents = [];
    logger = Logger.createDefault();
    (fs.lstat as unknown as Mock).mockResolvedValue(buildFsStats("directory"));
    (fs.readdir as unknown as Mock).mockResolvedValue([".git"]);
    (fs.access as unknown as Mock).mockResolvedValue(undefined);
    delete process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT];

    (simpleGit as unknown as Mock).mockImplementation((first?: unknown, second?: unknown) => {
      const record: BuiltClient = {
        options: ((typeof first === "string" ? second : first) ?? {}) as Partial<SimpleGitOptions>,
        commands: [],
      };
      built.push(record);
      const push = (args: string[]): void => void record.commands.push(args);
      const client: any = {
        env: vi.fn(() => client),
        raw: vi.fn(async (args: string[]) => {
          push(args);
          return rawOutput(args);
        }),
        fetch: vi.fn(async (args: string[] = []) => push(["fetch", ...args])),
        clone: vi.fn(async (url: string, dir: string, args: string[] = []) => push(["clone", url, dir, ...args])),
        merge: vi.fn(async (args: string[] = []) => push(["merge", ...args])),
      };
      return client;
    });
  });

  afterEach(() => {
    setEnvVar(ENV_CONSTANTS.UNIT_TEST_SHORTCUT, originalShortcut);
  });

  it("passes --progress so the unshallow is not silent for its whole transfer", async () => {
    await runSyncOnShallowClone();

    expect(onlyClientThatRan("fetch", "--unshallow").commands).toContainEqual([
      "fetch",
      "--unshallow",
      "--no-tags",
      "--progress",
    ]);
  });

  it("gives the unshallow the clone silence budget and the branch fetch the fetch one", async () => {
    await runSyncOnShallowClone();

    expect(onlyClientThatRan("fetch", "--unshallow").options.timeout).toEqual({
      block: DEFAULT_CONFIG.CLONE_TIMEOUT_MS,
    });
    expect(onlyClientThatRan("fetch", "origin").options.timeout).toEqual({
      block: DEFAULT_CONFIG.FETCH_TIMEOUT_MS,
    });
  });

  it("honours a configured cloneTimeoutMs for the unshallow", async () => {
    const service = new CloneSyncService(
      makeConfig({ cloneTimeoutMs: 1_234, fetchTimeoutMs: 42 }),
      buildGitService(),
      logger,
    );
    await service.initialize();
    await service.runSyncAttempt();

    expect(onlyClientThatRan("fetch", "--unshallow").options.timeout).toEqual({ block: 1_234 });
    expect(onlyClientThatRan("fetch", "origin").options.timeout).toEqual({ block: 42 });
  });

  it("reports the unshallow as fetch progress before and during the transfer", async () => {
    await runSyncOnShallowClone();

    expect(progressEvents).toContainEqual({
      phase: "fetch",
      message: `Fetching full history for '${REPO_URL}'`,
    });

    const onProgress = onlyClientThatRan("fetch", "--unshallow").options.progress;
    expect(onProgress).toBeTypeOf("function");
    onProgress?.({ method: "fetch", stage: "receiving", progress: 42, processed: 42, total: 100 });

    expect(progressEvents).toContainEqual({
      phase: "fetch",
      message: "fetch receiving: 42% (42/100)",
      progress: 42,
      processed: 42,
      total: 100,
    });
  });
});

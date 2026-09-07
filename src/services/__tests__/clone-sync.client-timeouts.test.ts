import * as fs from "fs/promises";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setEnvVar } from "../../__tests__/test-utils";
import { DEFAULT_CONFIG, ENV_CONSTANTS } from "../../constants";
import { CloneSyncService } from "../clone-sync.service";
import { Logger } from "../logger.service";

import type { Config } from "../../types";
import type { GitService } from "../git.service";
import type { SimpleGitOptions } from "simple-git";
import type { Mock } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");

// Clone mode splits the same way worktree mode does: `git fetch` and
// `ls-remote` keep simple-git's inactivity kill (a stalled connection must not
// hang the sync), while the local commands that follow — the ff-merge, the
// branch switch, the config rewrites — run without it. A merge that
// materializes a large tree is silent for minutes and would otherwise be
// SIGINT'd at fetchTimeoutMs.
describe("CloneSyncService git client timeouts", () => {
  interface BuiltClient {
    baseDir: string | undefined;
    options: Partial<SimpleGitOptions>;
    commands: string[][];
  }

  const WORKTREE_DIR = "/tmp/clone-timeouts";
  const REPO_URL = "https://github.com/example/repo.git";
  const originalShortcut = process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT];

  let built: BuiltClient[];
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
    }) as unknown as GitService;

  const rawOutput = (args: string[]): string => {
    const key = args.join(" ");
    if (key.startsWith("remote get-url origin")) return REPO_URL;
    if (key.startsWith("rev-parse --abbrev-ref HEAD")) return "main";
    if (key.startsWith("ls-remote")) return "aaaa\trefs/heads/main\n";
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

  beforeEach(() => {
    vi.clearAllMocks();
    built = [];
    logger = Logger.createDefault();
    // The suite-wide shortcut zeroes both timeouts; these tests need the real
    // ones to tell the two client kinds apart.
    delete process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT];

    (simpleGit as unknown as Mock).mockImplementation((first?: unknown, second?: unknown) => {
      const record: BuiltClient = {
        baseDir: typeof first === "string" ? first : undefined,
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

  it("fetches with the block timeout and ff-merges without one", async () => {
    (fs.readdir as unknown as Mock).mockResolvedValue([".git"]);
    (fs.access as unknown as Mock).mockResolvedValue(undefined);
    const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

    await service.initialize();
    await service.runSyncAttempt();

    expect(onlyClientThatRan("fetch").options.timeout).toEqual({ block: DEFAULT_CONFIG.FETCH_TIMEOUT_MS });
    expect(onlyClientThatRan("merge", "origin/main").options.timeout).toBeUndefined();
    for (const client of clientsThatRan("rev-parse", "--abbrev-ref", "HEAD")) {
      expect(client.options.timeout).toBeUndefined();
    }
  });

  it("clones with the clone timeout and configures the clone without a timeout", async () => {
    (fs.readdir as unknown as Mock).mockRejectedValue(
      Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
    );
    (fs.access as unknown as Mock).mockResolvedValue(undefined);
    (fs.mkdir as unknown as Mock).mockResolvedValue(undefined);
    (fs.writeFile as unknown as Mock).mockResolvedValue(undefined);
    const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

    await service.initialize();

    expect(onlyClientThatRan("clone").options.timeout).toEqual({ block: DEFAULT_CONFIG.CLONE_TIMEOUT_MS });
    expect(onlyClientThatRan("config", "--replace-all", "remote.origin.fetch").options.timeout).toBeUndefined();
  });

  it("runs ls-remote with the block timeout", async () => {
    (fs.access as unknown as Mock).mockRejectedValue(new Error("ENOENT"));
    const service = new CloneSyncService(makeConfig(), buildGitService(), logger);

    await service.getRemoteBranches();

    const lsRemote = onlyClientThatRan("ls-remote");
    expect(lsRemote.baseDir).toBeUndefined();
    expect(lsRemote.options.timeout).toEqual({ block: DEFAULT_CONFIG.FETCH_TIMEOUT_MS });
  });
});

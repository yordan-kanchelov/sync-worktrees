import * as fs from "fs/promises";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRIMARY_CHECKOUT_GIT_DIRS, PRIMARY_CHECKOUT_GIT_DIR_PROBE, buildFsStats } from "../../__tests__/test-utils";
import { CLONE_SYNC_PHASES } from "../clone-sync.service";
import { WorktreeSyncService } from "../worktree-sync.service";

import type { Config } from "../../types";
import type { Logger } from "../logger.service";
import type { RemoteRelationship } from "../git.service";
import type { Mock } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");

const { mockGitServiceInstance } = vi.hoisted(() => ({
  mockGitServiceInstance: {
    initialize: vi.fn<any>().mockResolvedValue(undefined),
    isInitialized: vi.fn().mockReturnValue(true),
    updateLogger: vi.fn(),
    setStaleDirectoryTrasher: vi.fn(),
    setLfsSkipEnabled: vi.fn(),
    isLfsSkipEnabled: vi.fn().mockReturnValue(false),
    verifyLfs: vi.fn<any>().mockResolvedValue(undefined),
    getRemoteDefaultBranch: vi.fn<any>().mockResolvedValue("main"),
    getSparseCheckoutService: vi.fn(),
    classifyRemoteRelationship: vi.fn<any>(),
    checkWorktreeStatus: vi.fn<any>(),
  },
}));

vi.mock("../git.service", () => ({
  GitService: vi.fn(function () {
    return mockGitServiceInstance;
  }),
}));

// A clock the mocked git commands move by hand, so each phase's duration is
// exactly what this test says it is. PhaseTimer and Timer read Date.now().
let now = 0;
const spend = (ms: number): void => {
  now += ms;
};

// The rows of a rendered timing table, keyed by the phase name they name. The
// table is cli-table3 box drawing, so a phase is looked up by the line its name
// appears on and read back as that line's duration cell.
function tableRow(table: string, phase: string): string | undefined {
  return table.split("\n").find((line) => line.includes(phase));
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    name: "clone-repo",
    repoUrl: "https://github.com/example/repo.git",
    worktreeDir: "/test/clone",
    cronSchedule: "0 * * * *",
    runOnce: true,
    mode: "clone",
    branch: "main",
    debug: true,
    trash: { enabled: false },
    ...overrides,
  } as Config;
}

// The probes a clone-mode tick makes, each spending a distinct, recognizable
// slice of the clock so a row that reports another phase's cost is visible in
// the assertion rather than plausible.
function installGitMock(options: { shallow?: boolean } = {}): { fetch: Mock; merge: Mock } {
  const client = {
    raw: vi.fn(async (args: string[]) => {
      const key = args.join(" ");
      if (key === PRIMARY_CHECKOUT_GIT_DIR_PROBE) return PRIMARY_CHECKOUT_GIT_DIRS;
      if (key === "rev-parse --abbrev-ref HEAD") {
        spend(500);
        return "main";
      }
      if (key === "remote get-url origin") {
        spend(500);
        return "https://github.com/example/repo.git";
      }
      if (key === "rev-parse --is-shallow-repository") {
        spend(1000);
        return options.shallow ? "true" : "false";
      }
      if (key.startsWith("config --local -z --get-regexp")) {
        spend(2000);
        return "";
      }
      if (key.startsWith("show-ref --verify")) {
        spend(3000);
        return "";
      }
      return "";
    }),
    clone: vi.fn<any>().mockResolvedValue(undefined),
    fetch: vi.fn(async () => {
      spend(4000);
    }),
    merge: vi.fn(async () => {
      spend(6000);
    }),
    env: vi.fn(),
  };
  client.env.mockReturnValue(client);
  (simpleGit as unknown as Mock).mockReturnValue(client);
  return { fetch: client.fetch as unknown as Mock, merge: client.merge as unknown as Mock };
}

// An initialized clone-mode service: the tick under test is an ordinary one, not
// the one that cloned, so init is not what this suite is about.
function makeService(config: Config): WorktreeSyncService {
  const service = new WorktreeSyncService(config);
  const cloneSync = (service as unknown as { cloneSyncService: { initialized: boolean; resolvedBranch: string } })
    .cloneSyncService;
  cloneSync.initialized = true;
  cloneSync.resolvedBranch = "main";
  return service;
}

function lastTable(logger: Logger): string {
  const table = logger.table as unknown as Mock;
  expect(table).toHaveBeenCalledTimes(1);
  return String(table.mock.calls[0][0]);
}

describe("clone-mode phase timing", () => {
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    (fs.lstat as Mock<any>).mockResolvedValue(buildFsStats("directory"));
    (fs.realpath as Mock<any>).mockImplementation(async (...args: unknown[]) => String(args[0]));
    (fs.readdir as Mock<any>).mockResolvedValue([]);

    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      table: vi.fn(),
    } as unknown as Logger;

    mockGitServiceInstance.classifyRemoteRelationship.mockImplementation(async (): Promise<RemoteRelationship> => {
      spend(1500);
      return "fast_forward";
    });
    // The scan the failure this suite exists for was spent in: a 38-second
    // `git status` over a large checkout.
    mockGitServiceInstance.checkWorktreeStatus.mockImplementation(async () => {
      spend(38000);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attributes a fast-forward tick to its phases in the worktree-mode table", async () => {
    installGitMock();

    const service = makeService(makeConfig({ logger }));
    const result = await service.sync();

    expect(result.started).toBe(true);
    const table = lastTable(logger);

    // What the acceptance asks for: the phases a slow tick is spent in are
    // named alongside the total, not folded into it.
    expect(table).toContain("Performance Summary - [clone-repo]");
    expect(tableRow(table, "Total Sync")).toContain("56.5s");
    expect(tableRow(table, CLONE_SYNC_PHASES.FETCH)).toContain("4.0s");
    expect(tableRow(table, CLONE_SYNC_PHASES.STATUS)).toContain("38.0s");
    expect(tableRow(table, CLONE_SYNC_PHASES.CLASSIFY)).toContain("1.5s");

    // And the rest of the tick, in the order it ran.
    expect(tableRow(table, CLONE_SYNC_PHASES.VALIDATE)).toContain("1.0s");
    expect(tableRow(table, CLONE_SYNC_PHASES.UNSHALLOW)).toContain("1.0s");
    expect(tableRow(table, CLONE_SYNC_PHASES.REMOTE_CONFIG)).toContain("2.0s");
    expect(tableRow(table, CLONE_SYNC_PHASES.VERIFY_REF)).toContain("3.0s");
    expect(tableRow(table, CLONE_SYNC_PHASES.MERGE)).toContain("6.0s");
  });

  // Since a tick classifies before it reads the working tree, most ticks never
  // scan at all. A phase that did not run has no row — the same way worktree
  // mode prints no update phase when updates are off — and the fixed phase
  // numbers leave the gap visible. A zero-duration row would claim the scan ran
  // and cost nothing.
  it("prints no status row for a tick that never scanned the working tree", async () => {
    installGitMock();
    mockGitServiceInstance.classifyRemoteRelationship.mockImplementation(async (): Promise<RemoteRelationship> => {
      spend(1500);
      return "up_to_date";
    });

    const service = makeService(makeConfig({ logger }));
    await service.sync();

    const table = lastTable(logger);

    expect(mockGitServiceInstance.checkWorktreeStatus).not.toHaveBeenCalled();
    expect(table).not.toContain(CLONE_SYNC_PHASES.STATUS);
    expect(table).not.toContain(CLONE_SYNC_PHASES.MERGE);
    // The phases that did run are all there, so the missing row is a phase the
    // tick skipped rather than a table that stopped early.
    expect(tableRow(table, CLONE_SYNC_PHASES.CLASSIFY)).toContain("1.5s");
    expect(tableRow(table, CLONE_SYNC_PHASES.VERIFY_REF)).toContain("3.0s");
    expect(tableRow(table, "Total Sync")).toContain("12.5s");
  });

  // The phase names are asserted through the exported constants everywhere
  // else, which cannot catch a value edited out of the shared
  // 'Phase N: Name' convention both modes print. One literal does.
  it("names the phases in the same format worktree mode prints", async () => {
    installGitMock();

    const service = makeService(makeConfig({ logger }));
    await service.sync();

    expect(lastTable(logger)).toContain("Phase 8: Status");
  });

  // A sparse-checkout phase is the same rule on a phase that is configuration
  // rather than state: nothing configured, no row.
  it("prints no sparse row when sparse-checkout is not configured", async () => {
    installGitMock();

    const service = makeService(makeConfig({ logger }));
    await service.sync();

    expect(lastTable(logger)).not.toContain(CLONE_SYNC_PHASES.SPARSE);
  });

  // The deepen fetches interleave with the classification reads they feed, so
  // they are the classify phase's count rather than a phase of their own.
  it("counts the deepen fetches a shallow tick spent inside classify", async () => {
    const { fetch } = installGitMock({ shallow: true });
    let classifications = 0;
    mockGitServiceInstance.classifyRemoteRelationship.mockImplementation(async (): Promise<RemoteRelationship> => {
      spend(1500);
      classifications++;
      return classifications === 1 ? "indeterminate_shallow" : "fast_forward";
    });

    const service = makeService(makeConfig({ logger, depth: 1 }));
    await service.sync();

    const table = lastTable(logger);

    // One sync fetch plus the one deepen fetch the classifier spent.
    expect(fetch).toHaveBeenCalledTimes(2);
    const classifyRow = tableRow(table, CLONE_SYNC_PHASES.CLASSIFY);
    expect(classifyRow).toContain("(1)");
    // Both classification reads and the deepen fetch between them.
    expect(classifyRow).toContain("7.0s");
  });

  it("prints no table at all when debug is off", async () => {
    installGitMock();

    const service = makeService(makeConfig({ logger, debug: false }));
    await service.sync();

    expect(logger.table).not.toHaveBeenCalled();
  });
});

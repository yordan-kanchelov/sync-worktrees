import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../constants";
import { runMultipleRepositories } from "../index";
import { setupSignalHandlers } from "../utils/signal-handlers";

import type { ConfigFile, RepositoryConfig } from "../types";

/**
 * The daemon half of `runMultipleRepositories` — everything that happens when
 * `runOnce` is false. Until now only the `--runOnce` half was exercised
 * (index.run-once.test.ts); this branch was mocked away wholesale, so the wiring
 * it does — one service per repository, the arguments the UI service is handed,
 * the schedule summary, the shutdown hook — was asserted nowhere.
 *
 * InteractiveUIService is a mock here on purpose, and that is the whole point
 * rather than a shortcut: the real one renders an Ink tree and registers cron
 * jobs that outlive the call, so a test built on it would leave handles behind
 * and hang the run. Its own behaviour has its own tests
 * (services/__tests__/interactive-ui.service.test.ts). What is under test here
 * is index.ts's side of that boundary, which is only visible as the arguments it
 * passes and the calls it makes.
 */

interface FakeUiService {
  addLog: ReturnType<typeof vi.fn>;
  calculateAndUpdateDiskSpace: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  setupCronJobs: ReturnType<typeof vi.fn>;
  setRepositoryFilter: ReturnType<typeof vi.fn>;
  triggerInitialSync: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  createLogger: vi.fn(),
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    table: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  initialize: vi.fn(),
  sync: vi.fn(),
  registerSignalHandler: vi.fn(),
  disposeSignalHandler: vi.fn(),
  // Every addLog line and the startup sync, in the order index.ts made them:
  // the summary lines are only "first" if nothing can overtake them.
  callOrder: [] as string[],
  // When set, the promise the fake startup sync returns — a sync still running
  // when `runMultipleRepositories` is expected to have returned.
  initialSyncGate: null as Promise<void> | null,
  // Constructor arguments paired with the object that construction returned. A
  // fresh object every time, never one shared instance: the daemon is supposed
  // to build exactly one UI service per run, and a shared spy would report the
  // same calls whether it built one or five.
  uiConstructions: [] as Array<{ args: unknown[]; instance: FakeUiService }>,
  syncServiceConstructions: [] as Array<{ config: RepositoryConfig; instance: unknown }>,
}));

vi.mock("../services/InteractiveUIService", () => ({
  InteractiveUIService: vi.fn(function (...args: unknown[]) {
    const instance: FakeUiService = {
      addLog: vi.fn((line: unknown) => {
        mocks.callOrder.push(`addLog:${String(line)}`);
      }),
      calculateAndUpdateDiskSpace: vi.fn(),
      destroy: vi.fn(),
      setupCronJobs: vi.fn(),
      setRepositoryFilter: vi.fn(),
      // Returns a promise, because index.ts leaves it unawaited and `void` on
      // a non-promise would be a different statement than the one under test.
      // `initialSyncGate` lets a test hold that promise open.
      triggerInitialSync: vi.fn(() => {
        mocks.callOrder.push("triggerInitialSync");
        return mocks.initialSyncGate ?? Promise.resolve();
      }),
    };
    mocks.uiConstructions.push({ args, instance });
    return instance;
  }),
}));

vi.mock("../services/logger.service", () => ({
  Logger: {
    createDefault: mocks.createLogger,
  },
}));

vi.mock("../services/worktree-sync.service", () => ({
  WorktreeSyncService: vi.fn(function (config: RepositoryConfig) {
    const instance = {
      getRecordedSkips: vi.fn(() => []),
      initialize: mocks.initialize,
      sync: mocks.sync,
    };
    mocks.syncServiceConstructions.push({ config, instance });
    return instance;
  }),
}));

vi.mock("../utils/signal-handlers", () => ({
  setupSignalHandlers: vi.fn(() => ({
    register: mocks.registerSignalHandler,
    dispose: mocks.disposeSignalHandler,
  })),
}));

function repository(name: string, cronSchedule: string): RepositoryConfig {
  return {
    name,
    repoUrl: `https://github.com/test/${name}.git`,
    worktreeDir: `/tmp/${name}`,
    cronSchedule,
    runOnce: false,
  };
}

/** A config file with `runOnce` off — the only thing that selects this branch. */
function daemonConfig(repositories: RepositoryConfig[], extra: Partial<ConfigFile> = {}): ConfigFile {
  return { defaults: { runOnce: false }, repositories, ...extra };
}

describe("runMultipleRepositories in daemon mode", () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.clearAllMocks();
    mocks.uiConstructions.length = 0;
    mocks.syncServiceConstructions.length = 0;
    mocks.callOrder.length = 0;
    mocks.initialSyncGate = null;
    mocks.createLogger.mockReturnValue(mocks.logger);
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
  });

  it("builds one sync service per repository and drives none of them directly", async () => {
    const repos = [repository("repo-a", "0 * * * *"), repository("repo-b", "0 * * * *")];

    await runMultipleRepositories(daemonConfig(repos), repos);

    // Order matters: the UI lists repositories in the order it was handed them.
    expect(mocks.syncServiceConstructions.map((built) => built.config)).toEqual(repos);
    // The startup sync and every cron tick go through the UI service, which owns
    // the progress plumbing, the parallelism limit and the lazy initialize. The
    // daemon branch must never reach past it into the services itself the way
    // the run-once branch does.
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
    // Nothing failed, and nothing in this branch reports an outcome at all.
    expect(process.exitCode).toBeUndefined();
  });

  it("hands the UI service the services it built, the config path and the parallelism limit", async () => {
    const repos = [repository("repo-a", "*/15 * * * *"), repository("repo-b", "*/15 * * * *")];

    await runMultipleRepositories(daemonConfig(repos, { parallelism: { maxRepositories: 5 } }), repos, "/etc/s.js");

    expect(mocks.uiConstructions).toHaveLength(1);
    const [services, configPath, displaySchedule, maxParallel] = mocks.uiConstructions[0].args;

    expect(services).toEqual(mocks.syncServiceConstructions.map((built) => built.instance));
    expect(configPath).toBe("/etc/s.js");
    // One shared schedule, so the UI can show it as *the* schedule.
    expect(displaySchedule).toBe("*/15 * * * *");
    expect(maxParallel).toBe(5);
  });

  it("shows no schedule when the repositories do not share one", async () => {
    const repos = [repository("repo-a", "0 * * * *"), repository("repo-b", "*/5 * * * *")];

    await runMultipleRepositories(daemonConfig(repos), repos);

    expect(mocks.uiConstructions[0].args[2]).toBeUndefined();
  });

  it("takes maxRepositories from `defaults` when the top level does not set it", async () => {
    const repos = [repository("repo-a", "0 * * * *")];
    const config = daemonConfig(repos);
    config.defaults = { ...config.defaults, parallelism: { maxRepositories: 7 } };

    await runMultipleRepositories(config, repos);

    expect(mocks.uiConstructions[0].args[3]).toBe(7);
  });

  it("prefers the top-level maxRepositories over the one in `defaults`", async () => {
    const repos = [repository("repo-a", "0 * * * *")];
    const config = daemonConfig(repos, { parallelism: { maxRepositories: 5 } });
    config.defaults = { ...config.defaults, parallelism: { maxRepositories: 7 } };

    await runMultipleRepositories(config, repos);

    expect(mocks.uiConstructions[0].args[3]).toBe(5);
  });

  it("falls back to the built-in maxRepositories when neither level sets one", async () => {
    const repos = [repository("repo-a", "0 * * * *")];

    await runMultipleRepositories(daemonConfig(repos), repos);

    expect(mocks.uiConstructions[0].args[3]).toBe(DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES);
    // The two cases above deliberately use numbers this is not, so neither of
    // them can be passing on the fallback.
    expect(DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES).not.toBe(5);
    expect(DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES).not.toBe(7);
  });

  it("starts the cron jobs and the disk-space probe exactly once", async () => {
    const repos = [repository("repo-a", "0 * * * *"), repository("repo-b", "0 * * * *")];

    await runMultipleRepositories(daemonConfig(repos), repos);

    const { instance } = mocks.uiConstructions[0];
    expect(instance.setupCronJobs).toHaveBeenCalledTimes(1);
    expect(instance.calculateAndUpdateDiskSpace).toHaveBeenCalledTimes(1);
  });

  it("logs the repository count and one line per distinct schedule with its share", async () => {
    const repos = [
      repository("repo-a", "0 * * * *"),
      repository("repo-b", "*/5 * * * *"),
      repository("repo-c", "0 * * * *"),
    ];

    await runMultipleRepositories(daemonConfig(repos), repos);

    const logged = mocks.uiConstructions[0].instance.addLog.mock.calls.map(([line]) => line as string);

    // Pinned as the whole list, in order: a schedule that got dropped, one
    // counted twice, or a count attributed to the wrong schedule all read the
    // same to a `toContain` on each line separately.
    expect(logged).toEqual([
      "📋 3 repositories configured",
      "⏰ 0 * * * *: 2 repository(ies)",
      "⏰ */5 * * * *: 1 repository(ies)",
    ]);
  });

  it("syncs once at startup when `defaults.syncOnStart` is left out", async () => {
    const repos = [repository("repo-a", "0 * * * *"), repository("repo-b", "0 * * * *")];

    await runMultipleRepositories(daemonConfig(repos), repos);

    // One cycle for the whole run, not one per repository: triggerInitialSync
    // takes every service the UI owns.
    expect(mocks.uiConstructions[0].instance.triggerInitialSync).toHaveBeenCalledTimes(1);
    expect(mocks.uiConstructions[0].instance.triggerInitialSync).toHaveBeenCalledWith();
  });

  it("syncs once at startup when `defaults.syncOnStart` is true", async () => {
    const repos = [repository("repo-a", "0 * * * *")];
    const config = daemonConfig(repos);
    config.defaults = { ...config.defaults, syncOnStart: true };

    await runMultipleRepositories(config, repos);

    expect(mocks.uiConstructions[0].instance.triggerInitialSync).toHaveBeenCalledTimes(1);
  });

  it("waits for the first cron tick when `defaults.syncOnStart` is false", async () => {
    const repos = [repository("repo-a", "0 * * * *")];
    const config = daemonConfig(repos);
    config.defaults = { ...config.defaults, syncOnStart: false };

    await runMultipleRepositories(config, repos);

    expect(mocks.uiConstructions[0].instance.triggerInitialSync).not.toHaveBeenCalled();
    // Opting out of the startup sync is not opting out of the schedule.
    expect(mocks.uiConstructions[0].instance.setupCronJobs).toHaveBeenCalledTimes(1);
  });

  it("starts the startup sync after the summary lines", async () => {
    const repos = [repository("repo-a", "0 * * * *")];

    await runMultipleRepositories(daemonConfig(repos), repos);

    // The summary is what a user sees first; a sync started ahead of it would
    // push its own fetch output above "📋 1 repositories configured", because
    // both go through the same ordered log buffer.
    expect(mocks.callOrder).toEqual([
      "addLog:📋 1 repositories configured",
      "addLog:⏰ 0 * * * *: 1 repository(ies)",
      "triggerInitialSync",
    ]);
  });

  it("returns while the startup sync is still running", async () => {
    const repos = [repository("repo-a", "0 * * * *")];
    const order: string[] = [];
    let release!: () => void;
    mocks.initialSyncGate = new Promise<void>((resolve) => {
      release = () => {
        order.push("startup sync finished");
        resolve();
      };
    });

    const call = runMultipleRepositories(daemonConfig(repos), repos).then(() => {
      order.push("runMultipleRepositories returned");
    });

    // Ordering, not a stopwatch: two turns of the event loop settle everything
    // this branch does not await (it awaits nothing else), while anything it
    // does await cannot settle until `release()` below. A loaded CI runner just
    // makes the turns take longer; it cannot change which of the two is first.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(order).toEqual(["runMultipleRepositories returned"]);
    expect(mocks.uiConstructions[0].instance.triggerInitialSync).toHaveBeenCalledTimes(1);

    release();
    await call;
    expect(order).toEqual(["runMultipleRepositories returned", "startup sync finished"]);
  });

  it("routes a shutdown signal to the UI service, passing the fast flag through", async () => {
    const repos = [repository("repo-a", "0 * * * *")];

    await runMultipleRepositories(daemonConfig(repos), repos);

    // A daemon runs until it is signalled, so tearing the UI down is the only
    // exit path this branch has; nothing else disposes the Ink render.
    expect(mocks.registerSignalHandler).toHaveBeenCalledTimes(1);
    const onShutdown = mocks.registerSignalHandler.mock.calls[0][0] as (fast: boolean) => void;

    const { instance } = mocks.uiConstructions[0];
    onShutdown(true);
    expect(instance.destroy).toHaveBeenCalledWith(true);
    onShutdown(false);
    expect(instance.destroy).toHaveBeenLastCalledWith(false);
  });

  it("installs the plain signal handlers, not the run-once exit-code variant", async () => {
    const repos = [repository("repo-a", "0 * * * *")];

    await runMultipleRepositories(daemonConfig(repos), repos);

    // `--runOnce` asks for `{ exitAfterCleanupCode: 130 }` so a Ctrl+C during a
    // one-shot run reports as interrupted. A daemon must not inherit that: it
    // exits by being signalled, which is its normal end, not a failure.
    expect(vi.mocked(setupSignalHandlers)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setupSignalHandlers)).toHaveBeenCalledWith();
    // And a daemon never disposes them while it is still running.
    expect(mocks.disposeSignalHandler).not.toHaveBeenCalled();
  });
  // A reload re-reads the config file, so the UI has to be told what the run
  // was narrowed to or `r` would quietly widen it back to every repository.
  it("hands the --filter to the UI so a config reload keeps it", async () => {
    const repos = [repository("backend-api", "0 * * * *")];

    await runMultipleRepositories(daemonConfig(repos), repos, "/etc/s.js", { filter: "backend-*" });

    expect(mocks.uiConstructions).toHaveLength(1);
    expect(mocks.uiConstructions[0].instance.setRepositoryFilter).toHaveBeenCalledWith("backend-*");
  });

  it("leaves the UI unfiltered without --filter", async () => {
    const repos = [repository("repo-a", "0 * * * *")];

    await runMultipleRepositories(daemonConfig(repos), repos);

    expect(mocks.uiConstructions[0].instance.setRepositoryFilter).not.toHaveBeenCalled();
  });
});

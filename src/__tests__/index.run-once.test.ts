import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runMultipleRepositories } from "../index";
import { InteractiveUIService } from "../services/InteractiveUIService";
import { WorktreeSyncService } from "../services/worktree-sync.service";

import type { ConfigFile, RepositoryConfig, SyncOutcomeCounts } from "../types";

const mocks = vi.hoisted(() => ({
  createLogger: vi.fn(),
  getRecordedSkips: vi.fn(),
  initialize: vi.fn(),
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    table: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  registerSignalHandler: vi.fn(),
  sync: vi.fn(),
  triggerInitialSync: vi.fn(),
}));

vi.mock("../services/InteractiveUIService", () => ({
  InteractiveUIService: vi.fn(function () {
    return {
      addLog: vi.fn(),
      calculateAndUpdateDiskSpace: vi.fn(),
      destroy: vi.fn(),
      setupCronJobs: vi.fn(),
      triggerInitialSync: mocks.triggerInitialSync,
    };
  }),
}));

vi.mock("../services/logger.service", () => ({
  Logger: {
    createDefault: mocks.createLogger,
  },
}));

vi.mock("../services/worktree-sync.service", () => ({
  // The name is passed through to `initialize` so a test can make one
  // repository's initialization fail while the others succeed, the way a
  // parallel run does.
  WorktreeSyncService: vi.fn(function (config: RepositoryConfig) {
    return {
      getRecordedSkips: mocks.getRecordedSkips,
      initialize: (): Promise<void> => mocks.initialize(config.name) as Promise<void>,
      sync: mocks.sync,
    };
  }),
}));

vi.mock("../utils/signal-handlers", () => ({
  setupSignalHandlers: vi.fn(() => ({
    register: mocks.registerSignalHandler,
    dispose: vi.fn(),
  })),
}));

const emptyCounts = (): SyncOutcomeCounts => ({
  created: 0,
  removed: 0,
  updated: 0,
  skipped: 0,
  preserved: 0,
  failed: 0,
  noop: 0,
});

const repo: RepositoryConfig = {
  name: "repo-a",
  repoUrl: "https://github.com/test/repo-a.git",
  worktreeDir: "/tmp/repo-a",
  cronSchedule: "0 * * * *",
  runOnce: true,
};

const configFile: ConfigFile = {
  defaults: { runOnce: true },
  repositories: [repo],
};

describe("runMultipleRepositories", () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.clearAllMocks();

    mocks.createLogger.mockReturnValue(mocks.logger);
    mocks.getRecordedSkips.mockReturnValue([]);
    mocks.initialize.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
  });

  it("sets a failing exit status when structured outcomes contain failures", async () => {
    mocks.sync.mockResolvedValue({
      started: true,
      outcome: {
        actions: [],
        counts: { ...emptyCounts(), failed: 1 },
        mode: "worktree",
        started: true,
      },
    });

    await runMultipleRepositories(configFile, [repo]);

    expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining("1 failed"));
    expect(process.exitCode).toBe(1);
  });

  it("keeps a repo in `synced` when it completed with only per-action skips", async () => {
    mocks.sync.mockResolvedValue({
      started: true,
      outcome: {
        actions: [],
        counts: { ...emptyCounts(), skipped: 1 },
        mode: "worktree",
        started: true,
      },
    });

    await runMultipleRepositories(configFile, [repo]);

    const summaryCall = mocks.logger.info.mock.calls.find(
      (args) => typeof args[0] === "string" && (args[0] as string).includes("Processed"),
    );
    const summary = summaryCall?.[0] as string | undefined;
    expect(summary).toBeDefined();
    expect(summary).toContain("1 synced");
    expect(summary).toContain("1 with partial skips");
    // Zero skips are not reported at all.
    expect(summary).not.toMatch(/skipped|clone-mode/);
    expect(summary).toContain("0 failed");
    expect(process.exitCode).toBeUndefined();
  });

  it("does not double-count a repo that has both per-action failures and per-action skips", async () => {
    mocks.sync.mockResolvedValue({
      started: true,
      outcome: {
        actions: [],
        counts: { ...emptyCounts(), failed: 1, skipped: 1 },
        mode: "worktree",
        started: true,
      },
    });

    await runMultipleRepositories(configFile, [repo]);

    const summaryCall = mocks.logger.info.mock.calls.find(
      (args) => typeof args[0] === "string" && (args[0] as string).includes("Processed"),
    );
    const summary = summaryCall?.[0] as string | undefined;
    expect(summary).toBeDefined();
    // 1 repo total — only counted as failed, never inflating skipped or partial-skip totals.
    expect(summary).toContain("0 synced");
    expect(summary).not.toMatch(/skipped|clone-mode/);
    expect(summary).toContain("1 failed");
    expect(summary).not.toContain("with partial skips");
    expect(process.exitCode).toBe(1);
  });

  it("counts a repo whose lock could not be taken as failed and names it in the summary", async () => {
    // Not contention: the state directory is a file / unwritable, so nothing
    // synced this repo and nothing will. A green exit here would let a CI
    // pipeline pass without a single clone, worktree or fetch.
    mocks.sync.mockResolvedValue({
      started: false,
      reason: "lock_unavailable",
      path: "/state/sync-worktrees/locks",
      code: "ENOTDIR",
      error: "ENOTDIR: not a directory, mkdir '/state/sync-worktrees/locks'",
    });

    await runMultipleRepositories(configFile, [repo]);

    const summaryCall = mocks.logger.info.mock.calls.find(
      (args) => typeof args[0] === "string" && (args[0] as string).includes("Processed"),
    );
    const summary = summaryCall?.[0] as string | undefined;
    expect(summary).toBeDefined();
    expect(summary).toContain("0 synced");
    expect(summary).not.toMatch(/skipped|clone-mode/);
    expect(summary).toContain("1 failed (1 lock unavailable)");
    expect(process.exitCode).toBe(1);

    const everyLine = [
      ...mocks.logger.info.mock.calls,
      ...mocks.logger.warn.mock.calls,
      ...mocks.logger.error.mock.calls,
    ]
      .map((args) => args[0])
      .filter((arg): arg is string => typeof arg === "string");
    expect(everyLine.join("\n")).not.toMatch(/another process holds/i);
  });

  it("keeps a contended lock as a skip with a clean exit status", async () => {
    mocks.sync.mockResolvedValue({ started: false, reason: "locked" });

    await runMultipleRepositories(configFile, [repo]);

    const summaryCall = mocks.logger.info.mock.calls.find(
      (args) => typeof args[0] === "string" && (args[0] as string).includes("Processed"),
    );
    const summary = summaryCall?.[0] as string | undefined;
    expect(summary).toBeDefined();
    expect(summary).toContain("0 synced");
    expect(summary).toContain("1 skipped");
    expect(summary).toContain("0 failed");
    expect(summary).not.toContain("lock unavailable");
    expect(process.exitCode).toBeUndefined();
  });

  it("counts a rejected sync as failed even when the repo recorded a soft skip first", async () => {
    mocks.getRecordedSkips.mockReturnValue([{ kind: "dirty_tree", worktreePath: "/tmp/repo-a" }]);
    mocks.sync.mockRejectedValue(new Error("network failed"));

    await runMultipleRepositories(configFile, [repo]);

    const summary = mocks.logger.info.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.includes("Processed"));
    expect(summary).toContain("1 failed");
    expect(summary).not.toMatch(/skipped|clone-mode/);
    expect(process.exitCode).toBe(1);
  });

  it("prints the run-once banner with credentials stripped from the repository URL", async () => {
    mocks.sync.mockResolvedValue({
      started: true,
      outcome: { actions: [], counts: emptyCounts(), mode: "worktree", started: true },
    });
    const tokenRepo: RepositoryConfig = { ...repo, repoUrl: "https://ci-bot:s3cr3t-token@example.com/r.git" };

    await runMultipleRepositories(configFile, [tokenRepo]);

    expect(mocks.logger.info).toHaveBeenCalledWith("   URL: https://***@example.com/r.git");
    const everything = [
      ...mocks.logger.info.mock.calls,
      ...mocks.logger.warn.mock.calls,
      ...mocks.logger.error.mock.calls,
    ]
      .flat()
      .map(String)
      .join("\n");
    expect(everything).not.toContain("s3cr3t-token");
  });
  // Under parallelism the "📦 Repository: <name>" header is printed whenever
  // that repository's task happens to start, so with N repositories in flight
  // a bare "Failed to initialize repository:" left no way to tell which one
  // died. allSettled hands the results back in the order it was given them, so
  // the index is the answer.
  it("names the repository whose initialization failed", async () => {
    const repoB: RepositoryConfig = { ...repo, name: "repo-b", worktreeDir: "/tmp/repo-b" };
    const repoC: RepositoryConfig = { ...repo, name: "repo-c", worktreeDir: "/tmp/repo-c" };
    mocks.initialize.mockImplementation((name: string) =>
      name === "repo-b" ? Promise.reject(new Error("clone failed")) : Promise.resolve(),
    );
    mocks.sync.mockResolvedValue({
      started: true,
      outcome: { actions: [], counts: emptyCounts(), mode: "worktree", started: true },
    });

    await runMultipleRepositories(configFile, [repo, repoB, repoC]);

    const errors = mocks.logger.error.mock.calls.map((args) => String(args[0])).join("\n");
    expect(errors).toContain("Failed to initialize repository 'repo-b'");
    // Not "a name was interpolated": the two that initialized fine must not be
    // blamed, which is what reading the wrong index would do.
    expect(errors).not.toContain("repo-a");
    expect(errors).not.toContain("repo-c");
    expect(process.exitCode).toBe(1);
  });

  it("pluralises the banner and summary, and adds the elapsed time to the summary", async () => {
    mocks.sync.mockResolvedValue({
      started: true,
      outcome: { actions: [], counts: emptyCounts(), mode: "worktree", started: true },
    });

    await runMultipleRepositories(configFile, [repo]);

    const lines = mocks.logger.info.mock.calls.map((args) => String(args[0]));
    expect(lines).toContain("\n🔄 Syncing 1 repository...");
    // A worktree-only run has no skips of any kind to report.
    expect(lines.find((line) => line.includes("Processed"))).toMatch(
      /^\n📊 Processed 1 repo in \d+(ms|\.\ds): 1 synced, 0 failed$/,
    );
    // The header's blank line is not routed through the repository's prefix,
    // which printed a line holding nothing but "[repo-a] ".
    expect(lines).toContain("📦 Repository: repo-a");
    expect(lines.filter((line) => line.startsWith("\n📦"))).toEqual([]);
    // Nothing failed, so there is nothing to hint about.
    expect(lines.join("\n")).not.toContain("--debug");
  });

  it("points at --debug after a failure, and at repoUrl/credentials when a repository did not initialize", async () => {
    mocks.initialize.mockRejectedValue(new Error("clone failed"));

    await runMultipleRepositories(configFile, [repo]);

    const hint = mocks.logger.info.mock.calls.map((args) => String(args[0])).find((line) => line.startsWith("💡"));
    expect(hint).toContain("--debug");
    expect(hint).toContain("repoUrl");
  });

  it("does not print the --debug hint when debug is already on", async () => {
    mocks.initialize.mockRejectedValue(new Error("clone failed"));

    await runMultipleRepositories(configFile, [{ ...repo, debug: true }]);

    expect(mocks.logger.info.mock.calls.map((args) => String(args[0])).join("\n")).not.toContain("💡");
    // The run-level logger follows the repositories' debug setting, so it keeps
    // the full error detail as well.
    expect(mocks.createLogger).toHaveBeenCalledWith(undefined, true);
  });

  it("never builds the UI, so `syncOnStart` cannot sync a one-shot run twice", async () => {
    mocks.sync.mockResolvedValue({
      started: true,
      outcome: { actions: [], counts: emptyCounts(), mode: "worktree", started: true },
    });

    // `syncOnStart` defaults to true and this config does not turn it off: the
    // guard is the branch, not the flag. A one-shot run syncs in this function
    // and must not also hand a startup cycle to a UI it never renders.
    await runMultipleRepositories({ ...configFile, defaults: { runOnce: true } }, [repo]);

    expect(vi.mocked(InteractiveUIService)).not.toHaveBeenCalled();
    expect(mocks.triggerInitialSync).not.toHaveBeenCalled();
    expect(mocks.sync).toHaveBeenCalledTimes(1);
  });

  // --quiet is for cron, which mails whatever reaches stdout: the per-repo
  // loggers go quiet, the banner goes, and the one summary line stays.
  it("under --quiet, builds quiet repository loggers and keeps only the summary line", async () => {
    mocks.sync.mockResolvedValue({
      started: true,
      outcome: { actions: [], counts: emptyCounts(), mode: "worktree", started: true },
    });

    await runMultipleRepositories(configFile, [repo], undefined, { quiet: true });

    expect(mocks.createLogger).toHaveBeenCalledWith(repo.name, repo.debug, { quiet: true });
    const infoLines = mocks.logger.info.mock.calls.map((args) => String(args[0]));
    expect(infoLines.some((line) => line.includes("Syncing"))).toBe(false);
    expect(infoLines.filter((line) => line.includes("Processed"))).toHaveLength(1);
    // No leading blank line: it separated the summary from output that --quiet dropped.
    expect(infoLines.find((line) => line.includes("Processed"))).toMatch(/^📊 Processed 1 repo in /);
    // Nor the blank line that separates each repository's header block.
    expect(infoLines).not.toContain("");
  });

  it("prints the banner and builds loud repository loggers without --quiet", async () => {
    mocks.sync.mockResolvedValue({
      started: true,
      outcome: { actions: [], counts: emptyCounts(), mode: "worktree", started: true },
    });

    await runMultipleRepositories(configFile, [repo]);

    expect(mocks.createLogger).toHaveBeenCalledWith(repo.name, repo.debug, { quiet: undefined });
    expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining("Syncing 1 repository..."));
  });

  it("hands each service its logger without writing it into the loaded configuration", async () => {
    mocks.sync.mockResolvedValue({
      started: true,
      outcome: { actions: [], counts: emptyCounts(), mode: "worktree", started: true },
    });
    const loaded: RepositoryConfig = { ...repo };

    await runMultipleRepositories(configFile, [loaded]);

    expect(loaded.logger).toBeUndefined();
    expect(vi.mocked(WorktreeSyncService)).toHaveBeenCalledWith(
      expect.objectContaining({ name: "repo-a", logger: mocks.logger }),
    );
  });

  it("keeps a logger the configuration already carries", async () => {
    mocks.sync.mockResolvedValue({
      started: true,
      outcome: { actions: [], counts: emptyCounts(), mode: "worktree", started: true },
    });
    const ownLogger = { ...mocks.logger };
    const loaded = { ...repo, logger: ownLogger } as unknown as RepositoryConfig;

    await runMultipleRepositories(configFile, [loaded]);

    expect(loaded.logger).toBe(ownLogger);
    expect(vi.mocked(WorktreeSyncService)).toHaveBeenCalledWith(expect.objectContaining({ logger: ownLogger }));
  });
});

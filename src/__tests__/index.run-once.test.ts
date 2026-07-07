import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runMultipleRepositories } from "../index";

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
}));

vi.mock("../services/InteractiveUIService", () => ({
  InteractiveUIService: vi.fn(function () {
    return {
      addLog: vi.fn(),
      calculateAndUpdateDiskSpace: vi.fn(),
      destroy: vi.fn(),
      setupCronJobs: vi.fn(),
    };
  }),
}));

vi.mock("../services/logger.service", () => ({
  Logger: {
    createDefault: mocks.createLogger,
  },
}));

vi.mock("../services/worktree-sync.service", () => ({
  WorktreeSyncService: vi.fn(function () {
    return {
      getRecordedSkips: mocks.getRecordedSkips,
      initialize: mocks.initialize,
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
    expect(summary).toMatch(/0 (skipped|with clone-mode skips|with skips)/);
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
    expect(summary).toMatch(/0 (skipped|with clone-mode skips|with skips)/);
    expect(summary).toContain("1 failed");
    expect(summary).not.toContain("with partial skips");
    expect(process.exitCode).toBe(1);
  });

  it("counts a rejected sync as failed even when the repo recorded a soft skip first", async () => {
    mocks.getRecordedSkips.mockReturnValue([{ kind: "dirty_tree", worktreePath: "/tmp/repo-a" }]);
    mocks.sync.mockRejectedValue(new Error("network failed"));

    await runMultipleRepositories(configFile, [repo]);

    expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining("1 failed"));
    expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining("0 skipped"));
    expect(process.exitCode).toBe(1);
  });
});

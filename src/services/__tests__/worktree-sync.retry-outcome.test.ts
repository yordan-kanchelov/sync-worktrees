import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorktreeSyncService } from "../worktree-sync.service";

import type { Config } from "../../types";
import type { Logger } from "../logger.service";
import type { SyncOutcomeAccumulator } from "../sync-outcome";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  retry: vi.fn(),
  runSyncAttempt: vi.fn(),
  setLfsSkipEnabled: vi.fn(),
}));

vi.mock("../../utils/retry", () => ({
  retry: mocks.retry,
}));

vi.mock("../git.service", () => ({
  GitService: vi.fn(function () {
    return {
      initialize: vi.fn(),
      isInitialized: vi.fn(() => true),
      setLfsSkipEnabled: mocks.setLfsSkipEnabled,
      updateLogger: vi.fn(),
      setStaleDirectoryTrasher: vi.fn(),
    };
  }),
}));

vi.mock("../repo-operation-lock", () => ({
  RepoOperationLock: vi.fn(function () {
    return {
      acquire: mocks.acquire,
    };
  }),
}));

vi.mock("../worktree-mode-sync-runner", () => ({
  WorktreeModeSyncRunner: vi.fn(function () {
    return {
      runSyncAttempt: mocks.runSyncAttempt,
      updateLogger: vi.fn(),
    };
  }),
}));

function makeConfig(): Config {
  return {
    repoUrl: "https://github.com/test/repo.git",
    worktreeDir: "/tmp/worktrees",
    cronSchedule: "0 * * * *",
    runOnce: true,
    retry: { maxAttempts: 2, initialDelayMs: 0 },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      table: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
  };
}

describe("WorktreeSyncService retry outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.acquire.mockResolvedValue(mocks.release);
    mocks.release.mockResolvedValue(undefined);
    mocks.retry.mockImplementation(async (fn: () => Promise<void>, options: { onRetry?: (...args: any[]) => void }) => {
      try {
        return await fn();
      } catch (error) {
        options.onRetry?.(error, 1, { isLfsError: false });
      }
      return fn();
    });
  });

  it("does not carry failed actions from retry attempts that later succeed", async () => {
    let attempt = 0;
    mocks.runSyncAttempt.mockImplementation(
      async (_phaseTimer: unknown, _syncContext: unknown, outcome: SyncOutcomeAccumulator) => {
        attempt++;

        if (attempt === 1) {
          outcome.recordFailed("worktree", "temporary network error", {
            reason: "update_failed",
            branch: "feature",
            path: "/tmp/worktrees/feature",
          });
          throw Object.assign(new Error("temporary network error"), { code: "ETIMEDOUT" });
        }

        outcome.recordNoop("repo", "retry_succeeded", {});
      },
    );

    const service = new WorktreeSyncService(makeConfig());
    const result = await service.sync();

    expect(result.started).toBe(true);
    if (!result.started) throw new Error(`Expected sync to start, got ${result.reason}`);

    expect(mocks.runSyncAttempt).toHaveBeenCalledTimes(2);
    expect(result.outcome.counts.failed).toBe(0);
    expect(result.outcome.counts.noop).toBe(1);
    expect(result.outcome.actions).toEqual([{ kind: "noop", scope: "repo", reason: "retry_succeeded" }]);
  });
});

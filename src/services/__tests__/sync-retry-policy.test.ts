import { describe, expect, it, vi } from "vitest";

import { SyncRetryPolicy } from "../sync-retry-policy";

import type { Config } from "../../types";
import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    repoUrl: "https://github.com/test/repo.git",
    worktreeDir: "/tmp/worktrees",
    cronSchedule: "0 * * * *",
    runOnce: false,
    ...overrides,
  };
}

function makePolicy(config: Config = makeConfig()): {
  policy: SyncRetryPolicy;
  gitService: Pick<GitService, "setLfsSkipEnabled">;
  logger: Pick<Logger, "info">;
} {
  const gitService = { setLfsSkipEnabled: vi.fn() };
  const logger = { info: vi.fn() };
  return {
    policy: new SyncRetryPolicy(config, gitService as unknown as GitService, logger as unknown as Logger),
    gitService,
    logger,
  };
}

describe("SyncRetryPolicy", () => {
  it("builds retry options from defaults and config overrides", () => {
    const { policy } = makePolicy(
      makeConfig({
        retry: {
          maxAttempts: 5,
          maxLfsRetries: 4,
          initialDelayMs: 10,
          maxDelayMs: 20,
          backoffMultiplier: 3,
        },
      }),
    );

    const options = policy.createOptions(policy.createContext());

    expect(options).toMatchObject({
      maxAttempts: 5,
      maxLfsRetries: 4,
      initialDelayMs: 10,
      maxDelayMs: 20,
      backoffMultiplier: 3,
    });
  });

  it("temporarily enables LFS skip only once for retry contexts", () => {
    const { policy, gitService } = makePolicy();
    const context = policy.createContext();
    const options = policy.createOptions(context);

    options.lfsRetryHandler?.({ isLfsError: true });
    options.lfsRetryHandler?.({ isLfsError: true });

    expect(context.lfsSkipEnabled).toBe(true);
    expect(gitService.setLfsSkipEnabled).toHaveBeenCalledTimes(1);
    expect(gitService.setLfsSkipEnabled).toHaveBeenCalledWith(true);
  });

  it("does not toggle LFS skip when skipLfs is configured", () => {
    const { policy, gitService } = makePolicy(makeConfig({ skipLfs: true }));
    const context = policy.createContext();
    const options = policy.createOptions(context);

    options.lfsRetryHandler?.({ isLfsError: true });
    policy.resetLfsSkipIfNeeded(context);

    expect(gitService.setLfsSkipEnabled).not.toHaveBeenCalled();
  });

  it("resets temporary LFS skip after sync", () => {
    const { policy, gitService } = makePolicy();
    const context = policy.createContext();
    context.lfsSkipEnabled = true;

    policy.resetLfsSkipIfNeeded(context);

    expect(gitService.setLfsSkipEnabled).toHaveBeenCalledWith(false);
  });

  it("logs LFS retry messages separately from generic retry messages", () => {
    const { policy, logger } = makePolicy();
    const options = policy.createOptions(policy.createContext());

    options.onRetry?.(new Error("smudge failed"), 1, { isLfsError: true });
    options.onRetry?.(new Error("network failed"), 2, { isLfsError: false });

    expect(logger.info).toHaveBeenCalledWith("🔄 LFS error detected. Will retry with LFS skipped...");
    expect(logger.info).toHaveBeenCalledWith("🔄 Retrying synchronization...\n");
  });
});

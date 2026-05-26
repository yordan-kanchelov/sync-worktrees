import { getErrorMessage } from "../utils/lfs-error";

import type { GitService } from "./git.service";
import type { Logger } from "./logger.service";
import type { Config } from "../types";
import type { RetryOptions } from "../utils/retry";

export interface SyncRetryContext {
  lfsSkipEnabled: boolean;
}

export class SyncRetryPolicy {
  constructor(
    private config: Config,
    private gitService: GitService,
    private logger: Logger,
  ) {}

  updateLogger(logger: Logger): void {
    this.logger = logger;
  }

  createContext(): SyncRetryContext {
    return { lfsSkipEnabled: false };
  }

  createOptions(syncContext: SyncRetryContext): RetryOptions {
    return {
      maxAttempts: this.config.retry?.maxAttempts ?? 3,
      maxLfsRetries: this.config.retry?.maxLfsRetries ?? 2,
      initialDelayMs: this.config.retry?.initialDelayMs ?? 1000,
      maxDelayMs: this.config.retry?.maxDelayMs ?? 30000,
      backoffMultiplier: this.config.retry?.backoffMultiplier ?? 2,
      jitterMs: this.config.retry?.jitterMs ?? 0,
      onRetry: (error, attempt, context): void => {
        const errorMessage = getErrorMessage(error);
        this.logger.info(`\n⚠️  Sync attempt ${attempt} failed: ${errorMessage}`);

        if (context?.isLfsError && !this.config.skipLfs) {
          this.logger.info(`🔄 LFS error detected. Will retry with LFS skipped...`);
        } else {
          this.logger.info(`🔄 Retrying synchronization...\n`);
        }
      },
      lfsRetryHandler: (): void => {
        if (!this.config.skipLfs && !syncContext.lfsSkipEnabled) {
          this.logger.info("⚠️  Temporarily disabling LFS downloads for this sync...");
          this.gitService.setLfsSkipEnabled(true);
          syncContext.lfsSkipEnabled = true;
        }
      },
    };
  }

  resetLfsSkipIfNeeded(syncContext: SyncRetryContext): void {
    if (syncContext.lfsSkipEnabled && !this.config.skipLfs) {
      this.gitService.setLfsSkipEnabled(false);
    }
  }
}

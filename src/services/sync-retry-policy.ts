import { DEFAULT_CONFIG } from "../constants";
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
      maxAttempts: this.config.retry?.maxAttempts ?? DEFAULT_CONFIG.RETRY.MAX_ATTEMPTS,
      maxLfsRetries: this.config.retry?.maxLfsRetries ?? DEFAULT_CONFIG.RETRY.MAX_LFS_RETRIES,
      initialDelayMs: this.config.retry?.initialDelayMs ?? DEFAULT_CONFIG.RETRY.INITIAL_DELAY_MS,
      maxDelayMs: this.config.retry?.maxDelayMs ?? DEFAULT_CONFIG.RETRY.MAX_DELAY_MS,
      backoffMultiplier: this.config.retry?.backoffMultiplier ?? DEFAULT_CONFIG.RETRY.BACKOFF_MULTIPLIER,
      jitterMs: this.config.retry?.jitterMs ?? DEFAULT_CONFIG.RETRY.JITTER_MS,
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

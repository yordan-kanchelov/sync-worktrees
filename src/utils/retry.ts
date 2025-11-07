import { isLfsErrorFromError } from "./lfs-error";

interface ErrorWithCode {
  code?: string;
  message?: string;
}

export interface LfsErrorContext {
  isLfsError: boolean;
}

export interface RetryOptions {
  maxAttempts?: number | "unlimited";
  maxLfsRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  /**
   * Add random jitter to retry delays to prevent thundering herd problem
   * in concurrent operations. Jitter is a random value between 0 and jitterMs
   * added to the calculated delay.
   *
   * Recommended for parallel operations to spread out retries.
   * Default: 0 (no jitter)
   */
  jitterMs?: number;
  shouldRetry?: (error: unknown, context?: LfsErrorContext) => boolean;
  onRetry?: (error: unknown, attempt: number, context?: LfsErrorContext) => void;
  lfsRetryHandler?: (context: LfsErrorContext) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "maxAttempts">> & { maxAttempts: number | "unlimited" } = {
  maxAttempts: "unlimited",
  maxLfsRetries: 2,
  initialDelayMs: 1000,
  maxDelayMs: 600000, // 10 minutes
  backoffMultiplier: 2,
  jitterMs: 0,
  shouldRetry: (error, context) => {
    const err = error as ErrorWithCode;

    // Check for LFS errors
    if (isLfsErrorFromError(error)) {
      if (context) {
        context.isLfsError = true;
      }
      return true;
    }

    if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT") {
      return true;
    }

    if (err.code === "EBUSY" || err.code === "ENOENT" || err.code === "EACCES") {
      return true;
    }

    if (err.message?.includes("Could not read from remote repository")) {
      return true;
    }

    if (err.message?.includes("fatal: unable to access")) {
      return true;
    }

    return false;
  },
  onRetry: () => {},
  lfsRetryHandler: (_context) => {},
};

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let attempt = 1;
  let lfsAttempt = 0;
  const lfsContext: LfsErrorContext = { isLfsError: false };

  while (true) {
    try {
      return await fn();
    } catch (error) {
      // Reset LFS error flag for each attempt
      lfsContext.isLfsError = false;

      // Check if we should retry
      if (!opts.shouldRetry(error, lfsContext)) {
        throw error;
      }

      // Track LFS attempts separately
      if (lfsContext.isLfsError) {
        lfsAttempt++;

        // Check if we've exceeded LFS retry limit
        if (lfsAttempt > opts.maxLfsRetries) {
          const err = error as Error;
          throw new Error(
            `LFS error retry limit exceeded (${opts.maxLfsRetries} attempts). ` +
              `Consider using --skip-lfs option to bypass LFS downloads.`,
            { cause: err },
          );
        }
      }

      const isLastAttempt = opts.maxAttempts !== "unlimited" && attempt >= opts.maxAttempts;
      if (isLastAttempt) {
        throw error;
      }

      // Handle LFS errors specifically
      if (lfsContext.isLfsError && opts.lfsRetryHandler) {
        opts.lfsRetryHandler(lfsContext);
      }

      const baseDelay = Math.min(opts.initialDelayMs * Math.pow(opts.backoffMultiplier, attempt - 1), opts.maxDelayMs);

      // Add jitter to prevent thundering herd in concurrent operations
      // Jitter is a random value between 0 and jitterMs
      const jitter = opts.jitterMs > 0 ? Math.random() * opts.jitterMs : 0;
      const delay = baseDelay + jitter;

      opts.onRetry(error, attempt, lfsContext);

      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt++;
    }
  }
}

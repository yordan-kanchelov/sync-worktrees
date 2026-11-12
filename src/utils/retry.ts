import { DEFAULT_CONFIG } from "../constants";

import { isGitAuthErrorFromError } from "./git-auth-error";
import { isLfsErrorFromError } from "./lfs-error";

interface ErrorWithCode {
  code?: string;
  message?: string;
  plugin?: string;
}

// What git prints for DNS, refused and timed-out connections (https and ssh).
const NETWORK_ERROR_MESSAGES = ["Could not resolve host", "Connection refused", "Connection timed out"];

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
  /** Stops retrying once aborted: no new attempt starts and a pending backoff ends early. */
  signal?: AbortSignal;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "maxAttempts" | "signal">> & {
  maxAttempts: number | "unlimited";
} = {
  maxAttempts: DEFAULT_CONFIG.RETRY.MAX_ATTEMPTS,
  maxLfsRetries: DEFAULT_CONFIG.RETRY.MAX_LFS_RETRIES,
  initialDelayMs: DEFAULT_CONFIG.RETRY.INITIAL_DELAY_MS,
  maxDelayMs: DEFAULT_CONFIG.RETRY.MAX_DELAY_MS,
  backoffMultiplier: DEFAULT_CONFIG.RETRY.BACKOFF_MULTIPLIER,
  jitterMs: DEFAULT_CONFIG.RETRY.JITTER_MS,
  shouldRetry: (error, context) => {
    const err = error as ErrorWithCode;

    // Check for LFS errors
    if (isLfsErrorFromError(error)) {
      if (context) {
        context.isLfsError = true;
      }
      return true;
    }

    // simple-git's inactivity kill (fetchTimeoutMs / cloneTimeoutMs).
    if (err.plugin === "timeout" || err.message?.includes("block timeout reached")) {
      return true;
    }

    if (err.code === "EACCES" || err.code === "EPERM" || err.code === "EROFS" || err.code === "ENOSPC") {
      return false;
    }

    if (err.code === "EBUSY") {
      return true;
    }

    // Credentials git could not obtain, a key ssh could not use or a host key
    // it could not confirm: checked before the generic remote-repository
    // patterns below, which these messages also contain. Retrying cannot help
    // and costs minutes of backoff.
    if (isGitAuthErrorFromError(error)) {
      return false;
    }

    if (NETWORK_ERROR_MESSAGES.some((m) => err.message?.includes(m))) {
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
  if (opts.maxAttempts !== "unlimited" && (!Number.isFinite(opts.maxAttempts) || opts.maxAttempts < 1)) {
    throw new Error("maxAttempts must be 'unlimited' or a finite positive number");
  }

  let attempt = 1;
  let lfsAttempt = 0;
  const lfsContext: LfsErrorContext = { isLfsError: false };

  const signal = opts.signal;
  while (true) {
    signal?.throwIfAborted();
    try {
      return await fn();
    } catch (error) {
      // Reset LFS error flag for each attempt
      lfsContext.isLfsError = false;

      // Check if we should retry
      if (signal?.aborted || !opts.shouldRetry(error, lfsContext)) {
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
              `Consider setting 'skipLfs: true' for this repository (or under 'defaults') to bypass LFS downloads.`,
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

      if (await sleepUnlessAborted(delay, signal)) {
        throw error;
      }
      attempt++;
    }
  }
}

/** Resolves true when the signal aborted before the delay elapsed. */
function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(true);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

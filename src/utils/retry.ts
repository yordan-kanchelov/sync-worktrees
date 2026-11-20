import { DEFAULT_CONFIG } from "../constants";

import { isGitAuthErrorFromError } from "./git-auth-error";
import { isLfsErrorFromError } from "./lfs-error";

interface ErrorWithCode {
  code?: string;
  message?: string;
  plugin?: string;
}

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
  jitterMs?: number;
  shouldRetry?: (error: unknown, context?: LfsErrorContext) => boolean;
  onRetry?: (error: unknown, attempt: number, context?: LfsErrorContext) => void;
  lfsRetryHandler?: (context: LfsErrorContext) => void;
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

    if (isLfsErrorFromError(error)) {
      if (context) {
        context.isLfsError = true;
      }
      return true;
    }

    if (err.plugin === "timeout" || err.message?.includes("block timeout reached")) {
      return true;
    }

    if (err.code === "EACCES" || err.code === "EPERM" || err.code === "EROFS" || err.code === "ENOSPC") {
      return false;
    }

    if (err.code === "EBUSY") {
      return true;
    }

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
      lfsContext.isLfsError = false;

      if (signal?.aborted || !opts.shouldRetry(error, lfsContext)) {
        throw error;
      }

      if (lfsContext.isLfsError) {
        lfsAttempt++;

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

      if (lfsContext.isLfsError && opts.lfsRetryHandler) {
        opts.lfsRetryHandler(lfsContext);
      }

      const baseDelay = Math.min(opts.initialDelayMs * Math.pow(opts.backoffMultiplier, attempt - 1), opts.maxDelayMs);

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

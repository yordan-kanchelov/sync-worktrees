interface ErrorWithCode {
  code?: string;
  message?: string;
}

export interface RetryOptions {
  maxAttempts?: number | "unlimited";
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "maxAttempts">> & { maxAttempts: number | "unlimited" } = {
  maxAttempts: "unlimited",
  initialDelayMs: 1000,
  maxDelayMs: 600000, // 10 minutes
  backoffMultiplier: 2,
  shouldRetry: (error) => {
    const err = error as ErrorWithCode;
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
};

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let attempt = 1;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = opts.maxAttempts !== "unlimited" && attempt >= opts.maxAttempts;

      if (isLastAttempt || !opts.shouldRetry(error)) {
        throw error;
      }

      const delay = Math.min(opts.initialDelayMs * Math.pow(opts.backoffMultiplier, attempt - 1), opts.maxDelayMs);

      opts.onRetry(error, attempt);

      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt++;
    }
  }
}

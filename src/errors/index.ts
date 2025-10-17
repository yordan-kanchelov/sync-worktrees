import { ERROR_MESSAGES } from "../constants";

export class SyncWorktreesError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
    if (cause && cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

export class GitError extends SyncWorktreesError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, `GIT_${code}`, cause);
  }
}

export class GitNotInitializedError extends GitError {
  constructor() {
    super(ERROR_MESSAGES.GIT_NOT_INITIALIZED, "NOT_INITIALIZED");
  }
}

export class GitOperationError extends GitError {
  constructor(operation: string, details: string, cause?: Error) {
    super(`Git operation '${operation}' failed: ${details}`, "OPERATION_FAILED", cause);
  }
}

export class FastForwardError extends GitError {
  constructor(
    public readonly branchName: string,
    cause?: Error,
  ) {
    super(`Cannot fast-forward branch '${branchName}'`, "FAST_FORWARD_FAILED", cause);
  }
}

export class WorktreeError extends SyncWorktreesError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, `WORKTREE_${code}`, cause);
  }
}

export class WorktreeAlreadyExistsError extends WorktreeError {
  constructor(
    public readonly path: string,
    public readonly branchName: string,
  ) {
    super(`Worktree already exists at '${path}' for branch '${branchName}'`, "ALREADY_EXISTS");
  }
}

export class WorktreeNotCleanError extends WorktreeError {
  constructor(
    public readonly path: string,
    public readonly reasons: string[],
  ) {
    super(`Worktree at '${path}' is not clean: ${reasons.join(", ")}`, "NOT_CLEAN");
  }
}

export class ConfigError extends SyncWorktreesError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, `CONFIG_${code}`, cause);
  }
}

export class ConfigValidationError extends ConfigError {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`Invalid configuration for '${field}': ${reason}`, "VALIDATION_FAILED");
  }
}

export class PathResolutionError extends SyncWorktreesError {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`Path resolution failed for '${path}': ${reason}`, "PATH_RESOLUTION_FAILED");
  }
}

export class LfsError extends GitError {
  constructor(message: string, cause?: Error) {
    super(`LFS operation failed: ${message}`, "LFS_ERROR", cause);
  }
}

export function isLfsError(error: Error | string): boolean {
  const message = typeof error === "string" ? error : error.message;
  return ERROR_MESSAGES.LFS_ERROR.some((pattern) => message.includes(pattern));
}

export function isFastForwardError(error: Error | string): boolean {
  const message = typeof error === "string" ? error : error.message;
  return ERROR_MESSAGES.FAST_FORWARD_FAILED.some((pattern) => message.includes(pattern));
}

export function isNoUpstreamError(error: Error | string): boolean {
  const message = typeof error === "string" ? error : error.message;
  return ERROR_MESSAGES.NO_UPSTREAM.some((pattern) => message.includes(pattern));
}

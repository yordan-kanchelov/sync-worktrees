import { ERROR_MESSAGES } from "../constants";
import { getErrorMessage } from "../utils/errors";

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

export class WorktreeNotCleanError extends WorktreeError {
  constructor(
    public readonly path: string,
    public readonly reasons: string[],
  ) {
    super(`Worktree at '${path}' is not clean: ${reasons.join(", ")}`, "NOT_CLEAN");
  }
}

// addWorktree created the worktree but could not record its metadata, so it
// removed the worktree again rather than leave one sync cannot manage.
export class WorktreeMetadataError extends WorktreeError {
  constructor(
    public readonly branchName: string,
    cause: unknown,
  ) {
    super(
      `Metadata creation failed for '${branchName}': ${getErrorMessage(cause)}`,
      "METADATA_FAILED",
      cause instanceof Error ? cause : undefined,
    );
  }
}

// `branch --set-upstream-to` failed on a worktree addWorktree had just added;
// the worktree has already been rolled back (or `rollbackSucceeded` says why
// not), so callers must not retry the add through the tracking fallback.
export class UpstreamSetupError extends WorktreeError {
  constructor(
    public readonly branchName: string,
    cause: unknown,
    public readonly rollbackSucceeded: boolean,
  ) {
    super(
      `Failed to set upstream for '${branchName}': ${getErrorMessage(cause)}${
        rollbackSucceeded ? "" : " (rollback failed; partial worktree may remain)"
      }`,
      "UPSTREAM_SETUP_FAILED",
      cause instanceof Error ? cause : undefined,
    );
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

export class ConfigFileNotFoundError extends ConfigError {
  constructor(public readonly configPath: string) {
    super(`Config file not found: ${configPath}`, "FILE_NOT_FOUND");
  }
}

export class ConfigFileExistsError extends ConfigError {
  constructor(public readonly configPath: string) {
    super(`Config file already exists: ${configPath}`, "FILE_EXISTS");
  }
}

export class TrashError extends SyncWorktreesError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, `TRASH_${code}`, cause);
  }
}

export class TrashOperationError extends TrashError {
  constructor(
    public readonly operation: string,
    details: string,
    cause?: Error,
  ) {
    super(`Trash operation '${operation}' failed: ${details}`, "OPERATION_FAILED", cause);
  }
}

export { isLfsErrorFromError as isLfsError } from "../utils/lfs-error";

export function isFastForwardError(error: Error | string): boolean {
  const message = typeof error === "string" ? error : error.message;
  return ERROR_MESSAGES.FAST_FORWARD_FAILED.some((pattern) => message.includes(pattern));
}

export function isNoUpstreamError(error: Error | string): boolean {
  const message = typeof error === "string" ? error : error.message;
  return ERROR_MESSAGES.NO_UPSTREAM.some((pattern) => message.includes(pattern));
}

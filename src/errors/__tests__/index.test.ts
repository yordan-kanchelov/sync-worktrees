import { describe, expect, it } from "vitest";

import { ERROR_MESSAGES } from "../../constants";
import {
  ConfigError,
  ConfigValidationError,
  FastForwardError,
  GitError,
  GitNotInitializedError,
  GitOperationError,
  LfsError,
  PathResolutionError,
  SyncWorktreesError,
  WorktreeAlreadyExistsError,
  WorktreeError,
  WorktreeNotCleanError,
  isFastForwardError,
  isLfsError,
  isNoUpstreamError,
} from "../index";

describe("Error Classes", () => {
  describe("SyncWorktreesError", () => {
    it("should create error with message and code", () => {
      const error = new SyncWorktreesError("Test message", "TEST_CODE");

      expect(error.message).toBe("Test message");
      expect(error.code).toBe("TEST_CODE");
      expect(error.name).toBe("SyncWorktreesError");
      expect(error.cause).toBeUndefined();
    });

    it("should include cause in stack trace when provided", () => {
      const cause = new Error("Original error");
      const error = new SyncWorktreesError("Wrapped error", "WRAP_CODE", cause);

      expect(error.cause).toBe(cause);
      expect(error.stack).toContain("Caused by:");
      expect(error.stack).toContain("Original error");
    });

    it("should handle cause without stack trace", () => {
      const cause = new Error("No stack");
      cause.stack = undefined;
      const error = new SyncWorktreesError("Wrapped error", "WRAP_CODE", cause);

      expect(error.cause).toBe(cause);
      expect(error.stack).not.toContain("Caused by:");
    });

    it("should be instanceof Error", () => {
      const error = new SyncWorktreesError("Test", "CODE");
      expect(error instanceof Error).toBe(true);
      expect(error instanceof SyncWorktreesError).toBe(true);
    });
  });

  describe("GitError", () => {
    it("should prefix code with GIT_", () => {
      const error = new GitError("Git failed", "CLONE_FAILED");

      expect(error.code).toBe("GIT_CLONE_FAILED");
      expect(error.name).toBe("GitError");
    });

    it("should pass cause to parent", () => {
      const cause = new Error("Network error");
      const error = new GitError("Git failed", "FETCH_FAILED", cause);

      expect(error.cause).toBe(cause);
    });

    it("should be instanceof SyncWorktreesError", () => {
      const error = new GitError("Test", "CODE");
      expect(error instanceof SyncWorktreesError).toBe(true);
      expect(error instanceof GitError).toBe(true);
    });
  });

  describe("GitNotInitializedError", () => {
    it("should use predefined message and code", () => {
      const error = new GitNotInitializedError();

      expect(error.message).toBe(ERROR_MESSAGES.GIT_NOT_INITIALIZED);
      expect(error.code).toBe("GIT_NOT_INITIALIZED");
      expect(error.name).toBe("GitNotInitializedError");
    });
  });

  describe("GitOperationError", () => {
    it("should format message with operation and details", () => {
      const error = new GitOperationError("fetch", "network timeout");

      expect(error.message).toBe("Git operation 'fetch' failed: network timeout");
      expect(error.code).toBe("GIT_OPERATION_FAILED");
    });

    it("should include cause when provided", () => {
      const cause = new Error("ECONNRESET");
      const error = new GitOperationError("push", "connection reset", cause);

      expect(error.cause).toBe(cause);
    });
  });

  describe("FastForwardError", () => {
    it("should include branch name in message", () => {
      const error = new FastForwardError("feature/test");

      expect(error.message).toBe("Cannot fast-forward branch 'feature/test'");
      expect(error.code).toBe("GIT_FAST_FORWARD_FAILED");
      expect(error.branchName).toBe("feature/test");
    });

    it("should include cause when provided", () => {
      const cause = new Error("diverged");
      const error = new FastForwardError("main", cause);

      expect(error.cause).toBe(cause);
    });
  });

  describe("WorktreeError", () => {
    it("should prefix code with WORKTREE_", () => {
      const error = new WorktreeError("Worktree failed", "CREATE_FAILED");

      expect(error.code).toBe("WORKTREE_CREATE_FAILED");
      expect(error.name).toBe("WorktreeError");
    });

    it("should be instanceof SyncWorktreesError", () => {
      const error = new WorktreeError("Test", "CODE");
      expect(error instanceof SyncWorktreesError).toBe(true);
      expect(error instanceof WorktreeError).toBe(true);
    });
  });

  describe("WorktreeAlreadyExistsError", () => {
    it("should include path and branch in message", () => {
      const error = new WorktreeAlreadyExistsError("/path/to/worktree", "feature/new");

      expect(error.message).toBe("Worktree already exists at '/path/to/worktree' for branch 'feature/new'");
      expect(error.code).toBe("WORKTREE_ALREADY_EXISTS");
      expect(error.path).toBe("/path/to/worktree");
      expect(error.branchName).toBe("feature/new");
    });
  });

  describe("WorktreeNotCleanError", () => {
    it("should list all reasons in message", () => {
      const reasons = ["uncommitted changes", "unpushed commits"];
      const error = new WorktreeNotCleanError("/path/to/worktree", reasons);

      expect(error.message).toBe("Worktree at '/path/to/worktree' is not clean: uncommitted changes, unpushed commits");
      expect(error.code).toBe("WORKTREE_NOT_CLEAN");
      expect(error.path).toBe("/path/to/worktree");
      expect(error.reasons).toEqual(reasons);
    });

    it("should handle single reason", () => {
      const error = new WorktreeNotCleanError("/worktree", ["stashed changes"]);

      expect(error.message).toBe("Worktree at '/worktree' is not clean: stashed changes");
    });
  });

  describe("ConfigError", () => {
    it("should prefix code with CONFIG_", () => {
      const error = new ConfigError("Config invalid", "PARSE_FAILED");

      expect(error.code).toBe("CONFIG_PARSE_FAILED");
      expect(error.name).toBe("ConfigError");
    });

    it("should include cause when provided", () => {
      const cause = new SyntaxError("Unexpected token");
      const error = new ConfigError("Parse failed", "SYNTAX", cause);

      expect(error.cause).toBe(cause);
    });
  });

  describe("ConfigValidationError", () => {
    it("should include field and reason in message", () => {
      const error = new ConfigValidationError("repoUrl", "must be a valid URL");

      expect(error.message).toBe("Invalid configuration for 'repoUrl': must be a valid URL");
      expect(error.code).toBe("CONFIG_VALIDATION_FAILED");
      expect(error.field).toBe("repoUrl");
      expect(error.reason).toBe("must be a valid URL");
    });
  });

  describe("PathResolutionError", () => {
    it("should include path and reason in message", () => {
      const error = new PathResolutionError("/invalid/path", "path outside base directory");

      expect(error.message).toBe("Path resolution failed for '/invalid/path': path outside base directory");
      expect(error.code).toBe("PATH_RESOLUTION_FAILED");
      expect(error.path).toBe("/invalid/path");
      expect(error.reason).toBe("path outside base directory");
    });
  });

  describe("LfsError", () => {
    it("should prefix message with LFS operation failed", () => {
      const error = new LfsError("smudge filter failed");

      expect(error.message).toBe("LFS operation failed: smudge filter failed");
      expect(error.code).toBe("GIT_LFS_ERROR");
    });

    it("should include cause when provided", () => {
      const cause = new Error("file not found");
      const error = new LfsError("download failed", cause);

      expect(error.cause).toBe(cause);
    });
  });
});

describe("Error Detection Functions", () => {
  describe("isLfsError", () => {
    it("should detect LFS errors from Error objects", () => {
      const lfsError = new Error("smudge filter lfs failed");
      expect(isLfsError(lfsError)).toBe(true);
    });

    it("should detect LFS errors from string messages", () => {
      expect(isLfsError("smudge filter lfs failed")).toBe(true);
      expect(isLfsError("git-lfs pull failed")).toBe(true);
      expect(isLfsError("LFS: error downloading")).toBe(true);
    });

    it("should return false for non-LFS errors", () => {
      expect(isLfsError(new Error("network timeout"))).toBe(false);
      expect(isLfsError("regular git error")).toBe(false);
    });

    it("should detect all LFS error patterns", () => {
      ERROR_MESSAGES.LFS_ERROR.forEach((pattern) => {
        expect(isLfsError(pattern)).toBe(true);
      });
    });
  });

  describe("isFastForwardError", () => {
    it("should detect fast-forward errors from Error objects", () => {
      const ffError = new Error("Not possible to fast-forward");
      expect(isFastForwardError(ffError)).toBe(true);
    });

    it("should detect fast-forward errors from string messages", () => {
      expect(isFastForwardError("fatal: Not possible to fast-forward")).toBe(true);
    });

    it("should return false for non-fast-forward errors", () => {
      expect(isFastForwardError(new Error("merge conflict"))).toBe(false);
      expect(isFastForwardError("regular error")).toBe(false);
    });

    it("should detect all fast-forward error patterns", () => {
      ERROR_MESSAGES.FAST_FORWARD_FAILED.forEach((pattern) => {
        expect(isFastForwardError(pattern)).toBe(true);
      });
    });
  });

  describe("isNoUpstreamError", () => {
    it("should detect no upstream errors from Error objects", () => {
      const noUpstream = new Error("fatal: no upstream configured for branch");
      expect(isNoUpstreamError(noUpstream)).toBe(true);
    });

    it("should detect no upstream errors from string messages", () => {
      expect(isNoUpstreamError("fatal: no upstream configured")).toBe(true);
      expect(isNoUpstreamError("unknown revision or path not in working tree")).toBe(true);
    });

    it("should return false for non-upstream errors", () => {
      expect(isNoUpstreamError(new Error("merge conflict"))).toBe(false);
      expect(isNoUpstreamError("regular error")).toBe(false);
    });

    it("should detect all no upstream error patterns", () => {
      ERROR_MESSAGES.NO_UPSTREAM.forEach((pattern) => {
        expect(isNoUpstreamError(pattern)).toBe(true);
      });
    });
  });
});

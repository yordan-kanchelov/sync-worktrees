import { describe, expect, it } from "vitest";

import { ERROR_MESSAGES } from "../../constants";
import {
  ConfigValidationError,
  FastForwardError,
  GitNotInitializedError,
  GitOperationError,
  LfsError,
  PathResolutionError,
  SyncWorktreesError,
  WorktreeAlreadyExistsError,
  WorktreeNotCleanError,
  isFastForwardError,
  isLfsError,
  isNoUpstreamError,
} from "../index";

describe("Error Classes", () => {
  it.each([
    {
      create: () => new SyncWorktreesError("base failure", "BASE_FAILED"),
      code: "BASE_FAILED",
      message: "base failure",
    },
    {
      create: () => new GitNotInitializedError(),
      code: "GIT_NOT_INITIALIZED",
      message: ERROR_MESSAGES.GIT_NOT_INITIALIZED,
    },
    {
      create: () => new GitOperationError("fetch", "network timeout"),
      code: "GIT_OPERATION_FAILED",
      message: "Git operation 'fetch' failed: network timeout",
    },
    {
      create: () => new FastForwardError("feature/test"),
      code: "GIT_FAST_FORWARD_FAILED",
      message: "Cannot fast-forward branch 'feature/test'",
    },
    {
      create: () => new LfsError("download failed"),
      code: "GIT_LFS_ERROR",
      message: "LFS operation failed: download failed",
    },
    {
      create: () => new WorktreeAlreadyExistsError("/repo/worktree", "feature/test"),
      code: "WORKTREE_ALREADY_EXISTS",
      message: "Worktree already exists at '/repo/worktree' for branch 'feature/test'",
    },
    {
      create: () => new WorktreeNotCleanError("/repo/worktree", ["uncommitted changes", "stashed changes"]),
      code: "WORKTREE_NOT_CLEAN",
      message: "Worktree at '/repo/worktree' is not clean: uncommitted changes, stashed changes",
    },
    {
      create: () => new ConfigValidationError("repoUrl", "is required"),
      code: "CONFIG_VALIDATION_FAILED",
      message: "Invalid configuration for 'repoUrl': is required",
    },
    {
      create: () => new PathResolutionError("../repo", "outside root"),
      code: "PATH_RESOLUTION_FAILED",
      message: "Path resolution failed for '../repo': outside root",
    },
  ])("should preserve the public $code contract", ({ create, code, message }) => {
    const error = create();

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(error.constructor.name);
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
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

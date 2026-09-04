import { SyncWorktreesError } from "../errors";
import { formatRepoLockUnavailable } from "../utils/repo-lock-format";

import type { RepoLockUnavailable } from "../types";
import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";

export type HandlerContext = ServerContext;

/**
 * Every tool advertises an `outputSchema`, so each result must carry a
 * `structuredContent` matching it (SEP-2106) — the SDK rejects a result that
 * omits it. The JSON text block is kept alongside for clients that only read
 * `content`.
 */
export function formatToolResponse(data: object): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data),
      },
    ],
    structuredContent: data,
  };
}

export function formatErrorResponse(error: unknown): CallToolResult {
  let code = "UNKNOWN_ERROR";
  let message = String(error);

  if (error instanceof SyncWorktreesError) {
    code = error.code;
    message = error.message;
  } else if (error instanceof Error) {
    code = "INTERNAL_ERROR";
    message = error.message;
  }

  const body: Record<string, unknown> = {
    error: true,
    code,
    message,
  };

  if (process.env.DEBUG && error instanceof Error && error.stack) {
    body.stack = error.stack;
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(body),
      },
    ],
    isError: true,
  };
}

export class CapabilityUnavailableError extends SyncWorktreesError {
  constructor(capability: string, reasons: string[]) {
    super(`Capability '${capability}' unavailable: ${reasons.join(", ")}`, "CAPABILITY_UNAVAILABLE");
  }
}

export class SyncInProgressError extends SyncWorktreesError {
  constructor(repoName: string) {
    super(`Sync already in progress for '${repoName}'`, "SYNC_IN_PROGRESS");
  }
}

// The cross-process repo lock could not be prepared or taken (ENOTDIR, EACCES,
// EROFS, ENOSPC, ...). Unlike SYNC_IN_PROGRESS nothing else is working on the
// repository — the operation simply did not run, and retrying will not help
// until the state directory is fixed.
export class RepoLockUnavailableError extends SyncWorktreesError {
  constructor(repoName: string, detail: Pick<RepoLockUnavailable, "path" | "code" | "error">) {
    super(`Operation not run for '${repoName}': ${formatRepoLockUnavailable(detail)}`, "LOCK_UNAVAILABLE");
  }
}

export class WorktreeTargetExistsError extends SyncWorktreesError {
  constructor(worktreePath: string) {
    super(
      `Path '${worktreePath}' exists but is not a registered worktree for a branch; remove it manually or run sync`,
      "TARGET_EXISTS",
    );
  }
}

export function wrapHandler<P>(
  fn: (params: P, ctx: HandlerContext) => Promise<CallToolResult>,
): (params: P, ctx: HandlerContext) => Promise<CallToolResult> {
  return async (params, ctx) => {
    try {
      return await fn(params, ctx);
    } catch (error) {
      return formatErrorResponse(error);
    }
  };
}

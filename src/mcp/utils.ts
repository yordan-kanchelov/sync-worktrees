import { SyncWorktreesError } from "../errors";
import { redactSecretsInText } from "../utils/git-url";
import { formatRepoLockUnavailable } from "../utils/repo-lock-format";

import type { RepoLockUnavailable } from "../types";
import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";

export type HandlerContext = ServerContext;

function redactSecretsInPayload<T>(value: T): T {
  if (typeof value === "string") {
    return redactSecretsInText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactSecretsInPayload(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = redactSecretsInPayload(item);
      }
      return out as T;
    }
  }
  return value;
}

export function formatToolResponse(data: object): CallToolResult {
  const payload = redactSecretsInPayload(data);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload),
      },
    ],
    structuredContent: payload,
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
    message: redactSecretsInText(message),
  };

  if (process.env.SYNC_WORKTREES_MCP_DEBUG && error instanceof Error && error.stack) {
    body.stack = redactSecretsInText(error.stack);
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

export class WorktreeDetachedError extends SyncWorktreesError {
  constructor(worktreePath: string, head?: string) {
    super(
      `Worktree at '${worktreePath}' is on a detached HEAD${head ? ` (${head})` : ""}; check out a branch before fast-forwarding`,
      "DETACHED_HEAD",
    );
  }
}

export class WorktreeMissingError extends SyncWorktreesError {
  constructor(worktreePath: string, locked: boolean) {
    super(
      `Worktree at '${worktreePath}' is registered but its directory is missing; ` +
        (locked ? "unlock it and run 'git worktree prune'" : "run 'git worktree prune' or sync"),
      "WORKTREE_MISSING",
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

import { SyncWorktreesError } from "../errors";
import { redactSecretsInText } from "../utils/git-url";
import { formatRepoLockUnavailable } from "../utils/repo-lock-format";

import type { RepoLockUnavailable } from "../types";
import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";

export type HandlerContext = ServerContext;

/**
 * Scrubs credential-bearing URLs from every string in a response payload.
 * Repository URLs (`repoUrl`, sibling and configured-repository summaries)
 * are redacted at their source too; this catches the free text that carries
 * git's own output — per-repository `error` fields, `notes`, skip messages,
 * outcome failures — without each handler having to remember to.
 */
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

/**
 * Every tool advertises an `outputSchema`, so each result must carry a
 * `structuredContent` matching it (SEP-2106) — the SDK rejects a result that
 * omits it. The JSON text block is kept alongside for clients that only read
 * `content`.
 */
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

  // git quotes the remote URL in its failures ("could not read from remote
  // repository", "unable to access '<url>'"), so the message — and the stack,
  // which starts with it — must be scrubbed before an MCP client sees them.
  const body: Record<string, unknown> = {
    error: true,
    code,
    message: redactSecretsInText(message),
  };

  if (process.env.DEBUG && error instanceof Error && error.stack) {
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

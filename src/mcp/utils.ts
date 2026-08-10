import { SyncWorktreesError } from "../errors";

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
    structuredContent: data as Record<string, unknown>,
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

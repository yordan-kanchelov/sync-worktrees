import { SyncWorktreesError } from "../errors";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

export type HandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export function formatToolResponse(data: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
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
        text: JSON.stringify(body, null, 2),
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
  fn: (params: P, extra: HandlerExtra) => Promise<CallToolResult>,
): (params: P, extra: HandlerExtra) => Promise<CallToolResult> {
  return async (params, extra) => {
    try {
      return await fn(params, extra);
    } catch (error) {
      return formatErrorResponse(error);
    }
  };
}

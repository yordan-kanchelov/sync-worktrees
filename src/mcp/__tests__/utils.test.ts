import { describe, expect, it } from "vitest";

import { GitOperationError } from "../../errors";
import {
  CapabilityUnavailableError,
  SyncInProgressError,
  WorktreeTargetExistsError,
  formatErrorResponse,
  formatToolResponse,
} from "../utils";

describe("formatToolResponse", () => {
  it("wraps data as JSON text content", () => {
    const result = formatToolResponse({ foo: "bar", count: 2 });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { text: string }).text;
    expect(JSON.parse(text)).toEqual({ foo: "bar", count: 2 });
    expect(result.isError).toBeUndefined();
  });
});

describe("formatErrorResponse", () => {
  it("serializes SyncWorktreesError with code", () => {
    const err = new GitOperationError("clone", "network failed");
    const result = formatErrorResponse(err);
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toBe(true);
    expect(body.code).toBe("GIT_OPERATION_FAILED");
    expect(body.message).toContain("clone");
  });

  it("handles plain Error as INTERNAL_ERROR", () => {
    const result = formatErrorResponse(new Error("boom"));
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.message).toBe("boom");
  });

  it("handles non-Error values as UNKNOWN_ERROR", () => {
    const result = formatErrorResponse("string error");
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.code).toBe("UNKNOWN_ERROR");
  });
});

describe("CapabilityUnavailableError", () => {
  it("has CAPABILITY_UNAVAILABLE code and includes reasons", () => {
    const err = new CapabilityUnavailableError("sync", ["no config", "no remote"]);
    expect(err.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(err.message).toContain("sync");
    expect(err.message).toContain("no config");
    expect(err.message).toContain("no remote");
  });
});

describe("SyncInProgressError", () => {
  it("has SYNC_IN_PROGRESS code", () => {
    const err = new SyncInProgressError("my-repo");
    expect(err.code).toBe("SYNC_IN_PROGRESS");
    expect(err.message).toContain("my-repo");
  });
});

describe("WorktreeTargetExistsError", () => {
  it("has TARGET_EXISTS code and names the path", () => {
    const err = new WorktreeTargetExistsError("/repo/worktrees/feature-x");
    expect(err.code).toBe("TARGET_EXISTS");
    expect(err.message).toContain("/repo/worktrees/feature-x");
    expect(err.message).toContain("not a registered worktree for a branch");
  });
});

describe("wrapHandler", () => {
  it("returns handler result on success", async () => {
    const { wrapHandler } = await import("../utils");
    const expected = { content: [{ type: "text", text: '{"ok":true}' }] };
    const wrapped = wrapHandler(async () => expected as any);

    await expect(wrapped({} as never, {} as never)).resolves.toEqual(expected);
  });

  it("formats thrown errors", async () => {
    const { wrapHandler } = await import("../utils");
    const wrapped = wrapHandler(async () => {
      throw new Error("kapow");
    });

    const result = await wrapped({} as never, {} as never);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(result.isError).toBe(true);
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.message).toBe("kapow");
  });
});

describe("credential redaction", () => {
  const TOKEN_URL = "https://ci-bot:s3cr3t-token@git.example.com/org/repo.git";
  const REDACTED_URL = "https://***@git.example.com/org/repo.git";

  it("formatToolResponse scrubs credential-bearing URLs from every string in the payload", () => {
    const result = formatToolResponse({
      repoUrl: TOKEN_URL,
      siblingRepositories: [{ name: "sib", repoUrl: TOKEN_URL, present: true }],
      configuredRepositories: [{ name: "ui", mode: "clone", repoUrl: TOKEN_URL, isCurrent: false }],
      notes: [`Failed to read bare repo: fatal: unable to access '${TOKEN_URL}/': 403`],
      repositories: { ui: { worktrees: [], error: `could not read from remote repository ${TOKEN_URL}` } },
      count: 2,
      nothing: null,
    });

    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("s3cr3t-token");
    expect(JSON.parse(text)).toEqual({
      repoUrl: REDACTED_URL,
      siblingRepositories: [{ name: "sib", repoUrl: REDACTED_URL, present: true }],
      configuredRepositories: [{ name: "ui", mode: "clone", repoUrl: REDACTED_URL, isCurrent: false }],
      notes: [`Failed to read bare repo: fatal: unable to access '${REDACTED_URL}/': 403`],
      repositories: { ui: { worktrees: [], error: `could not read from remote repository ${REDACTED_URL}` } },
      count: 2,
      nothing: null,
    });
    expect(result.structuredContent).toEqual(JSON.parse(text));
  });

  it("formatErrorResponse scrubs the remote URL that git quotes in its error text", () => {
    const err = new GitOperationError(
      "clone",
      `fatal: unable to access '${TOKEN_URL}/': The requested URL returned error: 403`,
    );

    const result = formatErrorResponse(err);
    const body = JSON.parse((result.content[0] as { text: string }).text);

    expect(result.isError).toBe(true);
    expect(body.code).toBe("GIT_OPERATION_FAILED");
    expect(body.message).toBe(
      `Git operation 'clone' failed: fatal: unable to access '${REDACTED_URL}/': The requested URL returned error: 403`,
    );
  });

  it("formatErrorResponse scrubs the stack it attaches under DEBUG", () => {
    const previous = process.env.DEBUG;
    process.env.DEBUG = "1";
    try {
      const result = formatErrorResponse(new Error(`fatal: could not read from remote repository ${TOKEN_URL}`));
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body.stack).toContain(REDACTED_URL);
      expect((result.content[0] as { text: string }).text).not.toContain("s3cr3t-token");
    } finally {
      if (previous === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = previous;
    }
  });

  it("wrapHandler returns a redacted error response for a thrown git error", async () => {
    const { wrapHandler } = await import("../utils");
    const wrapped = wrapHandler(async () => {
      throw new Error(`fatal: unable to access '${TOKEN_URL}/': 403`);
    });

    const result = await wrapped({} as never, {} as never);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(result.isError).toBe(true);
    expect(body.message).toBe(`fatal: unable to access '${REDACTED_URL}/': 403`);
  });
});

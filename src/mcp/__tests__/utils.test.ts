import { describe, expect, it } from "vitest";

import { GitOperationError } from "../../errors";
import { CapabilityUnavailableError, SyncInProgressError, formatErrorResponse, formatToolResponse } from "../utils";

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

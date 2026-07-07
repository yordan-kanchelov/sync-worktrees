import { execFile } from "child_process";

import { confirm } from "@inquirer/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { maybeRegisterMcpClients } from "../mcp-registration";

import type { MockedFunction } from "vitest";

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn() }));

// promisify(execFile) calls execFile(cmd, args, opts, callback). Our mock drives
// that callback so we can simulate ENOENT / non-zero exit / success per command.
type ExecCb = (err: NodeJS.ErrnoException | null, stdout?: string, stderr?: string) => void;
type ExecArgs = [string, string[], unknown, ExecCb];

const mockExecFile = execFile as unknown as MockedFunction<(...args: ExecArgs) => void>;
const mockConfirm = confirm as unknown as MockedFunction<typeof confirm>;

function enoent(): NodeJS.ErrnoException {
  const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function exitFailure(stderr = "sync-worktrees MCP server not found"): NodeJS.ErrnoException {
  const err = new Error("command failed") as NodeJS.ErrnoException;
  err.code = 1 as unknown as string;
  (err as NodeJS.ErrnoException & { stderr: string }).stderr = stderr;
  return err;
}

function ambiguousFailure(): NodeJS.ErrnoException {
  const err = new Error("timed out") as NodeJS.ErrnoException;
  err.code = 2 as unknown as string; // any non-1, non-ENOENT failure = "don't know"
  return err;
}

/** Route each mocked call by tool + `mcp <verb>`. */
function routeExecFile(handler: (tool: string, verb: string) => NodeJS.ErrnoException | null): void {
  mockExecFile.mockImplementation((tool, args, _opts, cb) => {
    const result = handler(tool, args[1]);
    cb(result, "", result ? ((result as NodeJS.ErrnoException & { stderr?: string }).stderr ?? "") : "");
  });
}

describe("maybeRegisterMcpClients", () => {
  const originalStdin = process.stdin.isTTY;
  const originalStdout = process.stdout.isTTY;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.stdin.isTTY = originalStdin;
    process.stdout.isTTY = originalStdout;
  });

  it("does nothing when not attached to a TTY", async () => {
    process.stdout.isTTY = false;

    await maybeRegisterMcpClients();

    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("skips tools that are not installed (ENOENT)", async () => {
    routeExecFile(() => enoent());

    await maybeRegisterMcpClients();

    expect(mockConfirm).not.toHaveBeenCalled();
    // Only the two `mcp get` probes ran, no `mcp add`.
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("skips tools that already have the server registered", async () => {
    routeExecFile(() => null); // every `mcp get` succeeds → already registered

    await maybeRegisterMcpClients();

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("does not prompt when the probe fails ambiguously (only ask when we know it's missing)", async () => {
    routeExecFile(() => ambiguousFailure()); // e.g. timeout / unexpected exit / no `mcp get`

    await maybeRegisterMcpClients();

    expect(mockConfirm).not.toHaveBeenCalled();
    const addCalls = mockExecFile.mock.calls.filter((call) => call[1][1] === "add");
    expect(addCalls).toHaveLength(0);
  });

  it("does not prompt or register on unrelated exit-1 probe errors", async () => {
    routeExecFile(() => exitFailure("failed to read corrupt config"));

    await maybeRegisterMcpClients();

    expect(mockConfirm).not.toHaveBeenCalled();
    const addCalls = mockExecFile.mock.calls.filter((call) => call[1][1] === "add");
    expect(addCalls).toHaveLength(0);
  });

  it("registers when the tool is present, unregistered, and the user confirms", async () => {
    routeExecFile((_tool, verb) => (verb === "get" ? exitFailure() : null));
    mockConfirm.mockResolvedValue(true);

    await maybeRegisterMcpClients();

    expect(mockConfirm).toHaveBeenCalledTimes(2);
    const addCalls = mockExecFile.mock.calls.filter((call) => call[1][1] === "add");
    expect(addCalls).toHaveLength(2);
    expect(addCalls[0][0]).toBe("claude");
    expect(addCalls[0][1]).toEqual([
      "mcp",
      "add",
      "sync-worktrees",
      "--",
      "npx",
      "-y",
      "-p",
      "sync-worktrees",
      "sync-worktrees-mcp",
    ]);
  });

  it("does not register when the user declines", async () => {
    routeExecFile((_tool, verb) => (verb === "get" ? exitFailure() : null));
    mockConfirm.mockResolvedValue(false);

    await maybeRegisterMcpClients();

    const addCalls = mockExecFile.mock.calls.filter((call) => call[1][1] === "add");
    expect(addCalls).toHaveLength(0);
  });

  it("never throws when registration fails", async () => {
    routeExecFile((_tool, verb) => (verb === "get" ? exitFailure() : exitFailure()));
    mockConfirm.mockResolvedValue(true);

    await expect(maybeRegisterMcpClients()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it("never throws when the user aborts the prompt (Ctrl-C)", async () => {
    routeExecFile((_tool, verb) => (verb === "get" ? exitFailure() : null));
    mockConfirm.mockRejectedValue(new Error("User force closed the prompt"));

    await expect(maybeRegisterMcpClients()).resolves.toBeUndefined();
    // Aborting stops the whole flow; no `mcp add` should run.
    const addCalls = mockExecFile.mock.calls.filter((call) => call[1][1] === "add");
    expect(addCalls).toHaveLength(0);
  });
});

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { clipboardCommands, copyToClipboard } from "../clipboard";

type Outcome = { exit: number } | { error: string } | "hang";

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
}

/** A spawn that answers each command with the outcome the test names for it. */
function fakeSpawn(outcomes: Record<string, Outcome>, written: Record<string, string>): typeof spawn {
  return vi.fn((command: string) => {
    const child = new EventEmitter() as FakeChild;
    child.stdin = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    let data = "";
    child.stdin.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    const outcome = outcomes[command] ?? { error: "ENOENT" };
    setImmediate(() => {
      if (outcome === "hang") return;
      if ("error" in outcome) {
        child.emit("error", Object.assign(new Error(`spawn ${command} ${outcome.error}`), { code: outcome.error }));
        return;
      }
      written[command] = data;
      if (outcome.exit !== 0) child.stderr.write("Error: Can't open display\n");
      setImmediate(() => child.emit("exit", outcome.exit, null));
    });
    return child;
  }) as unknown as typeof spawn;
}

describe("clipboardCommands", () => {
  it("uses pbcopy on macOS", () => {
    expect(clipboardCommands("darwin", {}).map((c) => c.command)).toEqual(["pbcopy"]);
  });

  it("tries wl-copy first in a Wayland session, then the X11 tools", () => {
    expect(clipboardCommands("linux", { WAYLAND_DISPLAY: "wayland-0" }).map((c) => c.command)).toEqual([
      "wl-copy",
      "xclip",
      "xsel",
    ]);
  });

  it("skips wl-copy without a Wayland session", () => {
    expect(clipboardCommands("linux", { DISPLAY: ":0" }).map((c) => c.command)).toEqual(["xclip", "xsel"]);
  });

  it("has nothing for an unsupported platform", () => {
    expect(clipboardCommands("win32", {})).toEqual([]);
  });
});

describe("copyToClipboard", () => {
  it("writes the text to the first tool that is installed", async () => {
    const written: Record<string, string> = {};
    const spawnFn = fakeSpawn({ xsel: { exit: 0 } }, written);

    const result = await copyToClipboard("/work/repo/main", { platform: "linux", env: {}, spawn: spawnFn });

    expect(result).toEqual({ success: true, tool: "xsel" });
    expect(written.xsel).toBe("/work/repo/main");
  });

  it("says which tools it looked for when none is installed", async () => {
    const result = await copyToClipboard("/p", { platform: "linux", env: {}, spawn: fakeSpawn({}, {}) });

    expect(result.success).toBe(false);
    expect(result.error).toBe("No clipboard tool found; install one of: xclip, xsel");
  });

  it("reports a tool that ran and failed, with its stderr", async () => {
    const result = await copyToClipboard("/p", {
      platform: "linux",
      env: {},
      spawn: fakeSpawn({ xclip: { exit: 1 } }, {}),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("xclip exited with code 1: Error: Can't open display");
  });

  it("gives up on a tool that never exits", async () => {
    vi.useFakeTimers();
    try {
      const pending = copyToClipboard("/p", { platform: "darwin", env: {}, spawn: fakeSpawn({ pbcopy: "hang" }, {}) });
      await vi.advanceTimersByTimeAsync(3000);
      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.error).toContain("pbcopy did not finish");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an unsupported platform without spawning anything", async () => {
    const spawnFn = fakeSpawn({}, {});
    const result = await copyToClipboard("/p", { platform: "win32", env: {}, spawn: spawnFn });

    expect(result.success).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

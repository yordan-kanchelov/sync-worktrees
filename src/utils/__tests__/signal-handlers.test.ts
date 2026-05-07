import { EventEmitter } from "events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupSignalHandlers } from "../signal-handlers";

describe("setupSignalHandlers", () => {
  let proc: NodeJS.EventEmitter;
  let exit: (code: number) => void;
  let log: (message: string) => void;
  let exitMock: ReturnType<typeof vi.fn>;
  let logMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    proc = new EventEmitter();
    exitMock = vi.fn();
    logMock = vi.fn();
    exit = exitMock as unknown as (code: number) => void;
    log = logMock as unknown as (message: string) => void;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs registered cleanups in parallel and exits 0 on completion", async () => {
    const handle = setupSignalHandlers({ process: proc, exit, log, forceExitMs: 3000 });
    const order: string[] = [];
    handle.register(async () => {
      await new Promise((r) => setTimeout(r, 100));
      order.push("a");
    });
    handle.register(async () => {
      await new Promise((r) => setTimeout(r, 100));
      order.push("b");
    });

    proc.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(150);

    expect(order).toContain("a");
    expect(order).toContain("b");
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("force-exits 130 if cleanup exceeds watchdog window", async () => {
    const handle = setupSignalHandlers({ process: proc, exit, log, forceExitMs: 3000 });
    handle.register(() => new Promise(() => {}));

    proc.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(3001);

    expect(exitMock).toHaveBeenCalledWith(130);
  });

  it("force-exits 130 immediately on second signal", async () => {
    const handle = setupSignalHandlers({ process: proc, exit, log, forceExitMs: 5000 });
    handle.register(() => new Promise(() => {}));

    proc.emit("SIGINT");
    proc.emit("SIGINT");

    expect(exitMock).toHaveBeenLastCalledWith(130);
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining("second SIGINT"));
  });

  it("passes fast=true to cleanup functions", async () => {
    const handle = setupSignalHandlers({ process: proc, exit, log });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    handle.register(cleanup);

    proc.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(10);

    expect(cleanup).toHaveBeenCalledWith(true);
  });

  it("handles SIGTERM the same as SIGINT", async () => {
    const handle = setupSignalHandlers({ process: proc, exit, log });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    handle.register(cleanup);

    proc.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(10);

    expect(cleanup).toHaveBeenCalledWith(true);
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("dispose removes signal listeners", () => {
    const handle = setupSignalHandlers({ process: proc, exit, log });
    expect((proc as EventEmitter).listenerCount("SIGINT")).toBe(1);
    expect((proc as EventEmitter).listenerCount("SIGTERM")).toBe(1);

    handle.dispose();

    expect((proc as EventEmitter).listenerCount("SIGINT")).toBe(0);
    expect((proc as EventEmitter).listenerCount("SIGTERM")).toBe(0);
  });

  it("survives a cleanup that throws synchronously", async () => {
    const handle = setupSignalHandlers({ process: proc, exit, log });
    handle.register(() => {
      throw new Error("boom");
    });
    const after = vi.fn();
    handle.register(after);

    proc.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(10);

    expect(after).toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(0);
  });
});

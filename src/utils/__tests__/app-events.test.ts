import { afterEach, describe, expect, it, vi } from "vitest";

import { AppEventEmitter } from "../app-events";

describe("AppEventEmitter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a throwing listener through its logger and still runs the others", () => {
    const logger = { error: vi.fn() };
    const events = new AppEventEmitter(logger);
    const failure = new Error("listener broke");
    const second = vi.fn();
    events.on("setStatus", () => {
      throw failure;
    });
    events.on("setStatus", second);

    expect(() => events.emit("setStatus", "idle")).not.toThrow();

    expect(logger.error).toHaveBeenCalledWith("[app-events] Error in 'setStatus' listener:", failure);
    expect(second).toHaveBeenCalledWith("idle");
  });

  it("scrubs credentials from a listener error by default", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const events = new AppEventEmitter();
    events.on("setDiskSpace", () => {
      throw new Error("fatal: unable to access 'https://user:s3cret-token@github.com/org/repo.git/'");
    });

    events.emit("setDiskSpace", "1 GB");

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const printed = consoleSpy.mock.calls[0].map(String).join(" ");
    expect(printed).toContain("[app-events] Error in 'setDiskSpace' listener:");
    expect(printed).not.toContain("s3cret-token");
  });
});

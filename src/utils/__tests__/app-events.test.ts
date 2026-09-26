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

  // The dashboard's single entry point for text: whatever a caller forgot to
  // redact, no credential-bearing URL reaches a log line or a progress row.
  describe("credential redaction at the boundary", () => {
    const RAW = "https://ci-bot:s3cr3t-token@example.com/org/repo.git";
    const REDACTED = "https://***@example.com/org/repo.git";

    it("scrubs a log line", () => {
      const events = new AppEventEmitter({ error: vi.fn() });
      const listener = vi.fn();
      events.on("addLog", listener);

      events.emit("addLog", { message: `Clone-mode skip for '${RAW}': origin changed`, level: "warn" });

      expect(listener).toHaveBeenCalledWith({
        message: `Clone-mode skip for '${REDACTED}': origin changed`,
        level: "warn",
      });
    });

    it("scrubs a progress row's repository label and message and keeps its other fields", () => {
      const events = new AppEventEmitter({ error: vi.fn() });
      const listener = vi.fn();
      events.on("setSyncProgress", listener);

      events.emit("setSyncProgress", {
        repo: RAW,
        phase: "clone",
        message: `Cloning '${RAW}'`,
        progress: 40,
        total: 10,
      });

      expect(listener).toHaveBeenCalledWith({
        repo: REDACTED,
        phase: "clone",
        message: `Cloning '${REDACTED}'`,
        progress: 40,
        total: 10,
      });
    });

    it("hands a payload with nothing to scrub through as the same object", () => {
      const events = new AppEventEmitter({ error: vi.fn() });
      const listener = vi.fn();
      events.on("setSyncProgress", listener);
      const progress = { repo: "demo", phase: "fetch", message: "Fetching 'demo'" };

      events.emit("setSyncProgress", progress);
      events.emit("setSyncProgress", null);

      expect(listener.mock.calls[0][0]).toBe(progress);
      expect(listener.mock.calls[1][0]).toBeNull();
    });
  });
});

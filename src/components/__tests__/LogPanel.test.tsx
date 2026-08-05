import React from "react";
import { render, cleanup } from "ink-testing-library";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import LogPanel, { LogPanelProps } from "../LogPanel";
import type { LogEntry } from "../App";

const waitForStateUpdate = () => new Promise((resolve) => setTimeout(resolve, 100));

const createLog = (id: string, message: string, level: LogEntry["level"] = "info"): LogEntry => ({
  id,
  message,
  level,
  timestamp: new Date(),
});

describe("LogPanel", () => {
  let defaultProps: LogPanelProps;

  beforeEach(() => {
    defaultProps = {
      logs: [],
      height: 10,
      isActive: true,
    };
  });

  afterEach(() => {
    cleanup();
  });

  describe("rendering", () => {
    it("should render panel title", () => {
      const { lastFrame } = render(<LogPanel {...defaultProps} />);
      expect(lastFrame()).toContain("Logs");
    });

    it("should show log count when logs exist", () => {
      const props = {
        ...defaultProps,
        logs: [createLog("1", "Test log")],
      };
      const { lastFrame } = render(<LogPanel {...props} />);
      expect(lastFrame()).toContain("(1 entries)");
    });

    it("should render log messages", () => {
      const props = {
        ...defaultProps,
        logs: [
          createLog("1", "First log message"),
          createLog("2", "Second log message"),
        ],
      };
      const { lastFrame } = render(<LogPanel {...props} />);
      expect(lastFrame()).toContain("First log message");
      expect(lastFrame()).toContain("Second log message");
    });

    it("should render empty panel when no logs", () => {
      const { lastFrame } = render(<LogPanel {...defaultProps} />);
      expect(lastFrame()).toContain("Logs");
      expect(lastFrame()).not.toContain("entries");
    });
  });

  describe("scroll indicators", () => {
    it("should show 'more below' indicator when scrolled up from bottom", async () => {
      const logs = Array.from({ length: 20 }, (_, i) => createLog(`${i}`, `Log ${i}`));
      const props = {
        ...defaultProps,
        logs,
        height: 10,
      };
      const { stdin, lastFrame } = render(<LogPanel {...props} />);
      await waitForStateUpdate();

      // Scroll up multiple times to get away from the bottom
      stdin.write("\u001B[A"); // Up arrow
      stdin.write("\u001B[A"); // Up arrow
      stdin.write("\u001B[A"); // Up arrow
      await waitForStateUpdate();

      expect(lastFrame()).toContain("more below");
    });

    it("should show 'more above' indicator after scrolling up", async () => {
      const logs = Array.from({ length: 20 }, (_, i) => createLog(`${i}`, `Log ${i}`));
      const props = {
        ...defaultProps,
        logs,
        height: 10,
      };
      const { stdin, lastFrame } = render(<LogPanel {...props} />);

      await waitForStateUpdate();

      stdin.write("\u001B[A"); // Up arrow
      await waitForStateUpdate();

      expect(lastFrame()).toContain("more above");
    });
  });

  describe("mouse wheel", () => {
    const ESC = String.fromCharCode(27);
    const wheelUp = `${ESC}[<64;10;5M`;
    const wheelDown = `${ESC}[<65;10;5M`;
    // 40 entries in a 7-line viewport: deep enough that a notch of 3 lines is
    // visible in which entries are on screen.
    const manyLogs = (): LogEntry[] => Array.from({ length: 40 }, (_, i) => createLog(`${i}`, `Log ${i}`));

    it("scrolls back through history on wheel up", async () => {
      const { stdin, lastFrame } = render(<LogPanel {...defaultProps} logs={manyLogs()} height={10} />);
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Log 39");

      stdin.write(wheelUp);
      await waitForStateUpdate();

      expect(lastFrame()).not.toContain("Log 39");
      // Parking above the tail must stop new entries yanking the view back down.
      expect(lastFrame()).not.toContain("(auto)");
    });

    // A notch moves several lines, so one wheel up then one wheel down has to
    // land exactly back at the bottom and re-arm auto-scroll.
    it("returns to the bottom and re-enables auto-scroll on wheel down", async () => {
      const { stdin, lastFrame } = render(<LogPanel {...defaultProps} logs={manyLogs()} height={10} />);
      await waitForStateUpdate();

      stdin.write(wheelUp);
      await waitForStateUpdate();
      expect(lastFrame()).not.toContain("(auto)");

      stdin.write(wheelDown);
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Log 39");
      expect(lastFrame()).not.toContain("more below");
      expect(lastFrame()).toContain("(auto)");
    });

    it("does not scroll past the top or the bottom", async () => {
      const { stdin, lastFrame } = render(<LogPanel {...defaultProps} logs={manyLogs()} height={10} />);
      await waitForStateUpdate();

      for (let i = 0; i < 30; i++) stdin.write(wheelUp);
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Log 0");
      expect(lastFrame()).not.toContain("more above");

      for (let i = 0; i < 30; i++) stdin.write(wheelDown);
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Log 39");
      expect(lastFrame()).not.toContain("more below");
    });

    // Clicks share the same escape-sequence shape as the wheel and must not be
    // mistaken for scrolling.
    it("ignores button clicks", async () => {
      const { stdin, lastFrame } = render(<LogPanel {...defaultProps} logs={manyLogs()} height={10} />);
      await waitForStateUpdate();

      stdin.write(`${ESC}[<0;10;5M`);
      stdin.write(`${ESC}[<0;10;5m`);
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Log 39");
      expect(lastFrame()).toContain("(auto)");
    });

    // Growing the terminal shrinks maxOffset. A parked offset left above the new
    // maximum shows a part-empty panel the reader cannot scroll further down
    // from, in a window that is now tall enough to show everything below it.
    it("keeps a parked offset within range when the panel grows", async () => {
      const { stdin, lastFrame, rerender } = render(
        <LogPanel {...defaultProps} logs={manyLogs()} height={10} />,
      );
      await waitForStateUpdate();

      stdin.write(wheelUp);
      await waitForStateUpdate();
      expect(lastFrame()).not.toContain("(auto)");

      // 7 visible lines -> 27, so the last 27 entries now fit on screen.
      rerender(<LogPanel {...defaultProps} logs={manyLogs()} height={30} />);
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Log 13");
      expect(lastFrame()).toContain("Log 39");
    });

    it("stays inert while the panel is not active", async () => {
      const { stdin, lastFrame } = render(
        <LogPanel {...defaultProps} logs={manyLogs()} height={10} isActive={false} />,
      );
      await waitForStateUpdate();

      stdin.write(wheelUp);
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Log 39");
    });
  });

  describe("keyboard navigation", () => {
    it("cancels an old g timer before starting a new gg sequence", async () => {
      const logs = Array.from({ length: 40 }, (_, i) => createLog(`${i}`, `Log ${i}`));
      const { stdin, lastFrame } = render(<LogPanel {...defaultProps} logs={logs} height={10} />);

      stdin.write("g");
      await waitForStateUpdate();
      stdin.write("\u001B[A");
      await waitForStateUpdate();
      stdin.write("g");
      await new Promise((resolve) => setTimeout(resolve, 350));
      stdin.write("g");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Log 0");
      expect(lastFrame()).not.toContain("more above");
    });

    it("should scroll up with up arrow key", async () => {
      const logs = Array.from({ length: 20 }, (_, i) => createLog(`${i}`, `Log ${i}`));
      const props = {
        ...defaultProps,
        logs,
        height: 10,
      };
      const { stdin, lastFrame } = render(<LogPanel {...props} />);

      await waitForStateUpdate();
      const initialFrame = lastFrame();

      stdin.write("\u001B[A"); // Up arrow
      await waitForStateUpdate();

      const scrolledFrame = lastFrame();
      expect(scrolledFrame).not.toEqual(initialFrame);
    });

    it("should scroll down with down arrow key after scrolling up", async () => {
      const logs = Array.from({ length: 20 }, (_, i) => createLog(`${i}`, `Log ${i}`));
      const props = {
        ...defaultProps,
        logs,
        height: 10,
      };
      const { stdin, lastFrame } = render(<LogPanel {...props} />);

      await waitForStateUpdate();

      stdin.write("\u001B[A"); // Up arrow
      stdin.write("\u001B[A"); // Up arrow again
      await waitForStateUpdate();

      const afterUpFrame = lastFrame();

      stdin.write("\u001B[B"); // Down arrow
      await waitForStateUpdate();

      const afterDownFrame = lastFrame();
      expect(afterDownFrame).not.toEqual(afterUpFrame);
    });

    it("should not respond to keyboard when isActive is false", async () => {
      const logs = Array.from({ length: 20 }, (_, i) => createLog(`${i}`, `Log ${i}`));
      const props = {
        ...defaultProps,
        logs,
        height: 10,
        isActive: false,
      };
      const { stdin, lastFrame } = render(<LogPanel {...props} />);

      await waitForStateUpdate();
      const initialFrame = lastFrame();

      stdin.write("\u001B[A"); // Up arrow
      await waitForStateUpdate();

      expect(lastFrame()).toEqual(initialFrame);
    });
  });

  describe("auto-scroll", () => {
    it("should auto-scroll to bottom when new logs are added", async () => {
      const initialLogs = Array.from({ length: 5 }, (_, i) => createLog(`${i}`, `Log ${i}`));
      const props = {
        ...defaultProps,
        logs: initialLogs,
        height: 10,
      };
      const { lastFrame, rerender } = render(<LogPanel {...props} />);

      await waitForStateUpdate();

      const newLogs = [...initialLogs, createLog("new", "New log message")];
      rerender(<LogPanel {...props} logs={newLogs} />);
      await waitForStateUpdate();

      expect(lastFrame()).toContain("New log message");
    });

    it("should show auto indicator when auto-scroll is enabled", async () => {
      const logs = Array.from({ length: 20 }, (_, i) => createLog(`${i}`, `Log ${i}`));
      const props = {
        ...defaultProps,
        logs,
        height: 10,
      };
      const { lastFrame } = render(<LogPanel {...props} />);

      await waitForStateUpdate();

      expect(lastFrame()).toContain("(auto)");
    });

    it("should disable auto-scroll when user scrolls up", async () => {
      const logs = Array.from({ length: 20 }, (_, i) => createLog(`${i}`, `Log ${i}`));
      const props = {
        ...defaultProps,
        logs,
        height: 10,
      };
      const { stdin, lastFrame } = render(<LogPanel {...props} />);

      await waitForStateUpdate();

      stdin.write("\u001B[A"); // Up arrow
      await waitForStateUpdate();

      expect(lastFrame()).not.toContain("(auto)");
    });
  });

  describe("log levels", () => {
    it("should render info logs without special color", () => {
      const props = {
        ...defaultProps,
        logs: [createLog("1", "Info message", "info")],
      };
      const { lastFrame } = render(<LogPanel {...props} />);
      expect(lastFrame()).toContain("Info message");
    });

    it("should render warn logs", () => {
      const props = {
        ...defaultProps,
        logs: [createLog("1", "Warning message", "warn")],
      };
      const { lastFrame } = render(<LogPanel {...props} />);
      expect(lastFrame()).toContain("Warning message");
    });

    it("should render error logs", () => {
      const props = {
        ...defaultProps,
        logs: [createLog("1", "Error message", "error")],
      };
      const { lastFrame } = render(<LogPanel {...props} />);
      expect(lastFrame()).toContain("Error message");
    });
  });
});

import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect, beforeEach } from "vitest";

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

  describe("keyboard navigation", () => {
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

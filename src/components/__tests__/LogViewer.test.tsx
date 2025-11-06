import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect, beforeEach } from "vitest";

import LogViewer, { LogViewerProps } from "../LogViewer";
import { LogEntry } from "../App";

describe("LogViewer", () => {
  let defaultProps: LogViewerProps;

  beforeEach(() => {
    defaultProps = {
      logs: [],
      maxLines: 100,
    };
  });

  describe("rendering", () => {
    it("should show empty message when no logs", () => {
      const { lastFrame } = render(<LogViewer {...defaultProps} />);

      expect(lastFrame()).toContain("No logs yet");
      expect(lastFrame()).toContain("Waiting for sync operations");
    });

    it("should render single log entry", () => {
      const logs: LogEntry[] = [
        {
          id: "log-1",
          message: "Test message",
          level: "info",
          timestamp: new Date("2025-01-01T12:00:00"),
        },
      ];

      const { lastFrame } = render(<LogViewer {...defaultProps} logs={logs} />);

      expect(lastFrame()).toContain("Test message");
      expect(lastFrame()).not.toContain("No logs yet");
    });

    it("should render multiple log entries", () => {
      const logs: LogEntry[] = [
        {
          id: "log-1",
          message: "First message",
          level: "info",
          timestamp: new Date("2025-01-01T12:00:00"),
        },
        {
          id: "log-2",
          message: "Second message",
          level: "info",
          timestamp: new Date("2025-01-01T12:01:00"),
        },
        {
          id: "log-3",
          message: "Third message",
          level: "info",
          timestamp: new Date("2025-01-01T12:02:00"),
        },
      ];

      const { lastFrame } = render(<LogViewer {...defaultProps} logs={logs} />);

      expect(lastFrame()).toContain("First message");
      expect(lastFrame()).toContain("Second message");
      expect(lastFrame()).toContain("Third message");
    });
  });

  describe("log levels", () => {
    it("should display info level logs", () => {
      const logs: LogEntry[] = [
        {
          id: "log-1",
          message: "Info message",
          level: "info",
          timestamp: new Date(),
        },
      ];

      const { lastFrame } = render(<LogViewer {...defaultProps} logs={logs} />);

      expect(lastFrame()).toContain("Info message");
    });

    it("should display warn level logs", () => {
      const logs: LogEntry[] = [
        {
          id: "log-1",
          message: "Warning message",
          level: "warn",
          timestamp: new Date(),
        },
      ];

      const { lastFrame } = render(<LogViewer {...defaultProps} logs={logs} />);

      expect(lastFrame()).toContain("Warning message");
    });

    it("should display error level logs", () => {
      const logs: LogEntry[] = [
        {
          id: "log-1",
          message: "Error message",
          level: "error",
          timestamp: new Date(),
        },
      ];

      const { lastFrame } = render(<LogViewer {...defaultProps} logs={logs} />);

      expect(lastFrame()).toContain("Error message");
    });

    it("should display mixed level logs", () => {
      const logs: LogEntry[] = [
        {
          id: "log-1",
          message: "Info message",
          level: "info",
          timestamp: new Date(),
        },
        {
          id: "log-2",
          message: "Warning message",
          level: "warn",
          timestamp: new Date(),
        },
        {
          id: "log-3",
          message: "Error message",
          level: "error",
          timestamp: new Date(),
        },
      ];

      const { lastFrame } = render(<LogViewer {...defaultProps} logs={logs} />);

      expect(lastFrame()).toContain("Info message");
      expect(lastFrame()).toContain("Warning message");
      expect(lastFrame()).toContain("Error message");
    });
  });

  describe("timestamps", () => {
    it("should display timestamp for each log", () => {
      const timestamp = new Date("2025-01-01T12:00:00");
      const logs: LogEntry[] = [
        {
          id: "log-1",
          message: "Test message",
          level: "info",
          timestamp,
        },
      ];

      const { lastFrame } = render(<LogViewer {...defaultProps} logs={logs} />);

      expect(lastFrame()).toContain("[");
      expect(lastFrame()).toContain("]");
      expect(lastFrame()).toContain("Test message");
    });

    it("should format timestamps as locale time", () => {
      const timestamp = new Date("2025-01-01T12:00:00");
      const logs: LogEntry[] = [
        {
          id: "log-1",
          message: "Test",
          level: "info",
          timestamp,
        },
      ];

      const { lastFrame } = render(<LogViewer {...defaultProps} logs={logs} />);

      const expectedTime = timestamp.toLocaleTimeString();
      expect(lastFrame()).toContain(expectedTime);
    });
  });

  describe("maxLines limit", () => {
    it("should respect default maxLines of 100", () => {
      const logs: LogEntry[] = Array.from({ length: 150 }, (_, i) => ({
        id: `log-${i}`,
        message: `Message ${i}`,
        level: "info" as const,
        timestamp: new Date(),
      }));

      const { lastFrame } = render(<LogViewer logs={logs} />);

      expect(lastFrame()).not.toContain("Message 0");
      expect(lastFrame()).not.toContain("Message 49");
      expect(lastFrame()).toContain("Message 50");
      expect(lastFrame()).toContain("Message 149");
    });

    it("should respect custom maxLines", () => {
      const logs: LogEntry[] = Array.from({ length: 20 }, (_, i) => ({
        id: `log-${i}`,
        message: `Message ${i}`,
        level: "info" as const,
        timestamp: new Date(),
      }));

      const { lastFrame } = render(<LogViewer logs={logs} maxLines={10} />);

      expect(lastFrame()).not.toContain("Message 0");
      expect(lastFrame()).not.toContain("Message 9");
      expect(lastFrame()).toContain("Message 10");
      expect(lastFrame()).toContain("Message 19");
    });

    it("should show all logs when count is less than maxLines", () => {
      const logs: LogEntry[] = Array.from({ length: 5 }, (_, i) => ({
        id: `log-${i}`,
        message: `Message ${i}`,
        level: "info" as const,
        timestamp: new Date(),
      }));

      const { lastFrame } = render(<LogViewer logs={logs} maxLines={10} />);

      expect(lastFrame()).toContain("Message 0");
      expect(lastFrame()).toContain("Message 1");
      expect(lastFrame()).toContain("Message 2");
      expect(lastFrame()).toContain("Message 3");
      expect(lastFrame()).toContain("Message 4");
    });
  });

  describe("dynamic updates", () => {
    it("should update when logs are added", () => {
      const { lastFrame, rerender } = render(<LogViewer {...defaultProps} logs={[]} />);

      expect(lastFrame()).toContain("No logs yet");

      const newLogs: LogEntry[] = [
        {
          id: "log-1",
          message: "New message",
          level: "info",
          timestamp: new Date(),
        },
      ];

      rerender(<LogViewer {...defaultProps} logs={newLogs} />);

      expect(lastFrame()).not.toContain("No logs yet");
      expect(lastFrame()).toContain("New message");
    });

    it("should show newest logs when limit is reached", () => {
      const initialLogs: LogEntry[] = [
        {
          id: "log-1",
          message: "Old message",
          level: "info",
          timestamp: new Date(),
        },
      ];

      const { lastFrame, rerender } = render(<LogViewer logs={initialLogs} maxLines={2} />);

      expect(lastFrame()).toContain("Old message");

      const newLogs: LogEntry[] = [
        ...initialLogs,
        {
          id: "log-2",
          message: "New message 1",
          level: "info",
          timestamp: new Date(),
        },
        {
          id: "log-3",
          message: "New message 2",
          level: "info",
          timestamp: new Date(),
        },
      ];

      rerender(<LogViewer logs={newLogs} maxLines={2} />);

      expect(lastFrame()).not.toContain("Old message");
      expect(lastFrame()).toContain("New message 1");
      expect(lastFrame()).toContain("New message 2");
    });
  });

  describe("unique log ids", () => {
    it("should handle logs with unique ids", () => {
      const logs: LogEntry[] = [
        {
          id: "unique-1",
          message: "Message 1",
          level: "info",
          timestamp: new Date(),
        },
        {
          id: "unique-2",
          message: "Message 2",
          level: "info",
          timestamp: new Date(),
        },
      ];

      const { lastFrame } = render(<LogViewer {...defaultProps} logs={logs} />);

      expect(lastFrame()).toContain("Message 1");
      expect(lastFrame()).toContain("Message 2");
    });
  });
});

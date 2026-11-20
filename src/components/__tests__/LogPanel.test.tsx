import React from "react";
import { render, cleanup } from "ink-testing-library";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import LogPanelView, { CollapsedLogLine, useLogScroll } from "../LogPanel";
import type { LogEntry } from "../App";
import { frameLines, resizeTerminal } from "./terminal-size";

type LogPanelProps = { logs: LogEntry[]; height: number };

const LogPanel: React.FC<LogPanelProps> = (props) => <LogPanelView {...props} scroll={useLogScroll()} />;

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
    };
  });

  afterEach(() => {
    cleanup();
  });

  describe("narrow terminals and the collapsed line", () => {
    const many = (count: number): LogEntry[] =>
      Array.from({ length: count }, (_, index) => createLog(`${index}`, `Log line ${index}`));

    it("keeps its heading on one row in a narrow terminal", async () => {
      const { stdout, lastFrame } = render(<LogPanel logs={many(40)} height={6} />);
      resizeTerminal(stdout, 40, 24);
      await waitForStateUpdate();

      const lines = frameLines(lastFrame());
      expect(lines).toHaveLength(6);
      expect(lines[1]).toContain("📋 Logs");
      expect(lastFrame()).toContain("Log line 39");
    });

    it("folds to the count and the latest entry, coloured by its level", () => {
      const logs = [...many(3), createLog("err", "Sync failed for 'infra'", "error")];
      const { lastFrame } = render(<CollapsedLogLine logs={logs} expandKey="l" />);

      expect(frameLines(lastFrame())).toHaveLength(1);
      expect(lastFrame()).toContain("(4 entries, l to expand)");
      expect(lastFrame()).toContain("Sync failed for 'infra'");
      expect(lastFrame()).not.toContain("Log line 2");
    });
  });

  describe("rendering", () => {
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
        logs: [createLog("1", "First log message"), createLog("2", "Second log message")],
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

      stdin.write("\u001B[A");
      stdin.write("\u001B[A");
      stdin.write("\u001B[A");
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

      stdin.write("\u001B[A");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("more above");
    });
  });

  describe("mouse wheel", () => {
    const ESC = String.fromCharCode(27);
    const wheelUp = `${ESC}[<64;10;5M`;
    const wheelDown = `${ESC}[<65;10;5M`;
    const manyLogs = (): LogEntry[] => Array.from({ length: 40 }, (_, i) => createLog(`${i}`, `Log ${i}`));

    it("scrolls back through history on wheel up", async () => {
      const { stdin, lastFrame } = render(<LogPanel {...defaultProps} logs={manyLogs()} height={10} />);
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Log 39");

      stdin.write(wheelUp);
      await waitForStateUpdate();

      expect(lastFrame()).not.toContain("Log 39");
      expect(lastFrame()).not.toContain("(auto)");
    });

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

    it("ignores button clicks", async () => {
      const { stdin, lastFrame } = render(<LogPanel {...defaultProps} logs={manyLogs()} height={10} />);
      await waitForStateUpdate();

      stdin.write(`${ESC}[<0;10;5M`);
      stdin.write(`${ESC}[<0;10;5m`);
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Log 39");
      expect(lastFrame()).toContain("(auto)");
    });

    it("keeps a parked offset within range when the panel grows", async () => {
      const { stdin, lastFrame, rerender } = render(<LogPanel {...defaultProps} logs={manyLogs()} height={10} />);
      await waitForStateUpdate();

      stdin.write(wheelUp);
      await waitForStateUpdate();
      expect(lastFrame()).not.toContain("(auto)");

      rerender(<LogPanel {...defaultProps} logs={manyLogs()} height={30} />);
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Log 15");
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

    it("should scroll down with down arrow key after scrolling up", async () => {
      const logs = Array.from({ length: 20 }, (_, i) => createLog(`${i}`, `Log ${i}`));
      const props = {
        ...defaultProps,
        logs,
        height: 10,
      };
      const { stdin, lastFrame } = render(<LogPanel {...props} />);

      await waitForStateUpdate();

      stdin.write("\u001B[A");
      stdin.write("\u001B[A");
      await waitForStateUpdate();

      const afterUpFrame = lastFrame();

      stdin.write("\u001B[B");
      await waitForStateUpdate();

      const afterDownFrame = lastFrame();
      expect(afterDownFrame).not.toEqual(afterUpFrame);
    });
  });

  describe("height budget", () => {
    const ESC = String.fromCharCode(27);
    const wheelUp = `${ESC}[<64;10;5M`;
    const manyLogs = (): LogEntry[] => Array.from({ length: 40 }, (_, i) => createLog(`${i}`, `Log ${i}`));

    it("renders exactly `height` rows while following the tail", async () => {
      const { lastFrame } = render(<LogPanel {...defaultProps} logs={manyLogs()} height={10} />);
      await waitForStateUpdate();

      expect(lastFrame()).toContain("more above");
      expect(lastFrame()!.split("\n")).toHaveLength(10);
      expect(lastFrame()).toContain("📋 Logs");
      expect(lastFrame()).toContain("(40 entries)");
      expect(lastFrame()).toContain("Log 39");
    });

    it("renders exactly `height` rows when parked between both indicators", async () => {
      const { stdin, lastFrame } = render(<LogPanel {...defaultProps} logs={manyLogs()} height={10} />);
      await waitForStateUpdate();

      stdin.write(wheelUp);
      await waitForStateUpdate();
      stdin.write(wheelUp);
      await waitForStateUpdate();

      expect(lastFrame()).toContain("more above");
      expect(lastFrame()).toContain("more below");
      expect(lastFrame()!.split("\n")).toHaveLength(10);
      expect(lastFrame()).toContain("📋 Logs");
      expect(lastFrame()).toContain("(40 entries)");
    });

    it("renders exactly `height` rows when an entry still carries newlines", async () => {
      const table = ["phase        ms", "fetch      1200", "prune       300", "create     2000", "status      450"];
      const logs = [...manyLogs(), createLog("multi", table.join("\n"))];
      const { lastFrame } = render(<LogPanel {...defaultProps} logs={logs} height={10} />);
      await waitForStateUpdate();

      const rows = lastFrame()!.split("\n");
      expect(rows).toHaveLength(10);
      expect(rows.at(-1)).toMatch(/^└─+┘$/);
    });

    it("keeps the budget at a height the App cannot shrink further", async () => {
      const { lastFrame } = render(<LogPanel {...defaultProps} logs={manyLogs()} height={5} />);
      await waitForStateUpdate();

      const rows = lastFrame()!.split("\n");
      expect(rows).toHaveLength(5);
      expect(rows.at(-1)).toMatch(/^└─+┘$/);
    });

    it("keeps the header and both counts at the App's minimum height", async () => {
      const { stdin, lastFrame } = render(<LogPanel {...defaultProps} logs={manyLogs()} height={5} />);
      await waitForStateUpdate();

      stdin.write(wheelUp);
      await waitForStateUpdate();
      stdin.write(wheelUp);
      await waitForStateUpdate();

      const rows = lastFrame()!.split("\n");
      expect(rows).toHaveLength(5);
      expect(lastFrame()).toContain("📋 Logs");
      expect(lastFrame()).toContain("(40 entries)");
      expect(lastFrame()).toContain("more above");
      expect(lastFrame()).toContain("more below");
      expect(rows.at(-1)).toMatch(/^└─+┘$/);
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

      stdin.write("\u001B[A");
      await waitForStateUpdate();

      expect(lastFrame()).not.toContain("(auto)");
    });
  });
});

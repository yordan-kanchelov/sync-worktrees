import React from "react";
import { render, cleanup } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import StatusBar, { StatusBarProps } from "../StatusBar";

// Helper to wait for React state updates and effects
const waitForEffects = () => new Promise(resolve => setTimeout(resolve, 100));

describe("StatusBar", () => {
  let defaultProps: StatusBarProps;

  beforeEach(() => {
    defaultProps = {
      status: "idle",
      repositoryCount: 3,
      lastSyncTime: null,
      cronSchedule: undefined,
      diskSpaceUsed: undefined,
    };
  });

  afterEach(() => {
    cleanup();
  });

  describe("rendering", () => {
    it("should render status bar with repository count", () => {
      const { lastFrame } = render(<StatusBar {...defaultProps} />);

      expect(lastFrame()).toContain("Repositories:");
      expect(lastFrame()).toContain("3");
    });

    it("should show different repository counts", () => {
      const { lastFrame: frame1 } = render(<StatusBar {...defaultProps} repositoryCount={1} />);
      expect(frame1()).toContain("1");

      const { lastFrame: frame2 } = render(<StatusBar {...defaultProps} repositoryCount={10} />);
      expect(frame2()).toContain("10");
    });

    it("should render active interactive operations even while idle", () => {
      const { lastFrame } = render(
        <StatusBar {...defaultProps} status="idle" activeOps={["Creating worktree feature/x"]} />,
      );

      expect(lastFrame()).toContain("Running");
      expect(lastFrame()).toContain("Creating worktree feature/x");
    });

    it("should render active operations alongside a running sync", () => {
      const { lastFrame } = render(
        <StatusBar {...defaultProps} status="syncing" activeOps={["Creating worktree feature/y"]} />,
      );

      expect(lastFrame()).toContain("Syncing...");
      expect(lastFrame()).toContain("Creating worktree feature/y");
    });
  });

  describe("status display", () => {
    it("should show Running status when idle", () => {
      const { lastFrame } = render(<StatusBar {...defaultProps} status="idle" />);

      expect(lastFrame()).toContain("Running");
    });

    it("should show Syncing status when syncing", () => {
      const { lastFrame } = render(<StatusBar {...defaultProps} status="syncing" />);

      expect(lastFrame()).toContain("Syncing...");
    });

    it("should change status from idle to syncing", () => {
      const { lastFrame, rerender } = render(<StatusBar {...defaultProps} status="idle" />);

      expect(lastFrame()).toContain("Running");

      rerender(<StatusBar {...defaultProps} status="syncing" />);

      expect(lastFrame()).toContain("Syncing...");
    });

    it("should show current progress while syncing", () => {
      const { lastFrame } = render(
        <StatusBar
          {...defaultProps}
          status="syncing"
          syncProgressEntries={[
            {
              repo: "game-platform",
              phase: "fetch",
              message: "fetch receiving: 75% (70914/94551)",
              progress: 75,
            },
          ]}
        />,
      );

      expect(lastFrame()).toContain("Progress:");
      expect(lastFrame()).toContain("[game-platform] fetch receiving: 75% (70914/94551)");
    });

    it("should show a waiting progress message before the first progress event", () => {
      const { lastFrame } = render(<StatusBar {...defaultProps} status="syncing" />);

      expect(lastFrame()).toContain("Progress:");
      expect(lastFrame()).toContain("waiting for progress events");
    });

    it("should show concurrent progress for two repositories", () => {
      const { lastFrame } = render(
        <StatusBar
          {...defaultProps}
          status="syncing"
          maxProgressLines={2}
          syncProgressEntries={[
            {
              repo: "game-platform",
              phase: "fetch",
              message: "fetch receiving: 75% (70914/94551)",
              progress: 75,
            },
            {
              repo: "game-platform-slots",
              phase: "fetch",
              message: "fetch receiving: 50% (47276/94551)",
              progress: 50,
            },
          ]}
        />,
      );

      expect(lastFrame()).toContain("[game-platform] fetch receiving: 75% (70914/94551)");
      expect(lastFrame()).toContain("[game-platform-slots] fetch receiving: 50% (47276/94551)");
    });

    it("should not show stale progress when idle", () => {
      const { lastFrame } = render(
        <StatusBar
          {...defaultProps}
          status="idle"
          syncProgressEntries={[{ repo: "repo", phase: "fetch", message: "fetch remote", progress: 50 }]}
        />,
      );

      expect(lastFrame()).not.toContain("Progress:");
      expect(lastFrame()).not.toContain("fetch remote");
    });

    it("should not synthesize a percent that is absent from the progress message", () => {
      const { lastFrame } = render(
        <StatusBar
          {...defaultProps}
          status="syncing"
          syncProgressEntries={[{ repo: "repo", phase: "fetch", message: "Receiving objects", progress: 42 }]}
        />,
      );

      expect(lastFrame()).toContain("[repo] Receiving objects");
      expect(lastFrame()).not.toContain("42%");
    });
  });

  describe("last sync time", () => {
    it("should show N/A when lastSyncTime is null", () => {
      const { lastFrame } = render(<StatusBar {...defaultProps} lastSyncTime={null} />);

      expect(lastFrame()).toContain("Last Sync:");
      expect(lastFrame()).toContain("N/A");
    });

    it("should show formatted time when lastSyncTime is provided", () => {
      const syncTime = new Date("2025-01-01T12:00:00");
      const { lastFrame } = render(<StatusBar {...defaultProps} lastSyncTime={syncTime} />);

      expect(lastFrame()).toContain("Last Sync:");
      expect(lastFrame()).not.toContain("N/A");
    });

    it("should update when lastSyncTime changes", () => {
      const { lastFrame, rerender } = render(<StatusBar {...defaultProps} lastSyncTime={null} />);

      expect(lastFrame()).toContain("N/A");

      const syncTime = new Date();
      rerender(<StatusBar {...defaultProps} lastSyncTime={syncTime} />);

      expect(lastFrame()).not.toContain("N/A");
    });
  });

  describe("cron schedule", () => {
    it("should show Next Sync when cronSchedule is provided", () => {
      const { lastFrame } = render(<StatusBar {...defaultProps} cronSchedule="0 * * * *" />);

      expect(lastFrame()).toContain("Next Sync:");
    });

    it("should not show Next Sync when cronSchedule is undefined", () => {
      const { lastFrame } = render(<StatusBar {...defaultProps} cronSchedule={undefined} />);

      expect(lastFrame()).not.toContain("Next Sync:");
    });

    it("should handle invalid cron schedule gracefully", () => {
      const { lastFrame } = render(<StatusBar {...defaultProps} cronSchedule="invalid" />);

      expect(lastFrame()).toContain("Next Sync:");
      expect(lastFrame()).toContain("N/A");
    });

    it("should calculate next sync time for valid cron", async () => {
      const { lastFrame } = render(<StatusBar {...defaultProps} cronSchedule="0 * * * *" />);

      // Wait for useEffect to calculate next sync time
      await waitForEffects();

      const frame = lastFrame();
      expect(frame).toContain("Next Sync:");
      // Check that Next Sync line contains a time (not N/A)
      expect(frame).toMatch(/Next Sync:.*\d{1,2}:\d{2}:\d{2}/);
    });

    it("should re-parse cron expression on each interval tick to avoid drift", async () => {
      vi.useFakeTimers();

      const { CronExpressionParser } = await import("cron-parser");
      const parseSpy = vi.spyOn(CronExpressionParser, "parse");

      render(<StatusBar {...defaultProps} cronSchedule="0 * * * *" />);

      // Initial render calls parse once
      const initialCallCount = parseSpy.mock.calls.length;
      expect(initialCallCount).toBeGreaterThanOrEqual(1);

      // Advance by 60s to trigger interval
      vi.advanceTimersByTime(60000);

      // Should have called parse again (fresh instance, not reusing iterator)
      expect(parseSpy.mock.calls.length).toBeGreaterThan(initialCallCount);

      parseSpy.mockRestore();
      vi.useRealTimers();
    });

    it("should update next sync time when cronSchedule changes", () => {
      const { lastFrame, rerender } = render(<StatusBar {...defaultProps} cronSchedule={undefined} />);

      expect(lastFrame()).not.toContain("Next Sync:");

      rerender(<StatusBar {...defaultProps} cronSchedule="0 * * * *" />);

      expect(lastFrame()).toContain("Next Sync:");
    });
  });

  describe("disk space", () => {
    it("should show Calculating... when diskSpaceUsed is undefined", () => {
      const { lastFrame } = render(<StatusBar {...defaultProps} diskSpaceUsed={undefined} />);

      expect(lastFrame()).toContain("Disk Space:");
      expect(lastFrame()).toContain("Calculating...");
    });

    it("should show disk space value when provided", () => {
      const { lastFrame } = render(<StatusBar {...defaultProps} diskSpaceUsed="1.2 GB" />);

      expect(lastFrame()).toContain("Disk Space:");
      expect(lastFrame()).toContain("1.2 GB");
      expect(lastFrame()).not.toContain("Calculating...");
    });

    it("should show N/A when disk space calculation fails", () => {
      const { lastFrame } = render(<StatusBar {...defaultProps} diskSpaceUsed="N/A" />);

      expect(lastFrame()).toContain("Disk Space:");
      expect(lastFrame()).toContain("N/A");
    });

    it("should update when diskSpaceUsed changes", () => {
      const { lastFrame, rerender } = render(<StatusBar {...defaultProps} diskSpaceUsed={undefined} />);

      expect(lastFrame()).toContain("Calculating...");

      rerender(<StatusBar {...defaultProps} diskSpaceUsed="500 MB" />);

      expect(lastFrame()).toContain("500 MB");
      expect(lastFrame()).not.toContain("Calculating...");
    });

  });
});

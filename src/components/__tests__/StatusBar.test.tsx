import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect, beforeEach } from "vitest";

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
  });

  describe("status display", () => {
    it("should show Running status when idle", () => {
      const { lastFrame } = render(<StatusBar {...defaultProps} status="idle" />);

      expect(lastFrame()).toContain("Running");
      expect(lastFrame()).toContain("✓");
    });

    it("should show Syncing status when syncing", () => {
      const { lastFrame } = render(<StatusBar {...defaultProps} status="syncing" />);

      expect(lastFrame()).toContain("Syncing...");
      expect(lastFrame()).toContain("⟳");
    });

    it("should change status from idle to syncing", () => {
      const { lastFrame, rerender } = render(<StatusBar {...defaultProps} status="idle" />);

      expect(lastFrame()).toContain("Running");

      rerender(<StatusBar {...defaultProps} status="syncing" />);

      expect(lastFrame()).toContain("Syncing...");
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

    it("should update next sync time when cronSchedule changes", () => {
      const { lastFrame, rerender } = render(<StatusBar {...defaultProps} cronSchedule={undefined} />);

      expect(lastFrame()).not.toContain("Next Sync:");

      rerender(<StatusBar {...defaultProps} cronSchedule="0 * * * *" />);

      expect(lastFrame()).toContain("Next Sync:");
    });
  });

  describe("visual elements", () => {
    it("should show checkmark icon when idle", () => {
      const { lastFrame } = render(<StatusBar {...defaultProps} status="idle" />);

      expect(lastFrame()).toContain("✓");
    });

    it("should show sync icon when syncing", () => {
      const { lastFrame } = render(<StatusBar {...defaultProps} status="syncing" />);

      expect(lastFrame()).toContain("⟳");
    });

    it("should have Status label", () => {
      const { lastFrame } = render(<StatusBar {...defaultProps} />);

      expect(lastFrame()).toContain("Status:");
    });

    it("should have Repositories label", () => {
      const { lastFrame } = render(<StatusBar {...defaultProps} />);

      expect(lastFrame()).toContain("Repositories:");
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

    it("should display different disk space formats correctly", () => {
      const testCases = ["123.45 KB", "12.34 MB", "5.67 GB", "1.23 TB"];

      testCases.forEach((diskSpace) => {
        const { lastFrame } = render(<StatusBar {...defaultProps} diskSpaceUsed={diskSpace} />);
        expect(lastFrame()).toContain(diskSpace);
      });
    });
  });
});

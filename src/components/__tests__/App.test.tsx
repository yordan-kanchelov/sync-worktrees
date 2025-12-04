import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import App, { AppProps } from "../App";
import { appEvents } from "../../utils/app-events";

// Helper to wait for React state updates
const waitForStateUpdate = () => new Promise(resolve => setTimeout(resolve, 100));

describe("App", () => {
  let defaultProps: AppProps;

  beforeEach(() => {
    defaultProps = {
      repositoryCount: 3,
      cronSchedule: "0 * * * *",
      onManualSync: vi.fn(),
      onReload: vi.fn(),
      onQuit: vi.fn(),
      getRepositoryList: vi.fn().mockReturnValue([{ index: 0, name: "test-repo", repoUrl: "https://example.com/repo.git" }]),
      getBranchesForRepo: vi.fn().mockResolvedValue(["main", "develop"]),
      getDefaultBranchForRepo: vi.fn().mockReturnValue("main"),
      createAndPushBranch: vi.fn().mockResolvedValue({ success: true, finalName: "test-branch" }),
      getWorktreesForRepo: vi.fn().mockResolvedValue([{ path: "/worktrees/main", branch: "main" }]),
      openEditorInWorktree: vi.fn().mockReturnValue({ success: true }),
      createWorktreeForBranch: vi.fn().mockResolvedValue(undefined),
    };

    appEvents.removeAllListeners();
  });

  afterEach(() => {
    appEvents.removeAllListeners();
  });

  describe("rendering", () => {
    it("should render status bar with repository count", () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      expect(lastFrame()).toContain("Repositories:");
      expect(lastFrame()).toContain("3");
    });

    it("should render initial status as Running", () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      expect(lastFrame()).toContain("Running");
    });

  });

  describe("event subscriptions", () => {
    it("should respond to appEvents on mount", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      appEvents.emit("setStatus", "syncing");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Syncing...");
    });

    it("should clean up event subscriptions on unmount", async () => {
      const { unmount, lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();
      expect(lastFrame()).toContain("Running");

      unmount();

      // Events should no longer affect the component after unmount
      appEvents.emit("setStatus", "syncing");
      await waitForStateUpdate();
      // No error should occur - events are just silently ignored
    });
  });


  describe("updateLastSyncTime functionality", () => {
    it("should update last sync time and set status to idle", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      appEvents.emit("setStatus", "syncing");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Syncing...");

      appEvents.emit("updateLastSyncTime");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Running");
      expect(lastFrame()).not.toContain("Syncing...");
    });

    it("should show last sync time after update", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      expect(lastFrame()).toContain("Last Sync:");
      expect(lastFrame()).toContain("N/A");

      appEvents.emit("updateLastSyncTime");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Last Sync:");
      expect(lastFrame()).not.toContain("N/A");
    });
  });

  describe("setStatus functionality", () => {
    it("should change status from idle to syncing", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      expect(lastFrame()).toContain("Running");

      appEvents.emit("setStatus", "syncing");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Syncing...");
      expect(lastFrame()).not.toContain("Running");
    });

    it("should change status from syncing to idle", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      appEvents.emit("setStatus", "syncing");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Syncing...");

      appEvents.emit("setStatus", "idle");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Running");
    });
  });

  describe("keyboard input", () => {
    it("should call onQuit when q is pressed", () => {
      const onQuit = vi.fn();
      const { stdin } = render(<App {...defaultProps} onQuit={onQuit} />);

      stdin.write("q");

      expect(onQuit).toHaveBeenCalled();
    });

    it("should toggle help modal when ? is pressed", async () => {
      const { stdin, lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate(); // Wait for useEffect to set up

      expect(lastFrame()).not.toContain("Keyboard Shortcuts");

      stdin.write("?");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Keyboard Shortcuts");

      stdin.write("?");
      await waitForStateUpdate();

      expect(lastFrame()).not.toContain("Keyboard Shortcuts");
    });

    it("should toggle help modal when h is pressed", async () => {
      const { stdin, lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate(); // Wait for useEffect to set up

      expect(lastFrame()).not.toContain("Keyboard Shortcuts");

      stdin.write("h");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Keyboard Shortcuts");
    });

    it("should call onManualSync when s is pressed", () => {
      const onManualSync = vi.fn();
      const { stdin } = render(<App {...defaultProps} onManualSync={onManualSync} />);

      stdin.write("s");

      expect(onManualSync).toHaveBeenCalled();
    });

    it("should not call onManualSync when syncing is in progress", async () => {
      const onManualSync = vi.fn();
      const { stdin } = render(<App {...defaultProps} onManualSync={onManualSync} />);

      await waitForStateUpdate();

      appEvents.emit("setStatus", "syncing");
      await waitForStateUpdate();

      stdin.write("s");

      expect(onManualSync).not.toHaveBeenCalled();
    });

    it("should call onReload when r is pressed", () => {
      const onReload = vi.fn();
      const { stdin } = render(<App {...defaultProps} onReload={onReload} />);

      stdin.write("r");

      expect(onReload).toHaveBeenCalled();
    });

    it("should not call onReload when syncing is in progress", async () => {
      const onReload = vi.fn();
      const { stdin } = render(<App {...defaultProps} onReload={onReload} />);

      await waitForStateUpdate();

      appEvents.emit("setStatus", "syncing");
      await waitForStateUpdate();

      stdin.write("r");

      expect(onReload).not.toHaveBeenCalled();
    });
  });

  describe("cron schedule", () => {
    it("should display next sync time when cron schedule is provided", () => {
      const { lastFrame } = render(<App {...defaultProps} cronSchedule="0 * * * *" />);

      expect(lastFrame()).toContain("Next Sync:");
    });

    it("should not display next sync time when no cron schedule", () => {
      const { lastFrame } = render(<App {...defaultProps} cronSchedule={undefined} />);

      expect(lastFrame()).not.toContain("Next Sync:");
    });
  });

  describe("setDiskSpace functionality", () => {
    it("should initially show Calculating... for disk space", () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      expect(lastFrame()).toContain("Disk Space:");
      expect(lastFrame()).toContain("Calculating...");
    });

    it("should update disk space when setDiskSpace is called", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      expect(lastFrame()).toContain("Calculating...");

      appEvents.emit("setDiskSpace", "1.2 GB");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("1.2 GB");
      expect(lastFrame()).not.toContain("Calculating...");
    });

    it("should handle N/A disk space value", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      appEvents.emit("setDiskSpace", "N/A");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("N/A");
    });

    it("should update disk space multiple times", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      appEvents.emit("setDiskSpace", "500 MB");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("500 MB");

      appEvents.emit("setDiskSpace", "1.2 GB");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("1.2 GB");
      expect(lastFrame()).not.toContain("500 MB");
    });
  });

  describe("addLog functionality", () => {
    it("should respond to addLog events", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      appEvents.emit("addLog", { message: "Test message", level: "info" });
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Test message");
    });

    it("should display info logs", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      appEvents.emit("addLog", { message: "Test info message", level: "info" });
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Test info message");
    });

    it("should display warn logs", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      appEvents.emit("addLog", { message: "Test warning message", level: "warn" });
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Test warning message");
    });

    it("should display error logs", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      appEvents.emit("addLog", { message: "Test error message", level: "error" });
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Test error message");
    });

    it("should display multiple logs in order", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      appEvents.emit("addLog", { message: "First log", level: "info" });
      appEvents.emit("addLog", { message: "Second log", level: "info" });
      appEvents.emit("addLog", { message: "Third log", level: "info" });
      await waitForStateUpdate();

      const frame = lastFrame();
      expect(frame).toContain("First log");
      expect(frame).toContain("Second log");
      expect(frame).toContain("Third log");
    });
  });
});

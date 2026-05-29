import React from "react";
import { render, cleanup } from "ink-testing-library";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import App, { AppProps } from "../App";
import { AppEventEmitter } from "../../utils/app-events";

// Helper to wait for React state updates
const waitForStateUpdate = () => new Promise(resolve => setTimeout(resolve, 100));

describe("App", () => {
  let defaultProps: AppProps;
  let appEvents: AppEventEmitter;

  beforeEach(() => {
    appEvents = new AppEventEmitter();
    defaultProps = {
      events: appEvents,
      repositoryCount: 3,
      cronSchedule: "0 * * * *",
      onManualSync: vi.fn(),
      onReload: vi.fn(),
      onQuit: vi.fn().mockResolvedValue(undefined),
      getRepositoryList: vi.fn().mockReturnValue([{ index: 0, name: "test-repo", repoUrl: "https://example.com/repo.git" }]),
      getBranchesForRepo: vi.fn().mockResolvedValue(["main", "develop"]),
      getDefaultBranchForRepo: vi.fn().mockReturnValue("main"),
      createAndPushBranch: vi.fn().mockResolvedValue({ success: true, finalName: "test-branch" }),
      getWorktreesForRepo: vi.fn().mockResolvedValue([{ path: "/worktrees/main", branch: "main" }]),
      openEditorInWorktree: vi.fn().mockReturnValue({ success: true }),
      openTerminalInWorktree: vi.fn().mockReturnValue({ success: true }),
      createWorktreeForBranch: vi.fn().mockResolvedValue(undefined),
      getWorktreeStatusForRepo: vi.fn().mockResolvedValue([]),
    };
  });

  afterEach(() => {
    cleanup();
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

    it("should render sync progress events in the status bar", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      appEvents.emit("setStatus", "syncing");
      appEvents.emit("setSyncProgress", {
        repo: "game-platform",
        phase: "fetch",
        message: "fetch receiving: 75% (70914/94551)",
        progress: 75,
      });
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Progress:");
      expect(lastFrame()).toContain("[game-platform] fetch receiving: 75% (70914/94551)");
    });

    it("should render progress for concurrent repositories", async () => {
      const { lastFrame } = render(<App {...defaultProps} maxProgressLines={2} />);

      await waitForStateUpdate();

      appEvents.emit("setStatus", "syncing");
      appEvents.emit("setSyncProgress", {
        repo: "game-platform",
        phase: "fetch",
        message: "fetch receiving: 75% (70914/94551)",
        progress: 75,
      });
      appEvents.emit("setSyncProgress", {
        repo: "game-platform-slots",
        phase: "fetch",
        message: "fetch receiving: 50% (47276/94551)",
        progress: 50,
      });
      await waitForStateUpdate();

      expect(lastFrame()).toContain("[game-platform] fetch receiving: 75% (70914/94551)");
      expect(lastFrame()).toContain("[game-platform-slots] fetch receiving: 50% (47276/94551)");
    });

    it("should remove a repository progress row when it completes", async () => {
      const { lastFrame } = render(<App {...defaultProps} maxProgressLines={2} />);

      await waitForStateUpdate();

      appEvents.emit("setStatus", "syncing");
      appEvents.emit("setSyncProgress", {
        repo: "game-platform",
        phase: "fetch",
        message: "fetch receiving",
      });
      appEvents.emit("setSyncProgress", {
        repo: "game-platform-slots",
        phase: "fetch",
        message: "fetch receiving",
      });
      await waitForStateUpdate();
      expect(lastFrame()).toContain("[game-platform] fetch receiving");
      expect(lastFrame()).toContain("[game-platform-slots] fetch receiving");

      appEvents.emit("setSyncProgress", {
        repo: "game-platform",
        phase: "complete",
        message: "Finished",
        completed: true,
      });
      await waitForStateUpdate();

      expect(lastFrame()).not.toContain("[game-platform] fetch receiving");
      expect(lastFrame()).toContain("[game-platform-slots] fetch receiving");
    });

    it("should clear sync progress when status returns to idle", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      appEvents.emit("setStatus", "syncing");
      appEvents.emit("setSyncProgress", {
        repo: "repo",
        phase: "fetch",
        message: "fetch remote",
      });
      await waitForStateUpdate();
      expect(lastFrame()).toContain("fetch remote");

      appEvents.emit("setStatus", "idle");
      await waitForStateUpdate();

      expect(lastFrame()).not.toContain("Progress:");
      expect(lastFrame()).not.toContain("fetch remote");
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
      const onQuit = vi.fn().mockResolvedValue(undefined);
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

    it("should show worktree status view when w is pressed", async () => {
      const { stdin, lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      stdin.write("w");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Worktree Status");
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

  describe("commands available while syncing", () => {
    // create/open/status no longer require an idle status: they either don't touch
    // git (open/status) or queue behind the sync (create). See the repo-mutex design.
    it("should open the branch creation wizard with c while syncing", async () => {
      const { stdin, lastFrame } = render(<App {...defaultProps} />);
      await waitForStateUpdate();

      appEvents.emit("setStatus", "syncing");
      await waitForStateUpdate();

      stdin.write("c");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Select base branch:");
    });

    it("should open the open-worktree wizard with o while syncing", async () => {
      const { stdin, lastFrame } = render(<App {...defaultProps} />);
      await waitForStateUpdate();

      appEvents.emit("setStatus", "syncing");
      await waitForStateUpdate();

      stdin.write("o");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Select worktree:");
    });

    it("should open the worktree status view with w while syncing", async () => {
      const { stdin, lastFrame } = render(<App {...defaultProps} />);
      await waitForStateUpdate();

      appEvents.emit("setStatus", "syncing");
      await waitForStateUpdate();

      stdin.write("w");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Worktree Status");
    });
  });

  describe("updateRepositoryCount event", () => {
    it("should update repository count when event is emitted", async () => {
      const { lastFrame } = render(<App {...defaultProps} repositoryCount={3} />);

      await waitForStateUpdate();

      expect(lastFrame()).toContain("3");

      appEvents.emit("updateRepositoryCount", 5);
      await waitForStateUpdate();

      expect(lastFrame()).toContain("5");
    });
  });

  describe("updateCronSchedule event", () => {
    it("should update cron schedule when event is emitted", async () => {
      const { lastFrame } = render(<App {...defaultProps} cronSchedule="0 * * * *" />);

      await waitForStateUpdate();

      expect(lastFrame()).toContain("Next Sync:");

      appEvents.emit("updateCronSchedule", "*/30 * * * *");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Next Sync:");
    });

    it("should hide next sync time when schedule becomes undefined", async () => {
      const { lastFrame } = render(<App {...defaultProps} cronSchedule="0 * * * *" />);

      await waitForStateUpdate();

      expect(lastFrame()).toContain("Next Sync:");

      appEvents.emit("updateCronSchedule", undefined);
      await waitForStateUpdate();

      expect(lastFrame()).not.toContain("Next Sync:");
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

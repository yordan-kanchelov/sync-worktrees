import React from "react";
import { render, cleanup } from "ink-testing-library";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { AppProps } from "../App";
import App, { LOG_FLUSH_INTERVAL_MS } from "../App";
import { AppEventEmitter } from "../../utils/app-events";
import type { RepositoryDashboardRow } from "../../utils/app-events";
import { resizeTerminal } from "./terminal-size";

// Helper to wait for React state updates
const waitForStateUpdate = () => new Promise((resolve) => setTimeout(resolve, 100));

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
      getRepositoryList: vi
        .fn()
        .mockReturnValue([{ index: 0, name: "test-repo", repoUrl: "https://example.com/repo.git" }]),
      getBranchesForRepo: vi.fn().mockResolvedValue(["main", "develop"]),
      getDefaultBranchForRepo: vi.fn().mockResolvedValue("main"),
      createAndPushBranch: vi.fn().mockResolvedValue({ success: true, finalName: "test-branch" }),
      getWorktreesForRepo: vi.fn().mockResolvedValue([{ path: "/worktrees/main", branch: "main" }]),
      openEditorInWorktree: vi.fn().mockReturnValue({ success: true }),
      openTerminalInWorktree: vi.fn().mockReturnValue({ success: true }),
      createWorktreeForBranch: vi.fn().mockResolvedValue(undefined),
      getWorktreeStatusForRepo: vi.fn().mockResolvedValue([]),
      getForceCleanPreview: vi.fn().mockResolvedValue([
        {
          repoIndex: 0,
          repoName: "test-repo",
          preview: {
            trashEntries: 2,
            trashBytes: 1024,
            unknownTrashSizes: 0,
            invalidTrashEntries: 1,
            keepRefs: 1,
            trashEntryIds: ["entry-a", "entry-b"],
            keepRefNames: ["refs/sync-worktrees/keep/ref-a"],
          },
        },
      ]),
      forceClean: vi.fn().mockResolvedValue([
        {
          repoIndex: 0,
          repoName: "test-repo",
          result: {
            trashEntries: 0,
            trashBytes: 0,
            unknownTrashSizes: 0,
            invalidTrashEntries: 1,
            keepRefs: 0,
            trashEntryIds: [],
            keepRefNames: [],
            trashDeleted: 2,
            keepRefsDeleted: 1,
            keepRefsRetained: 0,
            skippedNewEntries: 0,
            skippedNewKeepRefs: 0,
            gcSucceeded: true,
            errors: [],
          },
        },
      ]),
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

    it("should render initial status as Idle", () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      expect(lastFrame()).toContain("Idle");
    });
  });

  describe("event subscriptions", () => {
    // index.ts kicks off the daemon's startup sync in the same synchronous turn
    // as InteractiveUIService's constructor — the turn render() runs in. Log
    // lines survive a late mount either way, because addLog buffers until
    // `uiReady` and flushLogBuffer replays in call order; setStatus and
    // setSyncProgress have no buffer at all. Emitted before this effect has
    // subscribed they are dropped on the floor, and the status bar would read
    // Running for the whole of the first sync with an empty progress panel.
    // Ink flushes a mount effect synchronously inside render(); pin it, because
    // that is what makes the startup sync's status reach the screen.
    it("emits uiReady before render() returns", () => {
      const seen: string[] = [];
      appEvents.on("uiReady", () => seen.push("uiReady"));

      render(<App {...defaultProps} />);

      expect(seen).toEqual(["uiReady"]);
    });

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
      expect(lastFrame()).toContain("Idle");

      unmount();

      // Events should no longer affect the component after unmount
      appEvents.emit("setStatus", "syncing");
      await waitForStateUpdate();
      // No error should occur - events are just silently ignored
    });
  });

  describe("updateLastSyncTime functionality", () => {
    // The stamp is not the end of the sync. The service emits it from inside a
    // cycle, and with cycles overlapping, the one that stamps is not
    // necessarily the last one out: ending the sync here put the bar back to
    // `Running` and took another cycle's progress rows off the screen mid-fetch.
    it("does not end the sync or clear the progress rows when the last sync time is stamped", async () => {
      const { lastFrame } = render(<App {...defaultProps} maxProgressLines={2} />);

      await waitForStateUpdate();

      appEvents.emit("setStatus", "syncing");
      appEvents.emit("setSyncProgress", { repo: "repo-a", phase: "fetch", message: "fetch receiving: 40%" });
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Syncing...");
      expect(lastFrame()).toContain("[repo-a] fetch receiving: 40%");

      appEvents.emit("updateLastSyncTime");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Syncing...");
      expect(lastFrame()).toContain("[repo-a] fetch receiving: 40%");
      expect(lastFrame()).not.toContain("N/A");

      // `setStatus` is the one gate, and it still ends it.
      appEvents.emit("setStatus", "idle");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Idle");
      expect(lastFrame()).not.toContain("[repo-a] fetch receiving: 40%");
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

      expect(lastFrame()).toContain("Idle");

      appEvents.emit("setStatus", "syncing");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Syncing...");
      expect(lastFrame()).not.toContain("Idle");
    });

    it("should change status from syncing to idle", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      appEvents.emit("setStatus", "syncing");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Syncing...");

      appEvents.emit("setStatus", "idle");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Idle");
    });
  });

  describe("keyboard input", () => {
    it("should call onQuit when q is pressed", () => {
      const onQuit = vi.fn().mockResolvedValue(undefined);
      const { stdin } = render(<App {...defaultProps} onQuit={onQuit} />);

      stdin.write("q");

      expect(onQuit).toHaveBeenCalled();
    });

    it("does not quit when Esc is pressed on the main screen", async () => {
      const onQuit = vi.fn().mockResolvedValue(undefined);
      const { stdin, lastFrame } = render(<App {...defaultProps} onQuit={onQuit} />);

      await waitForStateUpdate();

      stdin.write("\x1b");
      // Ink v7 buffers a lone ESC and flushes it as `key.escape` after a 20ms
      // debounce (to disambiguate it from the start of an escape sequence), so
      // this has to wait rather than assert on the next tick.
      await waitForStateUpdate();

      expect(onQuit).not.toHaveBeenCalled();
      expect(lastFrame()).toContain("Repositories:");
    });

    it("does not quit on the Esc that follows the one closing the help screen", async () => {
      // Esc is this interface's "back out" key everywhere it is bound, so it
      // arrives in runs: one to close the screen, and whatever the hand adds.
      // The extra ones have to land on nothing.
      const onQuit = vi.fn().mockResolvedValue(undefined);
      const { stdin, lastFrame } = render(<App {...defaultProps} onQuit={onQuit} />);

      await waitForStateUpdate();

      stdin.write("?");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Keyboard Shortcuts");

      stdin.write("\x1b");
      await waitForStateUpdate();
      expect(lastFrame()).not.toContain("Keyboard Shortcuts");

      stdin.write("\x1b");
      await waitForStateUpdate();

      expect(onQuit).not.toHaveBeenCalled();
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

    it("previews and confirms force clean with x then the typed word", async () => {
      const { stdin, lastFrame } = render(<App {...defaultProps} />);

      stdin.write("x");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Force Clean");
      expect(lastFrame()).toContain("2 trash");
      expect(lastFrame()).toContain("1 skipped invalid");

      stdin.write("clean");
      await waitForStateUpdate();
      stdin.write("\r");
      await waitForStateUpdate();

      expect(defaultProps.forceClean).toHaveBeenCalledTimes(1);
      // `y` authorizes the set behind the counts it just read out, so that is
      // what reaches the service — not "whatever is in the trash by then".
      expect(defaultProps.forceClean).toHaveBeenCalledWith([
        {
          repoIndex: 0,
          trashEntryIds: ["entry-a", "entry-b"],
          keepRefNames: ["refs/sync-worktrees/keep/ref-a"],
        },
      ]);
      expect(lastFrame()).toContain("deleted 2 trash and 1 refs");
    });

    it("cancels force clean with Esc", async () => {
      const { stdin, lastFrame } = render(<App {...defaultProps} />);

      stdin.write("x");
      await waitForStateUpdate();
      stdin.write("\u001B");
      await waitForStateUpdate();

      expect(defaultProps.forceClean).not.toHaveBeenCalled();
      expect(lastFrame()).not.toContain("Force Clean");
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

  describe("keys that cannot act during a sync", () => {
    it.each(["s", "r", "x"])("says a sync is in progress when %s is pressed during one", async (key) => {
      const onManualSync = vi.fn();
      const onReload = vi.fn();
      const { stdin, lastFrame } = render(<App {...defaultProps} onManualSync={onManualSync} onReload={onReload} />);
      await waitForStateUpdate();

      appEvents.emit("setStatus", "syncing");
      await waitForStateUpdate();

      stdin.write(key);
      await waitForStateUpdate();

      expect(lastFrame()).toContain("A sync is in progress");
      expect(lastFrame()).not.toContain("Force Clean");
      expect(onManualSync).not.toHaveBeenCalled();
      expect(onReload).not.toHaveBeenCalled();
    });

    it("clears the notice after a moment", async () => {
      const { stdin, lastFrame } = render(<App {...defaultProps} />);
      await waitForStateUpdate();
      appEvents.emit("setStatus", "syncing");
      await waitForStateUpdate();

      stdin.write("s");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("A sync is in progress");

      await new Promise((resolve) => setTimeout(resolve, 2600));
      expect(lastFrame()).not.toContain("A sync is in progress");
      expect(lastFrame()).toContain("help");
    });
  });

  describe("quitting while work is running", () => {
    it("asks before quitting during a sync, and quits on a second q", async () => {
      const onQuit = vi.fn().mockResolvedValue(undefined);
      const { stdin, lastFrame } = render(<App {...defaultProps} onQuit={onQuit} />);
      await waitForStateUpdate();
      appEvents.emit("setStatus", "syncing");
      await waitForStateUpdate();

      stdin.write("q");
      await waitForStateUpdate();
      expect(onQuit).not.toHaveBeenCalled();
      expect(lastFrame()).toContain("a sync still running — press q again to quit");

      stdin.write("q");
      await waitForStateUpdate();
      expect(onQuit).toHaveBeenCalledTimes(1);
    });

    it("stays when any other key follows the question", async () => {
      const onQuit = vi.fn().mockResolvedValue(undefined);
      const onManualSync = vi.fn();
      const { stdin, lastFrame } = render(<App {...defaultProps} onQuit={onQuit} onManualSync={onManualSync} />);
      await waitForStateUpdate();
      appEvents.emit("setStatus", "syncing");
      await waitForStateUpdate();

      stdin.write("q");
      await waitForStateUpdate();
      stdin.write("n");
      await waitForStateUpdate();

      expect(onQuit).not.toHaveBeenCalled();
      expect(lastFrame()).not.toContain("press q again");

      stdin.write("q");
      await waitForStateUpdate();
      expect(onQuit).not.toHaveBeenCalled();
      expect(lastFrame()).toContain("press q again");
    });

    it("asks while a hook is still running", async () => {
      const onQuit = vi.fn().mockResolvedValue(undefined);
      const { stdin, lastFrame } = render(<App {...defaultProps} onQuit={onQuit} getRunningHookCount={() => 2} />);
      await waitForStateUpdate();

      stdin.write("q");
      await waitForStateUpdate();

      expect(onQuit).not.toHaveBeenCalled();
      expect(lastFrame()).toContain("2 hooks still running");
    });

    // After the confirmed quit the service is waiting on the sync, and its own
    // notice says a second q forces the exit. Asking again would swallow it.
    it("passes every q after a confirmed quit straight through", async () => {
      const onQuit = vi.fn().mockResolvedValue(undefined);
      const { stdin } = render(<App {...defaultProps} onQuit={onQuit} />);
      await waitForStateUpdate();
      appEvents.emit("setStatus", "syncing");
      await waitForStateUpdate();

      stdin.write("q");
      await waitForStateUpdate();
      stdin.write("q");
      await waitForStateUpdate();
      stdin.write("q");
      await waitForStateUpdate();

      expect(onQuit).toHaveBeenCalledTimes(2);
    });
  });

  describe("last sync outcome", () => {
    it("shows failures in words next to the last sync time", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);
      await waitForStateUpdate();

      appEvents.emit("updateLastSyncTime");
      appEvents.emit("setLastSyncOutcome", { kind: "failed", count: 2 });
      await waitForStateUpdate();

      expect(lastFrame()).toContain("✗ 2 failed");
      expect(lastFrame()).toContain("Idle");

      appEvents.emit("setLastSyncOutcome", { kind: "ok" });
      await waitForStateUpdate();
      expect(lastFrame()).not.toContain("failed");
      expect(lastFrame()).toContain("✓ OK");
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
    it("shows the next sync when repositories use different schedules", () => {
      const { lastFrame } = render(<App {...defaultProps} cronSchedule={["0 * * * *", "*/5 * * * *"]} />);

      expect(lastFrame()).toContain("Next Sync:");
      expect(lastFrame()).not.toMatch(/Next Sync: N\/A/);
    });

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

    // A message with newlines in it rendered as several rows out of a panel
    // that had budgeted one, which is how the frame grew past the terminal.
    it("splits a multi-line message into one entry per line", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      appEvents.emit("addLog", { message: "Synchronization finished.\nElapsed: 1.2s", level: "info" });
      await waitForStateUpdate();

      const frame = lastFrame();
      expect(frame).toContain("Synchronization finished.");
      expect(frame).toContain("Elapsed: 1.2s");
      expect(frame).toContain("(2 entries)");
    });

    // A terminator is not a line of its own: the panel would spend a row on it.
    it("does not turn a trailing newline into an empty entry", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      appEvents.emit("addLog", { message: "Synchronization finished.\n", level: "info" });
      await waitForStateUpdate();

      expect(lastFrame()).toContain("(1 entries)");
      // One entry and one row: the newline that used to survive into the entry
      // rendered as a second row and pushed the frame past the terminal.
      expect(lastFrame()!.split("\n")).toHaveLength(24);
    });

    // Nor a leading one, and both multi-line producers open with one:
    // `Logger.table` wraps its content in newlines at both ends, and the sync
    // failure line starts with one.
    it("does not turn a leading newline into an empty entry", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      appEvents.emit("addLog", { message: "\nphase\tms\nfetch\t1200\n", level: "info" });
      await waitForStateUpdate();

      expect(lastFrame()).toContain("(2 entries)");
      expect(lastFrame()).toContain("fetch");
    });
  });

  // The frame is sized to the terminal: one row over and Ink stops rendering
  // incrementally, clears the whole screen on every render and scrolls the top
  // row out of view.
  describe("frame height", () => {
    it("fills exactly the terminal height once the log panel is full", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      for (let i = 0; i < 100; i++) {
        appEvents.emit("addLog", { message: `Log line ${i}`, level: "info" });
      }
      await waitForStateUpdate();

      const frame = lastFrame()!;
      expect(frame.split("\n")).toHaveLength(24);
      expect(frame).toContain("📋 Logs");
      expect(frame).toContain("uit");
    });

    it("stays at the terminal height while syncing with progress rows", async () => {
      const { lastFrame } = render(<App {...defaultProps} maxProgressLines={2} />);

      await waitForStateUpdate();

      for (let i = 0; i < 100; i++) {
        appEvents.emit("addLog", { message: `Log line ${i}`, level: "info" });
      }
      appEvents.emit("setStatus", "syncing");
      appEvents.emit("setSyncProgress", { repo: "repo-a", phase: "fetch", message: "fetch receiving" });
      await waitForStateUpdate();

      const frame = lastFrame()!;
      expect(frame).toContain("[repo-a] fetch receiving");
      expect(frame.split("\n")).toHaveLength(24);
    });

    it("stays at the terminal height when a log entry carries newlines", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate();

      for (let i = 0; i < 100; i++) {
        appEvents.emit("addLog", { message: `Log line ${i}`, level: "info" });
      }
      appEvents.emit("addLog", { message: "phase\ttook\nfetch\t1.2s\nprune\t0.3s\ncreate\t2.0s", level: "info" });
      await waitForStateUpdate();

      const frame = lastFrame()!;
      expect(frame.split("\n")).toHaveLength(24);
      expect(frame).toContain("📋 Logs");
    });
  });
  describe("mouse wheel", () => {
    const ESC = String.fromCharCode(27);
    const wheelUp = `${ESC}[<64;10;5M`;

    const fillLogs = async (): Promise<void> => {
      for (let i = 0; i < 40; i++) {
        appEvents.emit("addLog", { message: `Log line ${i}`, level: "info" });
      }
      await waitForStateUpdate();
    };

    it("scrolls the log panel with the wheel", async () => {
      const { stdin, lastFrame } = render(<App {...defaultProps} />);
      await waitForStateUpdate();
      await fillLogs();
      expect(lastFrame()).toContain("Log line 39");

      stdin.write(wheelUp);
      await waitForStateUpdate();

      expect(lastFrame()).not.toContain("Log line 39");
    });

    // The whole point of the guard: a mouse report is one `input` string, and
    // anything that echoes input would otherwise paint the escape sequence.
    it("never renders a mouse report as text", async () => {
      const { stdin, lastFrame } = render(<App {...defaultProps} />);
      await waitForStateUpdate();
      await fillLogs();

      stdin.write(wheelUp);
      stdin.write(`${ESC}[<0;10;5M`);
      await waitForStateUpdate();

      expect(lastFrame()).not.toContain("[<");
      expect(lastFrame()).not.toContain("64;10;5");
    });

    // A stray click must not trip a single-key shortcut such as quit.
    it("does not fire shortcuts on a click report", async () => {
      const { stdin } = render(<App {...defaultProps} />);
      await waitForStateUpdate();

      stdin.write(`${ESC}[<0;10;5M`);
      stdin.write(`${ESC}[<0;10;5m`);
      await waitForStateUpdate();

      expect(defaultProps.onQuit).not.toHaveBeenCalled();
      expect(defaultProps.onManualSync).not.toHaveBeenCalled();
    });
  });

  // Every log line used to copy the whole buffer and re-render the tree on its
  // own, and a sync delivers its lines one tick apart, so React could not batch
  // them either.
  describe("log batching", () => {
    const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    it("renders a burst of log lines in one update instead of one per line", async () => {
      const { lastFrame, frames } = render(<App {...defaultProps} />);
      await waitForStateUpdate();
      const framesBefore = frames.length;

      for (let i = 0; i < 20; i++) {
        appEvents.emit("addLog", { message: `Burst line ${i}`, level: "info" });
        await nextTick();
      }
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Burst line 19");
      expect(lastFrame()).toContain("(20 entries)");
      // One flush, with slack for a slow machine splitting the burst in two.
      expect(frames.length - framesBefore).toBeLessThanOrEqual(3);
    });

    it("holds a line back until the flush, then shows it", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);
      await waitForStateUpdate();

      appEvents.emit("addLog", { message: "Deferred line", level: "info" });
      await nextTick();
      expect(lastFrame()).not.toContain("Deferred line");

      await new Promise((resolve) => setTimeout(resolve, LOG_FLUSH_INTERVAL_MS + 50));
      expect(lastFrame()).toContain("Deferred line");
    });

    it("keeps the buffer order and the redaction across batches", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);
      await waitForStateUpdate();

      appEvents.emit("addLog", { message: "first batch", level: "info" });
      await waitForStateUpdate();
      appEvents.emit("addLog", {
        message: "fetch https://user:hunter2@example.com/repo.git failed",
        level: "error",
      });
      appEvents.emit("addLog", { message: "second batch", level: "info" });
      await waitForStateUpdate();

      const frame = lastFrame()!;
      expect(frame.indexOf("first batch")).toBeLessThan(frame.indexOf("second batch"));
      expect(frame).not.toContain("hunter2");
      expect(frame).toContain("(3 entries)");
    });

    it("reads the repository list once per opened modal, not on every log line", async () => {
      const { stdin } = render(<App {...defaultProps} />);
      await waitForStateUpdate();

      stdin.write("o");
      await waitForStateUpdate();
      const callsWhileOpen = vi.mocked(defaultProps.getRepositoryList).mock.calls.length;
      expect(callsWhileOpen).toBeGreaterThan(0);

      for (let i = 0; i < 5; i++) {
        appEvents.emit("addLog", { message: `line ${i}`, level: "info" });
        appEvents.emit("setDiskSpace", `${i} MB`);
        await waitForStateUpdate();
      }

      expect(vi.mocked(defaultProps.getRepositoryList).mock.calls.length).toBe(callsWhileOpen);
    });
  });

  describe("repository dashboard", () => {
    const table = (count: number, overrides: Partial<RepositoryDashboardRow> = {}): RepositoryDashboardRow[] =>
      Array.from({ length: count }, (_, index) => ({
        name: `repo-${String(index).padStart(2, "0")}`,
        state: index === 1 ? "failed" : "idle",
        lastResult: index === 1 ? "fatal: remote hung up" : "up to date",
        lastSyncAt: Date.now() - 180_000,
        worktrees: 3,
        changes: { dirty: 1, unpushed: 0 },
        schedule: "0 * * * *",
        ...overrides,
      }));

    const fillLogs = (count: number): void => {
      for (let i = 0; i < count; i++) {
        appEvents.emit("addLog", { message: `Log line ${i}`, level: "info" });
      }
    };

    const logLinesShown = (frame: string): number =>
      frame.split("\n").filter((line) => /Log line \d+/.test(line)).length;

    it("leads the home screen with a row per repository, above the log", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);
      await waitForStateUpdate();

      appEvents.emit("setRepositoryDashboard", table(3));
      fillLogs(40);
      await waitForStateUpdate();

      const frame = lastFrame()!;
      expect(frame).toContain("REPOSITORY");
      expect(frame).toContain("✗ failed");
      expect(frame).toContain("fatal: remote hung up");
      expect(frame.indexOf("repo-02")).toBeLessThan(frame.indexOf("📋 Logs"));
      expect(frame.split("\n")).toHaveLength(24);
    });

    it("folds the log to one line with l, keeps its latest entry in view, and brings it back", async () => {
      const { stdin, lastFrame } = render(<App {...defaultProps} />);
      await waitForStateUpdate();
      appEvents.emit("setRepositoryDashboard", table(3));
      fillLogs(40);
      await waitForStateUpdate();

      stdin.write("l");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("(40 entries, l to expand)");
      expect(lastFrame()).toContain("Log line 39");
      expect(logLinesShown(lastFrame()!)).toBe(1);
      expect(lastFrame()!.split("\n")).toHaveLength(24);

      stdin.write("l");
      await waitForStateUpdate();
      expect(logLinesShown(lastFrame()!)).toBeGreaterThan(1);
      expect(lastFrame()!.split("\n")).toHaveLength(24);
    });

    it("grows the log with + at the table's expense and shrinks it with -, down to one line", async () => {
      const { stdin, lastFrame } = render(<App {...defaultProps} />);
      await waitForStateUpdate();
      appEvents.emit("setRepositoryDashboard", table(8));
      fillLogs(60);
      await waitForStateUpdate();
      const before = logLinesShown(lastFrame()!);

      stdin.write("+");
      await waitForStateUpdate();
      const grown = logLinesShown(lastFrame()!);
      expect(grown).toBeGreaterThan(before);
      expect(lastFrame()!.split("\n")).toHaveLength(24);

      for (let i = 0; i < 4; i++) {
        stdin.write("-");
        await waitForStateUpdate();
      }
      expect(lastFrame()).toContain("l to expand");
      expect(logLinesShown(lastFrame()!)).toBe(1);
      expect(lastFrame()).toContain("repo-07");
      expect(lastFrame()!.split("\n")).toHaveLength(24);
    });

    it("hands the whole screen to the log when + is held", async () => {
      const { stdin, lastFrame } = render(<App {...defaultProps} />);
      await waitForStateUpdate();
      appEvents.emit("setRepositoryDashboard", table(3));
      fillLogs(60);
      await waitForStateUpdate();

      for (let i = 0; i < 8; i++) {
        stdin.write("+");
        await waitForStateUpdate();
      }

      expect(lastFrame()).not.toContain("REPOSITORY");
      expect(lastFrame()!.split("\n")).toHaveLength(24);
    });

    it("gives the screen to a modal and comes back after it", async () => {
      const { stdin, lastFrame } = render(<App {...defaultProps} />);
      await waitForStateUpdate();
      appEvents.emit("setRepositoryDashboard", table(3));
      await waitForStateUpdate();

      stdin.write("?");
      await waitForStateUpdate();
      expect(lastFrame()).not.toContain("REPOSITORY");

      stdin.write("?");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("REPOSITORY");
    });

    describe("narrow and short terminals", () => {
      it.each([
        [80, 24],
        [60, 20],
        [40, 14],
        [30, 10],
      ])("fits a %ix%i terminal exactly while syncing", async (columns, rows) => {
        const { stdout, lastFrame } = render(<App {...defaultProps} maxProgressLines={1} />);
        resizeTerminal(stdout, columns, rows);
        await waitForStateUpdate();
        appEvents.emit("setRepositoryDashboard", table(5, { state: "syncing" }));
        appEvents.emit("setStatus", "syncing");
        appEvents.emit("setSyncProgress", { repo: "repo-00", phase: "fetch", message: "fetch receiving: 40%" });
        fillLogs(50);
        await waitForStateUpdate();

        const lines = lastFrame()!.split("\n");
        expect(lines).toHaveLength(rows);
        for (const line of lines) {
          expect([...line].length).toBeLessThanOrEqual(columns);
        }
        // The status bar is always the last thing on screen.
        expect(lines[lines.length - 1]).toMatch(/^└/);
      });

      it("keeps the status bar on screen under the force-clean modal with many repositories", async () => {
        const previews = Array.from({ length: 20 }, (_, index) => ({
          repoIndex: index,
          repoName: `repo-${index}`,
          preview: {
            trashEntries: 1,
            trashBytes: 10,
            unknownTrashSizes: 0,
            invalidTrashEntries: 0,
            keepRefs: 0,
            trashEntryIds: ["a"],
            keepRefNames: [],
          },
        }));
        const { stdout, stdin, lastFrame } = render(
          <App {...defaultProps} getForceCleanPreview={vi.fn().mockResolvedValue(previews)} />,
        );
        resizeTerminal(stdout, 80, 24);
        await waitForStateUpdate();

        stdin.write("x");
        await waitForStateUpdate();

        const lines = lastFrame()!.split("\n");
        expect(lastFrame()).toContain("Force Clean");
        expect(lastFrame()).toContain("to scroll");
        expect(lines.length).toBeLessThanOrEqual(24);
        expect(lastFrame()).toContain("Disk Space");
      });
    });
  });
});

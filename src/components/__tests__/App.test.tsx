import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect, vi, beforeEach } from "vitest";

import App, { AppProps } from "../App";

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
    };

    delete (globalThis as any).__inkAppMethods;
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

  describe("global methods", () => {
    it("should set up global methods on mount", () => {
      render(<App {...defaultProps} />);

      const methods = (globalThis as any).__inkAppMethods;
      expect(methods).toBeDefined();
      expect(methods.updateLastSyncTime).toBeInstanceOf(Function);
      expect(methods.setStatus).toBeInstanceOf(Function);
    });

    it("should clean up global methods on unmount", () => {
      const { unmount } = render(<App {...defaultProps} />);

      expect((globalThis as any).__inkAppMethods).toBeDefined();

      unmount();

      expect((globalThis as any).__inkAppMethods).toBeUndefined();
    });
  });


  describe("updateLastSyncTime functionality", () => {
    it("should update last sync time and set status to idle", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate(); // Wait for useEffect to set up global methods

      const { setStatus, updateLastSyncTime } = (globalThis as any).__inkAppMethods;

      setStatus("syncing");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Syncing...");

      updateLastSyncTime();
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Running");
      expect(lastFrame()).not.toContain("Syncing...");
    });

    it("should show last sync time after update", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate(); // Wait for useEffect to set up global methods

      const { updateLastSyncTime } = (globalThis as any).__inkAppMethods;

      expect(lastFrame()).toContain("Last Sync:");
      expect(lastFrame()).toContain("N/A");

      updateLastSyncTime();
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Last Sync:");
      expect(lastFrame()).not.toContain("N/A");
    });
  });

  describe("setStatus functionality", () => {
    it("should change status from idle to syncing", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate(); // Wait for useEffect to set up global methods

      const { setStatus } = (globalThis as any).__inkAppMethods;

      expect(lastFrame()).toContain("Running");

      setStatus("syncing");
      await waitForStateUpdate();

      expect(lastFrame()).toContain("Syncing...");
      expect(lastFrame()).not.toContain("Running");
    });

    it("should change status from syncing to idle", async () => {
      const { lastFrame } = render(<App {...defaultProps} />);

      await waitForStateUpdate(); // Wait for useEffect to set up global methods

      const { setStatus } = (globalThis as any).__inkAppMethods;

      setStatus("syncing");
      await waitForStateUpdate();
      expect(lastFrame()).toContain("Syncing...");

      setStatus("idle");
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

    it("should call onQuit when escape is pressed", () => {
      const onQuit = vi.fn();
      const { stdin } = render(<App {...defaultProps} onQuit={onQuit} />);

      stdin.write("\x1b");

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

      await waitForStateUpdate(); // Wait for useEffect to set up global methods

      const { setStatus } = (globalThis as any).__inkAppMethods;
      setStatus("syncing");
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

      await waitForStateUpdate(); // Wait for useEffect to set up global methods

      const { setStatus } = (globalThis as any).__inkAppMethods;
      setStatus("syncing");
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
});

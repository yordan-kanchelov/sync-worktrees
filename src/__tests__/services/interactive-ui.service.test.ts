import blessed from "blessed";

import { InteractiveUIService } from "../../services/interactive-ui.service";

import type { WorktreeSyncService } from "../../services/worktree-sync.service";

jest.mock("blessed");
jest.mock("../../services/worktree-sync.service");
jest.mock("../../services/config-loader.service");
jest.mock("cron-parser", () => ({
  parseExpression: jest.fn(() => ({
    next: () => ({
      toDate: () => new Date("2025-10-31T12:00:00Z"),
    }),
  })),
}));

describe("InteractiveUIService", () => {
  let mockScreen: any;
  let mockStatusBox: any;
  let mockLogBox: any;
  let mockHelpBox: any;
  let mockSyncService: jest.Mocked<WorktreeSyncService>;
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalConsoleWarn: typeof console.warn;

  beforeEach(() => {
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalConsoleWarn = console.warn;

    mockStatusBox = {
      setContent: jest.fn(),
    };

    mockLogBox = {
      log: jest.fn(),
    };

    mockHelpBox = {};

    mockScreen = {
      append: jest.fn(),
      key: jest.fn(),
      render: jest.fn(),
      remove: jest.fn(),
      destroy: jest.fn(),
      once: jest.fn(),
    };

    (blessed.screen as jest.Mock).mockReturnValue(mockScreen);
    (blessed.box as jest.Mock).mockImplementation((opts) => {
      if (opts.bottom === 0) return mockHelpBox;
      if (opts.top === "center") return { key: jest.fn(), focus: jest.fn() };
      return mockStatusBox;
    });
    (blessed.log as jest.Mock).mockReturnValue(mockLogBox);

    mockSyncService = {
      sync: jest.fn().mockResolvedValue(undefined),
      initialize: jest.fn().mockResolvedValue(undefined),
    } as any;
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    jest.clearAllMocks();
  });

  describe("constructor", () => {
    it("should initialize blessed UI components", () => {
      new InteractiveUIService([mockSyncService], undefined, "0 * * * *");

      expect(blessed.screen).toHaveBeenCalledWith({
        smartCSR: true,
        title: "sync-worktrees",
        fullUnicode: true,
      });
      expect(blessed.box).toHaveBeenCalled();
      expect(blessed.log).toHaveBeenCalled();
      expect(mockScreen.append).toHaveBeenCalledTimes(3);
      expect(mockScreen.render).toHaveBeenCalled();
    });

    it("should set up keyboard handlers", () => {
      new InteractiveUIService([mockSyncService], undefined, "0 * * * *");

      expect(mockScreen.key).toHaveBeenCalledWith(["?"], expect.any(Function));
      expect(mockScreen.key).toHaveBeenCalledWith(["s"], expect.any(Function));
      expect(mockScreen.key).toHaveBeenCalledWith(["r"], expect.any(Function));
      expect(mockScreen.key).toHaveBeenCalledWith(["q", "C-c"], expect.any(Function));
    });

    it("should redirect console methods", () => {
      new InteractiveUIService([mockSyncService], undefined, "0 * * * *");

      expect(console.log).not.toBe(originalConsoleLog);
      expect(console.error).not.toBe(originalConsoleError);
      expect(console.warn).not.toBe(originalConsoleWarn);
    });

    it("should calculate initial state", () => {
      new InteractiveUIService([mockSyncService], "/path/to/config.js", "0 * * * *");

      expect(mockStatusBox.setContent).toHaveBeenCalledWith(expect.stringContaining("Running"));
      expect(mockStatusBox.setContent).toHaveBeenCalledWith(expect.stringContaining("1 repo"));
    });

    it("should handle multiple repositories", () => {
      const mockSyncService2 = { ...mockSyncService };
      new InteractiveUIService([mockSyncService, mockSyncService2 as any], undefined, "0 * * * *");

      expect(mockStatusBox.setContent).toHaveBeenCalledWith(expect.stringContaining("2 repos"));
    });
  });

  describe("console redirection", () => {
    it("should redirect console.log to blessed log box", () => {
      new InteractiveUIService([mockSyncService], undefined, "0 * * * *");

      console.log("test message");
      expect(mockLogBox.log).toHaveBeenCalledWith("test message");
      expect(mockScreen.render).toHaveBeenCalled();
    });

    it("should redirect console.error with red color", () => {
      new InteractiveUIService([mockSyncService], undefined, "0 * * * *");

      console.error("error message");
      expect(mockLogBox.log).toHaveBeenCalledWith(expect.stringContaining("ERROR: error message"));
      expect(mockLogBox.log).toHaveBeenCalledWith(expect.stringContaining("{red-fg}"));
    });

    it("should redirect console.warn with yellow color", () => {
      new InteractiveUIService([mockSyncService], undefined, "0 * * * *");

      console.warn("warning message");
      expect(mockLogBox.log).toHaveBeenCalledWith(expect.stringContaining("WARN: warning message"));
      expect(mockLogBox.log).toHaveBeenCalledWith(expect.stringContaining("{yellow-fg}"));
    });

    it("should handle non-string console arguments", () => {
      new InteractiveUIService([mockSyncService], undefined, "0 * * * *");

      console.log({ key: "value" });
      expect(mockLogBox.log).toHaveBeenCalledWith(expect.stringContaining('"key"'));
    });
  });

  describe("log method", () => {
    it("should log messages to the log box", () => {
      const ui = new InteractiveUIService([mockSyncService], undefined, "0 * * * *");

      ui.log("custom message");
      expect(mockLogBox.log).toHaveBeenCalledWith("custom message");
      expect(mockScreen.render).toHaveBeenCalled();
    });
  });

  describe("updateLastSyncTime", () => {
    it("should update last sync time and recalculate next sync", () => {
      const ui = new InteractiveUIService([mockSyncService], undefined, "0 * * * *");
      mockStatusBox.setContent.mockClear();

      ui.updateLastSyncTime();

      expect(mockStatusBox.setContent).toHaveBeenCalledWith(expect.stringContaining("Last sync:"));
      expect(mockStatusBox.setContent).toHaveBeenCalledWith(expect.stringContaining("Next sync:"));
    });
  });

  describe("destroy", () => {
    it("should restore console methods and destroy screen", () => {
      const ui = new InteractiveUIService([mockSyncService], undefined, "0 * * * *");

      ui.destroy();

      expect(console.log).toBe(originalConsoleLog);
      expect(console.error).toBe(originalConsoleError);
      expect(console.warn).toBe(originalConsoleWarn);
      expect(mockScreen.destroy).toHaveBeenCalled();
    });
  });

  describe("keyboard command handlers", () => {
    it("should handle sync now command (s)", async () => {
      new InteractiveUIService([mockSyncService], undefined, "0 * * * *");

      const syncHandler = mockScreen.key.mock.calls.find((call: any) => call[0][0] === "s")[1];

      await syncHandler();

      expect(mockSyncService.sync).toHaveBeenCalled();
      expect(mockLogBox.log).toHaveBeenCalledWith(expect.stringContaining("Manual sync triggered"));
      expect(mockLogBox.log).toHaveBeenCalledWith(expect.stringContaining("Manual sync completed"));
    });

    it("should prevent concurrent syncs", async () => {
      new InteractiveUIService([mockSyncService], undefined, "0 * * * *");

      const syncHandler = mockScreen.key.mock.calls.find((call: any) => call[0][0] === "s")[1];

      mockSyncService.sync.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));

      const promise1 = syncHandler();
      const promise2 = syncHandler();

      await Promise.all([promise1, promise2]);

      expect(mockSyncService.sync).toHaveBeenCalledTimes(1);
      expect(mockLogBox.log).toHaveBeenCalledWith(expect.stringContaining("Sync already in progress"));
    });

    it("should handle sync errors gracefully", async () => {
      new InteractiveUIService([mockSyncService], undefined, "0 * * * *");

      const syncHandler = mockScreen.key.mock.calls.find((call: any) => call[0][0] === "s")[1];

      mockSyncService.sync.mockRejectedValue(new Error("Sync failed"));

      await syncHandler();

      expect(mockLogBox.log).toHaveBeenCalledWith(expect.stringContaining("Sync failed"));
    });

    it("should show help on ? key", async () => {
      new InteractiveUIService([mockSyncService], undefined, "0 * * * *");

      const helpHandler = mockScreen.key.mock.calls.find((call: any) => call[0][0] === "?")[1];

      await helpHandler();

      expect(blessed.box).toHaveBeenCalledWith(
        expect.objectContaining({
          top: "center",
          left: "center",
        }),
      );
      expect(mockScreen.append).toHaveBeenCalledWith(expect.any(Object));
    });

    it("should handle reload in single repo mode", async () => {
      new InteractiveUIService([mockSyncService], undefined, "0 * * * *");

      const reloadHandler = mockScreen.key.mock.calls.find((call: any) => call[0][0] === "r")[1];

      await reloadHandler();

      expect(mockLogBox.log).toHaveBeenCalledWith(expect.stringContaining("Cannot reload: no config file"));
    });
  });
});

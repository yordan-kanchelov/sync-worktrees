import blessed from "blessed";
import cronParser from "cron-parser";

import { ConfigLoaderService } from "./config-loader.service";
import { WorktreeSyncService } from "./worktree-sync.service";

import type { Widgets } from "blessed";

interface UIState {
  lastSyncTime: Date | null;
  nextSyncTime: Date | null;
  repoCount: number;
  isSyncing: boolean;
}

export class InteractiveUIService {
  private screen: Widgets.Screen;
  private statusBox: Widgets.BoxElement;
  private logBox: Widgets.Log;
  private helpBox: Widgets.BoxElement;
  private state: UIState;
  private syncServices: WorktreeSyncService[];
  private configPath?: string;
  private cronSchedule?: string;
  private originalConsoleLog: typeof console.log;
  private originalConsoleError: typeof console.error;
  private originalConsoleWarn: typeof console.warn;

  constructor(syncServices: WorktreeSyncService[], configPath?: string, cronSchedule?: string) {
    this.syncServices = syncServices;
    this.configPath = configPath;
    this.cronSchedule = cronSchedule;
    this.state = {
      lastSyncTime: null,
      nextSyncTime: this.calculateNextSyncTime(),
      repoCount: syncServices.length,
      isSyncing: false,
    };

    this.originalConsoleLog = console.log;
    this.originalConsoleError = console.error;
    this.originalConsoleWarn = console.warn;

    this.screen = blessed.screen({
      smartCSR: true,
      title: "sync-worktrees",
      fullUnicode: true,
    });

    this.statusBox = blessed.box({
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      content: "",
      tags: true,
      border: {
        type: "line",
      },
      style: {
        border: {
          fg: "cyan",
        },
      },
    });

    this.logBox = blessed.log({
      top: 3,
      left: 0,
      width: "100%",
      height: "100%-4",
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: " ",
        style: {
          bg: "blue",
        },
      },
      tags: true,
      border: {
        type: "line",
      },
      style: {
        border: {
          fg: "green",
        },
      },
    });

    this.helpBox = blessed.box({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      content:
        "{cyan-fg}? Help{/cyan-fg} | {green-fg}s Sync Now{/green-fg} | {yellow-fg}r Reload{/yellow-fg} | {red-fg}q Quit{/red-fg}",
      tags: true,
      style: {
        bg: "black",
        fg: "white",
      },
    });

    this.screen.append(this.statusBox);
    this.screen.append(this.logBox);
    this.screen.append(this.helpBox);

    this.setupKeyHandlers();
    this.redirectConsole();
    this.updateStatusBox();
    this.screen.render();
  }

  private setupKeyHandlers(): void {
    this.screen.key(["?"], async () => {
      await this.showHelp();
    });

    this.screen.key(["s"], async () => {
      await this.handleSyncNow();
    });

    this.screen.key(["r"], async () => {
      await this.handleReload();
    });

    this.screen.key(["q", "C-c"], () => {
      this.handleQuit();
    });
  }

  private redirectConsole(): void {
    console.log = (...args: unknown[]): void => {
      const message = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg, null, 2))).join(" ");
      this.logBox.log(message);
      this.screen.render();
    };

    console.error = (...args: unknown[]): void => {
      const message = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg, null, 2))).join(" ");
      this.logBox.log(`{red-fg}ERROR: ${message}{/red-fg}`);
      this.screen.render();
    };

    console.warn = (...args: unknown[]): void => {
      const message = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg, null, 2))).join(" ");
      this.logBox.log(`{yellow-fg}WARN: ${message}{/yellow-fg}`);
      this.screen.render();
    };
  }

  private restoreConsole(): void {
    console.log = this.originalConsoleLog;
    console.error = this.originalConsoleError;
    console.warn = this.originalConsoleWarn;
  }

  private updateStatusBox(): void {
    const status = this.state.isSyncing ? "{yellow-fg}Syncing...{/yellow-fg}" : "{green-fg}Running{/green-fg}";
    const lastSync = this.state.lastSyncTime ? this.state.lastSyncTime.toLocaleTimeString() : "Never";
    const nextSync = this.state.nextSyncTime ? this.state.nextSyncTime.toLocaleTimeString() : "N/A";
    const repos = this.state.repoCount === 1 ? "1 repo" : `${this.state.repoCount} repos`;

    this.statusBox.setContent(
      `{bold}Status:{/bold} ${status} | {bold}Repos:{/bold} ${repos} | {bold}Last sync:{/bold} ${lastSync}\n` +
        `{bold}Next sync:{/bold} ${nextSync} | Press {cyan-fg}?{/cyan-fg} for help`,
    );
    this.screen.render();
  }

  private calculateNextSyncTime(): Date | null {
    if (!this.cronSchedule) return null;

    try {
      const interval = cronParser.parse(this.cronSchedule);
      return interval.next().toDate();
    } catch {
      return null;
    }
  }

  private async showHelp(): Promise<void> {
    const helpContent = blessed.box({
      top: "center",
      left: "center",
      width: "60%",
      height: "50%",
      content:
        "{bold}{cyan-fg}sync-worktrees - Keyboard Commands{/cyan-fg}{/bold}\n\n" +
        "{bold}Available Commands:{/bold}\n" +
        "  {cyan-fg}?{/cyan-fg}  - Show this help screen\n" +
        "  {green-fg}s{/green-fg}  - Trigger immediate sync for all repositories\n" +
        "  {yellow-fg}r{/yellow-fg}  - Reload configuration and re-sync all repos\n" +
        "  {red-fg}q{/red-fg}  - Gracefully quit the application\n\n" +
        "{bold}Current Status:{/bold}\n" +
        `  Repositories: ${this.state.repoCount}\n` +
        `  Last sync: ${this.state.lastSyncTime ? this.state.lastSyncTime.toLocaleString() : "Never"}\n` +
        `  Next sync: ${this.state.nextSyncTime ? this.state.nextSyncTime.toLocaleString() : "N/A"}\n` +
        `  Cron schedule: ${this.cronSchedule || "N/A"}\n\n` +
        "{gray-fg}Press any key to close{/gray-fg}",
      tags: true,
      border: {
        type: "line",
      },
      style: {
        border: {
          fg: "cyan",
        },
        bg: "black",
      },
    });

    this.screen.append(helpContent);
    helpContent.focus();
    this.screen.render();

    helpContent.key(["escape", "enter", "q", "?"], () => {
      this.screen.remove(helpContent);
      this.screen.render();
    });
  }

  private async handleSyncNow(): Promise<void> {
    if (this.state.isSyncing) {
      this.logBox.log("{yellow-fg}⚠ Sync already in progress...{/yellow-fg}");
      this.screen.render();
      return;
    }

    this.state.isSyncing = true;
    this.updateStatusBox();

    try {
      this.logBox.log("\n{bold}{green-fg}🔄 Manual sync triggered{/green-fg}{/bold}\n");

      for (const service of this.syncServices) {
        await service.sync();
      }

      this.state.lastSyncTime = new Date();
      this.state.nextSyncTime = this.calculateNextSyncTime();
      this.logBox.log("\n{bold}{green-fg}✅ Manual sync completed{/green-fg}{/bold}\n");
    } catch (error) {
      this.logBox.log(
        `\n{bold}{red-fg}❌ Sync failed: ${error instanceof Error ? error.message : String(error)}{/red-fg}{/bold}\n`,
      );
    } finally {
      this.state.isSyncing = false;
      this.updateStatusBox();
    }
  }

  private async handleReload(): Promise<void> {
    if (this.state.isSyncing) {
      this.logBox.log("{yellow-fg}⚠ Cannot reload during sync...{/yellow-fg}");
      this.screen.render();
      return;
    }

    if (!this.configPath) {
      this.logBox.log("{red-fg}❌ Cannot reload: no config file (running in single repo mode){/red-fg}");
      this.screen.render();
      return;
    }

    this.state.isSyncing = true;
    this.updateStatusBox();

    try {
      this.logBox.log("\n{bold}{yellow-fg}🔄 Reloading configuration...{/yellow-fg}{/bold}\n");

      const configLoader = new ConfigLoaderService();
      const newConfigFile = await configLoader.loadConfigFile(this.configPath);

      this.logBox.log(`{green-fg}✅ Config reloaded: ${newConfigFile.repositories.length} repositories{/green-fg}`);

      const path = await import("path");
      const configDir = path.dirname(path.resolve(this.configPath));
      const repositories = newConfigFile.repositories.map((repo) =>
        configLoader.resolveRepositoryConfig(repo, newConfigFile.defaults, configDir, newConfigFile.retry),
      );

      this.syncServices = [];
      for (const repo of repositories) {
        const service = new WorktreeSyncService(repo);
        await service.initialize();
        this.syncServices.push(service);
      }

      this.state.repoCount = this.syncServices.length;
      this.updateStatusBox();

      this.logBox.log("{bold}{green-fg}🚀 Re-syncing all repositories...{/green-fg}{/bold}\n");

      for (const service of this.syncServices) {
        await service.sync();
      }

      this.state.lastSyncTime = new Date();
      this.state.nextSyncTime = this.calculateNextSyncTime();
      this.logBox.log("\n{bold}{green-fg}✅ Reload and sync completed{/green-fg}{/bold}\n");
    } catch (error) {
      this.logBox.log(
        `\n{bold}{red-fg}❌ Reload failed: ${error instanceof Error ? error.message : String(error)}{/red-fg}{/bold}\n`,
      );
    } finally {
      this.state.isSyncing = false;
      this.updateStatusBox();
    }
  }

  private handleQuit(): void {
    if (this.state.isSyncing) {
      this.logBox.log("{yellow-fg}⚠ Sync in progress... Press q again to force quit{/yellow-fg}");
      this.screen.render();

      this.screen.once("key q", () => {
        this.destroy();
        process.exit(0);
      });
      return;
    }

    this.destroy();
    process.exit(0);
  }

  public destroy(): void {
    this.restoreConsole();
    this.screen.destroy();
  }

  public updateLastSyncTime(): void {
    this.state.lastSyncTime = new Date();
    this.state.nextSyncTime = this.calculateNextSyncTime();
    this.updateStatusBox();
  }

  public log(message: string): void {
    this.logBox.log(message);
    this.screen.render();
  }
}

import React from "react";
import { render, Instance } from "ink";
import * as cron from "node-cron";
import App from "../components/App";
import { WorktreeSyncService } from "./worktree-sync.service";
import { ConfigLoaderService } from "./config-loader.service";
import { calculateSyncDiskSpace } from "../utils/disk-space";
import { getDefaultBareRepoDir } from "../utils/git-url";
import type { RepositoryConfig } from "../types";

export class InteractiveUIService {
  private app: Instance | null = null;
  private syncServices: WorktreeSyncService[];
  private configPath?: string;
  private cronSchedule?: string;
  private cronJobs: cron.ScheduledTask[] = [];
  private repositoryCount: number;
  private originalConsoleLog: typeof console.log;
  private originalConsoleWarn: typeof console.warn;
  private originalConsoleError: typeof console.error;

  constructor(syncServices: WorktreeSyncService[], configPath?: string, cronSchedule?: string) {
    if (syncServices.length === 0) {
      throw new Error("InteractiveUIService requires at least one WorktreeSyncService");
    }

    this.syncServices = syncServices;
    this.configPath = configPath;
    this.cronSchedule = cronSchedule;
    this.repositoryCount = syncServices.length;

    this.originalConsoleLog = console.log.bind(console);
    this.originalConsoleWarn = console.warn.bind(console);
    this.originalConsoleError = console.error.bind(console);

    this.redirectConsole();
    this.setupCronJobs();
    this.renderUI();
  }

  private redirectConsole(): void {
    console.log = (...args: unknown[]): void => {
      const message = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg, null, 2))).join(" ");
      this.originalConsoleLog(message);
    };

    console.warn = (...args: unknown[]): void => {
      const message = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg, null, 2))).join(" ");
      this.originalConsoleWarn(message);
    };

    console.error = (...args: unknown[]): void => {
      const message = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg, null, 2))).join(" ");
      this.originalConsoleError(message);
    };
  }

  private restoreConsole(): void {
    console.log = this.originalConsoleLog;
    console.warn = this.originalConsoleWarn;
    console.error = this.originalConsoleError;
  }

  private setupCronJobs(): void {
    if (!this.cronSchedule) {
      return;
    }

    for (const service of this.syncServices) {
      if (service.config.runOnce) {
        continue;
      }

      const schedule = service.config.cronSchedule || this.cronSchedule;
      const task = cron.schedule(schedule, async () => {
        this.setStatus("syncing");
        try {
          await service.sync();
        } catch (error) {
          console.error(`Error syncing: ${(error as Error).message}`);
        } finally {
          this.setStatus("idle");
        }
        this.updateLastSyncTime();
        await this.calculateAndUpdateDiskSpace();
      });

      this.cronJobs.push(task);
    }
  }

  private cancelCronJobs(): void {
    for (const job of this.cronJobs) {
      job.stop();
    }
    this.cronJobs = [];
  }

  private renderUI(): void {
    if (this.app) {
      this.app.unmount();
    }

    this.app = render(
      <App
        repositoryCount={this.repositoryCount}
        cronSchedule={this.cronSchedule}
        onManualSync={() => this.handleManualSync()}
        onReload={() => this.handleReload()}
        onQuit={() => this.handleQuit()}
      />
    );
  }

  private async handleManualSync(): Promise<void> {
    this.setStatus("syncing");

    try {
      for (const service of this.syncServices) {
        await service.sync();
      }

      this.updateLastSyncTime();
      await this.calculateAndUpdateDiskSpace();
    } catch (error) {
      console.error("Manual sync failed:", error);
    } finally {
      this.setStatus("idle");
    }
  }

  private async handleReload(): Promise<void> {
    try {
      if (!this.configPath) {
        this.setStatus("idle");
        return;
      }

      await this.waitForInProgressSyncs();

      this.cancelCronJobs();

      console.log("Reloading configuration...");
      this.setStatus("syncing");

      const configLoader = new ConfigLoaderService();
      const configFile = await configLoader.loadConfigFile(this.configPath);

      const newServices: WorktreeSyncService[] = [];
      for (const repoConfig of configFile.repositories) {
        try {
          const service = new WorktreeSyncService(repoConfig);
          await service.initialize();
          newServices.push(service);
        } catch (error) {
          console.error(`Failed to initialize repository ${repoConfig.name}: ${(error as Error).message}`);
        }
      }

      if (newServices.length === 0) {
        throw new Error("No repositories could be initialized from the configuration");
      }

      this.syncServices = newServices;
      this.repositoryCount = this.syncServices.length;

      this.setupCronJobs();

      const failures: Array<{ repo: string; error: string }> = [];

      for (const service of this.syncServices) {
        try {
          await service.sync();
        } catch (error) {
          const repoName = (service.config as RepositoryConfig).name || service.config.repoUrl;
          const errorMessage = (error as Error).message;
          console.error(`Failed to sync repository ${repoName}: ${errorMessage}`);
          failures.push({ repo: repoName, error: errorMessage });
        }
      }

      this.renderUI();
      this.updateLastSyncTime();
      await this.calculateAndUpdateDiskSpace();
      this.setStatus("idle");

      if (failures.length > 0) {
        console.warn(`Reload completed with ${failures.length} repository failure(s)`);
      }
    } catch (error) {
      console.error(`Reload failed: ${(error as Error).message}`);
      this.setupCronJobs();
      this.setStatus("idle");
    }
  }

  private async handleQuit(): Promise<void> {
    await this.waitForInProgressSyncs();

    this.destroy();
    process.exit(0);
  }

  private async waitForInProgressSyncs(): Promise<void> {
    const inProgressServices = this.syncServices.filter((s) => s.isSyncInProgress());

    if (inProgressServices.length === 0) {
      return;
    }

    const syncChecks = inProgressServices.map(async (service) => {
      const timeout = 30000;
      const checkInterval = 500;
      const startTime = Date.now();

      while (service.isSyncInProgress()) {
        if (Date.now() - startTime > timeout) {
          throw new Error("Timeout waiting for sync operations to complete");
        }
        await new Promise((resolve) => setTimeout(resolve, checkInterval));
      }
    });

    try {
      await Promise.all(syncChecks);
    } catch (error) {
      // Silently handle timeout
    }
  }

  public updateLastSyncTime(): void {
    const methods = (globalThis as any).__inkAppMethods;
    if (methods && methods.updateLastSyncTime) {
      methods.updateLastSyncTime();
    }
  }

  public setStatus(status: "idle" | "syncing"): void {
    const methods = (globalThis as any).__inkAppMethods;
    if (methods && methods.setStatus) {
      methods.setStatus(status);
    }
  }

  public setDiskSpace(diskSpace: string): void {
    const methods = (globalThis as any).__inkAppMethods;
    if (methods && methods.setDiskSpace) {
      methods.setDiskSpace(diskSpace);
    }
  }

  private async calculateAndUpdateDiskSpace(): Promise<void> {
    try {
      const bareRepoDirs = this.syncServices.map(
        (service) => service.config.bareRepoDir || getDefaultBareRepoDir(service.config.repoUrl),
      );
      const worktreeDirs = this.syncServices.map((service) => service.config.worktreeDir);

      const diskSpace = await calculateSyncDiskSpace(bareRepoDirs, worktreeDirs);
      this.setDiskSpace(diskSpace);
    } catch (error) {
      console.error("Failed to calculate disk space:", error);
      this.setDiskSpace("N/A");
    }
  }

  public destroy(): void {
    this.cancelCronJobs();
    this.restoreConsole();
    if (this.app) {
      this.app.unmount();
      this.app = null;
    }
    delete (globalThis as any).__inkAppMethods;
  }
}

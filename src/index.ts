#!/usr/bin/env node

import * as path from "path";

import { confirm } from "@inquirer/prompts";
import * as cron from "node-cron";
import pLimit from "p-limit";

import { DEFAULT_CONFIG } from "./constants";
import { ConfigLoaderService } from "./services/config-loader.service";
import { InteractiveUIService } from "./services/InteractiveUIService";
import { Logger } from "./services/logger.service";
import { WorktreeSyncService } from "./services/worktree-sync.service";
import { isInteractiveMode, parseArguments, reconstructCliCommand } from "./utils/cli";
import { findConfigInCwd } from "./utils/config-generator";
import { promptForConfig } from "./utils/interactive";

import type { ReloadOptions } from "./services/InteractiveUIService";
import type { Config, RepositoryConfig } from "./types";
import type { CliOptions } from "./utils/cli";

const cleanupFns: Array<() => void | Promise<void>> = [];

function setupSignalHandlers(): void {
  let shuttingDown = false;
  const handler = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
    for (const fn of cleanupFns) {
      try {
        await fn();
      } catch {
        // best effort
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void handler("SIGINT"));
  process.on("SIGTERM", () => void handler("SIGTERM"));
}

async function runSingleRepository(config: Config): Promise<void> {
  const logger = Logger.createDefault(undefined, config.debug);

  logger.info("\n📋 CLI Command (for future reference):");
  logger.info(`   ${reconstructCliCommand(config)}`);
  logger.info("");

  if (!config.logger) {
    config.logger = logger;
  }

  const syncService = new WorktreeSyncService(config);

  try {
    await syncService.initialize();

    if (config.runOnce) {
      logger.info("Running the sync process once as requested by --runOnce flag.");
      await syncService.sync();
    } else {
      const uiService = new InteractiveUIService([syncService], undefined, config.cronSchedule);
      cleanupFns.push(() => uiService.destroy());

      await syncService.sync();
      uiService.updateLastSyncTime();
      void uiService.calculateAndUpdateDiskSpace();

      cron.schedule(config.cronSchedule, async () => {
        try {
          uiService.setStatus("syncing");
          await syncService.sync();
          uiService.updateLastSyncTime();
          void uiService.calculateAndUpdateDiskSpace();
        } catch (error) {
          logger.error(`Error during scheduled sync: ${(error as Error).message}`, error);
          uiService.setStatus("idle");
        }
      });
    }
  } catch (error) {
    logger.error("❌ Fatal Error during initialization:", error as Error);
    process.exit(1);
  }
}

async function runMultipleRepositories(
  repositories: RepositoryConfig[],
  runOnce: boolean,
  configPath?: string,
  maxParallel?: number,
  syncOnStart?: boolean,
  reloadOptions?: ReloadOptions,
): Promise<void> {
  const services = new Map<string, WorktreeSyncService>();
  const globalLogger = Logger.createDefault();

  // Apply default limit to prevent resource exhaustion with many repositories
  // Each repository internally parallelizes worktree operations, so total concurrent
  // operations = maxRepositories × (maxWorktreeCreation + maxWorktreeUpdates + maxStatusChecks)
  const limit = pLimit(maxParallel ?? DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES);

  if (runOnce) {
    // For runOnce mode, initialize services immediately with console logging
    globalLogger.info(`\n🔄 Syncing ${repositories.length} repositories...`);

    const initResults = await Promise.allSettled(
      repositories.map((repoConfig) =>
        limit(async () => {
          const repoLogger = Logger.createDefault(repoConfig.name, repoConfig.debug);

          repoLogger.info(`\n📦 Repository: ${repoConfig.name}`);
          repoLogger.info(`   URL: ${repoConfig.repoUrl}`);
          repoLogger.info(`   Worktrees: ${repoConfig.worktreeDir}`);
          if (repoConfig.bareRepoDir) {
            repoLogger.info(`   Bare repo: ${repoConfig.bareRepoDir}`);
          }

          if (!repoConfig.logger) {
            repoConfig.logger = repoLogger;
          }

          const syncService = new WorktreeSyncService(repoConfig);
          await syncService.initialize();
          return { name: repoConfig.name, service: syncService };
        }),
      ),
    );

    const servicesToSync: Array<{ name: string; service: WorktreeSyncService }> = [];

    for (const result of initResults) {
      if (result.status === "fulfilled") {
        services.set(result.value.name, result.value.service);
        servicesToSync.push(result.value);
      } else {
        globalLogger.error(`❌ Failed to initialize repository:`, result.reason);
      }
    }

    const syncResults = await Promise.allSettled(
      servicesToSync.map(({ name, service }) =>
        limit(async () => {
          try {
            await service.sync();
          } catch (error) {
            globalLogger.error(`❌ Error syncing repository '${name}':`, error);
            throw error;
          }
        }),
      ),
    );

    const successCount = syncResults.filter((r) => r.status === "fulfilled").length;
    globalLogger.info(`\n✅ Successfully synced ${successCount}/${servicesToSync.length} repositories`);
  } else {
    // For interactive mode, create services without initialization
    // They will be initialized lazily when first sync is triggered
    for (const repoConfig of repositories) {
      const syncService = new WorktreeSyncService(repoConfig);
      services.set(repoConfig.name, syncService);
    }

    const uniqueSchedules = [...new Set(repositories.map((r) => r.cronSchedule))];
    const displaySchedule = uniqueSchedules.length === 1 ? uniqueSchedules[0] : undefined;
    const allServices = Array.from(services.values());
    const uiService = new InteractiveUIService(allServices, configPath, displaySchedule, maxParallel, reloadOptions);
    cleanupFns.push(() => uiService.destroy());

    void uiService.calculateAndUpdateDiskSpace();

    uiService.setupCronJobs();

    uiService.addLog(`📋 ${repositories.length} repositories configured`);

    const cronSchedules = new Map<string, number>();
    for (const repo of repositories) {
      cronSchedules.set(repo.cronSchedule, (cronSchedules.get(repo.cronSchedule) || 0) + 1);
    }
    for (const [schedule, count] of cronSchedules) {
      uiService.addLog(`⏰ ${schedule}: ${count} repository(ies)`);
    }

    if (syncOnStart) {
      await uiService.triggerInitialSync();
    }
  }
}

async function listRepositories(configPath: string, filter?: string): Promise<void> {
  const configLoader = new ConfigLoaderService();

  try {
    const { repositories } = await configLoader.buildRepositories(configPath, { filter });

    if (filter && repositories.length === 0) {
      console.error(`❌ No repositories match filter: ${filter}`);
      process.exit(1);
    }

    console.log("\n📋 Configured repositories:\n");

    repositories.forEach((repo, index) => {
      console.log(`${index + 1}. ${repo.name}`);
      console.log(`   URL: ${repo.repoUrl}`);
      console.log(`   Worktrees: ${repo.worktreeDir}`);
      console.log(`   Schedule: ${repo.cronSchedule}`);
      console.log(`   Run Once: ${repo.runOnce}`);
      if (repo.bareRepoDir) {
        console.log(`   Bare repo: ${repo.bareRepoDir}`);
      }
      if (repo.skipLfs) {
        console.log(`   Skip LFS: ${repo.skipLfs}`);
      }
      console.log("");
    });
  } catch (error) {
    console.error("❌ Error loading config file:", (error as Error).message);
    process.exit(1);
  }
}

async function runFromConfigFile(
  configPath: string,
  options: {
    filter?: string;
    noUpdateExisting?: boolean;
    debug?: boolean;
    runOnce?: boolean;
    syncOnStart?: boolean;
  },
): Promise<void> {
  const configLoader = new ConfigLoaderService();
  const { repositories, configFile } = await configLoader.buildRepositories(configPath, {
    filter: options.filter,
    noUpdateExisting: options.noUpdateExisting,
    debug: options.debug,
  });

  if (options.filter && repositories.length === 0) {
    console.error(`❌ No repositories match filter: ${options.filter}`);
    process.exit(1);
  }

  const globalRunOnce = options.runOnce ?? configFile.defaults?.runOnce ?? false;

  const maxParallel =
    configFile.parallelism?.maxRepositories ??
    configFile.defaults?.parallelism?.maxRepositories ??
    DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES;

  const reloadOptions: ReloadOptions = {
    filter: options.filter,
    noUpdateExisting: options.noUpdateExisting,
    debug: options.debug,
  };

  await runMultipleRepositories(
    repositories,
    globalRunOnce,
    configPath,
    maxParallel,
    options.syncOnStart,
    reloadOptions,
  );
}

async function runInteractive(partial: Partial<Config>, options: CliOptions): Promise<void> {
  const result = await promptForConfig(partial);

  if (result.savedConfigPath) {
    await runFromConfigFile(result.savedConfigPath, {
      filter: options.filter,
      noUpdateExisting: options.noUpdateExisting,
      debug: options.debug,
      runOnce: options.runOnce,
      syncOnStart: options.syncOnStart,
    });
    return;
  }

  const config = result.config;

  if (options.noUpdateExisting) {
    config.updateExistingWorktrees = false;
  } else if (config.updateExistingWorktrees === undefined) {
    config.updateExistingWorktrees = true;
  }

  if (options.debug !== undefined) {
    config.debug = options.debug;
  }

  await runSingleRepository(config);
}

async function main(): Promise<void> {
  setupSignalHandlers();
  const options = parseArguments();

  if (!options.config && !options.repoUrl && !options.worktreeDir) {
    const discovered = await findConfigInCwd();
    if (discovered) {
      options.config = discovered;
      console.log(`📄 Using config: ${path.relative(process.cwd(), discovered)}`);
    }
  }

  if (options.config) {
    if (options.list) {
      await listRepositories(options.config, options.filter);
      return;
    }

    try {
      await runFromConfigFile(options.config, {
        filter: options.filter,
        noUpdateExisting: options.noUpdateExisting,
        debug: options.debug,
        runOnce: options.runOnce,
        syncOnStart: options.syncOnStart,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("Config file not found")) {
        console.error(`\n❌ Config file not found: ${options.config}`);

        const createConfig = await confirm({
          message: "Would you like to run interactive setup to create a config file?",
          default: true,
        });

        if (createConfig) {
          await runInteractive({}, options);
        } else {
          console.log("\n💡 You can create a config file manually or run without --config for interactive setup.");
          process.exit(1);
        }
      } else {
        console.error("❌ Error loading config file:", (error as Error).message);
        process.exit(1);
      }
    }
  } else if (isInteractiveMode(options)) {
    await runInteractive(options, options);
  } else {
    const config = options as Config;

    if (options.noUpdateExisting) {
      config.updateExistingWorktrees = false;
    } else if (config.updateExistingWorktrees === undefined) {
      config.updateExistingWorktrees = true;
    }

    if (options.debug !== undefined) {
      config.debug = options.debug;
    }

    await runSingleRepository(config);
  }
}

main().catch((error) => {
  console.error("❌ Unhandled error:", error);
  process.exit(1);
});

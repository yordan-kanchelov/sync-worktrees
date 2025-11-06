#!/usr/bin/env node

import * as path from "path";

import { confirm } from "@inquirer/prompts";
import * as cron from "node-cron";
import pLimit from "p-limit";

import { DEFAULT_CONFIG } from "./constants";
import { ConfigLoaderService } from "./services/config-loader.service";
import { InteractiveUIService } from "./services/InteractiveUIService";
import { WorktreeSyncService } from "./services/worktree-sync.service";
import { isInteractiveMode, parseArguments, reconstructCliCommand } from "./utils/cli";
import { promptForConfig } from "./utils/interactive";

import type { Config, RepositoryConfig } from "./types";

async function runSingleRepository(config: Config): Promise<void> {
  console.log("\n📋 CLI Command (for future reference):");
  console.log(`   ${reconstructCliCommand(config)}`);
  console.log("");

  const syncService = new WorktreeSyncService(config);

  try {
    await syncService.initialize();

    if (config.runOnce) {
      console.log("Running the sync process once as requested by --runOnce flag.");
      await syncService.sync();
    } else {
      const uiService = new InteractiveUIService([syncService], undefined, config.cronSchedule);

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
          console.error(`Error during scheduled sync: ${(error as Error).message}`);
          uiService.setStatus("idle");
        }
      });
    }
  } catch (error) {
    console.error("❌ Fatal Error during initialization:", (error as Error).message);
    process.exit(1);
  }
}

async function runMultipleRepositories(
  repositories: RepositoryConfig[],
  runOnce: boolean,
  configPath?: string,
  maxParallel?: number,
): Promise<void> {
  const services = new Map<string, WorktreeSyncService>();

  console.log(`\n🔄 Syncing ${repositories.length} repositories...`);

  // Apply default limit to prevent resource exhaustion with many repositories
  // Each repository internally parallelizes worktree operations, so total concurrent
  // operations = maxRepositories × (maxWorktreeCreation + maxWorktreeUpdates + maxStatusChecks)
  const limit = pLimit(maxParallel ?? DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES);

  const initResults = await Promise.allSettled(
    repositories.map((repoConfig) =>
      limit(async () => {
        console.log(`\n📦 Repository: ${repoConfig.name}`);
        console.log(`   URL: ${repoConfig.repoUrl}`);
        console.log(`   Worktrees: ${repoConfig.worktreeDir}`);
        if (repoConfig.bareRepoDir) {
          console.log(`   Bare repo: ${repoConfig.bareRepoDir}`);
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
      console.error(`❌ Failed to initialize repository:`, result.reason);
    }
  }

  const syncResults = await Promise.allSettled(
    servicesToSync.map(({ name, service }) =>
      limit(async () => {
        try {
          await service.sync();
        } catch (error) {
          console.error(`❌ Error syncing repository '${name}':`, (error as Error).message);
          throw error;
        }
      }),
    ),
  );

  const successCount = syncResults.filter((r) => r.status === "fulfilled").length;
  console.log(`\n✅ Successfully synced ${successCount}/${servicesToSync.length} repositories`);

  if (!runOnce) {
    const uniqueSchedules = [...new Set(repositories.map((r) => r.cronSchedule))];
    const displaySchedule = uniqueSchedules.length === 1 ? uniqueSchedules[0] : undefined;
    const allServices = Array.from(services.values());
    const uiService = new InteractiveUIService(allServices, configPath, displaySchedule);

    uiService.updateLastSyncTime();
    void uiService.calculateAndUpdateDiskSpace();

    const cronJobs = new Map<string, string>();

    for (const repoConfig of repositories) {
      const syncService = services.get(repoConfig.name);
      if (!syncService) continue;

      if (!cronJobs.has(repoConfig.cronSchedule)) {
        cronJobs.set(repoConfig.cronSchedule, repoConfig.cronSchedule);

        cron.schedule(repoConfig.cronSchedule, async () => {
          const reposToSync = repositories.filter((r) => r.cronSchedule === repoConfig.cronSchedule);

          uiService.setStatus("syncing");

          await Promise.allSettled(
            reposToSync.map((repo) =>
              limit(async () => {
                const service = services.get(repo.name);
                if (!service) return;

                console.log(`Running scheduled sync for: ${repo.name}`);
                try {
                  await service.sync();
                } catch (error) {
                  console.error(`Error syncing '${repo.name}': ${(error as Error).message}`);
                }
              }),
            ),
          );

          uiService.updateLastSyncTime();
          void uiService.calculateAndUpdateDiskSpace();
        });
      }
    }

    console.log(`All ${repositories.length} repositories scheduled`);

    for (const [schedule] of cronJobs) {
      const repoCount = repositories.filter((r) => r.cronSchedule === schedule).length;
      console.log(`${schedule}: ${repoCount} repository(ies)`);
    }
  }
}

async function listRepositories(configPath: string, filter?: string): Promise<void> {
  const configLoader = new ConfigLoaderService();

  try {
    const configFile = await configLoader.loadConfigFile(configPath);
    const configDir = path.dirname(path.resolve(configPath));

    let repositories = configFile.repositories.map((repo) =>
      configLoader.resolveRepositoryConfig(repo, configFile.defaults, configDir, configFile.retry),
    );

    if (filter) {
      repositories = configLoader.filterRepositories(repositories, filter);
      if (repositories.length === 0) {
        console.error(`❌ No repositories match filter: ${filter}`);
        process.exit(1);
      }
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

async function main(): Promise<void> {
  const options = parseArguments();

  if (options.config) {
    const configLoader = new ConfigLoaderService();

    if (options.list) {
      await listRepositories(options.config, options.filter);
      return;
    }

    try {
      const configFile = await configLoader.loadConfigFile(options.config);
      const configDir = path.dirname(path.resolve(options.config));

      let repositories = configFile.repositories.map((repo) =>
        configLoader.resolveRepositoryConfig(repo, configFile.defaults, configDir, configFile.retry),
      );

      if (options.filter) {
        repositories = configLoader.filterRepositories(repositories, options.filter);
        if (repositories.length === 0) {
          console.error(`❌ No repositories match filter: ${options.filter}`);
          process.exit(1);
        }
      }

      const globalRunOnce = options.runOnce ?? configFile.defaults?.runOnce ?? false;

      // Apply CLI overrides
      if (options.noUpdateExisting) {
        repositories = repositories.map((repo) => ({
          ...repo,
          updateExistingWorktrees: false,
        }));
      }

      if (options.debug) {
        repositories = repositories.map((repo) => ({
          ...repo,
          debug: true,
        }));
      }

      const maxParallel =
        configFile.parallelism?.maxRepositories ??
        configFile.defaults?.parallelism?.maxRepositories ??
        DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES;

      await runMultipleRepositories(repositories, globalRunOnce, options.config, maxParallel);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Config file not found")) {
        console.error(`\n❌ Config file not found: ${options.config}`);

        const createConfig = await confirm({
          message: "Would you like to run interactive setup to create a config file?",
          default: true,
        });

        if (createConfig) {
          // Run interactive mode which will offer to save config
          const config = await promptForConfig({});
          await runSingleRepository(config);
        } else {
          console.log("\n💡 You can create a config file manually or run without --config for interactive setup.");
          process.exit(1);
        }
      } else {
        console.error("❌ Error loading config file:", (error as Error).message);
        process.exit(1);
      }
    }
  } else {
    let config: Config;
    if (isInteractiveMode(options)) {
      config = await promptForConfig(options);
    } else {
      config = options as Config;
    }

    // Apply CLI overrides
    if (options.noUpdateExisting) {
      config.updateExistingWorktrees = false;
    } else if (config.updateExistingWorktrees === undefined) {
      config.updateExistingWorktrees = true; // Default to true
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

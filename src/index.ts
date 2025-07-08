#!/usr/bin/env node

import * as path from "path";

import { confirm } from "@inquirer/prompts";
import * as cron from "node-cron";

import { ConfigLoaderService } from "./services/config-loader.service";
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
      console.log("Git Worktree Sync script started as a scheduled job.");
      console.log(`Job is scheduled with cron pattern: "${config.cronSchedule}"`);
      console.log(`To see options, run: node ${path.basename(process.argv[1])} --help`);

      console.log("Running initial sync...");
      await syncService.sync();

      console.log("Waiting for the next scheduled run...");

      cron.schedule(config.cronSchedule, async () => {
        try {
          await syncService.sync();
        } catch (error) {
          console.error("Error during scheduled sync:", error);
        }
      });
    }
  } catch (error) {
    console.error("❌ Fatal Error during initialization:", (error as Error).message);
    process.exit(1);
  }
}

async function runMultipleRepositories(repositories: RepositoryConfig[], runOnce: boolean): Promise<void> {
  const services = new Map<string, WorktreeSyncService>();

  console.log(`\n🔄 Syncing ${repositories.length} repositories...`);

  for (const repoConfig of repositories) {
    console.log(`\n📦 Repository: ${repoConfig.name}`);
    console.log(`   Path: ${repoConfig.repoPath}`);
    console.log(`   Worktrees: ${repoConfig.worktreeDir}`);

    const syncService = new WorktreeSyncService(repoConfig);
    services.set(repoConfig.name, syncService);

    try {
      await syncService.initialize();
      await syncService.sync();
    } catch (error) {
      console.error(`❌ Error syncing repository '${repoConfig.name}':`, (error as Error).message);
    }
  }

  if (!runOnce) {
    console.log("\n⏰ Scheduling cron jobs for all repositories...");

    const cronJobs = new Map<string, string>();

    for (const repoConfig of repositories) {
      const syncService = services.get(repoConfig.name);
      if (!syncService) continue;

      if (!cronJobs.has(repoConfig.cronSchedule)) {
        cronJobs.set(repoConfig.cronSchedule, repoConfig.cronSchedule);

        cron.schedule(repoConfig.cronSchedule, async () => {
          const reposToSync = repositories.filter((r) => r.cronSchedule === repoConfig.cronSchedule);

          for (const repo of reposToSync) {
            const service = services.get(repo.name);
            if (!service) continue;

            console.log(`\n🔄 Running scheduled sync for: ${repo.name}`);
            try {
              await service.sync();
            } catch (error) {
              console.error(`Error during scheduled sync for '${repo.name}':`, error);
            }
          }
        });
      }
    }

    console.log("\n✅ All repositories scheduled. Waiting for next runs...");
    for (const [schedule] of cronJobs) {
      const repoCount = repositories.filter((r) => r.cronSchedule === schedule).length;
      console.log(`   ${schedule}: ${repoCount} repository(ies)`);
    }
  }
}

async function listRepositories(configPath: string): Promise<void> {
  const configLoader = new ConfigLoaderService();

  try {
    const configFile = await configLoader.loadConfigFile(configPath);
    const configDir = path.dirname(path.resolve(configPath));

    console.log("\n📋 Configured repositories:\n");

    configFile.repositories.forEach((repo, index) => {
      const resolved = configLoader.resolveRepositoryConfig(repo, configFile.defaults, configDir);
      console.log(`${index + 1}. ${resolved.name}`);
      console.log(`   Repository: ${resolved.repoPath}`);
      console.log(`   Worktrees: ${resolved.worktreeDir}`);
      console.log(`   Schedule: ${resolved.cronSchedule}`);
      console.log(`   Run Once: ${resolved.runOnce}`);
      if (resolved.repoUrl) {
        console.log(`   URL: ${resolved.repoUrl}`);
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
      await listRepositories(options.config);
      return;
    }

    try {
      const configFile = await configLoader.loadConfigFile(options.config);
      const configDir = path.dirname(path.resolve(options.config));

      let repositories = configFile.repositories.map((repo) =>
        configLoader.resolveRepositoryConfig(repo, configFile.defaults, configDir),
      );

      if (options.filter) {
        repositories = configLoader.filterRepositories(repositories, options.filter);
        if (repositories.length === 0) {
          console.error(`❌ No repositories match filter: ${options.filter}`);
          process.exit(1);
        }
      }

      const globalRunOnce = options.runOnce ?? configFile.defaults?.runOnce ?? false;

      await runMultipleRepositories(repositories, globalRunOnce);
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

    await runSingleRepository(config);
  }
}

main().catch((error) => {
  console.error("❌ Unhandled error:", error);
  process.exit(1);
});

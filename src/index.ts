#!/usr/bin/env node

import * as path from "path";

import pLimit from "p-limit";

import { DEFAULT_CONFIG } from "./constants";
import { ConfigFileExistsError, ConfigFileNotFoundError } from "./errors";
import { ConfigLoaderService } from "./services/config-loader.service";
import { InteractiveUIService } from "./services/InteractiveUIService";
import { Logger } from "./services/logger.service";
import { WorktreeSyncService } from "./services/worktree-sync.service";
import { CLI_COMMANDS, parseArguments } from "./utils/cli";
import { formatCloneSkipReason } from "./utils/clone-skip-format";
import { findConfigInCwd, generateConfigFile, getDefaultConfigPath } from "./utils/config-generator";
import { fileExists } from "./utils/file-exists";
import { promptForInitConfig } from "./utils/interactive";
import { setupSignalHandlers } from "./utils/signal-handlers";

import type { CloneSkipReason } from "./services/clone-sync.service";
import type { ConfigFile, RepositoryConfig } from "./types";
import type { CliOptions } from "./utils/cli";

const signalHandle = setupSignalHandlers();

async function runMultipleRepositories(
  configFile: ConfigFile,
  repositories: RepositoryConfig[],
  configPath?: string,
): Promise<void> {
  const services = new Map<string, WorktreeSyncService>();
  const globalLogger = Logger.createDefault();

  const runOnce = configFile.defaults?.runOnce ?? false;
  const maxParallel =
    configFile.parallelism?.maxRepositories ??
    configFile.defaults?.parallelism?.maxRepositories ??
    DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES;

  const limit = pLimit(maxParallel);

  if (runOnce) {
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

    const skipsByRepo: Array<{ repo: string; reasons: readonly CloneSkipReason[] }> = [];
    let successCount = 0;
    for (let i = 0; i < servicesToSync.length; i++) {
      const { name, service } = servicesToSync[i];
      const reasons = service.getRecordedSkips();
      if (reasons.length > 0) {
        skipsByRepo.push({ repo: name, reasons });
      } else if (syncResults[i].status === "fulfilled") {
        successCount++;
      }
    }

    if (skipsByRepo.length > 0) {
      const skipsRepoWord = skipsByRepo.length === 1 ? "repo" : "repos";
      globalLogger.warn(`\n⚠️  Clone-mode skips (${skipsByRepo.length} ${skipsRepoWord}):`);
      for (const { repo, reasons } of skipsByRepo) {
        for (const reason of reasons) {
          globalLogger.warn(`  • ${repo} — ${formatCloneSkipReason(reason)}`);
        }
      }
    }

    const initFailures = initResults.filter((r) => r.status === "rejected").length;
    const syncFailures = syncResults.filter((r) => r.status === "rejected").length;
    const failedCount = initFailures + syncFailures;
    const skippedCount = skipsByRepo.length;
    const processedRepoWord = repositories.length === 1 ? "repo" : "repos";
    globalLogger.info(
      `\n📊 Processed ${repositories.length} ${processedRepoWord}: ${successCount} synced, ${skippedCount} with clone-mode skips, ${failedCount} failed`,
    );

    if (initFailures > 0 || syncFailures > 0) {
      process.exitCode = 1;
    }
  } else {
    for (const repoConfig of repositories) {
      const syncService = new WorktreeSyncService(repoConfig);
      services.set(repoConfig.name, syncService);
    }

    const uniqueSchedules = [...new Set(repositories.map((r) => r.cronSchedule))];
    const displaySchedule = uniqueSchedules.length === 1 ? uniqueSchedules[0] : undefined;
    const allServices = Array.from(services.values());
    const uiService = new InteractiveUIService(allServices, configPath, displaySchedule, maxParallel);
    signalHandle.register((fast) => uiService.destroy(fast));

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
  }
}

async function runList(configPath: string, filter?: string): Promise<void> {
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

async function runFromConfigFile(configPath: string): Promise<void> {
  const configLoader = new ConfigLoaderService();
  const { repositories, configFile } = await configLoader.buildRepositories(configPath);
  await runMultipleRepositories(configFile, repositories, configPath);
}

async function resolveConfigOrExit(cliPath: string | undefined): Promise<string> {
  const resolved = cliPath ? path.resolve(cliPath) : await findConfigInCwd();
  if (!resolved) {
    console.error(
      "❌ No config file found. Pass --config <path>, run `sync-worktrees init` to create one, or place a sync-worktrees.config.{js,mjs,cjs} in this directory.",
    );
    process.exit(1);
  }
  return resolved;
}

function exitConfigExists(targetPath: string): never {
  console.error(`\n❌ Config file already exists: ${targetPath}`);
  console.error(`💡 Re-run with --force to overwrite.`);
  process.exit(1);
}

async function runInit(configPath: string | undefined, force: boolean): Promise<void> {
  const targetPath = configPath ? path.resolve(configPath) : getDefaultConfigPath();

  // Preflight before prompts so user isn't asked 5 questions just to fail at write.
  // The atomic `wx` write below is still the source of truth — it closes the TOCTOU
  // window between this check and the write.
  if (!force && (await fileExists(targetPath))) {
    exitConfigExists(targetPath);
  }

  const input = await promptForInitConfig();

  try {
    await generateConfigFile(input, targetPath, { overwrite: force });
  } catch (error) {
    if (error instanceof ConfigFileExistsError) {
      exitConfigExists(error.configPath);
    }
    throw error;
  }

  const displayPath = path.relative(process.cwd(), targetPath) || targetPath;
  console.log(`\n✅ Configuration saved to: ${targetPath}`);
  console.log(`\n💡 Next: sync-worktrees --config ${displayPath}`);
}

async function runSync(options: CliOptions): Promise<void> {
  const configPath = await resolveConfigOrExit(options.config);
  const displayPath = path.relative(process.cwd(), configPath) || configPath;
  console.log(`📄 Using config: ${displayPath}`);

  try {
    await runFromConfigFile(configPath);
  } catch (error) {
    if (error instanceof ConfigFileNotFoundError) {
      console.error(`\n❌ Config file not found: ${error.configPath}`);
      console.error(`💡 Run 'sync-worktrees init --config ${displayPath}' to create one.`);
      process.exit(1);
    }
    console.error("❌ Error loading config file:", (error as Error).message);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const options = parseArguments();

  switch (options.command) {
    case CLI_COMMANDS.INIT:
      return runInit(options.config, options.force);
    case CLI_COMMANDS.LIST: {
      const configPath = await resolveConfigOrExit(options.config);
      return runList(configPath, options.filter);
    }
    case CLI_COMMANDS.RUN:
      return runSync(options);
    default: {
      const _exhaustive: never = options;
      throw new Error(`Unhandled command: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

main().catch((error) => {
  console.error("❌ Unhandled error:", error);
  process.exit(1);
});

#!/usr/bin/env node

import { realpathSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { input } from "@inquirer/prompts";
import pLimit from "p-limit";

import { DEFAULT_CONFIG, GIT_CONSTANTS } from "./constants";
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
import { maybeRegisterMcpClients } from "./utils/mcp-registration";
import { setupSignalHandlers } from "./utils/signal-handlers";
import { warnIfUnitTestShortcutEnabled } from "./utils/unit-test-shortcut";

import type { CloneSkipReason } from "./services/clone-sync.service";
import type { ConfigFile, RepositoryConfig } from "./types";
import type { CliOptions } from "./utils/cli";

export type {
  SyncWorktreesConfig,
  SyncWorktreesDefaults,
  SyncWorktreesHooksConfig,
  SyncWorktreesParallelismConfig,
  SyncWorktreesRepository,
  SyncWorktreesRepositoryMode,
  SyncWorktreesRetryConfig,
  SyncWorktreesSparseCheckoutConfig,
  SyncWorktreesSparseCheckoutMode,
  SyncWorktreesTrashConfig,
} from "./types";

export async function runMultipleRepositories(
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
    const runOnceSignalHandle = setupSignalHandlers({ exitAfterCleanupCode: 130 });
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
            return await service.sync();
          } catch (error) {
            globalLogger.error(`❌ Error syncing repository '${name}':`, error);
            throw error;
          }
        }),
      ),
    );

    const skipsByRepo: Array<{ repo: string; reasons: readonly CloneSkipReason[] }> = [];
    const skippedNames = new Set<string>();
    const lockUnavailableNames = new Set<string>();
    const outcomeFailedNames = new Set<string>();
    const partialSkipNames = new Set<string>();
    for (let i = 0; i < servicesToSync.length; i++) {
      const { name, service } = servicesToSync[i];
      const result = syncResults[i];
      const reasons = service.getRecordedSkips();
      if (reasons.length > 0) {
        skipsByRepo.push({ repo: name, reasons });
      }

      if (result.status === "fulfilled") {
        if (!result.value.started) {
          // Contention (another process or operation) is a skip: the repo will
          // be synced by whoever holds the lock. An unavailable lock is not —
          // nothing synced it and nothing will — so it fails the run.
          if (result.value.reason === "lock_unavailable") {
            lockUnavailableNames.add(name);
          } else {
            skippedNames.add(name);
          }
          continue;
        }

        const counts = result.value.outcome?.counts;
        const hasFailedOutcome = Boolean(counts && counts.failed > 0);
        if (reasons.length > 0 && !hasFailedOutcome) {
          skippedNames.add(name);
        }
        if (counts) {
          if (counts.failed > 0) {
            outcomeFailedNames.add(name);
          }
          // Per-action skips are informational — they don't demote a repo that
          // otherwise completed its sync attempt out of `successCount`. A
          // failed repo's headline is its failure, so don't double-label it.
          if (counts.skipped > 0 && !skippedNames.has(name) && !outcomeFailedNames.has(name)) {
            partialSkipNames.add(name);
          }
        }
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

    const initFailures = initResults.filter((result) => result.status === "rejected").length;
    const syncFailures = syncResults.filter((result) => result.status === "rejected").length;
    const failedCount = initFailures + syncFailures + outcomeFailedNames.size + lockUnavailableNames.size;
    const skippedCount = skippedNames.size;
    const successCount = syncResults.filter((result, index) => {
      const repoName = servicesToSync[index].name;
      return (
        result.status === "fulfilled" &&
        result.value.started &&
        !skippedNames.has(repoName) &&
        !outcomeFailedNames.has(repoName)
      );
    }).length;
    const processedRepoWord = repositories.length === 1 ? "repo" : "repos";
    const skipSummaryLabel = skippedNames.size === skipsByRepo.length ? "with clone-mode skips" : "skipped";
    const partialSuffix = partialSkipNames.size > 0 ? ` (${partialSkipNames.size} with partial skips)` : "";
    const failedSuffix = lockUnavailableNames.size > 0 ? ` (${lockUnavailableNames.size} lock unavailable)` : "";
    globalLogger.info(
      `\n📊 Processed ${repositories.length} ${processedRepoWord}: ${successCount} synced${partialSuffix}, ${skippedCount} ${skipSummaryLabel}, ${failedCount} failed${failedSuffix}`,
    );

    if (failedCount > 0) {
      process.exitCode = 1;
    }
    runOnceSignalHandle.dispose();
  } else {
    const signalHandle = setupSignalHandlers();
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

async function runTrash(configPath: string, filter?: string, restoreId?: string, dropKeepRef?: string): Promise<void> {
  const configLoader = new ConfigLoaderService();
  const { repositories } = await configLoader.buildRepositories(configPath, { filter });
  if (repositories.length !== 1) {
    throw new Error(`Trash operations require exactly one repository; matched ${repositories.length}. Use --filter.`);
  }

  const service = new WorktreeSyncService(repositories[0]);
  if (service.isCloneMode()) throw new Error("Trash operations are only available for worktree-mode repositories");
  if (restoreId) {
    const manifest = await service.restoreFromTrash(restoreId);
    console.log(`✅ Restored ${manifest.id} to ${manifest.originalPath}`);
    return;
  }
  if (dropKeepRef) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("--dropKeepRef requires an interactive TTY");
    }
    const confirmation = await input({ message: `Type '${dropKeepRef}' to confirm deleting this keep ref:` });
    if (confirmation !== dropKeepRef) {
      throw new Error("Keep ref deletion was not confirmed");
    }
    await service.deleteKeepRef(dropKeepRef);
    console.log(`✅ Deleted ${dropKeepRef}`);
    return;
  }

  const { entries, invalid } = await service.listTrashEntries();
  for (const { manifest } of entries) {
    console.log(`${manifest.id}\t${manifest.reason}\t${manifest.expiresAt}\t${manifest.originalPath}`);
  }
  for (const invalidPath of invalid) console.warn(`⚠️ Invalid trash entry left untouched: ${invalidPath}`);
  const keepRefs = await service.listKeepRefs();
  for (const ref of keepRefs) console.log(`KEEP\t${ref.slice(GIT_CONSTANTS.KEEP_REF_PREFIX.length)}`);
}

async function runFromConfigFile(configPath: string, runOnceOverride = false): Promise<void> {
  const configLoader = new ConfigLoaderService();
  const { repositories, configFile } = await configLoader.buildRepositories(configPath);
  const effectiveConfigFile = runOnceOverride
    ? { ...configFile, defaults: { ...(configFile.defaults ?? {}), runOnce: true } }
    : configFile;
  await runMultipleRepositories(effectiveConfigFile, repositories, configPath);
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

  await maybeRegisterMcpClients();

  console.log(`\n💡 Next: sync-worktrees --config ${displayPath}`);
}

async function runSync(options: Extract<CliOptions, { command: typeof CLI_COMMANDS.RUN }>): Promise<void> {
  const configPath = await resolveConfigOrExit(options.config);
  const displayPath = path.relative(process.cwd(), configPath) || configPath;
  console.log(`📄 Using config: ${displayPath}`);

  try {
    await runFromConfigFile(configPath, options.runOnce);
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

export async function main(): Promise<void> {
  const options = parseArguments();
  warnIfUnitTestShortcutEnabled((message) => console.warn(message));

  switch (options.command) {
    case CLI_COMMANDS.INIT:
      return runInit(options.config, options.force);
    case CLI_COMMANDS.LIST: {
      const configPath = await resolveConfigOrExit(options.config);
      return runList(configPath, options.filter);
    }
    case CLI_COMMANDS.TRASH: {
      const configPath = await resolveConfigOrExit(options.config);
      return runTrash(configPath, options.filter, options.restore, options.dropKeepRef);
    }
    case CLI_COMMANDS.RUN:
      return runSync(options);
    default: {
      const _exhaustive: never = options;
      throw new Error(`Unhandled command: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function isMainEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  // realpathSync resolves symlinks on the argv side so the guard works for
  // npm/pnpm global-bin shims and macOS /tmp -> /private/tmp; import.meta.url
  // is already the resolved path by default.
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainEntrypoint()) {
  main().catch((error) => {
    console.error("❌ Unhandled error:", error);
    process.exit(1);
  });
}

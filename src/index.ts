#!/usr/bin/env node

import { realpathSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { inspect } from "util";

import pLimit from "p-limit";

import { runDoctor } from "./cli/doctor";
import { runDryRun } from "./cli/dry-run";
import { runTrash } from "./cli/trash-command";
import { CONFIG_FILE_NAMES } from "./constants";
import { ConfigFileExistsError, ConfigFileNotFoundError, SyncWorktreesError } from "./errors";
import { runList } from "./cli/list";
import { ConfigLoaderService } from "./services/config-loader.service";
import { resolveMaxRepositories } from "./services/config-schema";
import { InteractiveUIService } from "./services/InteractiveUIService";
import { Logger } from "./services/logger.service";
import { WorktreeSyncService } from "./services/worktree-sync.service";
import { CLI_COMMANDS, parseArguments } from "./utils/cli";
import { formatCloneSkipReason } from "./utils/clone-skip-format";
import { CONFIG_PATH_ENV_VAR, describeConfigPath, resolveConfigPath } from "./utils/config-discovery";
import { generateConfigFile, getDefaultConfigPath } from "./utils/config-generator";
import { fileExists } from "./utils/file-exists";
import { redactRepoUrl, redactSecretsInText } from "./utils/git-url";
import { configLoadErrorMessage, getErrorMessage } from "./utils/errors";
import { promptForInitConfig } from "./utils/interactive";
import { maybeRegisterMcpClients } from "./utils/mcp-registration";
import { setupSignalHandlers } from "./utils/signal-handlers";
import { hasInteractiveTerminal } from "./utils/terminal";
import { formatDuration } from "./utils/timing";
import { warnIfUnitTestShortcutEnabled } from "./utils/unit-test-shortcut";

import type { CloneSkipReason } from "./services/clone-sync.service";
import type { ConfigFile, RepositoryConfig } from "./types";
import type { CliOptions } from "./utils/cli";
import type { ResolvedConfigPath } from "./utils/config-discovery";

export interface RunOptions {
  quiet?: boolean;
  filter?: string;
  debug?: boolean;
}

export async function runMultipleRepositories(
  configFile: ConfigFile,
  repositories: RepositoryConfig[],
  configPath?: string,
  options: RunOptions = {},
): Promise<void> {
  const services = new Map<string, WorktreeSyncService>();
  const startedAt = Date.now();
  const anyDebug = repositories.some((repo) => repo.debug === true);
  const globalLogger = Logger.createDefault(undefined, anyDebug);

  const runOnce = configFile.defaults?.runOnce ?? false;
  const syncOnStart = configFile.defaults?.syncOnStart ?? true;
  const maxParallel = resolveMaxRepositories(configFile);

  const limit = pLimit(maxParallel);

  if (runOnce) {
    const runOnceSignalHandle = setupSignalHandlers({ exitAfterCleanupCode: 130 });
    if (!options.quiet) {
      globalLogger.info(`\n🔄 Syncing ${countOf(repositories.length, "repository", "repositories")}...`);
    }

    const initResults = await Promise.allSettled(
      repositories.map((repoConfig) =>
        limit(async () => {
          const repoLogger = Logger.createDefault(repoConfig.name, repoConfig.debug, { quiet: options.quiet });

          if (!options.quiet) {
            globalLogger.info("");
          }
          repoLogger.info(`📦 Repository: ${repoConfig.name}`);
          repoLogger.info(`   URL: ${redactRepoUrl(repoConfig.repoUrl)}`);
          repoLogger.info(`   Worktrees: ${repoConfig.worktreeDir}`);
          if (repoConfig.bareRepoDir) {
            repoLogger.info(`   Bare repo: ${repoConfig.bareRepoDir}`);
          }

          const syncService = new WorktreeSyncService({ ...repoConfig, logger: repoConfig.logger ?? repoLogger });
          return { name: repoConfig.name, service: syncService };
        }),
      ),
    );

    const servicesToSync: Array<{ name: string; service: WorktreeSyncService }> = [];

    for (const [index, result] of initResults.entries()) {
      if (result.status === "fulfilled") {
        services.set(result.value.name, result.value.service);
        servicesToSync.push(result.value);
      } else {
        globalLogger.error(`❌ Failed to initialize repository '${repositories[index].name}':`, result.reason);
      }
    }

    const syncResults = await Promise.allSettled(
      servicesToSync.map(({ name, service }) =>
        limit(async () => {
          try {
            return await service.sync();
          } catch (error) {
            const failed = service.isInitialized() ? "Error syncing" : "Failed to initialize";
            globalLogger.error(`❌ ${failed} repository '${name}':`, error);
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
    const skipSummaryLabel =
      skipsByRepo.length > 0 && skippedNames.size === skipsByRepo.length ? "with clone-mode skips" : "skipped";
    const partialSuffix = partialSkipNames.size > 0 ? ` (${partialSkipNames.size} with partial skips)` : "";
    const skippedPart = skippedCount > 0 ? `, ${skippedCount} ${skipSummaryLabel}` : "";
    const failedSuffix = lockUnavailableNames.size > 0 ? ` (${lockUnavailableNames.size} lock unavailable)` : "";
    const elapsed = formatDuration(Date.now() - startedAt);
    const summarySpacer = options.quiet ? "" : "\n";
    globalLogger.info(
      `${summarySpacer}📊 Processed ${countOf(repositories.length, "repo", "repos")} in ${elapsed}: ${successCount} synced${partialSuffix}${skippedPart}, ${failedCount} failed${failedSuffix}`,
    );

    if (failedCount > 0) {
      process.exitCode = 1;
      if (!anyDebug) {
        const neverInitialized = syncResults.some(
          (result, index) => result.status === "rejected" && !servicesToSync[index].service.isInitialized(),
        );
        const cloneHint =
          initFailures > 0 || neverInitialized
            ? " A repository that fails to initialize usually has a wrong repoUrl or missing credentials."
            : "";
        globalLogger.info(`💡 Re-run with --debug (or set debug: true) for full error details.${cloneHint}`);
      }
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
    const uiService = new InteractiveUIService(allServices, configPath, displaySchedule, maxParallel, undefined, {
      debug: options.debug,
    });
    if (options.filter) {
      uiService.setRepositoryFilter(options.filter);
    }
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

    if (syncOnStart) {
      void uiService.triggerInitialSync();
    }
  }
}

function countOf(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

async function loadRunConfig(
  configPath: string,
  overrides: { runOnce: boolean; debug: boolean; filter?: string },
): Promise<{ configFile: ConfigFile; repositories: RepositoryConfig[] }> {
  const configLoader = new ConfigLoaderService();
  const { repositories, configFile } = await configLoader.buildRepositories(configPath, {
    debug: overrides.debug,
    filter: overrides.filter,
  });
  return {
    repositories,
    configFile: overrides.runOnce
      ? { ...configFile, defaults: { ...(configFile.defaults ?? {}), runOnce: true } }
      : configFile,
  };
}

async function resolveConfigOrExit(cliPath: string | undefined): Promise<ResolvedConfigPath> {
  const resolved = await resolveConfigPath(cliPath);
  if (!resolved) {
    const extensions = CONFIG_FILE_NAMES.map((name) => path.extname(name).slice(1)).join(",");
    console.error(
      `❌ No config file found. Pass --config <path>, set ${CONFIG_PATH_ENV_VAR}, run \`sync-worktrees init\` to create one, or place a sync-worktrees.config.{${extensions}} in this directory or a parent.`,
    );
    process.exit(1);
  }
  if (resolved.source === "env" && !(await fileExists(resolved.path))) {
    console.error(`❌ ${CONFIG_PATH_ENV_VAR} points to a file that does not exist: ${resolved.path}`);
    console.error(`💡 Fix or unset ${CONFIG_PATH_ENV_VAR}, or pass --config <path>.`);
    process.exit(1);
  }
  return resolved;
}

const CONFIG_DOCS_URL = "https://github.com/yordan-kanchelov/sync-worktrees/blob/main/docs/configuration.md";

function exitConfigExists(targetPath: string): never {
  console.error(`\n❌ Config file already exists: ${targetPath}`);
  console.error(`💡 Re-run with --force to overwrite.`);
  process.exit(1);
}

async function runInit(configPath: string | undefined, force: boolean): Promise<void> {
  const targetPath = configPath ? path.resolve(configPath) : getDefaultConfigPath();

  if (!hasInteractiveTerminal()) {
    console.error("❌ 'sync-worktrees init' is an interactive wizard and needs a terminal (stdin and stdout).");
    console.error(`💡 Run it from a terminal, or write the config by hand: ${CONFIG_DOCS_URL}`);
    process.exit(1);
  }

  if (!force && (await fileExists(targetPath))) {
    exitConfigExists(targetPath);
  }

  const input = await promptForInitConfig(path.dirname(targetPath));

  try {
    await generateConfigFile(input, targetPath, { overwrite: force });
  } catch (error) {
    if (error instanceof ConfigFileExistsError) {
      exitConfigExists(error.configPath);
    }
    throw error;
  }

  try {
    await new ConfigLoaderService().buildRepositories(targetPath);
  } catch (error) {
    console.error(`\n❌ Wrote ${targetPath}, but it does not load:`);
    console.error(`   ${redactSecretsInText(getErrorMessage(error))}`);
    console.error(
      `💡 The file was left in place — fix it by hand, or re-run 'sync-worktrees init --force' to redo it.`,
    );
    process.exit(1);
  }

  const displayPath = path.relative(process.cwd(), targetPath) || targetPath;
  console.log(`\n✅ Configuration saved to: ${targetPath}`);

  await maybeRegisterMcpClients();

  console.log(`\n💡 Next: sync-worktrees --config ${displayPath}`);
}

async function runSync(options: Extract<CliOptions, { command: typeof CLI_COMMANDS.RUN }>): Promise<void> {
  const resolved = await resolveConfigOrExit(options.config);
  const configPath = resolved.path;
  const displayPath = path.relative(process.cwd(), configPath) || configPath;
  if (options.json) {
    console.error(`📄 Using config: ${describeConfigPath(resolved)}`);
  } else if (!options.quiet) {
    console.log(`📄 Using config: ${describeConfigPath(resolved)}`);
  }

  let loaded: { configFile: ConfigFile; repositories: RepositoryConfig[] };
  try {
    loaded = await loadRunConfig(configPath, options);
  } catch (error) {
    if (error instanceof ConfigFileNotFoundError) {
      console.error(`\n❌ Config file not found: ${error.configPath}`);
      console.error(`💡 Run 'sync-worktrees init --config ${displayPath}' to create one.`);
      process.exit(1);
    }
    console.error("❌ Error loading config file:", configLoadErrorMessage(error));
    process.exit(1);
  }

  if (options.filter && loaded.repositories.length === 0) {
    console.error(`❌ No repositories match filter: ${options.filter}`);
    process.exit(1);
  }

  if (options.dryRun) {
    process.exitCode = await runDryRun(loaded.configFile, loaded.repositories, {
      json: options.json,
      debug: options.debug,
    });
    return;
  }

  if (loaded.configFile.defaults?.runOnce !== true && !hasInteractiveTerminal()) {
    console.error("❌ The interactive dashboard needs a terminal, and stdin or stdout is not one.");
    console.error(
      "💡 For unattended runs use 'sync-worktrees --run-once' (or runOnce: true in the config) from cron, a systemd timer or CI.",
    );
    process.exit(1);
  }

  try {
    await runMultipleRepositories(loaded.configFile, loaded.repositories, configPath, {
      debug: options.debug,
      quiet: options.quiet,
      filter: options.filter,
    });
  } catch (error) {
    console.error("❌ Error running sync:", redactSecretsInText(getErrorMessage(error)));
    if (!(error instanceof SyncWorktreesError) && error instanceof Error && error.stack) {
      console.error(redactSecretsInText(error.stack));
    }
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
      const resolved = await resolveConfigOrExit(options.config);
      const code = await runList(resolved, { filter: options.filter, json: options.json });
      if (code !== 0) process.exit(code);
      return;
    }
    case CLI_COMMANDS.TRASH: {
      const resolved = await resolveConfigOrExit(options.config);
      if (resolved.source !== "flag") console.error(`📄 Using config: ${describeConfigPath(resolved)}`);
      return runTrash(resolved.path, options);
    }
    case CLI_COMMANDS.DOCTOR:
      process.exitCode = await runDoctor(options);
      return;
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
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

export function reportUnhandledError(error: unknown): void {
  console.error("❌ Unhandled error:", redactSecretsInText(typeof error === "string" ? error : inspect(error)));
}

if (isMainEntrypoint()) {
  main().catch((error: unknown) => {
    reportUnhandledError(error);
    process.exit(1);
  });
}

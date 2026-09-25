#!/usr/bin/env node

import { realpathSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { inspect } from "util";

import { input } from "@inquirer/prompts";
import Table from "cli-table3";
import pLimit from "p-limit";

import { CONFIG_FILE_NAMES, DEFAULT_CONFIG, GIT_CONSTANTS } from "./constants";
import { ConfigFileExistsError, ConfigFileNotFoundError, SyncWorktreesError } from "./errors";
import { ConfigLoaderService } from "./services/config-loader.service";
import { InteractiveUIService } from "./services/InteractiveUIService";
import { Logger } from "./services/logger.service";
import { isWorktreeRestorable } from "./services/trash.service";
import { WorktreeSyncService } from "./services/worktree-sync.service";
import { CLI_COMMANDS, parseArguments } from "./utils/cli";
import { formatCloneSkipReason } from "./utils/clone-skip-format";
import { findConfigInCwd, generateConfigFile, getDefaultConfigPath } from "./utils/config-generator";
import { formatBytes } from "./utils/disk-space";
import { fileExists } from "./utils/file-exists";
import { redactRepoUrl, redactSecretsInText } from "./utils/git-url";
import { getErrorMessage } from "./utils/errors";
import { promptForInitConfig } from "./utils/interactive";
import { maybeRegisterMcpClients } from "./utils/mcp-registration";
import { setupSignalHandlers } from "./utils/signal-handlers";
import { warnIfUnitTestShortcutEnabled } from "./utils/unit-test-shortcut";

import type { CloneSkipReason } from "./services/clone-sync.service";
import type { TrashEntry, TrashManifest } from "./services/trash.service";
import type { ConfigFile, RepositoryConfig } from "./types";
import type { CliOptions, TrashCliOptions } from "./utils/cli";

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
  // Read off the config file, not off a resolved repository: this and `runOnce`
  // are whole-file switches over one process, and the loader rejects both on a
  // repository entry for that reason. Resolving `syncOnStart` per repository
  // would advertise a granularity it does not have — the daemon runs exactly one
  // startup cycle across every service.
  const syncOnStart = configFile.defaults?.syncOnStart ?? true;
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
          repoLogger.info(`   URL: ${redactRepoUrl(repoConfig.repoUrl)}`);
          repoLogger.info(`   Worktrees: ${repoConfig.worktreeDir}`);
          if (repoConfig.bareRepoDir) {
            repoLogger.info(`   Bare repo: ${repoConfig.bareRepoDir}`);
          }

          // A copy, not an assignment: the loaded configuration stays as it
          // was read, whoever else holds it.
          const syncService = new WorktreeSyncService({ ...repoConfig, logger: repoConfig.logger ?? repoLogger });
          await syncService.initialize();
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
        // allSettled preserves the order of what it was handed, and it was
        // handed repositories.map(...), so index is this repository. The name
        // has to come from there: the rejected task never got far enough to
        // return one, and its header line was printed whenever it happened to
        // start, which under parallelism is nowhere near this line.
        globalLogger.error(`❌ Failed to initialize repository '${repositories[index].name}':`, result.reason);
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

    // Last, and deliberately. The constructor above already called Ink's
    // render(), and Ink flushes the App's mount effect — the one that subscribes
    // to every event and emits `uiReady` — synchronously inside it, so the
    // interface is listening before this line runs. Going after the summary
    // lines keeps their order under either timing anyway: addLog emits straight
    // through once the UI is ready and otherwise buffers in call order, so the
    // sync's output cannot overtake them. Not awaited, like the disk-space probe
    // above — the branch returns to leave the cron jobs and the UI running. The
    // cycle is exactly what the first cron tick would have run (same services,
    // same lazy initialize inside runSyncServices) except for logErrors, which
    // is on here: a startup failure answers "I just started it, where are my
    // worktrees?", while the cron path stays quiet and retries next tick.
    if (syncOnStart) {
      void uiService.triggerInitialSync();
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
      console.log(`   URL: ${redactRepoUrl(repo.repoUrl)}`);
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
    console.error("❌ Error loading config file:", redactSecretsInText(getErrorMessage(error)));
    process.exit(1);
  }
}

// A failure the person running `sync-worktrees trash` is expected to hit and
// can do something about: a wrong id, a destination that is already occupied,
// a lock somebody else holds, a confirmation they declined. Those get one line
// and exit code 1. Anything else keeps its stack and goes to main().catch,
// because a stack is the only useful thing to say about a bug.
class TrashCliError extends Error {}

// Ctrl+C at one of the confirmation prompts. @inquirer installs its own SIGINT
// handler and rejects with an ExitPromptError rather than letting the signal
// through, so declining a destructive prompt the most ordinary way there is
// printed "❌ Unhandled error:" and ten frames of readline internals. Matched
// by name because @inquirer/prompts does not re-export the class, and
// @inquirer/core is not a dependency of this package.
function isPromptCancellation(error: unknown): error is Error {
  return error instanceof Error && error.name === "ExitPromptError";
}

function isExpectedTrashFailure(error: unknown): error is Error {
  return error instanceof TrashCliError || error instanceof SyncWorktreesError || isPromptCancellation(error);
}

// `null`, not `0`: sizes are measured off the repository lock, so a freshly
// trashed entry is genuinely unmeasured rather than empty, and rendering it as
// "0 B" would invite exactly the wrong conclusion about what deleting it frees.
function formatTrashSize(sizeBytes: number | null): string {
  return sizeBytes === null ? "—" : formatBytes(sizeBytes);
}

function formatTrashExpiry(expiresAt: string, now: number): string {
  const parsed = new Date(expiresAt);
  const day = Number.isNaN(parsed.getTime()) ? expiresAt : parsed.toISOString().slice(0, 10);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() <= now ? `${day} (expired)` : day;
}

// Branch when there is one. An "orphan" entry has none, and then the directory
// it came from is the only thing that identifies it — dropping that would make
// those rows unreadable, which is what the old tab-separated listing at least
// got right by always printing originalPath.
function trashEntryLabel(manifest: TrashManifest, worktreeDir: string): string {
  if (manifest.branch) return manifest.branch;
  const relative = path.relative(worktreeDir, manifest.originalPath);
  return relative !== "" && !relative.startsWith("..") ? relative : manifest.originalPath;
}

// The rows this command printed from 5.2.0 until now. Kept for a piped stdout
// so that `sync-worktrees trash | cut -f1` and anything else built on the tab
// layout still works: cli-table3 draws box characters and ANSI colour with no
// terminal detection of its own, so sending the table down a pipe would hand a
// script escape sequences instead of fields. A human at a terminal gets the
// table; everything else gets exactly what it got before, and `--json` is the
// shape to build anything new on.
function printTrashRows(entries: TrashEntry[], keepRefs: string[]): void {
  for (const { manifest } of entries) {
    console.log(`${manifest.id}\t${manifest.reason}\t${manifest.expiresAt}\t${manifest.originalPath}`);
  }
  for (const ref of keepRefs) console.log(`KEEP\t${ref.slice(GIT_CONSTANTS.KEEP_REF_PREFIX.length)}`);
}

function printTrashTable(entries: TrashEntry[], keepRefs: string[], worktreeDir: string): void {
  if (!process.stdout.isTTY) {
    printTrashRows(entries, keepRefs);
    return;
  }
  if (entries.length === 0) {
    console.log("No trash entries.");
  } else {
    const now = Date.now();
    const table = new Table({
      head: ["Id", "Branch / path", "Reason", "Size", "Expires", "Restores as", "Keep on reap"],
      style: { head: ["cyan", "bold"], border: ["gray"] },
    });
    for (const { manifest } of entries) {
      table.push([
        manifest.id,
        trashEntryLabel(manifest, worktreeDir),
        manifest.reason,
        formatTrashSize(manifest.sizeBytes),
        formatTrashExpiry(manifest.expiresAt, now),
        isWorktreeRestorable(manifest) ? "worktree" : "files only",
        manifest.keepPinOnReap === true ? "yes" : "",
      ]);
    }
    console.log(table.toString());
  }

  if (keepRefs.length > 0) {
    console.log(`\nPermanent keep refs (commits held past payload expiry):`);
    for (const ref of keepRefs) console.log(`  ${ref.slice(GIT_CONSTANTS.KEEP_REF_PREFIX.length)}`);
  }
}

function printTrashJson(entries: TrashEntry[], invalid: string[], keepRefs: string[]): void {
  console.log(
    JSON.stringify(
      {
        entries: entries.map(({ manifest }) => ({
          id: manifest.id,
          branch: manifest.branch,
          reason: manifest.reason,
          originalPath: manifest.originalPath,
          deletedAt: manifest.deletedAt,
          expiresAt: manifest.expiresAt,
          // Stays null when nothing has measured this payload yet.
          sizeBytes: manifest.sizeBytes,
          restoresAsWorktree: isWorktreeRestorable(manifest),
          keepPinOnReap: manifest.keepPinOnReap === true,
          source: manifest.source,
        })),
        invalidEntries: invalid,
        keepRefs: keepRefs.map((ref) => ref.slice(GIT_CONSTANTS.KEEP_REF_PREFIX.length)),
      },
      null,
      2,
    ),
  );
}

function requireTrashTTY(flag: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new TrashCliError(`${flag} requires an interactive TTY`);
  }
}

async function runTrash(configPath: string, options: TrashCliOptions): Promise<void> {
  try {
    await executeTrash(configPath, options);
  } catch (error) {
    if (!isExpectedTrashFailure(error)) throw error;
    console.error(`❌ ${redactSecretsInText(error.message)}`);
    process.exitCode = 1;
  }
}

async function executeTrash(configPath: string, options: TrashCliOptions): Promise<void> {
  const configLoader = new ConfigLoaderService();
  // Config loading throws plain Errors as well as typed ConfigErrors — a config
  // file is user-supplied JS — and a config someone can fix is never a bug in
  // this tool. `list` and the sync command already report these as one line;
  // without this, `trash` was the only command that answered a missing
  // `repoUrl` with a stack trace.
  let repositories;
  try {
    ({ repositories } = await configLoader.buildRepositories(configPath, { filter: options.filter }));
  } catch (error) {
    throw new TrashCliError(`Error loading config file: ${getErrorMessage(error)}`);
  }
  if (repositories.length !== 1) {
    throw new TrashCliError(
      `Trash operations require exactly one repository; matched ${repositories.length}. Use --filter.`,
    );
  }

  const service = new WorktreeSyncService(repositories[0]);
  if (service.isCloneMode()) {
    throw new TrashCliError("Trash operations are only available for worktree-mode repositories");
  }
  // A bounded budget, never an open-ended block: see DEFAULT_CONFIG.LOCK_WAIT_MS.
  const lockWaitMs = options.wait === true ? DEFAULT_CONFIG.LOCK_WAIT_MS : undefined;
  // Announced before the wait begins, and only for the two operations that take
  // the lock — a listing takes none, so saying it would wait for one is a lie
  // told to whoever is watching the terminal.
  if (lockWaitMs !== undefined && (options.restore !== undefined || options.purge !== undefined)) {
    console.log(
      `⏳ Waiting up to ${Math.round(lockWaitMs / 1000)}s for the repository lock if another process holds it`,
    );
  }

  if (options.restore) {
    const manifest = await service.restoreFromTrash(options.restore, { lockWaitMs });
    console.log(`✅ Restored ${manifest.id} to ${manifest.originalPath}`);
    return;
  }
  if (options.purge) {
    await purgeTrashEntry(service, options.purge, lockWaitMs);
    return;
  }
  if (options.dropKeepRef) {
    requireTrashTTY("--dropKeepRef");
    const confirmation = await input({ message: `Type '${options.dropKeepRef}' to confirm deleting this keep ref:` });
    if (confirmation !== options.dropKeepRef) {
      throw new TrashCliError("Keep ref deletion was not confirmed");
    }
    await service.deleteKeepRef(options.dropKeepRef);
    console.log(`✅ Deleted ${options.dropKeepRef}`);
    return;
  }
  if (options.dropAllKeepRefs) {
    requireTrashTTY("--dropAllKeepRefs");
    // The names are read here, before the confirmation, and handed to the
    // service as the set to act on: a sync running alongside this command can
    // mint keep refs for entries it has just reaped, and those were never on
    // screen. See deleteKeepRefs.
    const names = (await service.listKeepRefs()).map((ref) => ref.slice(GIT_CONSTANTS.KEEP_REF_PREFIX.length));
    if (names.length === 0) {
      console.log("No keep refs to drop.");
      return;
    }
    const phrase = `drop ${names.length}`;
    const confirmation = await input({
      message:
        `Deleting ${names.length} keep ref(s) makes their commits eligible for 'git gc' and cannot be undone. ` +
        `Type '${phrase}' to confirm:`,
    });
    if (confirmation !== phrase) {
      throw new TrashCliError("Keep ref deletion was not confirmed");
    }
    const dropped = await service.deleteKeepRefs(names);
    console.log(`✅ Deleted ${dropped.deleted} keep ref(s)`);
    for (const ref of dropped.retained) {
      console.log(`   Retained ${ref} — a '.diverged/' directory still depends on it`);
    }
    for (const error of dropped.errors) console.warn(`⚠️ Could not delete ${error}`);
    return;
  }

  // Deliberately listEntries, not listEntriesWithSizes: sizing execs `du` over
  // every payload, node_modules and all, and a listing that waits minutes to
  // fill one column is worse than a column that says "—" for what nothing has
  // measured yet.
  const { entries, invalid } = await service.listTrashEntries();
  const keepRefs = await service.listKeepRefs();
  if (options.json === true) {
    printTrashJson(entries, invalid, keepRefs);
    return;
  }
  printTrashTable(entries, keepRefs, repositories[0].worktreeDir);
  for (const invalidPath of invalid) console.warn(`⚠️ Invalid trash entry left untouched: ${invalidPath}`);
}

// Permanent deletion of one entry, gated exactly like --dropKeepRef and
// --dropAllKeepRefs: an interactive TTY, a typed confirmation naming what is
// being destroyed, and an audit record — the last written by the reap path
// inside the lock, so it records the attempt and not merely the intent.
//
// The entry is read once before the prompt so the prompt can say whether this
// is a keep-on-reap entry, whose commits reached no remote and whose payload
// may be the only copy. The purge itself re-reads under the lock; this listing
// only decides what the person is told.
async function purgeTrashEntry(
  service: WorktreeSyncService,
  id: string,
  lockWaitMs: number | undefined,
): Promise<void> {
  requireTrashTTY("--purge");
  const { entries } = await service.listTrashEntries();
  const entry = entries.find((candidate) => candidate.manifest.id === id);
  if (!entry) throw new TrashCliError(`No trash entry with id '${id}'`);

  const keepNote = entry.manifest.keepPinOnReap
    ? ` Its commits were on no remote when it was trashed, so '${GIT_CONSTANTS.KEEP_REF_PREFIX}${id}' is created first and the files are deleted only if that succeeds.`
    : "";
  const confirmation = await input({
    message:
      `Deleting trash entry '${id}' removes its files permanently and cannot be undone.${keepNote} ` +
      `Type '${id}' to confirm:`,
  });
  if (confirmation !== id) throw new TrashCliError("Trash entry deletion was not confirmed");

  const result = await service.purgeTrashEntry(id, { lockWaitMs });
  if (!result.deleted) {
    for (const ref of result.keepRefsMinted) console.log(`   Kept commits at '${ref}'`);
    throw new TrashCliError(
      `Trash entry '${id}' was not deleted and stays listed: ${result.errors.join("; ") || "no reason reported"}`,
    );
  }
  console.log(`✅ Purged ${id}`);
  // Ref and commit only. The reap path logs the full "recover with: git branch
  // <name> <oid>" line as it mints the ref, and printing that verbatim a second
  // time is how a two-line result becomes four lines of the same sentence.
  for (const ref of result.keepRefsMinted) {
    console.log(`   Commits kept at '${ref}' (${entry.manifest.headOid})`);
  }
  for (const error of result.errors) console.warn(`⚠️ ${error}`);
}

async function loadRunConfig(
  configPath: string,
  runOnceOverride: boolean,
): Promise<{ configFile: ConfigFile; repositories: RepositoryConfig[] }> {
  const configLoader = new ConfigLoaderService();
  const { repositories, configFile } = await configLoader.buildRepositories(configPath);
  return {
    repositories,
    configFile: runOnceOverride
      ? { ...configFile, defaults: { ...(configFile.defaults ?? {}), runOnce: true } }
      : configFile,
  };
}

async function resolveConfigOrExit(cliPath: string | undefined): Promise<string> {
  const resolved = cliPath ? path.resolve(cliPath) : await findConfigInCwd();
  if (!resolved) {
    // Derived from CONFIG_FILE_NAMES, not restated: this message named
    // `{js,mjs,cjs}` while `findConfigInCwd` — which shares that constant —
    // already searched for `.ts` as well, so the one place a user is told what
    // to create disagreed with what the CLI would find. Building it from the
    // list is the same fix as pinning the list: the claim cannot drift again.
    const extensions = CONFIG_FILE_NAMES.map((name) => path.extname(name).slice(1)).join(",");
    console.error(
      `❌ No config file found. Pass --config <path>, run \`sync-worktrees init\` to create one, or place a sync-worktrees.config.{${extensions}} in this directory.`,
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

  const input = await promptForInitConfig(path.dirname(targetPath));

  try {
    await generateConfigFile(input, targetPath, { overwrite: force });
  } catch (error) {
    if (error instanceof ConfigFileExistsError) {
      exitConfigExists(error.configPath);
    }
    throw error;
  }

  // The wizard is the one place a config is written without the user ever
  // seeing it, so prove it loads before claiming success. `buildRepositories`
  // is the exact entry point `runFromConfigFile` uses, so anything it accepts
  // here the next `sync-worktrees` run accepts too.
  try {
    await new ConfigLoaderService().buildRepositories(targetPath);
  } catch (error) {
    // The file is left in place deliberately: it holds the answers the user
    // just typed and is the only evidence of what went wrong, and with --force
    // deleting it would destroy the config it overwrote as well.
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
  const configPath = await resolveConfigOrExit(options.config);
  const displayPath = path.relative(process.cwd(), configPath) || configPath;
  console.log(`📄 Using config: ${displayPath}`);

  let loaded: { configFile: ConfigFile; repositories: RepositoryConfig[] };
  try {
    loaded = await loadRunConfig(configPath, options.runOnce);
  } catch (error) {
    if (error instanceof ConfigFileNotFoundError) {
      console.error(`\n❌ Config file not found: ${error.configPath}`);
      console.error(`💡 Run 'sync-worktrees init --config ${displayPath}' to create one.`);
      process.exit(1);
    }
    console.error("❌ Error loading config file:", redactSecretsInText(getErrorMessage(error)));
    process.exit(1);
  }

  try {
    await runMultipleRepositories(loaded.configFile, loaded.repositories, configPath);
  } catch (error) {
    // The config loaded; this is the run failing. Everything that escapes here
    // — a service constructor rejecting a repository name, a render that will
    // not mount — used to be reported as "Error loading config file", which
    // sent people to edit a file that was never the problem.
    console.error("❌ Error running sync:", redactSecretsInText(getErrorMessage(error)));
    // A typed failure says everything it has to say in that line. Anything else
    // is a bug in this tool, and a stack is the only useful thing to say about
    // one — through the same scrubbing, because a git error quotes the remote.
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
      const configPath = await resolveConfigOrExit(options.config);
      return runList(configPath, options.filter);
    }
    case CLI_COMMANDS.TRASH: {
      const configPath = await resolveConfigOrExit(options.config);
      return runTrash(configPath, options);
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
  main().catch((error: unknown) => {
    // Inspect before printing so a git error that quotes a credential-bearing
    // remote URL can be scrubbed; console.error(msg, error) would print it raw.
    console.error("❌ Unhandled error:", redactSecretsInText(typeof error === "string" ? error : inspect(error)));
    process.exit(1);
  });
}

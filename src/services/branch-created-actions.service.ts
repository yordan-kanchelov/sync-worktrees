import { FileCopyService } from "./file-copy.service";

import type { HookExecutionService } from "./hook-execution.service";
import type { Logger } from "./logger.service";
import type { Config, HookContext } from "../types";

export interface CopyFilesParams {
  config: Pick<Config, "filesToCopyOnBranchCreate" | "worktreeDir" | "bareRepoDir" | "__configuredRepoDirs">;
  branchName: string;
  worktreePath: string;
  sourceDir: string;
  logger: Logger;
}

export interface RunHooksParams {
  config: Pick<Config, "hooks" | "repoUrl">;
  repoName: string;
  branchName: string;
  worktreePath: string;
  baseBranch: string;
  logger: Logger;
  hookExecutionService: HookExecutionService;
}

export class BranchCreatedActionsService {
  private fileCopyService: FileCopyService;

  constructor(fileCopyService?: FileCopyService) {
    this.fileCopyService = fileCopyService ?? new FileCopyService();
  }

  async copyFiles(params: CopyFilesParams): Promise<void> {
    const { config, sourceDir, worktreePath, branchName, logger } = params;
    const patterns = config.filesToCopyOnBranchCreate;
    if (!patterns?.length) return;

    try {
      const result = await this.fileCopyService.copyFiles(sourceDir, worktreePath, patterns, {
        excludeDirs: this.buildExcludeDirs(config, worktreePath),
      });

      if (result.copied.length > 0) {
        logger.info(`📋 Copied ${result.copied.length} file(s) to '${branchName}': ${result.copied.join(", ")}`);
      }
      if (result.errors.length > 0) {
        logger.warn(`⚠️ Failed to copy ${result.errors.length} file(s) to '${branchName}':`);
        for (const err of result.errors) {
          logger.warn(`  - ${err.file}: ${err.error}`);
        }
      }
    } catch (error) {
      logger.error(`Failed to copy files to '${branchName}': ${String(error)}`);
    }
  }

  /**
   * The directories the copy must never read out of: the checkout being filled,
   * and every checkout the config file hands to a repository. Both callers
   * reach this through copyFiles, so clone mode (source: the config file's
   * directory, which the documented layout makes the parent of every checkout)
   * and worktree mode (source: an existing worktree, which sits inside this
   * repository's own worktreeDir, so what it has to keep out is the other
   * repositories' checkouts and any worktreeDir a config nests inside this
   * one's — allowed, with a warning, by detectPathCollisions) are covered by
   * one rule. FileCopyOptions.excludeDirs says what happens to an entry that
   * lies outside the source or contains it; this list does not have to
   * pre-filter.
   */
  private buildExcludeDirs(config: CopyFilesParams["config"], worktreePath: string): string[] {
    const configured = config.__configuredRepoDirs ?? [config.worktreeDir, config.bareRepoDir];
    const dirs = [worktreePath, ...configured].filter(
      (dir): dir is string => typeof dir === "string" && dir.length > 0,
    );
    return Array.from(new Set(dirs));
  }

  runHooks(params: RunHooksParams): void {
    const { config, branchName, worktreePath, repoName, baseBranch, logger, hookExecutionService } = params;
    if (!config.hooks?.onBranchCreated?.length) return;

    const context: HookContext = {
      branchName,
      worktreePath,
      repoName,
      baseBranch,
      repoUrl: config.repoUrl,
    };

    logger.info(`Running ${config.hooks.onBranchCreated.length} hook(s) for branch '${branchName}'...`);

    hookExecutionService.executeOnBranchCreated(config.hooks, context, {
      onStdout: (data) => logger.info(`[hook] ${data}`),
      onStderr: (data) => logger.warn(`[hook] ${data}`),
      onError: (command, error) => logger.error(`[hook] Failed to execute '${command}': ${error.message}`),
      onComplete: (command, exitCode) => {
        // Named, not counted: several hooks finish out of order and interleaved
        // with each other's output, so "exited with code 1" on its own does not
        // say which of them the user has to go and fix.
        if (exitCode === 0) {
          logger.info(`[hook] Command completed successfully: ${command}`);
        } else if (exitCode !== null) {
          logger.warn(`[hook] Command exited with code ${exitCode}: ${command}`);
        }
      },
    });
  }
}

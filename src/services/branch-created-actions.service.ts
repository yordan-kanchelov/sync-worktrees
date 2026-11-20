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
      if (result.copied.length === 0 && result.skipped.length === 0 && result.errors.length === 0) {
        logger.info(
          `📋 Copy for '${branchName}' matched 0 files for patterns [${patterns.join(", ")}] in ${sourceDir}`,
        );
      }
    } catch (error) {
      logger.error(`Failed to copy files to '${branchName}': ${String(error)}`);
    }
  }

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
      onStdout: (line, command) => logger.info(`[hook: ${command}] ${line}`),
      onStderr: (line, command) => logger.warn(`[hook: ${command}] ${line}`),
      onError: (command, error) => logger.error(`[hook] Failed to execute '${command}': ${error.message}`),
      onSkipped: (commands) => {
        for (const command of commands) logger.warn(`[hook] Skipped after an earlier hook failed: ${command}`);
      },
      onComplete: (command, exitCode) => {
        if (exitCode === 0) {
          logger.info(`[hook] Command completed successfully: ${command}`);
        } else if (exitCode !== null) {
          logger.warn(`[hook] Command exited with code ${exitCode}: ${command}`);
        }
      },
    });
  }
}

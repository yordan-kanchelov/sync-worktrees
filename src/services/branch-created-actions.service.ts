import { FileCopyService } from "./file-copy.service";

import type { HookExecutionService } from "./hook-execution.service";
import type { Logger } from "./logger.service";
import type { Config, HookContext } from "../types";

export interface BranchCreatedActionsParams {
  config: Pick<Config, "filesToCopyOnBranchCreate" | "hooks" | "repoUrl">;
  repoName: string;
  branchName: string;
  worktreePath: string;
  baseBranch: string;
  sourceDir: string;
  logger: Logger;
  hookExecutionService?: HookExecutionService;
  fileCopyService?: FileCopyService;
}

export class BranchCreatedActionsService {
  private fileCopyService: FileCopyService;

  constructor(fileCopyService?: FileCopyService) {
    this.fileCopyService = fileCopyService ?? new FileCopyService();
  }

  async copyFiles(params: BranchCreatedActionsParams): Promise<void> {
    const { config, sourceDir, worktreePath, branchName, logger } = params;
    const patterns = config.filesToCopyOnBranchCreate;
    if (!patterns?.length) return;

    try {
      const result = await this.fileCopyService.copyFiles(sourceDir, worktreePath, patterns);

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
      logger.error(`Failed to copy files to '${branchName}': ${error}`);
    }
  }

  runHooks(params: BranchCreatedActionsParams): void {
    const { config, branchName, worktreePath, repoName, baseBranch, logger, hookExecutionService } = params;
    if (!config.hooks?.onBranchCreated?.length) return;
    if (!hookExecutionService) return;

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
        if (exitCode === 0) {
          logger.info(`[hook] Command completed successfully`);
        } else if (exitCode !== null) {
          logger.warn(`[hook] Command exited with code ${exitCode}`);
        }
      },
    });
  }

  async run(params: BranchCreatedActionsParams): Promise<void> {
    await this.copyFiles(params);
    this.runHooks(params);
  }
}

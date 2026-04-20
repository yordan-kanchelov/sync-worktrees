import * as fs from "fs/promises";
import * as path from "path";
import { pathToFileURL } from "url";

import * as cron from "node-cron";

import { DEFAULT_CONFIG } from "../constants";
import { matchesPattern } from "../utils/branch-filter";

import type { Config, ConfigFile, RepositoryConfig } from "../types";

export class ConfigLoaderService {
  async loadConfigFile(configPath: string): Promise<ConfigFile> {
    const absolutePath = path.resolve(configPath);

    try {
      await fs.access(absolutePath);
    } catch {
      throw new Error(`Config file not found: ${absolutePath}`);
    }

    try {
      const fileUrl = pathToFileURL(absolutePath);
      fileUrl.searchParams.set("t", Date.now().toString());
      const configModule = await import(fileUrl.href);
      const config = configModule.default;

      if (!config) {
        throw new Error("Config file must use 'export default' syntax");
      }

      this.validateConfigFile(config);

      return config;
    } catch (error) {
      if (error instanceof Error && error.message.includes("Config file not found")) {
        throw error;
      }
      throw new Error(`Failed to load config file: ${(error as Error).message}`);
    }
  }

  private validateConfigFile(config: unknown): asserts config is ConfigFile {
    if (!config || typeof config !== "object") {
      throw new Error("Config file must export an object");
    }

    const configObj = config as Record<string, unknown>;

    if (!Array.isArray(configObj.repositories)) {
      throw new Error("Config file must have a 'repositories' array");
    }

    if (configObj.repositories.length === 0) {
      throw new Error("Config file must have at least one repository");
    }

    const seenNames = new Set<string>();

    configObj.repositories.forEach((repo: unknown, index: number) => {
      if (!repo || typeof repo !== "object") {
        throw new Error(`Repository at index ${index} must be an object`);
      }

      const repoObj = repo as Record<string, unknown>;

      if (!repoObj.name || typeof repoObj.name !== "string") {
        throw new Error(`Repository at index ${index} must have a 'name' property`);
      }

      if (seenNames.has(repoObj.name)) {
        throw new Error(`Duplicate repository name: ${repoObj.name}`);
      }
      seenNames.add(repoObj.name);

      if (!repoObj.repoUrl || typeof repoObj.repoUrl !== "string") {
        throw new Error(`Repository '${repoObj.name}' must have a 'repoUrl' property`);
      }

      if (!this.isValidGitUrl(repoObj.repoUrl)) {
        throw new Error(
          `Repository '${repoObj.name}' has invalid 'repoUrl': '${repoObj.repoUrl}'. ` +
            `Expected an HTTP(S), SSH, or Git protocol URL`,
        );
      }

      if (!repoObj.worktreeDir || typeof repoObj.worktreeDir !== "string") {
        throw new Error(`Repository '${repoObj.name}' must have a 'worktreeDir' property`);
      }

      if (repoObj.bareRepoDir !== undefined && typeof repoObj.bareRepoDir !== "string") {
        throw new Error(`Repository '${repoObj.name}' has invalid 'bareRepoDir' property`);
      }

      if (repoObj.cronSchedule !== undefined && typeof repoObj.cronSchedule !== "string") {
        throw new Error(`Repository '${repoObj.name}' has invalid 'cronSchedule' property`);
      }

      if (typeof repoObj.cronSchedule === "string" && !cron.validate(repoObj.cronSchedule)) {
        throw new Error(`Repository '${repoObj.name}' has invalid cron expression: '${repoObj.cronSchedule}'`);
      }

      if (repoObj.runOnce !== undefined && typeof repoObj.runOnce !== "boolean") {
        throw new Error(`Repository '${repoObj.name}' has invalid 'runOnce' property`);
      }

      if (repoObj.filesToCopyOnBranchCreate !== undefined) {
        this.validateFilesToCopyConfig(repoObj.filesToCopyOnBranchCreate, `Repository '${repoObj.name}'`);
      }

      if (repoObj.hooks !== undefined) {
        this.validateHooksConfig(repoObj.hooks, `Repository '${repoObj.name}'`);
      }
    });

    if (configObj.defaults) {
      if (typeof configObj.defaults !== "object") {
        throw new Error("'defaults' must be an object");
      }

      const defaults = configObj.defaults as Record<string, unknown>;

      if (defaults.cronSchedule !== undefined && typeof defaults.cronSchedule !== "string") {
        throw new Error("Invalid 'cronSchedule' in defaults");
      }
      if (typeof defaults.cronSchedule === "string" && !cron.validate(defaults.cronSchedule)) {
        throw new Error(`Invalid cron expression in defaults: '${defaults.cronSchedule}'`);
      }
      if (defaults.runOnce !== undefined && typeof defaults.runOnce !== "boolean") {
        throw new Error("Invalid 'runOnce' in defaults");
      }
      if (defaults.retry !== undefined && typeof defaults.retry !== "object") {
        throw new Error("Invalid 'retry' in defaults");
      }
      if (defaults.filesToCopyOnBranchCreate !== undefined) {
        this.validateFilesToCopyConfig(defaults.filesToCopyOnBranchCreate, "defaults");
      }

      if (defaults.hooks !== undefined) {
        this.validateHooksConfig(defaults.hooks, "defaults");
      }
    }

    if (configObj.retry !== undefined) {
      if (typeof configObj.retry !== "object") {
        throw new Error("'retry' must be an object");
      }

      const retry = configObj.retry as Record<string, unknown>;

      if (retry.maxAttempts !== undefined) {
        if (retry.maxAttempts !== "unlimited" && (typeof retry.maxAttempts !== "number" || retry.maxAttempts < 1)) {
          throw new Error("Invalid 'maxAttempts' in retry config. Must be 'unlimited' or a positive number");
        }
      }

      if (retry.maxLfsRetries !== undefined) {
        if (typeof retry.maxLfsRetries !== "number" || retry.maxLfsRetries < 0) {
          throw new Error("Invalid 'maxLfsRetries' in retry config. Must be a non-negative number");
        }
      }
      if (
        retry.initialDelayMs !== undefined &&
        (typeof retry.initialDelayMs !== "number" || retry.initialDelayMs < 0)
      ) {
        throw new Error("Invalid 'initialDelayMs' in retry config");
      }
      if (retry.maxDelayMs !== undefined && (typeof retry.maxDelayMs !== "number" || retry.maxDelayMs < 0)) {
        throw new Error("Invalid 'maxDelayMs' in retry config");
      }
      if (
        retry.backoffMultiplier !== undefined &&
        (typeof retry.backoffMultiplier !== "number" || retry.backoffMultiplier < 1)
      ) {
        throw new Error("Invalid 'backoffMultiplier' in retry config");
      }

      const initialDelay = (retry.initialDelayMs as number) ?? DEFAULT_CONFIG.RETRY.INITIAL_DELAY_MS;
      const maxDelay = (retry.maxDelayMs as number) ?? DEFAULT_CONFIG.RETRY.MAX_DELAY_MS;
      if (initialDelay > maxDelay) {
        throw new Error(
          `Invalid retry config: 'initialDelayMs' (${initialDelay}) must not exceed 'maxDelayMs' (${maxDelay})`,
        );
      }
    }

    if (configObj.parallelism !== undefined) {
      this.validateParallelismConfig(configObj.parallelism, "global");
    }

    if (configObj.defaults && typeof configObj.defaults === "object") {
      const defaults = configObj.defaults as Record<string, unknown>;
      if (defaults.parallelism !== undefined) {
        this.validateParallelismConfig(defaults.parallelism, "defaults");
      }
    }
  }

  private validateParallelismConfig(parallelism: unknown, context: string): void {
    if (typeof parallelism !== "object" || parallelism === null) {
      throw new Error(`'parallelism' in ${context} must be an object`);
    }

    const config = parallelism as Record<string, unknown>;

    if (config.maxRepositories !== undefined) {
      if (typeof config.maxRepositories !== "number" || config.maxRepositories < 1) {
        throw new Error(`Invalid 'maxRepositories' in ${context} parallelism config. Must be a positive number`);
      }
    }

    if (config.maxWorktreeCreation !== undefined) {
      if (typeof config.maxWorktreeCreation !== "number" || config.maxWorktreeCreation < 1) {
        throw new Error(`Invalid 'maxWorktreeCreation' in ${context} parallelism config. Must be a positive number`);
      }
    }

    if (config.maxWorktreeUpdates !== undefined) {
      if (typeof config.maxWorktreeUpdates !== "number" || config.maxWorktreeUpdates < 1) {
        throw new Error(`Invalid 'maxWorktreeUpdates' in ${context} parallelism config. Must be a positive number`);
      }
    }

    if (config.maxWorktreeRemoval !== undefined) {
      if (typeof config.maxWorktreeRemoval !== "number" || config.maxWorktreeRemoval < 1) {
        throw new Error(`Invalid 'maxWorktreeRemoval' in ${context} parallelism config. Must be a positive number`);
      }
    }

    if (config.maxStatusChecks !== undefined) {
      if (typeof config.maxStatusChecks !== "number" || config.maxStatusChecks < 1) {
        throw new Error(`Invalid 'maxStatusChecks' in ${context} parallelism config. Must be a positive number`);
      }
    }

    const maxRepos = (config.maxRepositories as number) ?? DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES;
    const maxCreation = (config.maxWorktreeCreation as number) ?? DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_CREATION;
    const maxUpdates = (config.maxWorktreeUpdates as number) ?? DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_UPDATES;
    const maxRemoval = (config.maxWorktreeRemoval as number) ?? DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_REMOVAL;
    const maxStatus = (config.maxStatusChecks as number) ?? DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS;

    const maxPerRepoOps = maxCreation + maxUpdates + maxRemoval + maxStatus;
    const totalMaxConcurrent = maxRepos * maxPerRepoOps;

    if (totalMaxConcurrent > DEFAULT_CONFIG.PARALLELISM.MAX_SAFE_TOTAL_CONCURRENT_OPS) {
      const safeMaxRepos = Math.floor(DEFAULT_CONFIG.PARALLELISM.MAX_SAFE_TOTAL_CONCURRENT_OPS / maxPerRepoOps);
      throw new Error(
        `Total concurrent operations (${totalMaxConcurrent}) exceeds safe limit (${DEFAULT_CONFIG.PARALLELISM.MAX_SAFE_TOTAL_CONCURRENT_OPS}). ` +
          `With current per-repository limits (creation: ${maxCreation}, updates: ${maxUpdates}, removal: ${maxRemoval}, status: ${maxStatus}), ` +
          `maximum safe maxRepositories is ${safeMaxRepos}. ` +
          `Consider reducing maxRepositories or lowering per-operation limits.`,
      );
    }
  }

  private validateFilesToCopyConfig(filesToCopy: unknown, context: string): void {
    if (!Array.isArray(filesToCopy)) {
      throw new Error(`'filesToCopyOnBranchCreate' in ${context} must be an array`);
    }

    for (let i = 0; i < filesToCopy.length; i++) {
      const pattern = filesToCopy[i];
      if (typeof pattern !== "string" || pattern.trim() === "") {
        throw new Error(
          `'filesToCopyOnBranchCreate' in ${context} must contain only non-empty strings (invalid at index ${i})`,
        );
      }
    }
  }

  private validateHooksConfig(hooks: unknown, context: string): void {
    if (typeof hooks !== "object" || hooks === null) {
      throw new Error(`'hooks' in ${context} must be an object`);
    }

    const hooksObj = hooks as Record<string, unknown>;

    if (hooksObj.onBranchCreated !== undefined) {
      if (!Array.isArray(hooksObj.onBranchCreated)) {
        throw new Error(`'hooks.onBranchCreated' in ${context} must be an array`);
      }

      for (let i = 0; i < hooksObj.onBranchCreated.length; i++) {
        const command = hooksObj.onBranchCreated[i];
        if (typeof command !== "string" || command.trim() === "") {
          throw new Error(
            `'hooks.onBranchCreated' in ${context} must contain only non-empty strings (invalid at index ${i})`,
          );
        }
      }
    }
  }

  resolveRepositoryConfig(
    repo: RepositoryConfig,
    defaults?: Partial<Config>,
    configDir?: string,
    globalRetry?: Config["retry"],
  ): RepositoryConfig {
    const resolved: RepositoryConfig = {
      name: repo.name,
      repoUrl: repo.repoUrl,
      worktreeDir: this.resolvePath(repo.worktreeDir, configDir),
      cronSchedule: repo.cronSchedule ?? defaults?.cronSchedule ?? DEFAULT_CONFIG.CRON_SCHEDULE,
      runOnce: repo.runOnce ?? defaults?.runOnce ?? false,
    };

    if (repo.bareRepoDir) {
      resolved.bareRepoDir = this.resolvePath(repo.bareRepoDir, configDir);
    }

    if (repo.branchMaxAge || defaults?.branchMaxAge) {
      resolved.branchMaxAge = repo.branchMaxAge ?? defaults?.branchMaxAge;
    }

    if (repo.branchInclude || defaults?.branchInclude) {
      resolved.branchInclude = repo.branchInclude ?? defaults?.branchInclude;
    }

    if (repo.branchExclude || defaults?.branchExclude) {
      resolved.branchExclude = repo.branchExclude ?? defaults?.branchExclude;
    }

    if (repo.skipLfs !== undefined || defaults?.skipLfs !== undefined) {
      resolved.skipLfs = repo.skipLfs ?? defaults?.skipLfs ?? false;
    }

    if (repo.retry || defaults?.retry || globalRetry) {
      resolved.retry = {
        ...(globalRetry || {}),
        ...(defaults?.retry || {}),
        ...(repo.retry || {}),
      };
    }

    if (repo.parallelism || defaults?.parallelism) {
      resolved.parallelism = {
        ...(defaults?.parallelism || {}),
        ...(repo.parallelism || {}),
      };
    }

    if (repo.updateExistingWorktrees !== undefined || defaults?.updateExistingWorktrees !== undefined) {
      resolved.updateExistingWorktrees = repo.updateExistingWorktrees ?? defaults?.updateExistingWorktrees ?? true;
    }

    if (repo.filesToCopyOnBranchCreate || defaults?.filesToCopyOnBranchCreate) {
      const files = repo.filesToCopyOnBranchCreate ?? defaults?.filesToCopyOnBranchCreate;
      resolved.filesToCopyOnBranchCreate = files?.map((f) => this.resolvePath(f, configDir));
    }

    if (repo.hooks || defaults?.hooks) {
      resolved.hooks = {
        ...(defaults?.hooks || {}),
        ...(repo.hooks || {}),
      };
    }

    return resolved;
  }

  private isValidGitUrl(url: string): boolean {
    // HTTP(S) URLs
    if (/^https?:\/\/.+/.test(url)) return true;
    // SSH URLs (git@host:path or ssh://...)
    if (/^(ssh:\/\/|git@).+/.test(url)) return true;
    // Git protocol
    if (/^git:\/\/.+/.test(url)) return true;
    // Local file paths (absolute)
    if (/^(file:\/\/|\/|[A-Za-z]:\\)/.test(url)) return true;
    return false;
  }

  private resolvePath(inputPath: string, baseDir?: string): string {
    if (path.isAbsolute(inputPath)) {
      return inputPath;
    }

    return path.resolve(baseDir || process.cwd(), inputPath);
  }

  filterRepositories(repositories: RepositoryConfig[], filter?: string): RepositoryConfig[] {
    if (!filter) {
      return repositories;
    }

    const patterns = filter.split(",").map((p) => p.trim());

    return repositories.filter((repo) => {
      return patterns.some((pattern) => matchesPattern(repo.name, pattern));
    });
  }

  async buildRepositories(
    configPath: string,
    overrides?: { filter?: string; noUpdateExisting?: boolean; debug?: boolean },
  ): Promise<{ repositories: RepositoryConfig[]; configFile: ConfigFile; configDir: string }> {
    const configFile = await this.loadConfigFile(configPath);
    const configDir = path.dirname(path.resolve(configPath));

    let repositories = configFile.repositories.map((repo) =>
      this.resolveRepositoryConfig(repo, configFile.defaults, configDir, configFile.retry),
    );

    if (overrides?.filter) {
      repositories = this.filterRepositories(repositories, overrides.filter);
    }

    if (overrides?.noUpdateExisting) {
      repositories = repositories.map((repo) => ({ ...repo, updateExistingWorktrees: false }));
    }

    if (overrides?.debug) {
      repositories = repositories.map((repo) => ({ ...repo, debug: true }));
    }

    return { repositories, configFile, configDir };
  }
}

import * as fs from "fs/promises";
import * as path from "path";
import { pathToFileURL } from "url";

import * as cron from "node-cron";

import { CONFIG_FILE_NAMES, DEFAULT_CONFIG } from "../constants";
import { matchesPattern } from "../utils/branch-filter";
import { getDefaultBareRepoDir } from "../utils/git-url";
import { normalizePathForCompare } from "../utils/path-compare";
import { sanitizeNameForPath } from "../utils/sanitize-name";

import type { Config, ConfigFile, RepositoryConfig } from "../types";

export class ConfigLoaderService {
  async findConfigUpward(startDir: string): Promise<string | null> {
    let current = path.resolve(startDir);
    const root = path.parse(current).root;

    while (true) {
      for (const name of CONFIG_FILE_NAMES) {
        const candidate = path.join(current, name);
        try {
          await fs.access(candidate);
          return candidate;
        } catch {
          /* try next */
        }
      }
      if (current === root) return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

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
            `Expected an HTTP(S), SSH, Git protocol URL, or a local/file path (file://, absolute filesystem path)`,
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

      if (repoObj.sparseCheckout !== undefined) {
        this.validateSparseCheckoutConfig(repoObj.sparseCheckout, `Repository '${repoObj.name}'`);
      }
    });

    this.warnOnDuplicateRepoUrls(configObj.repositories as Array<Record<string, unknown>>);

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

      if (defaults.sparseCheckout !== undefined) {
        this.validateSparseCheckoutConfig(defaults.sparseCheckout, "defaults");
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

    const positiveIntFields = [
      "maxRepositories",
      "maxWorktreeCreation",
      "maxWorktreeUpdates",
      "maxWorktreeRemoval",
      "maxStatusChecks",
      "maxBranchFetches",
    ] as const;

    for (const field of positiveIntFields) {
      const value = config[field];
      if (value !== undefined && (typeof value !== "number" || value < 1)) {
        throw new Error(`Invalid '${field}' in ${context} parallelism config. Must be a positive number`);
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

  private validateSparseCheckoutConfig(value: unknown, context: string): void {
    if (typeof value !== "object" || value === null) {
      throw new Error(`'sparseCheckout' in ${context} must be an object`);
    }

    const cfg = value as Record<string, unknown>;

    if (!Array.isArray(cfg.include)) {
      throw new Error(`'sparseCheckout.include' in ${context} must be an array`);
    }
    if (cfg.include.length === 0) {
      throw new Error(`'sparseCheckout.include' in ${context} must contain at least one pattern`);
    }
    for (let i = 0; i < cfg.include.length; i++) {
      const p = cfg.include[i];
      if (typeof p !== "string" || p.trim() === "") {
        throw new Error(
          `'sparseCheckout.include' in ${context} must contain only non-empty strings (invalid at index ${i})`,
        );
      }
    }

    if (cfg.exclude !== undefined) {
      if (!Array.isArray(cfg.exclude)) {
        throw new Error(`'sparseCheckout.exclude' in ${context} must be an array`);
      }
      for (let i = 0; i < cfg.exclude.length; i++) {
        const p = cfg.exclude[i];
        if (typeof p !== "string" || p.trim() === "") {
          throw new Error(
            `'sparseCheckout.exclude' in ${context} must contain only non-empty strings (invalid at index ${i})`,
          );
        }
      }
    }

    if (cfg.mode !== undefined && cfg.mode !== "cone" && cfg.mode !== "no-cone") {
      throw new Error(`'sparseCheckout.mode' in ${context} must be 'cone' or 'no-cone'`);
    }
  }

  private warnOnDuplicateRepoUrls(repositories: Array<Record<string, unknown>>): void {
    const seen = new Map<string, string[]>();
    for (const repo of repositories) {
      const url = typeof repo.repoUrl === "string" ? repo.repoUrl : null;
      const name = typeof repo.name === "string" ? repo.name : null;
      if (!url || !name) continue;
      const list = seen.get(url) ?? [];
      list.push(name);
      seen.set(url, list);
    }
    for (const [url, names] of seen) {
      if (names.length > 1) {
        console.warn(
          `[sync-worktrees] repoUrl '${url}' appears in multiple entries (${names.join(", ")}). ` +
            `Pin 'bareRepoDir' on duplicate entries to make config reorder-proof.`,
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
    allRepositories?: RepositoryConfig[],
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
    } else if (allRepositories && this.isDuplicateRepoUrl(repo, allRepositories)) {
      const sanitized = sanitizeNameForPath(repo.name, `Repository '${repo.name}' name`);
      resolved.bareRepoDir = this.resolvePath(`.bare/${sanitized}`, configDir);
    } else {
      resolved.bareRepoDir = this.resolvePath(getDefaultBareRepoDir(repo.repoUrl), configDir);
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

    const sparse = repo.sparseCheckout ?? defaults?.sparseCheckout;
    if (sparse) {
      resolved.sparseCheckout = sparse;
    }

    return resolved;
  }

  private isDuplicateRepoUrl(repo: RepositoryConfig, all: RepositoryConfig[]): boolean {
    const firstIndex = all.findIndex((r) => r.repoUrl === repo.repoUrl);
    const myIndex = all.indexOf(repo);
    return firstIndex !== -1 && myIndex !== -1 && myIndex !== firstIndex;
  }

  detectBareRepoDirCollisions(repositories: RepositoryConfig[]): void {
    const seen = new Map<string, { name: string; displayPath: string }>();
    for (const repo of repositories) {
      if (!repo.bareRepoDir) continue;
      const key = normalizePathForCompare(repo.bareRepoDir);
      const displayPath = path.resolve(repo.bareRepoDir);
      const existing = seen.get(key);
      if (existing && existing.name !== repo.name) {
        throw new Error(
          `Repositories '${existing.name}' and '${repo.name}' resolve to the same bareRepoDir '${displayPath}'. ` +
            `Set distinct 'bareRepoDir' values for duplicate repoUrl entries.`,
        );
      }
      seen.set(key, { name: repo.name, displayPath });
    }
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
      this.resolveRepositoryConfig(repo, configFile.defaults, configDir, configFile.retry, configFile.repositories),
    );

    this.detectBareRepoDirCollisions(repositories);

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

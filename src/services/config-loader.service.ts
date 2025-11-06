import * as fs from "fs/promises";
import * as path from "path";
import { pathToFileURL } from "url";

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

      if (!repoObj.worktreeDir || typeof repoObj.worktreeDir !== "string") {
        throw new Error(`Repository '${repoObj.name}' must have a 'worktreeDir' property`);
      }

      if (repoObj.bareRepoDir !== undefined && typeof repoObj.bareRepoDir !== "string") {
        throw new Error(`Repository '${repoObj.name}' has invalid 'bareRepoDir' property`);
      }

      if (repoObj.cronSchedule !== undefined && typeof repoObj.cronSchedule !== "string") {
        throw new Error(`Repository '${repoObj.name}' has invalid 'cronSchedule' property`);
      }

      if (repoObj.runOnce !== undefined && typeof repoObj.runOnce !== "boolean") {
        throw new Error(`Repository '${repoObj.name}' has invalid 'runOnce' property`);
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
      if (defaults.runOnce !== undefined && typeof defaults.runOnce !== "boolean") {
        throw new Error("Invalid 'runOnce' in defaults");
      }
      if (defaults.retry !== undefined && typeof defaults.retry !== "object") {
        throw new Error("Invalid 'retry' in defaults");
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
      cronSchedule: repo.cronSchedule ?? defaults?.cronSchedule ?? "0 * * * *",
      runOnce: repo.runOnce ?? defaults?.runOnce ?? false,
    };

    if (repo.bareRepoDir) {
      resolved.bareRepoDir = this.resolvePath(repo.bareRepoDir, configDir);
    }

    if (repo.branchMaxAge || defaults?.branchMaxAge) {
      resolved.branchMaxAge = repo.branchMaxAge ?? defaults?.branchMaxAge;
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

    if (repo.updateExistingWorktrees !== undefined || defaults?.updateExistingWorktrees !== undefined) {
      resolved.updateExistingWorktrees = repo.updateExistingWorktrees ?? defaults?.updateExistingWorktrees ?? true;
    }

    return resolved;
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
      return patterns.some((pattern) => {
        if (pattern.includes("*")) {
          const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
          return regex.test(repo.name);
        }
        return repo.name === pattern;
      });
    });
  }
}

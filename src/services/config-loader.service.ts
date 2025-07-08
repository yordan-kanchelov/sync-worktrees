import * as fs from "fs/promises";
import * as path from "path";

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
      delete require.cache[absolutePath];
      const configModule = require(absolutePath);
      const config = configModule.default || configModule;

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

      if (!repoObj.repoPath || typeof repoObj.repoPath !== "string") {
        throw new Error(`Repository '${repoObj.name}' must have a 'repoPath' property`);
      }

      if (!repoObj.worktreeDir || typeof repoObj.worktreeDir !== "string") {
        throw new Error(`Repository '${repoObj.name}' must have a 'worktreeDir' property`);
      }

      if (repoObj.repoUrl !== undefined && typeof repoObj.repoUrl !== "string") {
        throw new Error(`Repository '${repoObj.name}' has invalid 'repoUrl' property`);
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
    }
  }

  resolveRepositoryConfig(repo: RepositoryConfig, defaults?: Partial<Config>, configDir?: string): RepositoryConfig {
    const resolved: RepositoryConfig = {
      name: repo.name,
      repoPath: this.resolvePath(repo.repoPath, configDir),
      worktreeDir: this.resolvePath(repo.worktreeDir, configDir),
      cronSchedule: repo.cronSchedule ?? defaults?.cronSchedule ?? "0 * * * *",
      runOnce: repo.runOnce ?? defaults?.runOnce ?? false,
    };

    if (repo.repoUrl) {
      resolved.repoUrl = repo.repoUrl;
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

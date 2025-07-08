import * as fs from "fs/promises";
import * as path from "path";

import { beforeEach, describe, expect, it } from "@jest/globals";

import { ConfigLoaderService } from "../config-loader.service";

describe("ConfigLoaderService", () => {
  let configLoader: ConfigLoaderService;
  let tempDir: string;

  beforeEach(async () => {
    configLoader = new ConfigLoaderService();
    tempDir = await fs.mkdtemp(path.join(process.cwd(), "test-config-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("loadConfigFile", () => {
    it("should load a valid config file", async () => {
      const configPath = path.join(tempDir, "test.config.js");
      const configContent = `
        module.exports = {
          repositories: [
            {
              name: "test-repo",
              repoPath: "/path/to/repo",
              worktreeDir: "/path/to/worktrees"
            }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      const config = await configLoader.loadConfigFile(configPath);

      expect(config.repositories).toHaveLength(1);
      expect(config.repositories[0].name).toBe("test-repo");
    });

    it("should load config with defaults", async () => {
      const configPath = path.join(tempDir, "test.config.js");
      const configContent = `
        module.exports = {
          defaults: {
            cronSchedule: "*/30 * * * *",
            runOnce: true
          },
          repositories: [
            {
              name: "test-repo",
              repoPath: "/path/to/repo",
              worktreeDir: "/path/to/worktrees"
            }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      const config = await configLoader.loadConfigFile(configPath);

      expect(config.defaults).toEqual({
        cronSchedule: "*/30 * * * *",
        runOnce: true,
      });
    });

    it("should throw error for non-existent file", async () => {
      const configPath = path.join(tempDir, "non-existent.config.js");

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow("Config file not found");
    });

    it("should throw error for invalid config format", async () => {
      const configPath = path.join(tempDir, "invalid.config.js");
      const configContent = `module.exports = "not an object";`;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow("Config file must export an object");
    });

    it("should throw error for missing repositories array", async () => {
      const configPath = path.join(tempDir, "invalid.config.js");
      const configContent = `module.exports = { defaults: {} };`;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "Config file must have a 'repositories' array",
      );
    });

    it("should throw error for duplicate repository names", async () => {
      const configPath = path.join(tempDir, "duplicate.config.js");
      const configContent = `
        module.exports = {
          repositories: [
            {
              name: "duplicate",
              repoPath: "/path1",
              worktreeDir: "/worktrees1"
            },
            {
              name: "duplicate",
              repoPath: "/path2",
              worktreeDir: "/worktrees2"
            }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow("Duplicate repository name: duplicate");
    });
  });

  describe("resolveRepositoryConfig", () => {
    it("should resolve relative paths", () => {
      const repo = {
        name: "test",
        repoPath: "./relative/path",
        worktreeDir: "./relative/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const resolved = configLoader.resolveRepositoryConfig(repo, {}, "/base/dir");

      expect(resolved.repoPath).toBe("/base/dir/relative/path");
      expect(resolved.worktreeDir).toBe("/base/dir/relative/worktrees");
    });

    it("should preserve absolute paths", () => {
      const repo = {
        name: "test",
        repoPath: "/absolute/path",
        worktreeDir: "/absolute/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const resolved = configLoader.resolveRepositoryConfig(repo, {}, "/base/dir");

      expect(resolved.repoPath).toBe("/absolute/path");
      expect(resolved.worktreeDir).toBe("/absolute/worktrees");
    });

    it("should apply defaults", () => {
      const repo = {
        name: "test",
        repoPath: "/path",
        worktreeDir: "/worktrees",
        cronSchedule: undefined as any,
        runOnce: undefined as any,
      };

      const defaults = {
        cronSchedule: "*/15 * * * *",
        runOnce: true,
      };

      const resolved = configLoader.resolveRepositoryConfig(repo, defaults);

      expect(resolved.cronSchedule).toBe("*/15 * * * *");
      expect(resolved.runOnce).toBe(true);
    });

    it("should override defaults with repo config", () => {
      const repo = {
        name: "test",
        repoPath: "/path",
        worktreeDir: "/worktrees",
        cronSchedule: "0 0 * * *",
        runOnce: false,
      };

      const defaults = {
        cronSchedule: "*/15 * * * *",
        runOnce: true,
      };

      const resolved = configLoader.resolveRepositoryConfig(repo, defaults);

      expect(resolved.cronSchedule).toBe("0 0 * * *");
      expect(resolved.runOnce).toBe(false);
    });
  });

  describe("filterRepositories", () => {
    const repos = [
      { name: "frontend-app", repoPath: "/", worktreeDir: "/", cronSchedule: "", runOnce: false },
      { name: "backend-api", repoPath: "/", worktreeDir: "/", cronSchedule: "", runOnce: false },
      { name: "docs", repoPath: "/", worktreeDir: "/", cronSchedule: "", runOnce: false },
      { name: "admin-dashboard", repoPath: "/", worktreeDir: "/", cronSchedule: "", runOnce: false },
    ];

    it("should return all repos when no filter", () => {
      const filtered = configLoader.filterRepositories(repos);
      expect(filtered).toEqual(repos);
    });

    it("should filter by exact name", () => {
      const filtered = configLoader.filterRepositories(repos, "docs");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe("docs");
    });

    it("should filter by wildcard pattern", () => {
      const filtered = configLoader.filterRepositories(repos, "*-app");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe("frontend-app");
    });

    it("should filter by multiple patterns", () => {
      const filtered = configLoader.filterRepositories(repos, "docs,*-api");
      expect(filtered).toHaveLength(2);
      expect(filtered.map((r) => r.name)).toEqual(["backend-api", "docs"]);
    });

    it("should handle complex wildcard patterns", () => {
      const filtered = configLoader.filterRepositories(repos, "*end*");
      expect(filtered).toHaveLength(2);
      expect(filtered.map((r) => r.name).sort()).toEqual(["backend-api", "frontend-app"]);
    });
  });
});

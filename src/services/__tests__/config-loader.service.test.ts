import * as fs from "fs/promises";
import * as path from "path";

import { beforeEach, describe, expect, it } from "@jest/globals";

import { TEST_URLS, cleanupTempDirectories, createTempDirectory } from "../../__tests__/test-utils";
import { ConfigLoaderService } from "../config-loader.service";

describe("ConfigLoaderService", () => {
  let configLoader: ConfigLoaderService;
  let tempDir: string;

  beforeEach(async () => {
    configLoader = new ConfigLoaderService();
    tempDir = await createTempDirectory("test-config-");
  });

  afterEach(async () => {
    await cleanupTempDirectories();
  });

  describe("loadConfigFile", () => {
    it("should load a valid config file", async () => {
      const configPath = path.join(tempDir, "test.config.js");
      const configContent = `
        module.exports = {
          repositories: [
            {
              name: "test-repo",
              repoUrl: "${TEST_URLS.github}",
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
              repoUrl: "${TEST_URLS.github}",
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
              repoUrl: "https://github.com/test/repo1.git",
              worktreeDir: "/worktrees1"
            },
            {
              name: "duplicate",
              repoUrl: "https://github.com/test/repo2.git",
              worktreeDir: "/worktrees2"
            }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow("Duplicate repository name: duplicate");
    });

    it("should throw error for empty repositories array", async () => {
      const configPath = path.join(tempDir, "empty.config.js");
      const configContent = `
        module.exports = {
          repositories: []
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "Config file must have at least one repository",
      );
    });

    it("should throw error for invalid repository object", async () => {
      const configPath = path.join(tempDir, "invalid-repo.config.js");
      const configContent = `
        module.exports = {
          repositories: ["not-an-object"]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow("Repository at index 0 must be an object");
    });

    it("should throw error for missing repository name", async () => {
      const configPath = path.join(tempDir, "no-name.config.js");
      const configContent = `
        module.exports = {
          repositories: [
            { repoUrl: "https://github.com/test/repo.git", worktreeDir: "/path" }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "Repository at index 0 must have a 'name' property",
      );
    });

    it("should throw error for missing repoUrl", async () => {
      const configPath = path.join(tempDir, "no-url.config.js");
      const configContent = `
        module.exports = {
          repositories: [
            { name: "test", worktreeDir: "/path" }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "Repository 'test' must have a 'repoUrl' property",
      );
    });

    it("should throw error for missing worktreeDir", async () => {
      const configPath = path.join(tempDir, "no-worktree.config.js");
      const configContent = `
        module.exports = {
          repositories: [
            { name: "test", repoUrl: "https://github.com/test/repo.git" }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "Repository 'test' must have a 'worktreeDir' property",
      );
    });

    it("should throw error for invalid bareRepoDir type", async () => {
      const configPath = path.join(tempDir, "invalid-bare.config.js");
      const configContent = `
        module.exports = {
          repositories: [
            { name: "test", repoUrl: "https://github.com/test/repo.git", worktreeDir: "/path", bareRepoDir: 123 }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "Repository 'test' has invalid 'bareRepoDir' property",
      );
    });

    it("should throw error for invalid cronSchedule type", async () => {
      const configPath = path.join(tempDir, "invalid-cron.config.js");
      const configContent = `
        module.exports = {
          repositories: [
            { name: "test", repoUrl: "https://github.com/test/repo.git", worktreeDir: "/path", cronSchedule: 123 }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "Repository 'test' has invalid 'cronSchedule' property",
      );
    });

    it("should throw error for invalid runOnce type", async () => {
      const configPath = path.join(tempDir, "invalid-runonce.config.js");
      const configContent = `
        module.exports = {
          repositories: [
            { name: "test", repoUrl: "https://github.com/test/repo.git", worktreeDir: "/path", runOnce: "yes" }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "Repository 'test' has invalid 'runOnce' property",
      );
    });

    it("should throw error for invalid defaults object", async () => {
      const configPath = path.join(tempDir, "invalid-defaults.config.js");
      const configContent = `
        module.exports = {
          defaults: "not-an-object",
          repositories: [
            { name: "test", repoUrl: "https://github.com/test/repo.git", worktreeDir: "/path" }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow("'defaults' must be an object");
    });

    it("should throw error for invalid cronSchedule in defaults", async () => {
      const configPath = path.join(tempDir, "invalid-defaults-cron.config.js");
      const configContent = `
        module.exports = {
          defaults: { cronSchedule: 123 },
          repositories: [
            { name: "test", repoUrl: "https://github.com/test/repo.git", worktreeDir: "/path" }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow("Invalid 'cronSchedule' in defaults");
    });

    it("should throw error for invalid runOnce in defaults", async () => {
      const configPath = path.join(tempDir, "invalid-defaults-runonce.config.js");
      const configContent = `
        module.exports = {
          defaults: { runOnce: "yes" },
          repositories: [
            { name: "test", repoUrl: "https://github.com/test/repo.git", worktreeDir: "/path" }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow("Invalid 'runOnce' in defaults");
    });
  });

  describe("resolveRepositoryConfig", () => {
    it("should resolve relative paths", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./relative/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const resolved = configLoader.resolveRepositoryConfig(repo, {}, "/base/dir");

      expect(resolved.repoUrl).toBe("https://github.com/test/repo.git");
      expect(resolved.worktreeDir).toBe("/base/dir/relative/worktrees");
    });

    it("should preserve absolute paths", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "/absolute/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const resolved = configLoader.resolveRepositoryConfig(repo, {}, "/base/dir");

      expect(resolved.repoUrl).toBe("https://github.com/test/repo.git");
      expect(resolved.worktreeDir).toBe("/absolute/worktrees");
    });

    it("should apply defaults", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
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
        repoUrl: "https://github.com/test/repo.git",
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
      {
        name: "frontend-app",
        repoUrl: "https://github.com/test/frontend.git",
        worktreeDir: "/",
        cronSchedule: "",
        runOnce: false,
      },
      {
        name: "backend-api",
        repoUrl: "https://github.com/test/backend.git",
        worktreeDir: "/",
        cronSchedule: "",
        runOnce: false,
      },
      { name: "docs", repoUrl: "https://github.com/test/docs.git", worktreeDir: "/", cronSchedule: "", runOnce: false },
      {
        name: "admin-dashboard",
        repoUrl: "https://github.com/test/admin.git",
        worktreeDir: "/",
        cronSchedule: "",
        runOnce: false,
      },
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

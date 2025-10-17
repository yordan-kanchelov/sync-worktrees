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

  describe("retry configuration validation", () => {
    it("should accept valid global retry configuration", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        module.exports = {
          retry: {
            maxAttempts: 5,
            initialDelayMs: 2000,
            maxDelayMs: 60000,
            backoffMultiplier: 3
          },
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees"
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      const config = await configLoader.loadConfigFile(configPath);

      expect(config.retry).toEqual({
        maxAttempts: 5,
        initialDelayMs: 2000,
        maxDelayMs: 60000,
        backoffMultiplier: 3,
      });
    });

    it("should accept 'unlimited' as maxAttempts", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        module.exports = {
          retry: {
            maxAttempts: 'unlimited'
          },
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees"
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      const config = await configLoader.loadConfigFile(configPath);

      expect(config.retry?.maxAttempts).toBe("unlimited");
    });

    it("should reject invalid maxAttempts", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        module.exports = {
          retry: {
            maxAttempts: 0
          },
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees"
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "Invalid 'maxAttempts' in retry config. Must be 'unlimited' or a positive number",
      );
    });

    it("should reject negative initialDelayMs", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        module.exports = {
          retry: {
            initialDelayMs: -1000
          },
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees"
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow("Invalid 'initialDelayMs' in retry config");
    });

    it("should reject negative maxDelayMs", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        module.exports = {
          retry: {
            maxDelayMs: -1
          },
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees"
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow("Invalid 'maxDelayMs' in retry config");
    });

    it("should reject backoffMultiplier less than 1", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        module.exports = {
          retry: {
            backoffMultiplier: 0.5
          },
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees"
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "Invalid 'backoffMultiplier' in retry config",
      );
    });

    it("should reject non-object retry configuration", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        module.exports = {
          retry: "invalid",
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees"
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow("'retry' must be an object");
    });

    it("should accept retry config in defaults", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        module.exports = {
          defaults: {
            retry: {
              maxAttempts: 10
            }
          },
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees"
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      const config = await configLoader.loadConfigFile(configPath);

      expect(config.defaults?.retry).toEqual({ maxAttempts: 10 });
    });

    it("should reject invalid maxLfsRetries", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        module.exports = {
          retry: {
            maxLfsRetries: -1
          },
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees"
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "Invalid 'maxLfsRetries' in retry config. Must be a non-negative number",
      );
    });

    it("should accept valid maxLfsRetries", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        module.exports = {
          retry: {
            maxLfsRetries: 0
          },
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees"
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      const config = await configLoader.loadConfigFile(configPath);
      expect(config.retry?.maxLfsRetries).toBe(0);
    });
  });

  describe("resolveRepositoryConfig - retry and skipLfs", () => {
    it("should merge retry configs correctly", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
        retry: { maxAttempts: 20 },
      };

      const defaults = {
        retry: { initialDelayMs: 5000 },
      };

      const globalRetry = {
        maxAttempts: "unlimited" as const,
        maxDelayMs: 300000,
      };

      const resolved = configLoader.resolveRepositoryConfig(repo, defaults, tempDir, globalRetry);

      expect(resolved.retry).toEqual({
        maxAttempts: 20,
        initialDelayMs: 5000,
        maxDelayMs: 300000,
      });
    });

    it("should handle no retry config", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const resolved = configLoader.resolveRepositoryConfig(repo);

      expect(resolved.retry).toBeUndefined();
    });

    it("should handle skipLfs configuration", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        module.exports = {
          defaults: {
            skipLfs: true
          },
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees"
          }, {
            name: "test-repo-2",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees2",
            skipLfs: false
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      const config = await configLoader.loadConfigFile(configPath);
      const repo1 = configLoader.resolveRepositoryConfig(config.repositories[0], config.defaults, tempDir);
      const repo2 = configLoader.resolveRepositoryConfig(config.repositories[1], config.defaults, tempDir);

      expect(repo1.skipLfs).toBe(true);
      expect(repo2.skipLfs).toBe(false);
    });

    it("should default skipLfs to false when not specified", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const resolved = configLoader.resolveRepositoryConfig(repo);

      expect(resolved.skipLfs).toBeUndefined();
    });

    it("should prioritize repo retry over defaults and global", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
        retry: {
          maxAttempts: 3,
          initialDelayMs: 1000,
          maxDelayMs: 5000,
          backoffMultiplier: 1.5,
        },
      };

      const defaults = {
        retry: {
          maxAttempts: 10,
          initialDelayMs: 2000,
          maxDelayMs: 10000,
          backoffMultiplier: 2,
        },
      };

      const globalRetry = {
        maxAttempts: "unlimited" as const,
        initialDelayMs: 3000,
        maxDelayMs: 60000,
        backoffMultiplier: 3,
      };

      const resolved = configLoader.resolveRepositoryConfig(repo, defaults, tempDir, globalRetry);

      expect(resolved.retry).toEqual({
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        backoffMultiplier: 1.5,
      });
    });
  });
});

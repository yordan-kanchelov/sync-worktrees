import * as fs from "fs/promises";
import * as path from "path";

import { ConfigLoaderService } from "../../services/config-loader.service";
import { createTempDirectory } from "../test-utils";

describe("ConfigLoaderService", () => {
  let configLoader: ConfigLoaderService;
  let tempDir: string;

  beforeEach(async () => {
    configLoader = new ConfigLoaderService();
    tempDir = await createTempDirectory();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
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
            repoUrl: "https://github.com/test/repo.git",
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
            repoUrl: "https://github.com/test/repo.git",
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
            repoUrl: "https://github.com/test/repo.git",
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
            repoUrl: "https://github.com/test/repo.git",
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
            repoUrl: "https://github.com/test/repo.git",
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
            repoUrl: "https://github.com/test/repo.git",
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
            repoUrl: "https://github.com/test/repo.git",
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
            repoUrl: "https://github.com/test/repo.git",
            worktreeDir: "./worktrees"
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      const config = await configLoader.loadConfigFile(configPath);

      expect(config.defaults?.retry).toEqual({ maxAttempts: 10 });
    });
  });

  describe("resolveRepositoryConfig with retry", () => {
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
        maxAttempts: 20, // repo overrides
        initialDelayMs: 5000, // from defaults
        maxDelayMs: 300000, // from global
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
            repoUrl: "https://github.com/test/repo.git",
            worktreeDir: "./worktrees"
          }, {
            name: "test-repo-2",
            repoUrl: "https://github.com/test/repo2.git",
            worktreeDir: "./worktrees2",
            skipLfs: false
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      const config = await configLoader.loadConfigFile(configPath);
      const repo1 = configLoader.resolveRepositoryConfig(config.repositories[0], config.defaults, tempDir);
      const repo2 = configLoader.resolveRepositoryConfig(config.repositories[1], config.defaults, tempDir);

      expect(repo1.skipLfs).toBe(true); // Uses default
      expect(repo2.skipLfs).toBe(false); // Overrides default
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

      expect(resolved.skipLfs).toBeUndefined(); // Not explicitly set
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

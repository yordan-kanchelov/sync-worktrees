import * as fs from "fs/promises";
import * as path from "path";

import { beforeEach, describe, expect, it } from "@jest/globals";

import { generateConfigFile, getDefaultConfigPath } from "../config-generator";

import type { Config } from "../../types";

describe("Config Generator", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(process.cwd(), "test-config-gen-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("generateConfigFile", () => {
    it("should generate a basic config file", async () => {
      const config: Config = {
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/absolute/path/to/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const configPath = path.join(tempDir, "test.config.js");
      await generateConfigFile(config, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain('name: "repo"');
      expect(content).toContain('repoUrl: "https://github.com/user/repo.git"');
      expect(content).toContain('worktreeDir: "/absolute/path/to/worktrees"');
      expect(content).toContain('cronSchedule: "0 * * * *"');
      expect(content).toContain("runOnce: false");
    });

    it("should include repoUrl when provided", async () => {
      const config: Config = {
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/path/to/worktrees",
        cronSchedule: "*/30 * * * *",
        runOnce: true,
      };

      const configPath = path.join(tempDir, "test.config.js");
      await generateConfigFile(config, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain('repoUrl: "https://github.com/user/repo.git"');
      expect(content).toContain('cronSchedule: "*/30 * * * *"');
      expect(content).toContain("runOnce: true");
    });

    it("should use relative paths when appropriate", async () => {
      const config: Config = {
        repoUrl: "https://github.com/user/myproject.git",
        worktreeDir: path.join(tempDir, "worktrees"),
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const configPath = path.join(tempDir, "config.js");
      await generateConfigFile(config, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain('name: "myproject"');
      expect(content).toContain('repoUrl: "https://github.com/user/myproject.git"');
      expect(content).toContain('worktreeDir: "./worktrees"');
    });

    it("should use absolute paths for deeply nested relative paths", async () => {
      const config: Config = {
        repoUrl: "https://github.com/user/deeprepo.git",
        worktreeDir: path.join(tempDir, "worktrees"),
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const configPath = path.join(tempDir, "sub/dir/config.js");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await generateConfigFile(config, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain('name: "deeprepo"');
      expect(content).toContain('repoUrl: "https://github.com/user/deeprepo.git"');
    });

    it("should create parent directories if they don't exist", async () => {
      const config: Config = {
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/path/to/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const configPath = path.join(tempDir, "nested/dir/config.js");
      await generateConfigFile(config, configPath);

      const exists = await fs
        .access(configPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it("should include a timestamp in the generated file", async () => {
      const config: Config = {
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/path/to/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const configPath = path.join(tempDir, "test.config.js");
      await generateConfigFile(config, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toMatch(/Generated on \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe("getDefaultConfigPath", () => {
    it("should return sync-worktrees.config.js in current directory", () => {
      const configPath = getDefaultConfigPath();
      expect(path.basename(configPath)).toBe("sync-worktrees.config.js");
      expect(path.dirname(configPath)).toBe(process.cwd());
    });
  });
});

import * as fs from "fs/promises";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigFileExistsError, findConfigInCwd, generateConfigFile, getDefaultConfigPath } from "../config-generator";

import type { InitConfigInput } from "../../types";

describe("Config Generator", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(process.cwd(), "test-config-gen-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("generateConfigFile", () => {
    it("generates a basic config file", async () => {
      const input: InitConfigInput = {
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/absolute/path/to/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const configPath = path.join(tempDir, "test.config.js");
      await generateConfigFile(input, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain("// @ts-check");
      expect(content).toContain('/** @satisfies {import("sync-worktrees").SyncWorktreesConfig} */');
      expect(content).toContain("const config = {");
      expect(content).toContain("export default config;");
      expect(content).toContain('name: "repo"');
      expect(content).toContain('repoUrl: "https://github.com/user/repo.git"');
      expect(content).toContain('worktreeDir: "/absolute/path/to/worktrees"');
      expect(content).toContain('cronSchedule: "0 * * * *"');
      expect(content).toContain("runOnce: false");
    });

    it("emits runOnce: true and custom cronSchedule", async () => {
      const input: InitConfigInput = {
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/path/to/worktrees",
        cronSchedule: "*/30 * * * *",
        runOnce: true,
      };

      const configPath = path.join(tempDir, "test.config.js");
      await generateConfigFile(input, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain('cronSchedule: "*/30 * * * *"');
      expect(content).toContain("runOnce: true");
    });

    it("uses relative worktreeDir when target sits in config dir", async () => {
      const input: InitConfigInput = {
        repoUrl: "https://github.com/user/myproject.git",
        worktreeDir: path.join(tempDir, "worktrees"),
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const configPath = path.join(tempDir, "config.js");
      await generateConfigFile(input, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain('name: "myproject"');
      expect(content).toContain('repoUrl: "https://github.com/user/myproject.git"');
      expect(content).toContain('worktreeDir: "./worktrees"');
    });

    it("uses absolute paths for deeply nested relative paths", async () => {
      const input: InitConfigInput = {
        repoUrl: "https://github.com/user/deeprepo.git",
        worktreeDir: path.join(tempDir, "worktrees"),
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const configPath = path.join(tempDir, "sub/dir/config.js");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await generateConfigFile(input, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain('name: "deeprepo"');
      expect(content).toContain('repoUrl: "https://github.com/user/deeprepo.git"');
    });

    it("creates parent directories if missing", async () => {
      const input: InitConfigInput = {
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/path/to/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const configPath = path.join(tempDir, "nested/dir/config.js");
      await generateConfigFile(input, configPath);

      const exists = await fs
        .access(configPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it("includes a timestamp in the generated file", async () => {
      const input: InitConfigInput = {
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/path/to/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const configPath = path.join(tempDir, "test.config.js");
      await generateConfigFile(input, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toMatch(/Generated on \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("includes bareRepoDir as relative path when nested under config dir", async () => {
      const input: InitConfigInput = {
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: path.join(tempDir, "worktrees"),
        bareRepoDir: path.join(tempDir, ".bare/repo"),
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const configPath = path.join(tempDir, "config.js");
      await generateConfigFile(input, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain('bareRepoDir: "./.bare/repo"');
    });

    it("includes bareRepoDir as absolute path for deeply nested config", async () => {
      const input: InitConfigInput = {
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/absolute/path/to/worktrees",
        bareRepoDir: "/absolute/path/to/bare",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const configPath = path.join(tempDir, "deep/nested/dir/config.js");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await generateConfigFile(input, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain('bareRepoDir: "/absolute/path/to/bare"');
    });

    it("throws ConfigFileExistsError when target exists and overwrite is false", async () => {
      const input: InitConfigInput = {
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/path/to/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const configPath = path.join(tempDir, "existing.config.js");
      await fs.writeFile(configPath, "// pre-existing");

      await expect(generateConfigFile(input, configPath)).rejects.toBeInstanceOf(ConfigFileExistsError);
    });

    it("overwrites existing target when overwrite: true", async () => {
      const input: InitConfigInput = {
        repoUrl: "https://github.com/user/repo.git",
        worktreeDir: "/path/to/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const configPath = path.join(tempDir, "existing.config.js");
      await fs.writeFile(configPath, "// pre-existing");

      await generateConfigFile(input, configPath, { overwrite: true });

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain('repoUrl: "https://github.com/user/repo.git"');
      expect(content).not.toContain("pre-existing");
    });
  });

  describe("getDefaultConfigPath", () => {
    it("returns sync-worktrees.config.js in current directory", () => {
      const configPath = getDefaultConfigPath();
      expect(path.basename(configPath)).toBe("sync-worktrees.config.js");
      expect(path.dirname(configPath)).toBe(process.cwd());
    });
  });

  describe("findConfigInCwd", () => {
    it("returns null when no config file exists", async () => {
      const result = await findConfigInCwd(tempDir);
      expect(result).toBeNull();
    });

    it("finds sync-worktrees.config.js", async () => {
      const configPath = path.join(tempDir, "sync-worktrees.config.js");
      await fs.writeFile(configPath, "export default {};");
      const result = await findConfigInCwd(tempDir);
      expect(result).toBe(configPath);
    });

    it("finds sync-worktrees.config.mjs", async () => {
      const configPath = path.join(tempDir, "sync-worktrees.config.mjs");
      await fs.writeFile(configPath, "export default {};");
      const result = await findConfigInCwd(tempDir);
      expect(result).toBe(configPath);
    });

    it("finds sync-worktrees.config.cjs", async () => {
      const configPath = path.join(tempDir, "sync-worktrees.config.cjs");
      await fs.writeFile(configPath, "module.exports = {};");
      const result = await findConfigInCwd(tempDir);
      expect(result).toBe(configPath);
    });

    it("prefers .js over .mjs and .cjs when all exist", async () => {
      const jsPath = path.join(tempDir, "sync-worktrees.config.js");
      await fs.writeFile(jsPath, "export default {};");
      await fs.writeFile(path.join(tempDir, "sync-worktrees.config.mjs"), "export default {};");
      await fs.writeFile(path.join(tempDir, "sync-worktrees.config.cjs"), "module.exports = {};");
      const result = await findConfigInCwd(tempDir);
      expect(result).toBe(jsPath);
    });
  });
});

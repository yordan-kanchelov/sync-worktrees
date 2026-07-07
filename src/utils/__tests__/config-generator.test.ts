import * as fs from "fs/promises";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigLoaderService } from "../../services/config-loader.service";
import { ConfigFileExistsError, findConfigInCwd, generateConfigFile, getDefaultConfigPath } from "../config-generator";

import type { InitConfigInput, InitRepositoryInput } from "../../types";

function makeInput(repositories: InitRepositoryInput[], cronSchedule = "0 * * * *"): InitConfigInput {
  return { repositories, cronSchedule };
}

describe("Config Generator", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(process.cwd(), "test-config-gen-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("generateConfigFile", () => {
    it("generates a basic worktree config and never emits runOnce", async () => {
      const input = makeInput([
        {
          repoUrl: "https://github.com/user/repo.git",
          worktreeDir: "/absolute/path/to/worktrees",
          mode: "worktree",
        },
      ]);

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

      // runOnce is no longer part of the wizard/generated config.
      expect(content).not.toContain("runOnce");
      // worktree is the default mode, so it should not be serialized.
      expect(content).not.toContain('mode: "worktree"');
    });

    it("emits a custom cronSchedule", async () => {
      const input = makeInput(
        [{ repoUrl: "https://github.com/user/repo.git", worktreeDir: "/path/to/worktrees", mode: "worktree" }],
        "*/30 * * * *",
      );

      const configPath = path.join(tempDir, "test.config.js");
      await generateConfigFile(input, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain('cronSchedule: "*/30 * * * *"');
    });

    it("emits clone-mode repositories with mode, branch, and depth", async () => {
      const input = makeInput([
        {
          repoUrl: "https://github.com/user/game-platform.git",
          worktreeDir: "/slots/game-platform",
          mode: "clone",
          branch: "develop",
          depth: 10,
        },
      ]);

      const configPath = path.join(tempDir, "test.config.js");
      await generateConfigFile(input, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain('mode: "clone"');
      expect(content).toContain('branch: "develop"');
      expect(content).toContain("depth: 10");
      expect(content).not.toContain("bareRepoDir");
    });

    it("omits branch/depth for clone mode when not provided", async () => {
      const input = makeInput([
        {
          repoUrl: "https://github.com/user/game-ui.git",
          worktreeDir: "/slots/game-ui",
          mode: "clone",
        },
      ]);

      const configPath = path.join(tempDir, "test.config.js");
      await generateConfigFile(input, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      // Inspect only the config object, not the commented cheatsheet that follows it.
      const configBody = content.split("export default config;")[0];
      expect(configBody).toContain('mode: "clone"');
      expect(configBody).not.toContain("branch:");
      expect(configBody).not.toContain("depth:");
    });

    it("emits multiple repositories", async () => {
      const input = makeInput([
        { repoUrl: "https://github.com/user/first.git", worktreeDir: "/path/first", mode: "worktree" },
        { repoUrl: "https://github.com/user/second.git", worktreeDir: "/path/second", mode: "clone" },
      ]);

      const configPath = path.join(tempDir, "test.config.js");
      await generateConfigFile(input, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain('name: "first"');
      expect(content).toContain('name: "second"');
      expect(content).toContain('mode: "clone"');
    });

    it("deduplicates generated repository names", async () => {
      const input = makeInput([
        { repoUrl: "https://github.com/one/app.git", worktreeDir: "/path/one", mode: "worktree" },
        { repoUrl: "https://github.com/two/app.git", worktreeDir: "/path/two", mode: "worktree" },
        { repoUrl: "https://github.com/three/app.git", worktreeDir: "/path/three", mode: "clone" },
      ]);

      const configPath = path.join(tempDir, "test.config.js");
      await generateConfigFile(input, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain('name: "app"');
      expect(content).toContain('name: "app-2"');
      expect(content).toContain('name: "app-3"');
    });

    it("appends a commented cheatsheet of advanced options", async () => {
      const input = makeInput([
        { repoUrl: "https://github.com/user/repo.git", worktreeDir: "/path/to/worktrees", mode: "worktree" },
      ]);

      const configPath = path.join(tempDir, "test.config.js");
      await generateConfigFile(input, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain("More options");
      expect(content).toContain("branchMaxAge");
      expect(content).toContain("sparseCheckout");
      expect(content).toContain("github.com/yordan-kanchelov/sync-worktrees#configuration");
    });

    it("uses relative worktreeDir when target sits in config dir", async () => {
      const input = makeInput([
        {
          repoUrl: "https://github.com/user/myproject.git",
          worktreeDir: path.join(tempDir, "worktrees"),
          mode: "worktree",
        },
      ]);

      const configPath = path.join(tempDir, "config.js");
      await generateConfigFile(input, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain('name: "myproject"');
      expect(content).toContain('worktreeDir: "./worktrees"');
    });

    it("uses absolute paths for deeply nested relative paths", async () => {
      const worktreeDir = path.join(tempDir, "worktrees");
      const input = makeInput([
        {
          repoUrl: "https://github.com/user/deeprepo.git",
          worktreeDir,
          mode: "worktree",
        },
      ]);

      const configPath = path.join(tempDir, "a/b/c/config.js");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await generateConfigFile(input, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain(`worktreeDir: ${JSON.stringify(worktreeDir)}`);
    });

    it("creates parent directories if missing", async () => {
      const input = makeInput([
        { repoUrl: "https://github.com/user/repo.git", worktreeDir: "/path/to/worktrees", mode: "worktree" },
      ]);

      const configPath = path.join(tempDir, "nested/dir/config.js");
      await generateConfigFile(input, configPath);

      const exists = await fs
        .access(configPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it("includes a timestamp in the generated file", async () => {
      const input = makeInput([
        { repoUrl: "https://github.com/user/repo.git", worktreeDir: "/path/to/worktrees", mode: "worktree" },
      ]);

      const configPath = path.join(tempDir, "test.config.js");
      await generateConfigFile(input, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toMatch(/Generated on \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("includes bareRepoDir as relative path when nested under config dir", async () => {
      const input = makeInput([
        {
          repoUrl: "https://github.com/user/repo.git",
          worktreeDir: path.join(tempDir, "worktrees"),
          bareRepoDir: path.join(tempDir, ".bare/repo"),
          mode: "worktree",
        },
      ]);

      const configPath = path.join(tempDir, "config.js");
      await generateConfigFile(input, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain('bareRepoDir: "./.bare/repo"');
    });

    it("includes bareRepoDir as absolute path for deeply nested config", async () => {
      const input = makeInput([
        {
          repoUrl: "https://github.com/user/repo.git",
          worktreeDir: "/absolute/path/to/worktrees",
          bareRepoDir: "/absolute/path/to/bare",
          mode: "worktree",
        },
      ]);

      const configPath = path.join(tempDir, "deep/nested/dir/config.js");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await generateConfigFile(input, configPath);

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain('bareRepoDir: "/absolute/path/to/bare"');
    });

    it("throws ConfigFileExistsError when target exists and overwrite is false", async () => {
      const input = makeInput([
        { repoUrl: "https://github.com/user/repo.git", worktreeDir: "/path/to/worktrees", mode: "worktree" },
      ]);

      const configPath = path.join(tempDir, "existing.config.js");
      await fs.writeFile(configPath, "// pre-existing");

      await expect(generateConfigFile(input, configPath)).rejects.toBeInstanceOf(ConfigFileExistsError);
    });

    it("overwrites existing target when overwrite: true", async () => {
      const input = makeInput([
        { repoUrl: "https://github.com/user/repo.git", worktreeDir: "/path/to/worktrees", mode: "worktree" },
      ]);

      const configPath = path.join(tempDir, "existing.config.js");
      await fs.writeFile(configPath, "// pre-existing");

      await generateConfigFile(input, configPath, { overwrite: true });

      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain('repoUrl: "https://github.com/user/repo.git"');
      expect(content).not.toContain("pre-existing");
    });
  });

  describe("generated config round-trips through the loader", () => {
    it("loads a generated worktree + clone config without validation errors", async () => {
      const input = makeInput([
        { repoUrl: "https://github.com/user/app.git", worktreeDir: path.join(tempDir, "app"), mode: "worktree" },
        {
          repoUrl: "https://github.com/user/lib.git",
          worktreeDir: path.join(tempDir, "lib"),
          mode: "clone",
          branch: "main",
          depth: 5,
        },
      ]);

      const configPath = path.join(tempDir, "sync-worktrees.config.js");
      await generateConfigFile(input, configPath);

      const loaded = await new ConfigLoaderService().loadConfigFile(configPath);

      expect(loaded.repositories).toHaveLength(2);
      expect(loaded.repositories[1].mode).toBe("clone");
      expect(loaded.repositories[1].branch).toBe("main");
      expect(loaded.repositories[1].depth).toBe(5);
      expect(loaded.defaults?.cronSchedule).toBe("0 * * * *");
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

import * as fs from "fs/promises";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TEST_URLS, cleanupTempDirectories, createTempDirectory } from "../../__tests__/test-utils";
import { ConfigLoaderService } from "../config-loader.service";

import type { RepositoryConfig } from "../../types";

describe("ConfigLoaderService - clone mode", () => {
  let configLoader: ConfigLoaderService;
  let tempDir: string;

  beforeEach(async () => {
    configLoader = new ConfigLoaderService();
    tempDir = await createTempDirectory("test-clone-mode-");
  });

  afterEach(async () => {
    await cleanupTempDirectories();
  });

  async function writeConfig(content: string): Promise<string> {
    const configPath = path.join(tempDir, "test.config.js");
    await fs.writeFile(configPath, content);
    return configPath;
  }

  it("accepts mode: 'clone' with branch", async () => {
    const configPath = await writeConfig(`
      export default {
        repositories: [
          {
            name: "demo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "/tmp/demo",
            mode: "clone",
            branch: "main",
          },
        ],
      };
    `);

    const file = await configLoader.loadConfigFile(configPath);
    expect(file.repositories[0].mode).toBe("clone");
    expect(file.repositories[0].branch).toBe("main");
  });

  it("accepts mode: 'clone' without branch (resolved later)", async () => {
    const configPath = await writeConfig(`
      export default {
        repositories: [
          {
            name: "demo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "/tmp/demo",
            mode: "clone",
          },
        ],
      };
    `);

    const file = await configLoader.loadConfigFile(configPath);
    expect(file.repositories[0].mode).toBe("clone");
  });

  it("rejects invalid mode value", async () => {
    const configPath = await writeConfig(`
      export default {
        repositories: [
          {
            name: "demo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "/tmp/demo",
            mode: "mirror",
          },
        ],
      };
    `);

    await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(/must be 'clone' or 'worktree'/);
  });

  it("rejects empty branch string", async () => {
    const configPath = await writeConfig(`
      export default {
        repositories: [
          {
            name: "demo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "/tmp/demo",
            mode: "clone",
            branch: "",
          },
        ],
      };
    `);

    await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(/branch.*must be a non-empty string/);
  });

  it.each([
    ["branchInclude", `branchInclude: ["main"]`],
    ["branchExclude", `branchExclude: ["dev"]`],
    ["branchMaxAge", `branchMaxAge: "30d"`],
    ["updateExistingWorktrees", `updateExistingWorktrees: true`],
    ["bareRepoDir", `bareRepoDir: "/tmp/bare"`],
  ])("rejects '%s' on a clone-mode repo", async (field, line) => {
    const configPath = await writeConfig(`
      export default {
        repositories: [
          {
            name: "demo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "/tmp/demo",
            mode: "clone",
            ${line},
          },
        ],
      };
    `);

    await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
      new RegExp(`${field}.*not supported when mode is 'clone'`),
    );
  });

  it("rejects conflicting field inherited from defaults", async () => {
    const configPath = await writeConfig(`
      export default {
        defaults: { branchInclude: ["main"] },
        repositories: [
          {
            name: "demo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "/tmp/demo",
            mode: "clone",
          },
        ],
      };
    `);

    await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
      /branchInclude.*not supported when mode is 'clone'/,
    );
  });

  it("does not populate bareRepoDir for clone-mode resolved config", () => {
    const repo: RepositoryConfig = {
      name: "demo",
      repoUrl: TEST_URLS.github,
      worktreeDir: "/tmp/demo",
      cronSchedule: "0 * * * *",
      runOnce: false,
      mode: "clone",
      branch: "main",
    };

    const resolved = configLoader.resolveRepositoryConfig(repo, undefined, "/some/config-dir");
    expect(resolved.bareRepoDir).toBeUndefined();
    expect(resolved.mode).toBe("clone");
    expect(resolved.branch).toBe("main");
    expect(resolved.__configFileDir).toBe("/some/config-dir");
  });

  it("defaults mode to 'worktree' when not specified", () => {
    const repo: RepositoryConfig = {
      name: "demo",
      repoUrl: TEST_URLS.github,
      worktreeDir: "/tmp/demo",
      cronSchedule: "0 * * * *",
      runOnce: false,
    };

    const resolved = configLoader.resolveRepositoryConfig(repo, undefined, "/some/config-dir");
    expect(resolved.mode).toBe("worktree");
    expect(resolved.bareRepoDir).toBeDefined();
  });
});

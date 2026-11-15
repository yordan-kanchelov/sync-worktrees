import * as fs from "fs/promises";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TEST_URLS, cleanupTempDirectories, createTempDirectory } from "../../__tests__/test-utils";
import { ConfigLoaderService } from "../config-loader.service";
import { Logger } from "../logger.service";

// `parallelism.maxBranchFetches` bounded a fallback that could never run. It is
// still accepted so existing configs load, but every load says once that it does nothing.
describe("ConfigLoaderService deprecated-key warnings", () => {
  let tempDir: string;
  let warnings: string[];
  let logger: Logger;

  beforeEach(async () => {
    tempDir = await createTempDirectory("test-deprecated-keys-");
    warnings = [];
    logger = new Logger({
      outputFn: (message: string, level: string): void => {
        if (level === "warn") warnings.push(message);
      },
    });
  });

  afterEach(async () => {
    await cleanupTempDirectories();
    vi.restoreAllMocks();
  });

  async function writeConfig(parallelismBlocks: { top?: string; defaults?: string; repo?: string }): Promise<string> {
    const configPath = path.join(tempDir, "sync-worktrees.config.js");
    await fs.writeFile(
      configPath,
      `
      export default {
        ${parallelismBlocks.top ? `parallelism: ${parallelismBlocks.top},` : ""}
        ${parallelismBlocks.defaults ? `defaults: { parallelism: ${parallelismBlocks.defaults} },` : ""}
        repositories: [
          {
            name: "reference",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "${path.join(tempDir, "worktrees")}",
            bareRepoDir: "${path.join(tempDir, "bare")}",
            ${parallelismBlocks.repo ? `parallelism: ${parallelismBlocks.repo},` : ""}
          }
        ]
      };
    `,
      "utf-8",
    );
    return configPath;
  }

  it("loads a config setting maxBranchFetches with exactly one deprecation warning", async () => {
    const configPath = await writeConfig({ top: "{ maxBranchFetches: 3 }" });

    const { repositories } = await new ConfigLoaderService({ logger }).buildRepositories(configPath);

    expect(repositories).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("maxBranchFetches");
    expect(warnings[0]).toMatch(/deprecated/);
    expect(warnings[0]).toMatch(/no effect/);
  });

  it("warns once even when maxBranchFetches is set at every level", async () => {
    const configPath = await writeConfig({
      top: "{ maxBranchFetches: 3 }",
      defaults: "{ maxBranchFetches: 2 }",
      repo: "{ maxBranchFetches: 1 }",
    });

    await new ConfigLoaderService({ logger }).buildRepositories(configPath);

    expect(warnings.filter((w) => w.includes("maxBranchFetches"))).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  it("says nothing when maxBranchFetches is not set", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const configPath = await writeConfig({ top: "{ maxStatusChecks: 10 }", repo: "{ maxWorktreeUpdates: 2 }" });

    await new ConfigLoaderService({ logger }).buildRepositories(configPath);

    expect(warnings).toEqual([]);
    expect(consoleWarn).not.toHaveBeenCalled();
  });
});

import * as fs from "fs/promises";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TEST_URLS, cleanupTempDirectories, createTempDirectory } from "../../__tests__/test-utils";
import { ConfigLoaderService } from "../config-loader.service";
import { Logger } from "../logger.service";

describe("ConfigLoaderService unknown-key warnings", () => {
  let tempDir: string;
  let warnings: string[];
  let logger: Logger;

  beforeEach(async () => {
    tempDir = await createTempDirectory("test-unknown-keys-");
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

  async function writeConfig(body: string, name = "sync-worktrees.config.js"): Promise<string> {
    const configPath = path.join(tempDir, name);
    await fs.writeFile(configPath, body, "utf-8");
    return configPath;
  }

  function repoBody(extra: string): string {
    return `
      export default {
        repositories: [
          {
            name: "reference",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "${path.join(tempDir, "worktrees")}",
            bareRepoDir: "${path.join(tempDir, "bare")}",
            ${extra}
          }
        ]
      };
    `;
  }

  it("warns through the injected logger, naming the repository, the key and the suggestion", async () => {
    const configPath = await writeConfig(repoBody("updateExistingWorktree: false,"));

    const { repositories } = await new ConfigLoaderService({ logger }).buildRepositories(configPath);

    expect(warnings).toEqual([
      "[sync-worktrees] Unknown config key 'updateExistingWorktree' in repository 'reference' is ignored " +
        "(did you mean 'updateExistingWorktrees'?)",
    ]);
    expect("updateExistingWorktree" in repositories[0]).toBe(false);
    expect(repositories[0].updateExistingWorktrees).toBeUndefined();
  });

  it("warns that a repository-level parallelism.maxRepositories has no effect", async () => {
    const configPath = await writeConfig(repoBody("parallelism: { maxRepositories: 4 },"));

    await new ConfigLoaderService({ logger }).buildRepositories(configPath);

    expect(warnings).toEqual([
      "[sync-worktrees] 'parallelism.maxRepositories' in repository 'reference' has no effect on a repository; " +
        "set it at the top level or under defaults.",
    ]);
  });

  it("warns for the other spellings the audit collected", async () => {
    const configPath = await writeConfig(
      repoBody(`branchIncludes: ["main"], sparseCheckOut: { include: ["src"] }, maxAge: "30d", retries: 3,`),
    );

    await new ConfigLoaderService({ logger }).buildRepositories(configPath);

    expect(warnings).toEqual([
      "[sync-worktrees] Unknown config key 'branchIncludes' in repository 'reference' is ignored " +
        "(did you mean 'branchInclude'?)",
      "[sync-worktrees] Unknown config key 'sparseCheckOut' in repository 'reference' is ignored " +
        "(did you mean 'sparseCheckout'?)",
      "[sync-worktrees] Unknown config key 'maxAge' in repository 'reference' is ignored",
      "[sync-worktrees] Unknown config key 'retries' in repository 'reference' is ignored",
    ]);
  });

  it("reaches defaults, the top level and a nested block", async () => {
    const configPath = await writeConfig(`
      export default {
        cronScedule: "0 * * * *",
        retry: { maxAttemptz: 4 },
        defaults: { updatExistingWorktrees: true },
        repositories: [
          {
            name: "reference",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "${path.join(tempDir, "worktrees")}",
            bareRepoDir: "${path.join(tempDir, "bare")}",
            trash: { retentionDay: 5 }
          }
        ]
      };
    `);

    await new ConfigLoaderService({ logger }).buildRepositories(configPath);

    expect(warnings).toEqual([
      "[sync-worktrees] Unknown config key 'cronScedule' at the top level is ignored",
      "[sync-worktrees] Unknown config key 'retry.maxAttemptz' at the top level is ignored " +
        "(did you mean 'maxAttempts'?)",
      "[sync-worktrees] Unknown config key 'updatExistingWorktrees' in defaults is ignored " +
        "(did you mean 'updateExistingWorktrees'?)",
      "[sync-worktrees] Unknown config key 'trash.retentionDay' in repository 'reference' is ignored " +
        "(did you mean 'retentionDays'?)",
    ]);
  });

  it("warns for the per-repository directory and URL keys under defaults, which nothing inherits", async () => {
    const configPath = await writeConfig(`
      export default {
        defaults: { bareRepoDir: "./shared-bare", repoUrl: "${TEST_URLS.github}", worktreeDir: "./zzz" },
        repositories: [
          {
            name: "reference",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "${path.join(tempDir, "worktrees")}"
          }
        ]
      };
    `);

    const { repositories } = await new ConfigLoaderService({ logger }).buildRepositories(configPath);

    expect(warnings).toEqual([
      "[sync-worktrees] Unknown config key 'bareRepoDir' in defaults is ignored",
      "[sync-worktrees] Unknown config key 'repoUrl' in defaults is ignored",
      "[sync-worktrees] Unknown config key 'worktreeDir' in defaults is ignored",
    ]);
    expect(repositories[0].bareRepoDir).not.toContain("shared-bare");
  });

  it("loads a clone-mode repository beside a stray defaults.bareRepoDir, warning instead of rejecting", async () => {
    const configPath = await writeConfig(`
      export default {
        defaults: { bareRepoDir: "./shared-bare" },
        repositories: [
          {
            name: "reference",
            mode: "clone",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "${path.join(tempDir, "checkout")}"
          }
        ]
      };
    `);

    await new ConfigLoaderService({ logger }).buildRepositories(configPath);

    expect(warnings).toEqual(["[sync-worktrees] Unknown config key 'bareRepoDir' in defaults is ignored"]);
  });

  it("says nothing at all about a config built only from known keys", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const configPath = await writeConfig(`
      export default {
        retry: { maxAttempts: 3, maxLfsRetries: 2, initialDelayMs: 1000, maxDelayMs: 60000, backoffMultiplier: 2, jitterMs: 500 },
        parallelism: { maxRepositories: 2, maxWorktreeCreation: 1, maxWorktreeUpdates: 3, maxWorktreeRemoval: 3, maxStatusChecks: 20 },
        defaults: {
          cronSchedule: "0 * * * *",
          runOnce: false,
          mode: "worktree",
          skipLfs: false,
          debug: false,
          branchMaxAge: "30d",
          branchInclude: ["main"],
          branchExclude: ["wip/*"],
          updateExistingWorktrees: true,
          filesToCopyOnBranchCreate: [".env"],
          fetchTimeoutMs: 300000,
          cloneTimeoutMs: 900000,
          hooks: { onBranchCreated: ["echo hi"] },
          sparseCheckout: { include: ["src"], exclude: ["docs"], mode: "cone", skipUpdateWhenOutsideSparse: true },
          maintenance: { enabled: true, interval: "7d", aggressive: false },
          trash: { enabled: true, retentionDays: 30, warnSizeBytes: 1024, migrateLegacy: true },
          retry: { maxAttempts: "unlimited" },
          parallelism: { maxStatusChecks: 10 }
        },
        repositories: [
          {
            name: "reference",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "${path.join(tempDir, "worktrees")}",
            bareRepoDir: "${path.join(tempDir, "bare")}",
            cronSchedule: "0 * * * *",
            mode: "worktree",
            skipLfs: true,
            debug: true,
            branchMaxAge: "14d",
            branchInclude: ["release/*"],
            branchExclude: ["release/old-*"],
            updateExistingWorktrees: false,
            filesToCopyOnBranchCreate: [".env.local"],
            fetchTimeoutMs: 0,
            cloneTimeoutMs: 0,
            hooks: { onBranchCreated: ["echo bye"] },
            sparseCheckout: { include: ["packages"] },
            maintenance: { interval: "1d" },
            trash: { enabled: false },
            retry: { jitterMs: 10 },
            parallelism: { maxWorktreeUpdates: 1 }
          }
        ]
      };
    `);

    await new ConfigLoaderService({ logger }).buildRepositories(configPath);

    expect(warnings).toEqual([]);
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("says nothing about a clone-mode config using the clone-only keys", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const configPath = await writeConfig(`
      export default {
        repositories: [
          {
            name: "pinned",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "${path.join(tempDir, "clone")}",
            mode: "clone",
            branch: "main",
            depth: 1
          }
        ]
      };
    `);

    await new ConfigLoaderService({ logger }).buildRepositories(configPath);

    expect(warnings).toEqual([]);
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("keeps quiet about a known key that is present with the value undefined", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const configPath = await writeConfig(
      repoBody("updateExistingWorktrees: undefined, parallelism: { maxStatusChecks: undefined },"),
    );

    await new ConfigLoaderService({ logger }).buildRepositories(configPath);

    expect(warnings).toEqual([]);
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("falls through to console.warn — stderr — when no logger is injected", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const configPath = await writeConfig(repoBody("updateExistingWorktree: false,"));

    await new ConfigLoaderService().buildRepositories(configPath);

    expect(consoleWarn.mock.calls.flat()).toEqual([
      "[sync-worktrees] Unknown config key 'updateExistingWorktree' in repository 'reference' is ignored " +
        "(did you mean 'updateExistingWorktrees'?)",
    ]);
    expect(consoleLog).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("warns once per key for one load, and again for a genuine reload", async () => {
    const configPath = await writeConfig(repoBody("updateExistingWorktree: false,"));

    await new ConfigLoaderService({ logger }).buildRepositories(configPath);
    expect(warnings).toHaveLength(1);

    await new ConfigLoaderService({ logger }).buildRepositories(configPath);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toBe(warnings[0]);
  });

  it("stays silent when the config fails a real validation rule", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const configPath = await writeConfig(`
      export default {
        repositories: [
          {
            name: "reference",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "${path.join(tempDir, "worktrees")}",
            updateExistingWorktree: false,
            depth: 0
          }
        ]
      };
    `);

    await expect(new ConfigLoaderService({ logger }).buildRepositories(configPath)).rejects.toThrow(
      /depth.*positive safe integer/,
    );
    expect(warnings).toEqual([]);
    expect(consoleWarn).not.toHaveBeenCalled();
  });
});

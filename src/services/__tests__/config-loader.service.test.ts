import * as fs from "fs/promises";
import * as path from "path";

import pLimit from "p-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TEST_URLS, cleanupTempDirectories, createTempDirectory } from "../../__tests__/test-utils";
import { DEFAULT_CONFIG } from "../../constants";
import { ConfigError, ConfigValidationError } from "../../errors";
import { SIMPLE_GIT_CLIENT_CONCURRENCY } from "../../utils/git-client";
import { ConfigLoaderService, computeParallelismPeak } from "../config-loader.service";

import type { RepositoryConfig } from "../../types";

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
        export default {
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
        export default {
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

    // Node reports a config parsed under the wrong module system as a bare
    // `SyntaxError: Unexpected token 'export'` that names neither the file nor
    // the fix, so the loader appends a hint. A `.cjs` target is the case that
    // can be exercised here: it goes through the loader's real `require()`, so
    // Node's own parser produces the error. The sibling case -- a `.js` file in
    // a `"type": "commonjs"` package -- cannot be reproduced in-process, because
    // Vitest resolves `import()` through its own pipeline rather than Node's
    // module-type resolution; the generator's tests cover that one against a
    // real `node` child process instead.
    it("hints at the module system when a .cjs config uses export default", async () => {
      const configPath = path.join(tempDir, "esm-in.cjs");
      await fs.writeFile(configPath, `export default { repositories: [] };`);

      const error = await configLoader
        .loadConfigFile(configPath)
        .then(() => new Error("expected loadConfigFile to reject"))
        .catch((e: unknown) => e as Error);

      // Additive: the original Node message survives verbatim.
      expect(error.message).toContain("Failed to load config file: Unexpected token 'export'");
      expect(error.message).toContain("esm-in.cjs");
      expect(error.message).toContain('add "type": "module"');
      expect(error.message).toContain(".mjs/.cjs");
    });

    it("leaves an unrelated syntax error unhinted", async () => {
      // A genuine syntax error has nothing to do with the module system, so
      // the hint must not fire on every SyntaxError.
      const configPath = path.join(tempDir, "broken.cjs");
      await fs.writeFile(configPath, `module.exports = { repositories: [ ;`);

      const error = await configLoader
        .loadConfigFile(configPath)
        .then(() => new Error("expected loadConfigFile to reject"))
        .catch((e: unknown) => e as Error);

      expect(error.message).toContain("Unexpected token ';'");
      expect(error.message).not.toContain("hint:");
    });

    it("leaves other load failures unhinted", async () => {
      const configPath = path.join(tempDir, "not-an-object.config.js");
      await fs.writeFile(configPath, `export default "not an object";`);

      const error = await configLoader
        .loadConfigFile(configPath)
        .then(() => new Error("expected loadConfigFile to reject"))
        .catch((e: unknown) => e as Error);

      expect(error.message).toBe("Failed to load config file: Config file must export an object");
      expect(error.message).not.toContain("hint:");
    });

    it("should throw error for invalid config format", async () => {
      const configPath = path.join(tempDir, "invalid.config.js");
      const configContent = `export default "not an object";`;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow("Config file must export an object");
    });

    it("should throw error for missing repositories array", async () => {
      const configPath = path.join(tempDir, "invalid.config.js");
      const configContent = `export default { defaults: {} };`;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "Config file must have a 'repositories' array",
      );
    });

    it("should throw error for duplicate repository names", async () => {
      const configPath = path.join(tempDir, "duplicate.config.js");
      const configContent = `
        export default {
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

    it("redacts credentials from the invalid repoUrl error", async () => {
      const configPath = path.join(tempDir, "invalid-url.config.js");
      const configContent = `
        export default {
          repositories: [
            {
              name: "bad-url",
              repoUrl: "ftp://ci-bot:s3cr3t-token@example.com/repo.git",
              worktreeDir: "/worktrees"
            }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "Repository 'bad-url' has invalid 'repoUrl': 'ftp://***@example.com/repo.git'",
      );
    });

    it("redacts credentials from the duplicate repoUrl warning", async () => {
      const configPath = path.join(tempDir, "duplicate-url.config.js");
      const configContent = `
        export default {
          repositories: [
            {
              name: "first",
              repoUrl: "https://ci-bot:s3cr3t-token@example.com/repo.git",
              worktreeDir: "/worktrees1",
              bareRepoDir: "/bare1"
            },
            {
              name: "second",
              repoUrl: "https://ci-bot:s3cr3t-token@example.com/repo.git",
              worktreeDir: "/worktrees2",
              bareRepoDir: "/bare2"
            }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await configLoader.loadConfigFile(configPath);

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "repoUrl 'https://***@example.com/repo.git' appears in multiple entries (first, second)",
        ),
      );
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("s3cr3t-token");
    });

    it("should throw error for empty repositories array", async () => {
      const configPath = path.join(tempDir, "empty.config.js");
      const configContent = `
        export default {
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
        export default {
          repositories: ["not-an-object"]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow("Repository at index 0 must be an object");
    });

    it("should throw error for missing repository name", async () => {
      const configPath = path.join(tempDir, "no-name.config.js");
      const configContent = `
        export default {
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
        export default {
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
        export default {
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
        export default {
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
        export default {
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

    it("should reject repository runOnce with a defaults.runOnce pointer", async () => {
      const configPath = path.join(tempDir, "invalid-runonce.config.js");
      const configContent = `
        export default {
          repositories: [
            { name: "test", repoUrl: "https://github.com/test/repo.git", worktreeDir: "/path", runOnce: true }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toBeInstanceOf(ConfigError);
      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        /Repository 'test' runOnce.*defaults\.runOnce/,
      );
    });

    it("should throw error for invalid debug type", async () => {
      const configPath = path.join(tempDir, "invalid-debug.config.js");
      const configContent = `
        export default {
          repositories: [
            { name: "test", repoUrl: "https://github.com/test/repo.git", worktreeDir: "/path", debug: "yes" }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "Repository 'test' has invalid 'debug' property",
      );
    });

    it.each([
      ["branchInclude", `branchInclude: "main"`],
      ["branchExclude", `branchExclude: [123]`],
      ["branchMaxAge", `branchMaxAge: "14 days"`],
      ["skipLfs", `skipLfs: "yes"`],
      ["updateExistingWorktrees", `updateExistingWorktrees: 1`],
    ])("rejects invalid repository %s at load time", async (field, line) => {
      const configPath = path.join(tempDir, `invalid-${field}.config.js`);
      const configContent = `
        export default {
          repositories: [
            {
              name: "test-repo",
              repoUrl: "${TEST_URLS.github}",
              worktreeDir: "/path",
              ${line}
            }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toBeInstanceOf(ConfigError);
      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        new RegExp(`Repository 'test-repo'.*${field}`),
      );
    });

    it("should throw error for invalid defaults object", async () => {
      const configPath = path.join(tempDir, "invalid-defaults.config.js");
      const configContent = `
        export default {
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
        export default {
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
        export default {
          defaults: { runOnce: "yes" },
          repositories: [
            { name: "test", repoUrl: "https://github.com/test/repo.git", worktreeDir: "/path" }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow("Invalid 'runOnce' in defaults");
    });

    it("should throw error for invalid debug in defaults", async () => {
      const configPath = path.join(tempDir, "invalid-defaults-debug.config.js");
      const configContent = `
        export default {
          defaults: { debug: "yes" },
          repositories: [
            { name: "test", repoUrl: "https://github.com/test/repo.git", worktreeDir: "/path" }
          ]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow("Invalid 'debug' in defaults");
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

    it("should not let repository runOnce override defaults", () => {
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
      expect(resolved.runOnce).toBe(true);
    });

    it("should preserve debug from defaults for config-only runs", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const resolved = configLoader.resolveRepositoryConfig(repo, { debug: true });

      expect(resolved.debug).toBe(true);
    });

    it("should let repository debug override defaults", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
        debug: false,
      };

      const resolved = configLoader.resolveRepositoryConfig(repo, { debug: true });

      expect(resolved.debug).toBe(false);
    });
  });

  describe("maintenance configuration", () => {
    const baseRepo = {
      name: "test",
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/worktrees",
      cronSchedule: "0 * * * *",
      runOnce: false,
    };

    it("merges maintenance from defaults and lets repo override per-key", () => {
      const resolved = configLoader.resolveRepositoryConfig(
        { ...baseRepo, maintenance: { interval: "1d" } },
        { maintenance: { enabled: true, interval: "7d", aggressive: true } },
      );

      expect(resolved.maintenance).toEqual({ enabled: true, interval: "1d", aggressive: true });
    });

    it("leaves maintenance undefined when neither defaults nor repo set it", () => {
      const resolved = configLoader.resolveRepositoryConfig(baseRepo, {});
      expect(resolved.maintenance).toBeUndefined();
    });

    async function loadWith(maintenance: string): Promise<unknown> {
      const configPath = path.join(tempDir, "maint.config.js");
      await fs.writeFile(
        configPath,
        `export default { repositories: [{ name: "r", repoUrl: "${TEST_URLS.github}", worktreeDir: "/wt", maintenance: ${maintenance} }] };`,
      );
      return configLoader.loadConfigFile(configPath);
    }

    it("rejects a non-object maintenance value", async () => {
      await expect(loadWith("true")).rejects.toThrow("'maintenance' in Repository 'r' must be an object");
    });

    it("rejects a non-boolean maintenance.enabled", async () => {
      await expect(loadWith('{ enabled: "yes" }')).rejects.toThrow(
        "'maintenance.enabled' in Repository 'r' must be a boolean",
      );
    });

    it("rejects an invalid maintenance.interval duration", async () => {
      await expect(loadWith('{ interval: "soon" }')).rejects.toThrow(
        "'maintenance.interval' in Repository 'r' must be a positive duration string like '7d', '24h', or '2w'",
      );
    });

    it("rejects a zero maintenance.interval, which would disable gc throttling entirely", async () => {
      await expect(loadWith('{ interval: "0d" }')).rejects.toThrow(
        "'maintenance.interval' in Repository 'r' must be a positive duration string like '7d', '24h', or '2w'",
      );
    });

    it("rejects a non-boolean maintenance.aggressive", async () => {
      await expect(loadWith("{ aggressive: 1 }")).rejects.toThrow(
        "'maintenance.aggressive' in Repository 'r' must be a boolean",
      );
    });

    it("accepts a valid maintenance block", async () => {
      const config = (await loadWith('{ enabled: true, interval: "2w", aggressive: false }')) as {
        repositories: Array<{ maintenance?: unknown }>;
      };
      expect(config.repositories[0].maintenance).toEqual({ enabled: true, interval: "2w", aggressive: false });
    });
  });

  describe("trash configuration", () => {
    const baseRepo = {
      name: "test",
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/worktrees",
      cronSchedule: "0 * * * *",
      runOnce: false,
    };

    it("merges trash from defaults and lets repo override per-key", () => {
      const resolved = configLoader.resolveRepositoryConfig(
        { ...baseRepo, trash: { retentionDays: 7 } },
        { trash: { enabled: true, retentionDays: 30, migrateLegacy: false } },
      );

      expect(resolved.trash).toEqual({ enabled: true, retentionDays: 7, migrateLegacy: false });
    });

    it("leaves trash undefined when neither defaults nor repo set it", () => {
      const resolved = configLoader.resolveRepositoryConfig(baseRepo, {});
      expect(resolved.trash).toBeUndefined();
    });

    async function loadWith(trash: string): Promise<unknown> {
      const configPath = path.join(tempDir, "trash.config.js");
      await fs.writeFile(
        configPath,
        `export default { repositories: [{ name: "r", repoUrl: "${TEST_URLS.github}", worktreeDir: "/wt", trash: ${trash} }] };`,
      );
      return configLoader.loadConfigFile(configPath);
    }

    it("rejects a non-object trash value", async () => {
      await expect(loadWith("true")).rejects.toThrow("'trash' in Repository 'r' must be an object");
    });

    it("rejects a non-boolean trash.enabled", async () => {
      await expect(loadWith('{ enabled: "yes" }')).rejects.toThrow(
        "'trash.enabled' in Repository 'r' must be a boolean",
      );
    });

    it("rejects a non-positive trash.retentionDays", async () => {
      await expect(loadWith("{ retentionDays: 0 }")).rejects.toThrow(
        "'trash.retentionDays' in Repository 'r' must be a positive number",
      );
    });

    it("rejects a non-positive trash.warnSizeBytes", async () => {
      await expect(loadWith("{ warnSizeBytes: -5 }")).rejects.toThrow(
        "'trash.warnSizeBytes' in Repository 'r' must be a positive number",
      );
    });

    it("rejects trash on clone-mode repositories — clone mode never removes its checkout", async () => {
      const configPath = path.join(tempDir, "trash-clone.config.js");
      await fs.writeFile(
        configPath,
        `export default { repositories: [{ name: "r", repoUrl: "${TEST_URLS.github}", worktreeDir: "/wt", mode: "clone", trash: { enabled: true } }] };`,
      );
      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(/trash/);
    });

    it("accepts a valid trash block", async () => {
      const config = (await loadWith("{ enabled: true, retentionDays: 14, warnSizeBytes: 1073741824 }")) as {
        repositories: Array<{ trash?: unknown }>;
      };
      expect(config.repositories[0].trash).toEqual({ enabled: true, retentionDays: 14, warnSizeBytes: 1073741824 });
    });
  });

  /**
   * `fetchTimeoutMs` and `cloneTimeoutMs` are read by GitService (the bare
   * clone, fetch, push, ls-remote, `remote set-head`) and by CloneSyncService
   * (the clone, the branch fetches, the unshallow), and `Config` has documented
   * them as user knobs with a "set 0 to disable" gloss since they existed — but
   * resolveRepositoryConfig rebuilt the repository config from an explicit
   * allowlist that never named them, so every config-file run silently used the
   * 5- and 15-minute built-ins however the file was written.
   */
  describe("inactivity timeout configuration", () => {
    const baseRepo = {
      name: "test",
      repoUrl: TEST_URLS.github,
      worktreeDir: "/worktrees",
      cronSchedule: "0 * * * *",
      runOnce: false,
    };

    async function loadWith(entry: string, defaults = ""): Promise<unknown> {
      const configPath = path.join(tempDir, "timeouts.config.js");
      await fs.writeFile(
        configPath,
        `export default { ${defaults}repositories: [{ name: "r", repoUrl: "${TEST_URLS.github}", ` +
          `worktreeDir: "/wt"${entry} }] };`,
      );
      return configLoader.loadConfigFile(configPath);
    }

    it("carries both timeouts from a repository entry into the resolved config", () => {
      const resolved = configLoader.resolveRepositoryConfig({ ...baseRepo, fetchTimeoutMs: 0, cloneTimeoutMs: 60_000 });

      expect(resolved.fetchTimeoutMs).toBe(0);
      expect(resolved.cloneTimeoutMs).toBe(60_000);
      // Presence matters on its own: `undefined` would let the service fall
      // back to the built-in default, which is what a dropped key looked like.
      expect("fetchTimeoutMs" in resolved).toBe(true);
      expect("cloneTimeoutMs" in resolved).toBe(true);
    });

    it("inherits both timeouts from defaults when the repository sets neither", () => {
      const resolved = configLoader.resolveRepositoryConfig(baseRepo, {
        fetchTimeoutMs: 1_800_000,
        cloneTimeoutMs: 3_600_000,
      });

      expect(resolved.fetchTimeoutMs).toBe(1_800_000);
      expect(resolved.cloneTimeoutMs).toBe(3_600_000);
    });

    it("lets a repository entry override defaults, including with 0", () => {
      const resolved = configLoader.resolveRepositoryConfig(
        { ...baseRepo, fetchTimeoutMs: 0, cloneTimeoutMs: 1_000 },
        { fetchTimeoutMs: 1_800_000, cloneTimeoutMs: 3_600_000 },
      );

      // 0 is a setting, not an omission: a truthiness-based merge would hand
      // this repository the 1_800_000 from defaults instead of disabling the kill.
      expect(resolved.fetchTimeoutMs).toBe(0);
      expect(resolved.cloneTimeoutMs).toBe(1_000);
    });

    it("carries a defaults-level 0 rather than treating it as unset", () => {
      const resolved = configLoader.resolveRepositoryConfig(baseRepo, { fetchTimeoutMs: 0, cloneTimeoutMs: 0 });

      expect(resolved.fetchTimeoutMs).toBe(0);
      expect(resolved.cloneTimeoutMs).toBe(0);
    });

    it("leaves both undefined when neither defaults nor repo set them", () => {
      const resolved = configLoader.resolveRepositoryConfig(baseRepo, {});

      expect(resolved.fetchTimeoutMs).toBeUndefined();
      expect(resolved.cloneTimeoutMs).toBeUndefined();
      expect("fetchTimeoutMs" in resolved).toBe(false);
      expect("cloneTimeoutMs" in resolved).toBe(false);
    });

    it("carries both timeouts for clone-mode repositories too", () => {
      const resolved = configLoader.resolveRepositoryConfig(
        { ...baseRepo, mode: "clone", fetchTimeoutMs: 42, cloneTimeoutMs: 4_242 },
        {},
      );

      expect(resolved.mode).toBe("clone");
      expect(resolved.fetchTimeoutMs).toBe(42);
      expect(resolved.cloneTimeoutMs).toBe(4_242);
    });

    it("resolves both through buildRepositories, from defaults and from the entry", async () => {
      const configPath = path.join(tempDir, "timeouts-build.config.js");
      await fs.writeFile(
        configPath,
        `export default {
           defaults: { fetchTimeoutMs: 1800000, cloneTimeoutMs: 3600000 },
           repositories: [
             { name: "inherits", repoUrl: "${TEST_URLS.github}", worktreeDir: "./a" },
             { name: "overrides", repoUrl: "${TEST_URLS.github}", worktreeDir: "./b", fetchTimeoutMs: 0, cloneTimeoutMs: 60000 },
           ],
         };`,
      );

      const { repositories } = await configLoader.buildRepositories(configPath);

      expect(repositories.map((repo) => [repo.name, repo.fetchTimeoutMs, repo.cloneTimeoutMs])).toEqual([
        ["inherits", 1_800_000, 3_600_000],
        ["overrides", 0, 60_000],
      ]);
    });

    it("accepts 0 and any non-negative safe integer", async () => {
      const config = (await loadWith(", fetchTimeoutMs: 0, cloneTimeoutMs: 1800000")) as {
        repositories: Array<{ fetchTimeoutMs?: unknown; cloneTimeoutMs?: unknown }>;
      };

      expect(config.repositories[0].fetchTimeoutMs).toBe(0);
      expect(config.repositories[0].cloneTimeoutMs).toBe(1_800_000);
    });

    it.each([
      ["-1", "a negative window"],
      ["1.5", "a fraction"],
      ['"abc"', "a string"],
      ["true", "a boolean"],
      ["null", "null"],
      ["NaN", "NaN"],
      ["Infinity", "Infinity"],
      ["Number.MAX_SAFE_INTEGER + 2", "a value past the safe-integer range"],
    ])("rejects %s as a repository fetchTimeoutMs (%s)", async (value) => {
      await expect(loadWith(`, fetchTimeoutMs: ${value}`)).rejects.toThrow(ConfigValidationError);
      await expect(loadWith(`, fetchTimeoutMs: ${value}`)).rejects.toThrow(
        "Invalid configuration for 'Repository 'r' fetchTimeoutMs': " +
          "must be a non-negative safe integer (0 disables the timeout)",
      );
    });

    it("rejects an invalid repository cloneTimeoutMs under its own field name", async () => {
      await expect(loadWith(", cloneTimeoutMs: -1")).rejects.toThrow(
        "Invalid configuration for 'Repository 'r' cloneTimeoutMs': " +
          "must be a non-negative safe integer (0 disables the timeout)",
      );
    });

    it("rejects an invalid defaults.fetchTimeoutMs", async () => {
      await expect(loadWith("", "defaults: { fetchTimeoutMs: -1 }, ")).rejects.toThrow(
        "Invalid configuration for 'defaults.fetchTimeoutMs': " +
          "must be a non-negative safe integer (0 disables the timeout)",
      );
    });

    it("rejects an invalid defaults.cloneTimeoutMs", async () => {
      await expect(loadWith("", 'defaults: { cloneTimeoutMs: "1h" }, ')).rejects.toThrow(
        "Invalid configuration for 'defaults.cloneTimeoutMs': " +
          "must be a non-negative safe integer (0 disables the timeout)",
      );
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

    it("should escape regex metacharacters in filter patterns", () => {
      const reposWithDots = [
        ...repos,
        {
          name: "my.app",
          repoUrl: "https://github.com/test/myapp.git",
          worktreeDir: "/",
          cronSchedule: "",
          runOnce: false,
        },
        {
          name: "myXapp",
          repoUrl: "https://github.com/test/myxapp.git",
          worktreeDir: "/",
          cronSchedule: "",
          runOnce: false,
        },
      ];

      const filtered = configLoader.filterRepositories(reposWithDots, "my.app");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe("my.app");
    });

    it("should escape regex metacharacters with wildcards", () => {
      const reposWithSpecial = [
        {
          name: "my.app-v1",
          repoUrl: "https://github.com/test/myapp.git",
          worktreeDir: "/",
          cronSchedule: "",
          runOnce: false,
        },
        {
          name: "myXapp-v1",
          repoUrl: "https://github.com/test/myxapp.git",
          worktreeDir: "/",
          cronSchedule: "",
          runOnce: false,
        },
      ];

      const filtered = configLoader.filterRepositories(reposWithSpecial, "my.app*");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe("my.app-v1");
    });
  });

  describe("retry configuration validation", () => {
    it("should accept valid global retry configuration", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          retry: {
            maxAttempts: 5,
            initialDelayMs: 2000,
            maxDelayMs: 60000,
            backoffMultiplier: 3,
            jitterMs: 250
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
        jitterMs: 250,
      });
    });

    it("should accept 'unlimited' as maxAttempts", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
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
        export default {
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
        export default {
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
        export default {
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
        export default {
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

    it("should reject negative jitterMs", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          retry: {
            jitterMs: -1
          },
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees"
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow("Invalid 'jitterMs' in retry config");
    });

    it("should reject non-object retry configuration", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
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
        export default {
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
        export default {
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
        export default {
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
        export default {
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

    it("reloads .cjs configs and their required child modules", async () => {
      const childPath = path.join(tempDir, "repo-name.cjs");
      const configPath = path.join(tempDir, "sync-worktrees.config.cjs");
      await fs.writeFile(childPath, `module.exports = { name: "first" };`);
      await fs.writeFile(
        configPath,
        `
          const child = require("./repo-name.cjs");
          module.exports = {
            repositories: [{
              name: child.name,
              repoUrl: "${TEST_URLS.github}",
              worktreeDir: "./worktrees"
            }]
          };
        `,
      );

      const first = await configLoader.loadConfigFile(configPath);
      expect(first.repositories[0].name).toBe("first");

      await fs.writeFile(childPath, `module.exports = { name: "second" };`);

      const second = await configLoader.loadConfigFile(configPath);
      expect(second.repositories[0].name).toBe("second");
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

  describe("parallelism configuration validation", () => {
    it("should accept valid global parallelism configuration", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          parallelism: {
            maxRepositories: 5,
            maxWorktreeCreation: 2,
            maxWorktreeUpdates: 4,
            maxWorktreeRemoval: 4,
            maxStatusChecks: 10
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

      expect(config.parallelism).toEqual({
        maxRepositories: 5,
        maxWorktreeCreation: 2,
        maxWorktreeUpdates: 4,
        maxWorktreeRemoval: 4,
        maxStatusChecks: 10,
      });
    });

    it("should accept parallelism config in defaults", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          defaults: {
            parallelism: {
              maxRepositories: 3,
              maxWorktreeCreation: 1,
              maxWorktreeUpdates: 2,
              maxStatusChecks: 10
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

      expect(config.defaults?.parallelism).toEqual({
        maxRepositories: 3,
        maxWorktreeCreation: 1,
        maxWorktreeUpdates: 2,
        maxStatusChecks: 10,
      });
    });

    it("should reject non-object parallelism configuration", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          parallelism: "invalid",
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees"
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "'parallelism' in global must be an object",
      );
    });

    it.each([
      { field: "maxRepositories", invalidValue: 0 },
      { field: "maxWorktreeCreation", invalidValue: -1 },
      { field: "maxWorktreeUpdates", invalidValue: 0 },
      { field: "maxWorktreeRemoval", invalidValue: 0 },
      { field: "maxStatusChecks", invalidValue: 0 },
      { field: "maxBranchFetches", invalidValue: 1.5 },
    ])("should reject invalid $field", async ({ field, invalidValue }) => {
      const configPath = path.join(tempDir, `invalid-${field}.config.js`);
      const configContent = `
        export default {
          parallelism: {
            ${field}: ${invalidValue}
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
        `Invalid configuration for 'global parallelism.${field}': must be a positive integer`,
      );
    });

    it("should reject excessive total concurrent operations", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          parallelism: {
            maxRepositories: 20,
            maxWorktreeCreation: 10,
            maxWorktreeUpdates: 10,
            maxWorktreeRemoval: 10,
            maxStatusChecks: 50
          },
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees"
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(/exceeds safe limit/);
      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(/Consider reducing maxRepositories/);
    });

    it("should calculate safe limit correctly", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          parallelism: {
            maxRepositories: 100,
            maxStatusChecks: 20
          },
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees"
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(/maximum safe maxRepositories is/);
    });

    it("should accept safe concurrent operations", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          parallelism: {
            maxRepositories: 3,
            maxWorktreeCreation: 1,
            maxWorktreeUpdates: 3,
            maxWorktreeRemoval: 3,
            maxStatusChecks: 20
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
      expect(config.parallelism).toBeDefined();
    });

    // The peak is what the guardrail is for: a status check is not one git
    // process, and the phases it used to be summed with never run alongside it.
    it("reports the shipped defaults' peak as 40 concurrent git processes", () => {
      const peak = computeParallelismPeak();

      expect(peak.perRepository).toBe(DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS);
      expect(peak.total).toBe(
        DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES * DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS,
      );
      expect(peak.total).toBe(40);
      expect(peak.widestPhase.field).toBe("maxStatusChecks");
    });

    it("takes the widest phase rather than the sum of phases that never overlap", () => {
      const peak = computeParallelismPeak({
        maxRepositories: 2,
        maxWorktreeCreation: 4,
        maxWorktreeUpdates: 6,
        maxWorktreeRemoval: 5,
        maxStatusChecks: 9,
        maxBranchFetches: 7,
      });

      expect(peak.perRepository).toBe(9);
      expect(peak.total).toBe(18);
    });

    it("should accept a config that only exceeds the limit when phases are summed", async () => {
      const configPath = path.join(tempDir, "config.js");
      // Summed: 5 × (6 + 5 + 5 + 5) = 105 — over the old limit. Per phase:
      // 5 × 6 = 30, because creation, update, prune and status never overlap.
      const configContent = `
        export default {
          parallelism: {
            maxRepositories: 5,
            maxWorktreeCreation: 6,
            maxWorktreeUpdates: 5,
            maxWorktreeRemoval: 5,
            maxStatusChecks: 5
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
      expect(config.parallelism?.maxWorktreeCreation).toBe(6);
    });

    it("should name the widest phase and count status checks as git processes", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          parallelism: {
            maxRepositories: 6,
            maxStatusChecks: 20
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
        /Peak concurrent git processes \(120\) exceeds safe limit \(100\)/,
      );
      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(/maxStatusChecks: 20/);
      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(/Consider reducing maxRepositories/);
    });

    // Every branch fetch goes through the anchor worktree's one git client,
    // whose scheduler stops at 5 — measured: 40 concurrent fetches through one
    // cached client peak at 9 processes, never 40. Rejecting this config would
    // break a working setup over processes that cannot be spawned.
    it("should accept a maxBranchFetches the shared fetch client cannot reach", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          parallelism: {
            maxRepositories: 2,
            maxBranchFetches: 200
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
      expect(config.parallelism?.maxBranchFetches).toBe(200);
    });

    it("leaves the branch-fetch fallback out of the peak entirely", () => {
      const peak = computeParallelismPeak({ maxRepositories: 1, maxBranchFetches: 1000 });

      expect(peak.widestPhase.field).toBe("maxStatusChecks");
      expect(peak.total).toBe(DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS);
    });

    // `git worktree add` and `git worktree remove` both run on the bare
    // repository's single client, so these settings cannot reach their
    // configured width either.
    it("caps phases that share one git client at that client's concurrency", () => {
      const peak = computeParallelismPeak({
        maxRepositories: 1,
        maxWorktreeCreation: 50,
        maxWorktreeRemoval: 50,
        maxWorktreeUpdates: 1,
        maxStatusChecks: 1,
      });

      expect(peak.perRepository).toBe(SIMPLE_GIT_CLIENT_CONCURRENCY);
      expect(peak.total).toBe(SIMPLE_GIT_CLIENT_CONCURRENCY);
    });

    it("should accept per-client-capped phases that the raw numbers would reject", async () => {
      const configPath = path.join(tempDir, "config.js");
      // 20 × 50 = 1000 raw, but creation and removal top out at 5 apiece, so
      // the real widest phase is the 20 status checks: 20 × 20 = 400. Still
      // over the limit, and the message must name maxStatusChecks, not creation.
      const configContent = `
        export default {
          parallelism: {
            maxRepositories: 20,
            maxWorktreeCreation: 50,
            maxWorktreeRemoval: 50
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
        /widest phase \(status checks, maxStatusChecks: 20\) = 400 git processes/,
      );
    });

    // The phase advice has to solve for the phase at the *configured* number of
    // repositories: at 3 repositories, 100 status checks is still 300 processes.
    it("should size the phase advice against the configured maxRepositories", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          parallelism: {
            maxRepositories: 3,
            maxStatusChecks: 150
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
        /Even one repository exceeds the limit at maxStatusChecks: 150\./,
      );
      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        /With maxRepositories at 3, maxStatusChecks must be 33 or less/,
      );
    });

    it("should validate parallelism in defaults", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          defaults: {
            parallelism: {
              maxRepositories: 0
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

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "Invalid configuration for 'defaults parallelism.maxRepositories': must be a positive integer",
      );
    });

    // A repository entry may carry its own `parallelism` block -- the shipped
    // example config documents one -- and nothing validated it. The merged
    // number reaches `pLimit()` at the start of a sync phase, where p-limit
    // throws a TypeError mid-sync, after the fetch, on every run, while the
    // config file loads clean and `list` reports it as valid.
    it.each([
      { field: "maxStatusChecks", literal: "0", label: "zero" },
      { field: "maxStatusChecks", literal: "-1", label: "a negative" },
      { field: "maxStatusChecks", literal: "1.5", label: "a fraction" },
      { field: "maxStatusChecks", literal: "NaN", label: "NaN" },
      { field: "maxStatusChecks", literal: 'Number("not-a-number")', label: "a NaN from a bad env var" },
      { field: "maxStatusChecks", literal: '"50"', label: "a string" },
      { field: "maxStatusChecks", literal: "Infinity", label: "Infinity" },
      { field: "maxRepositories", literal: "0", label: "zero" },
      { field: "maxWorktreeCreation", literal: "0", label: "zero" },
      { field: "maxWorktreeUpdates", literal: "-2", label: "a negative" },
      { field: "maxWorktreeRemoval", literal: "2.5", label: "a fraction" },
      { field: "maxBranchFetches", literal: '"3"', label: "a string" },
    ])("should reject $label for repository-level parallelism.$field", async ({ field, literal }) => {
      const configPath = path.join(tempDir, `repo-parallelism-${field}-${literal}.config.js`);
      const configContent = `
        export default {
          repositories: [{
            name: "big",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees",
            parallelism: { ${field}: ${literal} }
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(ConfigValidationError);
      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        `Invalid configuration for 'Repository 'big' parallelism.${field}': must be a positive integer`,
      );
    });

    // The rule is p-limit's, so pin it to p-limit rather than to a list of
    // values someone believed it rejects. Infinity is the one deliberate
    // divergence: p-limit takes it as "unbounded", and an unbounded phase has
    // no peak to weigh against the safe-total limit.
    it("rejects the values p-limit itself refuses, and Infinity on purpose", async () => {
      for (const value of [0, -1, 1.5, Number.NaN, "50" as unknown as number]) {
        expect(() => pLimit(value)).toThrow("Expected `concurrency` to be a number from 1 and up");
      }
      expect(() => pLimit(Number.POSITIVE_INFINITY)).not.toThrow();

      const configPath = path.join(tempDir, "repo-parallelism-infinity.config.js");
      await fs.writeFile(
        configPath,
        `export default { repositories: [{ name: "big", repoUrl: "${TEST_URLS.github}", worktreeDir: "./w", parallelism: { maxStatusChecks: Infinity } }] };`,
      );

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "Invalid configuration for 'Repository 'big' parallelism.maxStatusChecks': must be a positive integer",
      );
    });

    it.each([{ literal: '"invalid"' }, { literal: "null" }, { literal: "42" }])(
      "should reject a repository-level parallelism that is not an object ($literal)",
      async ({ literal }) => {
        const configPath = path.join(tempDir, `repo-parallelism-shape-${literal}.config.js`);
        const configContent = `
        export default {
          repositories: [{
            name: "big",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees",
            parallelism: ${literal}
          }]
        };
      `;
        await fs.writeFile(configPath, configContent);

        await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
          "'parallelism' in Repository 'big' must be an object",
        );
      },
    );

    it("should still resolve a valid repository-level override over defaults and global", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          parallelism: { maxBranchFetches: 7 },
          defaults: { parallelism: { maxStatusChecks: 8, maxWorktreeUpdates: 9 } },
          repositories: [{
            name: "big",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees",
            parallelism: { maxStatusChecks: 12 }
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      const { repositories } = await configLoader.buildRepositories(configPath);

      expect(repositories[0].parallelism).toEqual({
        maxBranchFetches: 7,
        maxStatusChecks: 12,
        maxWorktreeUpdates: 9,
      });
    });
  });

  /**
   * The safe-total guard used to see one level at a time, each against the
   * built-in defaults for whatever it left out -- so a repository's own block,
   * which is merged over the global and `defaults` ones before it reaches
   * p-limit, was weighed against nothing.
   */
  describe("parallelism safe-total guard across merged levels", () => {
    const repoEntry = (name: string, parallelism?: string): string =>
      `{ name: "${name}", repoUrl: "https://github.com/test/${name}.git", worktreeDir: "./wt-${name}"` +
      `${parallelism ? `, parallelism: ${parallelism}` : ""} }`;

    const writeConfig = async (fileName: string, body: string): Promise<string> => {
      const configPath = path.join(tempDir, fileName);
      await fs.writeFile(configPath, `export default {${body}};`);
      return configPath;
    };

    it("rejects a repository override that pushes the run over the safe total", async () => {
      // Global alone is 3 x 20 = 60 and loads today; merged, the wide entry
      // runs 70 of its own beside two 20s.
      const configPath = await writeConfig(
        "over.config.js",
        `
          parallelism: { maxRepositories: 3, maxStatusChecks: 20 },
          repositories: [
            ${repoEntry("wide", "{ maxStatusChecks: 70 }")},
            ${repoEntry("narrow-a")},
            ${repoEntry("narrow-b")}
          ],
        `,
      );

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        /Peak concurrent git processes \(110\) exceeds safe limit \(100\)/,
      );
      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "the widest phase of each of the 3 repositories that can sync at once (maxRepositories: 3): " +
          "'wide' (status checks, maxStatusChecks: 70) + 'narrow-a' (status checks, maxStatusChecks: 20) + " +
          "'narrow-b' (status checks, maxStatusChecks: 20) = 110 git processes",
      );
      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        /Consider reducing maxRepositories or lowering maxStatusChecks\./,
      );
    });

    // Which repositories share the slots is scheduling, not file order, so the
    // worst case is the widest ones -- wherever they sit in the file.
    it("fills the slots with the widest repositories, not the first ones", async () => {
      const configPath = await writeConfig(
        "widest-in-slots.config.js",
        `
          parallelism: { maxRepositories: 2, maxStatusChecks: 20 },
          repositories: [
            ${repoEntry("narrow-a")},
            ${repoEntry("narrow-b")},
            ${repoEntry("wide", "{ maxStatusChecks: 90 }")}
          ],
        `,
      );

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        /Peak concurrent git processes \(110\) exceeds safe limit \(100\)/,
      );
      // Three repositories, two slots: the count in the message is the slots,
      // not the file's repository count, or it contradicts the number beside it.
      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "the widest phase of each of the 2 repositories that can sync at once (maxRepositories: 2): " +
          "'wide' (status checks, maxStatusChecks: 90) + 'narrow-a' (status checks, maxStatusChecks: 20) = 110",
      );
    });

    // The failure this guard was written for: a repository block and nothing
    // else, which is how the example config documents a per-repository override.
    it("weighs a repository override with no global or defaults block above it", async () => {
      const configPath = await writeConfig(
        "repo-only.config.js",
        `repositories: [${repoEntry("big", "{ maxStatusChecks: 101 }")}],`,
      );

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        /Peak concurrent git processes \(101\) exceeds safe limit \(100\)/,
      );
    });

    // A repository-level `maxRepositories` is validated as a positive integer,
    // but it bounds nothing: runMultipleRepositories reads the global or
    // `defaults` one and nothing else. Counting it here would reject a config
    // that runs three repositories two at a time perfectly safely.
    it("ignores a repository-level maxRepositories, which bounds nothing", async () => {
      const configPath = await writeConfig(
        "repo-max-repositories.config.js",
        `
          parallelism: { maxStatusChecks: 40 },
          repositories: [
            ${repoEntry("a", "{ maxRepositories: 50 }")},
            ${repoEntry("b")},
            ${repoEntry("c")}
          ],
        `,
      );

      const { repositories } = await configLoader.buildRepositories(configPath);

      expect(repositories).toHaveLength(3);
      expect(repositories[0].parallelism?.maxRepositories).toBe(50);
    });

    // One repository can exceed the ceiling by itself, and then the count in
    // the message is the repositories there are, not the slots there are.
    it("rejects a single repository that exceeds the ceiling on its own", async () => {
      const configPath = await writeConfig(
        "single-over.config.js",
        `
          parallelism: { maxRepositories: 5 },
          repositories: [${repoEntry("only", "{ maxStatusChecks: 101 }")}],
        `,
      );

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "the widest phase of each of the 1 repository that can sync at once (maxRepositories: 5): " +
          "'only' (status checks, maxStatusChecks: 101) = 101 git processes",
      );
    });

    // runMultipleRepositories reads maxRepositories global-first, unlike every
    // other setting, where `defaults` wins. The guard has to read it the same
    // way or it weighs a width the run will never reach: here only one
    // repository ever syncs at a time, so the peak is 25, not 5 x 25.
    it("reads maxRepositories global-first, the way the runner does", async () => {
      const configPath = await writeConfig(
        "max-repos-precedence.config.js",
        `
          parallelism: { maxRepositories: 1, maxStatusChecks: 25 },
          defaults: { parallelism: { maxRepositories: 5 } },
          repositories: [
            ${repoEntry("a")}, ${repoEntry("b")}, ${repoEntry("c")}, ${repoEntry("d")}, ${repoEntry("e")}
          ],
        `,
      );

      const { repositories } = await configLoader.buildRepositories(configPath);

      expect(repositories).toHaveLength(5);
      expect(repositories[0].parallelism?.maxStatusChecks).toBe(25);
    });

    // The peak is the sum of the repositories that can sync at once, not
    // maxRepositories x the single widest one: one wide repository beside
    // narrow ones never runs its width three times over, and rejecting it
    // would fail a setup that works today.
    it("accepts a wide repository whose slot-mates are narrow", async () => {
      const configPath = await writeConfig(
        "wide-beside-narrow.config.js",
        `
          parallelism: { maxRepositories: 3, maxStatusChecks: 20 },
          repositories: [
            ${repoEntry("wide", "{ maxStatusChecks: 50 }")},
            ${repoEntry("narrow-a")},
            ${repoEntry("narrow-b")}
          ],
        `,
      );

      const { repositories } = await configLoader.buildRepositories(configPath);

      expect(repositories.map((repo) => repo.parallelism?.maxStatusChecks)).toEqual([50, 20, 20]);
    });

    // Only as many repositories as exist can occupy the slots.
    it("counts at most as many repositories as the file defines", async () => {
      const configPath = await writeConfig(
        "one-repo.config.js",
        `
          parallelism: { maxRepositories: 5, maxStatusChecks: 20 },
          repositories: [${repoEntry("only", "{ maxStatusChecks: 90 }")}],
        `,
      );

      const config = await configLoader.loadConfigFile(configPath);

      expect(config.repositories[0].parallelism?.maxStatusChecks).toBe(90);
    });

    // Neither level is over the limit on its own -- 5 x 20 = 100 and 2 x 21 =
    // 42 -- but `defaults` overrides the global block for every repository, so
    // the run really peaks at 5 x 21.
    it("weighs the global and defaults blocks against each other", async () => {
      const configPath = await writeConfig(
        "global-plus-defaults.config.js",
        `
          parallelism: { maxRepositories: 5 },
          defaults: { parallelism: { maxStatusChecks: 21 } },
          repositories: [
            ${repoEntry("a")}, ${repoEntry("b")}, ${repoEntry("c")}, ${repoEntry("d")}, ${repoEntry("e")}
          ],
        `,
      );

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        /Peak concurrent git processes \(105\) exceeds safe limit \(100\)/,
      );
      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(/maxRepositories: 5/);
    });

    // Without per-repository overrides the sum is exactly maxRepositories x the
    // widest phase, so a config that loads today keeps loading: 2 x 50 = 100 is
    // at the limit, not over it, however many repositories the file lists.
    it("gives a config without overrides the same verdict as the per-level check", async () => {
      const configPath = await writeConfig(
        "no-overrides.config.js",
        `
          parallelism: { maxRepositories: 2, maxStatusChecks: 50 },
          repositories: [${repoEntry("a")}, ${repoEntry("b")}, ${repoEntry("c")}, ${repoEntry("d")}],
        `,
      );

      const config = await configLoader.loadConfigFile(configPath);

      expect(config.parallelism?.maxStatusChecks).toBe(50);
    });

    it("lists the widest slot-mates and sums the rest", async () => {
      const wide = (name: string): string => repoEntry(name, "{ maxStatusChecks: 25 }");
      const configPath = await writeConfig(
        "breakdown.config.js",
        `
          parallelism: { maxRepositories: 5, maxStatusChecks: 20 },
          repositories: [${wide("a")}, ${wide("b")}, ${wide("c")}, ${wide("d")}, ${wide("e")}],
        `,
      );

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(/\+ 2 more = 125 git processes/);
    });

    // A repository that overrides nothing runs the global block's widths, not
    // the built-in defaults. Every case above happens to set the global
    // maxStatusChecks to 20, which is also the built-in default, so dropping the
    // global layer from the merge changes none of their numbers. Here it does:
    // 51 + 50 is over, 51 + the built-in 20 would not be.
    it("counts the global block for a repository that overrides nothing", async () => {
      const configPath = await writeConfig(
        "global-inherited.config.js",
        `
          parallelism: { maxRepositories: 2, maxStatusChecks: 50 },
          repositories: [${repoEntry("a", "{ maxStatusChecks: 51 }")}, ${repoEntry("b")}],
        `,
      );

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "'a' (status checks, maxStatusChecks: 51) + 'b' (status checks, maxStatusChecks: 50) = 101 git processes",
      );
    });

    // The closing advice names the setting worth lowering, which is the widest
    // repository's phase and not the narrowest's. They are the same field
    // wherever every entry peaks on maxStatusChecks; here they are not.
    it("names the widest repository's phase in the advice, not a slot-mate's", async () => {
      const configPath = await writeConfig(
        "advice-field.config.js",
        `
          parallelism: { maxRepositories: 2 },
          repositories: [${repoEntry("updates-heavy", "{ maxWorktreeUpdates: 90 }")}, ${repoEntry("plain")}],
        `,
      );

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "'updates-heavy' (worktree updates, maxWorktreeUpdates: 90) + 'plain' (status checks, maxStatusChecks: 20) = " +
          "110 git processes. Consider reducing maxRepositories or lowering maxWorktreeUpdates.",
      );
    });

    // The per-level check still runs on `defaults`, and the merged guard is not
    // it in disguise: the per-level one weighs maxRepositories against the
    // built-in defaults however many repositories the file lists, so one
    // repository is enough for it to fire where the merged guard — one slot, 50
    // processes — sees nothing to complain about.
    it("still weighs a defaults block on its own, with its own message", async () => {
      const configPath = await writeConfig(
        "defaults-alone.config.js",
        `
          defaults: { parallelism: { maxRepositories: 5, maxStatusChecks: 50 } },
          repositories: [${repoEntry("only")}],
        `,
      );

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "Peak concurrent git processes (250) exceeds safe limit (100). Sync phases run one after another, so the " +
          "peak is 5 repositories × the widest phase (status checks, maxStatusChecks: 50) = 250 git processes.",
      );
    });
  });

  describe("resolveRepositoryConfig - parallelism", () => {
    it("should merge parallelism configs correctly", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
        parallelism: { maxWorktreeCreation: 2 },
      };

      const defaults = {
        parallelism: { maxWorktreeUpdates: 5 },
      };

      const resolved = configLoader.resolveRepositoryConfig(repo, defaults, tempDir);

      expect(resolved.parallelism).toEqual({
        maxWorktreeCreation: 2,
        maxWorktreeUpdates: 5,
      });
    });

    // The placement the example config and README show. It used to be dropped
    // on the floor: only defaults.parallelism and repo.parallelism were merged,
    // so a top-level block silently left every per-repo limit at its default.
    it("should apply a top-level parallelism block to every repository", async () => {
      const configPath = path.join(tempDir, "toplevel.config.js");
      await fs.writeFile(
        configPath,
        `export default {
          parallelism: { maxStatusChecks: 4 },
          repositories: [
            { name: "one", repoUrl: "${TEST_URLS.github}", worktreeDir: "./w1" },
            { name: "two", repoUrl: "${TEST_URLS.github}", worktreeDir: "./w2" }
          ]
        };`,
      );

      const { repositories } = await configLoader.buildRepositories(configPath);

      expect(repositories.map((repo) => repo.parallelism?.maxStatusChecks)).toEqual([4, 4]);
    });

    it("should let defaults and a repository override the top-level block", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
        parallelism: { maxStatusChecks: 3 },
      };

      const resolved = configLoader.resolveRepositoryConfig(
        repo,
        { parallelism: { maxStatusChecks: 6, maxWorktreeUpdates: 9 } },
        tempDir,
        undefined,
        undefined,
        { maxStatusChecks: 12, maxWorktreeUpdates: 12, maxWorktreeRemoval: 7 },
      );

      expect(resolved.parallelism).toEqual({
        maxStatusChecks: 3,
        maxWorktreeUpdates: 9,
        maxWorktreeRemoval: 7,
      });
    });

    it("should handle no parallelism config", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const resolved = configLoader.resolveRepositoryConfig(repo);

      expect(resolved.parallelism).toBeUndefined();
    });

    it("should prioritize repo parallelism over defaults", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
        parallelism: {
          maxWorktreeCreation: 3,
          maxWorktreeUpdates: 6,
        },
      };

      const defaults = {
        parallelism: {
          maxWorktreeCreation: 1,
          maxWorktreeUpdates: 3,
          maxStatusChecks: 10,
        },
      };

      const resolved = configLoader.resolveRepositoryConfig(repo, defaults, tempDir);

      expect(resolved.parallelism).toEqual({
        maxWorktreeCreation: 3,
        maxWorktreeUpdates: 6,
        maxStatusChecks: 10,
      });
    });
  });

  describe("hooks configuration validation", () => {
    it("should accept valid hooks configuration in repository", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees",
            hooks: {
              onBranchCreated: ["echo hello", "code {WORKTREE_PATH}"]
            }
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      const config = await configLoader.loadConfigFile(configPath);

      expect(config.repositories[0].hooks?.onBranchCreated).toEqual(["echo hello", "code {WORKTREE_PATH}"]);
    });

    it("should accept valid hooks configuration in defaults", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          defaults: {
            hooks: {
              onBranchCreated: ["echo default hook"]
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

      expect(config.defaults?.hooks?.onBranchCreated).toEqual(["echo default hook"]);
    });

    it("should accept empty hooks object", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees",
            hooks: {}
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      const config = await configLoader.loadConfigFile(configPath);

      expect(config.repositories[0].hooks).toEqual({});
    });

    it("should accept empty onBranchCreated array", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees",
            hooks: {
              onBranchCreated: []
            }
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      const config = await configLoader.loadConfigFile(configPath);

      expect(config.repositories[0].hooks?.onBranchCreated).toEqual([]);
    });

    it("should reject non-object hooks in repository", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees",
            hooks: "invalid"
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "'hooks' in Repository 'test-repo' must be an object",
      );
    });

    it("should reject non-object hooks in defaults", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          defaults: {
            hooks: "invalid"
          },
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees"
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow("'hooks' in defaults must be an object");
    });

    it("should reject non-array onBranchCreated", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees",
            hooks: {
              onBranchCreated: "single command"
            }
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "'hooks.onBranchCreated' in Repository 'test-repo' must be an array",
      );
    });

    it("should reject non-string command in onBranchCreated", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees",
            hooks: {
              onBranchCreated: ["valid", 123]
            }
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "'hooks.onBranchCreated' in Repository 'test-repo' must contain only non-empty strings (invalid at index 1)",
      );
    });

    it("should reject empty string command in onBranchCreated", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees",
            hooks: {
              onBranchCreated: ["valid", ""]
            }
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "'hooks.onBranchCreated' in Repository 'test-repo' must contain only non-empty strings (invalid at index 1)",
      );
    });

    it("should reject whitespace-only command in onBranchCreated", async () => {
      const configPath = path.join(tempDir, "config.js");
      const configContent = `
        export default {
          repositories: [{
            name: "test-repo",
            repoUrl: "${TEST_URLS.github}",
            worktreeDir: "./worktrees",
            hooks: {
              onBranchCreated: ["valid", "   "]
            }
          }]
        };
      `;
      await fs.writeFile(configPath, configContent);

      await expect(configLoader.loadConfigFile(configPath)).rejects.toThrow(
        "'hooks.onBranchCreated' in Repository 'test-repo' must contain only non-empty strings (invalid at index 1)",
      );
    });
  });

  describe("resolveRepositoryConfig - hooks", () => {
    it("should use defaults hooks when repo has none", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const defaults = {
        hooks: { onBranchCreated: ["default-command"] },
      };

      const resolved = configLoader.resolveRepositoryConfig(repo, defaults, tempDir);

      expect(resolved.hooks?.onBranchCreated).toEqual(["default-command"]);
    });

    it("should override defaults hooks with repo hooks", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
        hooks: { onBranchCreated: ["repo-command"] },
      };

      const defaults = {
        hooks: { onBranchCreated: ["default-command"] },
      };

      const resolved = configLoader.resolveRepositoryConfig(repo, defaults, tempDir);

      expect(resolved.hooks?.onBranchCreated).toEqual(["repo-command"]);
    });

    it("should keep filesToCopyOnBranchCreate patterns relative", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
        filesToCopyOnBranchCreate: [".env.local", "./configs/settings.json"],
      };

      const resolved = configLoader.resolveRepositoryConfig(repo, {}, "/base/dir");

      expect(resolved.filesToCopyOnBranchCreate).toEqual([".env.local", "./configs/settings.json"]);
    });

    it("should leave unsafe filesToCopyOnBranchCreate patterns for copy-time rejection", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
        filesToCopyOnBranchCreate: ["/absolute/.env.local"],
      };

      const resolved = configLoader.resolveRepositoryConfig(repo, {}, "/base/dir");

      expect(resolved.filesToCopyOnBranchCreate).toEqual(["/absolute/.env.local"]);
    });

    it("rejects worktree-mode bareRepoDir inside worktreeDir", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
        bareRepoDir: "./worktrees/repo-bare",
      };

      expect(() => configLoader.resolveRepositoryConfig(repo, {}, "/base/dir")).toThrow(/bareRepoDir\/worktreeDir/);
    });

    it("rejects worktree-mode worktreeDir inside bareRepoDir", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./repo-bare/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
        bareRepoDir: "./repo-bare",
      };

      expect(() => configLoader.resolveRepositoryConfig(repo, {}, "/base/dir")).toThrow(/bareRepoDir\/worktreeDir/);
    });

    it("derives bareRepoDir from an absolute local repoUrl", async () => {
      const configPath = path.join(tempDir, "local-path.config.js");
      await fs.writeFile(
        configPath,
        `
          export default {
            repositories: [{
              name: "local",
              repoUrl: "/srv/git/repo.git",
              worktreeDir: "./worktrees"
            }]
          };
        `,
      );

      const { repositories } = await configLoader.buildRepositories(configPath);

      expect(repositories[0].bareRepoDir).toBe(path.join(tempDir, ".bare", "repo"));
    });

    it("should not set hooks when neither repo nor defaults have hooks", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const resolved = configLoader.resolveRepositoryConfig(repo);

      expect(resolved.hooks).toBeUndefined();
    });

    it("should merge hooks object with repo overriding defaults", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
        hooks: { onBranchCreated: ["repo-only-command"] },
      };

      const defaults = {
        hooks: { onBranchCreated: ["default-only-command"] },
      };

      const resolved = configLoader.resolveRepositoryConfig(repo, defaults, tempDir);

      expect(resolved.hooks).toEqual({
        onBranchCreated: ["repo-only-command"],
      });
    });
  });

  describe("resolveRepositoryConfig - branchInclude/branchExclude", () => {
    it("should resolve branchInclude from repo config", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
        branchInclude: ["feature/*", "main"],
      };

      const resolved = configLoader.resolveRepositoryConfig(repo);
      expect(resolved.branchInclude).toEqual(["feature/*", "main"]);
    });

    it("should resolve branchExclude from defaults", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const defaults = {
        branchExclude: ["wip-*", "tmp-*"],
      };

      const resolved = configLoader.resolveRepositoryConfig(repo, defaults);
      expect(resolved.branchExclude).toEqual(["wip-*", "tmp-*"]);
    });

    it("should prefer repo-level branchInclude over defaults", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
        branchInclude: ["release-*"],
      };

      const defaults = {
        branchInclude: ["feature/*"],
      };

      const resolved = configLoader.resolveRepositoryConfig(repo, defaults);
      expect(resolved.branchInclude).toEqual(["release-*"]);
    });

    it("should leave branchInclude/branchExclude undefined when not set", () => {
      const repo = {
        name: "test",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "./worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };

      const resolved = configLoader.resolveRepositoryConfig(repo);
      expect(resolved.branchInclude).toBeUndefined();
      expect(resolved.branchExclude).toBeUndefined();
    });
  });

  describe("findConfigUpward", () => {
    it("returns null when no config exists in path or any parent", async () => {
      const startDir = path.join(tempDir, "deep", "nested");
      await fs.mkdir(startDir, { recursive: true });

      const result = await configLoader.findConfigUpward(startDir);
      expect(result).toBeNull();
    });

    it("finds config file in same directory", async () => {
      const configPath = path.join(tempDir, "sync-worktrees.config.js");
      await fs.writeFile(configPath, "export default { repositories: [] };", "utf-8");

      const result = await configLoader.findConfigUpward(tempDir);
      expect(result).toBe(configPath);
    });

    it("finds config file in parent directory", async () => {
      const configPath = path.join(tempDir, "sync-worktrees.config.js");
      await fs.writeFile(configPath, "export default { repositories: [] };", "utf-8");
      const childDir = path.join(tempDir, "child", "grandchild");
      await fs.mkdir(childDir, { recursive: true });

      const result = await configLoader.findConfigUpward(childDir);
      expect(result).toBe(configPath);
    });

    it("matches all supported extensions (.js, .mjs, .cjs)", async () => {
      for (const ext of ["js", "mjs", "cjs"]) {
        const dir = await createTempDirectory(`config-ext-${ext}-`);
        const configPath = path.join(dir, `sync-worktrees.config.${ext}`);
        await fs.writeFile(configPath, "// fake", "utf-8");

        const result = await configLoader.findConfigUpward(dir);
        expect(result).toBe(configPath);
      }
    });
  });

  describe("sparseCheckout validation", () => {
    async function loadInline(content: string): Promise<unknown> {
      const configPath = path.join(tempDir, "test.config.js");
      await fs.writeFile(configPath, content, "utf-8");
      return configLoader.loadConfigFile(configPath);
    }

    it("rejects sparseCheckout missing include", async () => {
      const c = `export default { repositories: [{ name: "r", repoUrl: "${TEST_URLS.github}", worktreeDir: "/w", sparseCheckout: { exclude: ["docs"] } }] };`;
      await expect(loadInline(c)).rejects.toThrow(/'sparseCheckout.include'.*must be an array/);
    });

    it("rejects empty include array", async () => {
      const c = `export default { repositories: [{ name: "r", repoUrl: "${TEST_URLS.github}", worktreeDir: "/w", sparseCheckout: { include: [] } }] };`;
      await expect(loadInline(c)).rejects.toThrow(/at least one pattern/);
    });

    it("rejects bad mode", async () => {
      const c = `export default { repositories: [{ name: "r", repoUrl: "${TEST_URLS.github}", worktreeDir: "/w", sparseCheckout: { include: ["a"], mode: "weird" } }] };`;
      await expect(loadInline(c)).rejects.toThrow(/must be 'cone' or 'no-cone'/);
    });

    it("rejects empty include strings", async () => {
      const c = `export default { repositories: [{ name: "r", repoUrl: "${TEST_URLS.github}", worktreeDir: "/w", sparseCheckout: { include: ["a", ""] } }] };`;
      await expect(loadInline(c)).rejects.toThrow(/non-empty strings/);
    });

    it("accepts valid cone config", async () => {
      const c = `export default { repositories: [{ name: "r", repoUrl: "${TEST_URLS.github}", worktreeDir: "/w", sparseCheckout: { include: ["apps", "packages"] } }] };`;
      await expect(loadInline(c)).resolves.toBeDefined();
    });

    it("accepts valid no-cone config with excludes", async () => {
      const c = `export default { repositories: [{ name: "r", repoUrl: "${TEST_URLS.github}", worktreeDir: "/w", sparseCheckout: { include: ["/*"], exclude: ["docs"], mode: "no-cone" } }] };`;
      await expect(loadInline(c)).resolves.toBeDefined();
    });

    it("validates sparseCheckout in defaults", async () => {
      const c = `export default { defaults: { sparseCheckout: { include: [] } }, repositories: [{ name: "r", repoUrl: "${TEST_URLS.github}", worktreeDir: "/w" }] };`;
      await expect(loadInline(c)).rejects.toThrow(/at least one pattern/);
    });
  });

  describe("resolveRepositoryConfig - sparseCheckout merge", () => {
    it("uses repo sparseCheckout over defaults", () => {
      const repo = {
        name: "r",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "/w",
        cronSchedule: "0 * * * *",
        runOnce: false,
        sparseCheckout: { include: ["apps"] },
      };
      const defaults = { sparseCheckout: { include: ["packages"] } };
      const resolved = configLoader.resolveRepositoryConfig(repo, defaults);
      expect(resolved.sparseCheckout).toEqual({ include: ["apps"] });
    });

    it("falls back to defaults sparseCheckout", () => {
      const repo = {
        name: "r",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "/w",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };
      const defaults = { sparseCheckout: { include: ["packages"] } };
      const resolved = configLoader.resolveRepositoryConfig(repo, defaults);
      expect(resolved.sparseCheckout).toEqual({ include: ["packages"] });
    });

    it("leaves sparseCheckout undefined when neither set", () => {
      const repo = {
        name: "r",
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "/w",
        cronSchedule: "0 * * * *",
        runOnce: false,
      };
      const resolved = configLoader.resolveRepositoryConfig(repo);
      expect(resolved.sparseCheckout).toBeUndefined();
    });
  });

  describe("resolveRepositoryConfig - asymmetric bareRepoDir for duplicate repoUrl", () => {
    const monorepoUrl = "https://github.com/acme/monorepo.git";

    function makeRepo(name: string, overrides: Record<string, unknown> = {}) {
      return {
        name,
        repoUrl: monorepoUrl,
        worktreeDir: `/wt/${name}`,
        cronSchedule: "0 * * * *",
        runOnce: false,
        ...overrides,
      };
    }

    it("first entry uses URL-derived bareRepoDir", () => {
      const all = [makeRepo("first"), makeRepo("second")];
      const resolved = configLoader.resolveRepositoryConfig(all[0], undefined, "/cfg", undefined, all);
      expect(resolved.bareRepoDir).toBe("/cfg/.bare/monorepo");
    });

    it("second duplicate entry uses name-derived bareRepoDir", () => {
      const all = [makeRepo("first"), makeRepo("second-name")];
      const resolved = configLoader.resolveRepositoryConfig(all[1], undefined, "/cfg", undefined, all);
      expect(resolved.bareRepoDir).toBe("/cfg/.bare/second-name");
    });

    it("explicit bareRepoDir always wins", () => {
      const all = [
        makeRepo("first", { bareRepoDir: "/explicit/first" }),
        makeRepo("second", { bareRepoDir: "/explicit/second" }),
      ];
      const r1 = configLoader.resolveRepositoryConfig(all[0], undefined, "/cfg", undefined, all);
      const r2 = configLoader.resolveRepositoryConfig(all[1], undefined, "/cfg", undefined, all);
      expect(r1.bareRepoDir).toBe("/explicit/first");
      expect(r2.bareRepoDir).toBe("/explicit/second");
    });

    it("non-duplicate entry keeps URL-derived default", () => {
      const repos = [
        makeRepo("a"),
        {
          name: "b",
          repoUrl: "https://github.com/other/repo.git",
          worktreeDir: "/wt/b",
          cronSchedule: "0 * * * *",
          runOnce: false,
        },
      ];
      const r2 = configLoader.resolveRepositoryConfig(repos[1], undefined, "/cfg", undefined, repos);
      expect(r2.bareRepoDir).toBe("/cfg/.bare/repo");
    });

    it("sanitizes name with slashes for path", () => {
      const all = [makeRepo("first"), makeRepo("group/sub-name")];
      const resolved = configLoader.resolveRepositoryConfig(all[1], undefined, "/cfg", undefined, all);
      expect(resolved.bareRepoDir).toBe("/cfg/.bare/group-sub-name");
    });

    it("rejects name that sanitizes to empty", () => {
      const all = [makeRepo("first"), makeRepo("...")];
      expect(() => configLoader.resolveRepositoryConfig(all[1], undefined, "/cfg", undefined, all)).toThrow(
        /empty path segment/,
      );
    });

    it("rejects Windows-reserved name", () => {
      const all = [makeRepo("first"), makeRepo("CON")];
      expect(() => configLoader.resolveRepositoryConfig(all[1], undefined, "/cfg", undefined, all)).toThrow(
        /reserved name/,
      );
    });
  });

  describe("resolveRepositoryConfig - __configuredRepoDirs", () => {
    function makeRepo(name: string, overrides: Record<string, unknown> = {}) {
      return {
        name,
        repoUrl: `https://github.com/acme/${name}.git`,
        worktreeDir: name,
        cronSchedule: "0 * * * *",
        runOnce: false,
        ...overrides,
      };
    }

    it("carries every entry's resolved worktreeDir and bareRepoDir, its own first", () => {
      const all = [
        makeRepo("api", { mode: "clone" }),
        makeRepo("web", { mode: "clone" }),
        makeRepo("trees", { mode: "worktree" }),
      ];

      const resolved = configLoader.resolveRepositoryConfig(all[1], undefined, "/cfg", undefined, all);

      expect(resolved.__configuredRepoDirs).toEqual(["/cfg/web", "/cfg/api", "/cfg/trees", "/cfg/.bare/trees"]);
    });

    it("resolves a relative worktreeDir against the config directory and keeps an absolute one", () => {
      const all = [
        makeRepo("api", { mode: "clone", worktreeDir: "./checkouts/api" }),
        makeRepo("web", { mode: "clone", worktreeDir: "/elsewhere/web" }),
      ];

      const resolved = configLoader.resolveRepositoryConfig(all[0], undefined, "/cfg", undefined, all);

      expect(resolved.__configuredRepoDirs).toEqual(["/cfg/checkouts/api", "/elsewhere/web"]);
    });

    it("falls back to the entry's own directories when the repository list is not supplied", () => {
      const resolved = configLoader.resolveRepositoryConfig(makeRepo("api", { mode: "clone" }), undefined, "/cfg");

      expect(resolved.__configuredRepoDirs).toEqual(["/cfg/api"]);
    });

    it("skips a sibling whose own name cannot be made into a path segment", () => {
      const url = "https://github.com/acme/monorepo.git";
      const all = [
        makeRepo("first", { repoUrl: url }),
        makeRepo("...", { repoUrl: url, worktreeDir: "broken" }),
        makeRepo("third", { repoUrl: url, worktreeDir: "third" }),
      ];

      // 'first' still resolves; the unusable name only fails when it is that
      // entry's turn.
      const resolved = configLoader.resolveRepositoryConfig(all[0], undefined, "/cfg", undefined, all);

      // '/cfg/broken' is absent: only the entry that cannot be resolved is left out.
      expect(resolved.__configuredRepoDirs).toEqual([
        "/cfg/first",
        "/cfg/.bare/monorepo",
        "/cfg/third",
        "/cfg/.bare/third",
      ]);
      expect(() => configLoader.resolveRepositoryConfig(all[1], undefined, "/cfg", undefined, all)).toThrow(
        /empty path segment/,
      );
    });
  });

  describe("detectPathCollisions", () => {
    const originalPlatform = process.platform;

    function setPlatform(platform: NodeJS.Platform): void {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    }

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    });

    function makeEntry(name: string, overrides: Partial<RepositoryConfig> & { worktreeDir: string }): RepositoryConfig {
      return {
        name,
        repoUrl: `https://github.com/x/${name}.git`,
        cronSchedule: "0 * * * *",
        runOnce: false,
        mode: "worktree",
        ...overrides,
      };
    }

    it("throws naming both repos when two worktree-mode repos share a worktreeDir", () => {
      const repos = [
        makeEntry("first", { worktreeDir: "/w/shared", bareRepoDir: "/b/first" }),
        makeEntry("second", { worktreeDir: "/w/shared", bareRepoDir: "/b/second" }),
      ];
      expect(() => configLoader.detectPathCollisions(repos)).toThrow(ConfigValidationError);
      expect(() => configLoader.detectPathCollisions(repos)).toThrow(/'first' and 'second'.*same worktreeDir/);
      expect(() => configLoader.detectPathCollisions(repos)).toThrow(path.resolve("/w/shared"));
    });

    it("throws when a clone-mode and a worktree-mode repo share a worktreeDir", () => {
      const repos = [
        makeEntry("checkout", { worktreeDir: "/w/shared", mode: "clone" }),
        makeEntry("trees", { worktreeDir: "/w/shared", bareRepoDir: "/b/trees" }),
      ];
      expect(() => configLoader.detectPathCollisions(repos)).toThrow(ConfigValidationError);
      expect(() => configLoader.detectPathCollisions(repos)).toThrow(/'checkout' and 'trees'.*same worktreeDir/);
    });

    it.each([
      ["equal", "/x", "/x"],
      ["bareRepoDir inside worktreeDir", "/x", "/x/inner"],
      ["worktreeDir inside bareRepoDir", "/x/inner", "/x"],
    ])(
      "throws when one repo's worktreeDir and another's bareRepoDir overlap (%s)",
      (_label, worktreeDir, bareRepoDir) => {
        const repos = [
          makeEntry("trees", { worktreeDir, bareRepoDir: "/elsewhere/trees" }),
          makeEntry("bare", { worktreeDir: "/elsewhere/bare-trees", bareRepoDir }),
        ];
        expect(() => configLoader.detectPathCollisions(repos)).toThrow(ConfigValidationError);
        expect(() => configLoader.detectPathCollisions(repos)).toThrow(/'trees' and 'bare'.*must not overlap/);
        // Order of entries must not matter.
        expect(() => configLoader.detectPathCollisions([...repos].reverse())).toThrow(
          /'trees' and 'bare'.*must not overlap/,
        );
      },
    );

    it("does not throw for distinct directories", () => {
      const repos = [
        makeEntry("a", { worktreeDir: "/w/a", bareRepoDir: "/b/a" }),
        makeEntry("b", { worktreeDir: "/w/b", bareRepoDir: "/b/b" }),
        makeEntry("c", { worktreeDir: "/w/c", mode: "clone" }),
      ];
      expect(() => configLoader.detectPathCollisions(repos)).not.toThrow();
    });

    it("does not treat a sibling that shares a string prefix as overlapping or nested", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const repos = [
        makeEntry("x", { worktreeDir: "/w/x", bareRepoDir: "/b/x" }),
        makeEntry("xy", { worktreeDir: "/w/xy", bareRepoDir: "/w/x-bare" }),
      ];
      expect(() => configLoader.detectPathCollisions(repos)).not.toThrow();
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("treats case-only differences as distinct directories on linux", () => {
      setPlatform("linux");
      const repos = [
        makeEntry("a", { worktreeDir: "/Work/Trees", bareRepoDir: "/Bare/A" }),
        makeEntry("b", { worktreeDir: "/work/trees", bareRepoDir: "/bare/a" }),
      ];
      expect(() => configLoader.detectPathCollisions(repos)).not.toThrow();
    });

    it("treats case-only worktreeDir duplicates as a collision on darwin", () => {
      setPlatform("darwin");
      const repos = [
        makeEntry("a", { worktreeDir: "/Work/Trees", bareRepoDir: "/bare/a" }),
        makeEntry("b", { worktreeDir: "/work/trees", bareRepoDir: "/bare/b" }),
      ];
      expect(() => configLoader.detectPathCollisions(repos)).toThrow(/'a' and 'b'.*same worktreeDir/);
    });

    it("warns without throwing when one worktreeDir is nested inside another", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const repos = [
        makeEntry("outer", { worktreeDir: "/w", bareRepoDir: "/b/outer" }),
        makeEntry("inner", { worktreeDir: "/w/sub", bareRepoDir: "/b/inner" }),
      ];
      expect(() => configLoader.detectPathCollisions(repos)).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain("'inner'");
      expect(message).toContain("'outer'");
      expect(message).toMatch(/is inside worktreeDir/);
      warn.mockRestore();
    });

    it("throws when two repos resolve to same bareRepoDir", () => {
      const repos = [
        makeEntry("a", { worktreeDir: "/w/a", bareRepoDir: "/shared/.bare/x" }),
        makeEntry("b", { worktreeDir: "/w/b", bareRepoDir: "/shared/.bare/x" }),
      ];
      expect(() => configLoader.detectPathCollisions(repos)).toThrow(ConfigValidationError);
      expect(() => configLoader.detectPathCollisions(repos)).toThrow(/'a' and 'b'.*same bareRepoDir/);
    });

    it("does not throw when bareRepoDirs differ", () => {
      const repos = [
        makeEntry("a", { worktreeDir: "/w/a", bareRepoDir: "/a/.bare" }),
        makeEntry("b", { worktreeDir: "/w/b", bareRepoDir: "/b/.bare" }),
      ];
      expect(() => configLoader.detectPathCollisions(repos)).not.toThrow();
    });

    it("detects bareRepoDir collision across case-only differences on darwin", () => {
      setPlatform("darwin");
      const repos = [
        makeEntry("a", { worktreeDir: "/w/a", bareRepoDir: "/Users/Me/.bare/x" }),
        makeEntry("b", { worktreeDir: "/w/b", bareRepoDir: "/users/me/.bare/x" }),
      ];
      expect(() => configLoader.detectPathCollisions(repos)).toThrow(/same bareRepoDir/);
    });
  });

  describe("buildRepositories path collisions", () => {
    async function writeSharedWorktreeDirConfig(): Promise<string> {
      const configPath = path.join(tempDir, "shared.config.js");
      await fs.writeFile(
        configPath,
        `export default {
          repositories: [
            { name: "first", repoUrl: "${TEST_URLS.github}", worktreeDir: "./shared", bareRepoDir: "./.bare/first" },
            { name: "second", repoUrl: "${TEST_URLS.gitlab}", worktreeDir: "./shared", bareRepoDir: "./.bare/second" }
          ]
        };`,
      );
      return configPath;
    }

    it("rejects a config whose entries share a worktreeDir", async () => {
      const configPath = await writeSharedWorktreeDirConfig();
      await expect(configLoader.buildRepositories(configPath)).rejects.toThrow(ConfigValidationError);
      await expect(configLoader.buildRepositories(configPath)).rejects.toThrow(
        /'first' and 'second'.*same worktreeDir/,
      );
      await expect(configLoader.buildRepositories(configPath)).rejects.toThrow(path.join(tempDir, "shared"));
    });

    it("rejects the collision even when --filter would select only one of the entries", async () => {
      const configPath = await writeSharedWorktreeDirConfig();
      await expect(configLoader.buildRepositories(configPath, { filter: "first" })).rejects.toThrow(
        /'first' and 'second'.*same worktreeDir/,
      );
    });
  });
});

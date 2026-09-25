import { execSync, spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const shouldSkip = process.env.SKIP_E2E_TESTS === "true";

const describeOrSkip = shouldSkip ? describe.skip : describe;

describeOrSkip("Config file loading E2E tests", () => {
  const cliPath = path.join(process.cwd(), "dist", "index.js");
  const tmpBase = path.join(process.cwd(), "tmp-e2e-config-test");

  beforeAll(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  afterAll(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it("should load and list repositories from config file", async () => {
    const configPath = path.join(tmpBase, "test.config.js");
    await fs.mkdir(tmpBase, { recursive: true });

    const configContent = `
export default {
  defaults: {
    cronSchedule: "0 * * * *",
    runOnce: true
  },
  repositories: [
    {
      name: "test-repo-1",
      repoUrl: "https://github.com/octocat/Hello-World.git",
      worktreeDir: "${path.join(tmpBase, "worktrees-1").replace(/\\/g, "/")}",
      bareRepoDir: "${path.join(tmpBase, "bare-1").replace(/\\/g, "/")}"
    },
    {
      name: "test-repo-2",
      repoUrl: "https://github.com/github/gitignore.git",
      worktreeDir: "${path.join(tmpBase, "worktrees-2").replace(/\\/g, "/")}",
      bareRepoDir: "${path.join(tmpBase, "bare-2").replace(/\\/g, "/")}"
    }
  ]
};
`;

    await fs.writeFile(configPath, configContent);

    const output = execSync(`node "${cliPath}" list --config "${configPath}"`, {
      encoding: "utf-8",
    });

    expect(output).toContain("Configured repositories:");
    expect(output).toContain("test-repo-1");
    expect(output).toContain("test-repo-2");
    expect(output).toContain("https://github.com/octocat/Hello-World.git");
    expect(output).toContain("https://github.com/github/gitignore.git");
  });

  /**
   * The acceptance case for unknown keys, run against the built CLI rather than
   * the loader: `list` loads the config exactly once, so the warning appears
   * exactly once, and it appears on stderr. The stdout half is not cosmetic —
   * the same loader runs inside the MCP stdio server, where stdout carries the
   * JSON-RPC stream and a stray line breaks the protocol.
   */
  it("warns once on stderr about a misspelled config key, and never on stdout", async () => {
    const configPath = path.join(tmpBase, "unknown-key.config.js");
    await fs.mkdir(tmpBase, { recursive: true });

    await fs.writeFile(
      configPath,
      `
export default {
  repositories: [
    {
      name: "reference",
      repoUrl: "https://github.com/octocat/Hello-World.git",
      worktreeDir: "${path.join(tmpBase, "worktrees-unknown").replace(/\\/g, "/")}",
      bareRepoDir: "${path.join(tmpBase, "bare-unknown").replace(/\\/g, "/")}",
      updateExistingWorktree: false
    }
  ]
};
`,
    );

    const run = spawnSync("node", [cliPath, "list", "--config", configPath], { encoding: "utf-8" });

    const expected =
      "[sync-worktrees] Unknown config key 'updateExistingWorktree' in repository 'reference' is ignored " +
      "(did you mean 'updateExistingWorktrees'?)";
    expect(run.status).toBe(0);
    expect(run.stderr.split(expected).length - 1).toBe(1);
    expect(run.stdout).toContain("reference");
    expect(run.stdout).not.toContain("Unknown config key");
  });

  it.skip("should sync a single repository from config file with runOnce", async () => {
    const configPath = path.join(tmpBase, "single-repo.config.js");
    const worktreeDir = path.join(tmpBase, "single-worktrees");
    const bareRepoDir = path.join(tmpBase, "single-bare");

    await fs.mkdir(tmpBase, { recursive: true });

    const configContent = `
export default {
  defaults: {
    cronSchedule: "0 * * * *",
    runOnce: true
  },
  repositories: [
    {
      name: "hello-world",
      repoUrl: "https://github.com/octocat/Hello-World.git",
      worktreeDir: "${worktreeDir.replace(/\\/g, "/")}",
      bareRepoDir: "${bareRepoDir.replace(/\\/g, "/")}"
    }
  ]
};
`;

    await fs.writeFile(configPath, configContent);

    console.log("Running sync-worktrees with config file...");
    const output = execSync(`node "${cliPath}" --config "${configPath}"`, {
      encoding: "utf-8",
      timeout: 60000,
    });

    expect(output).toContain("Syncing 1 repository...");
    expect(output).toContain("Repository: hello-world");
    expect(output).toContain("Clone successful");
    expect(output).toContain("Synchronization finished");

    const bareExists = await fs
      .access(bareRepoDir)
      .then(() => true)
      .catch(() => false);
    expect(bareExists).toBe(true);

    const worktrees = await fs.readdir(worktreeDir);
    console.log("Created worktrees:", worktrees);
    expect(worktrees.length).toBeGreaterThanOrEqual(2);
    expect(worktrees).toContain("master");
  });

  it("should handle config file with relative paths", async () => {
    const configDir = path.join(tmpBase, "config-dir");
    const configPath = path.join(configDir, "relative.config.js");
    await fs.mkdir(configDir, { recursive: true });

    const configContent = `
export default {
  repositories: [
    {
      name: "relative-repo",
      repoUrl: "https://github.com/octocat/Hello-World.git",
      worktreeDir: "./relative-worktrees",
      bareRepoDir: "./relative-bare"
    }
  ]
};
`;

    await fs.writeFile(configPath, configContent);

    const output = execSync(`node "${cliPath}" list --config "${configPath}"`, {
      encoding: "utf-8",
    });

    expect(output).toContain("relative-repo");
    const absoluteWorktreeDir = path.join(configDir, "relative-worktrees");
    expect(output).toContain(absoluteWorktreeDir);
  });

  it("should filter repositories by name", async () => {
    const configPath = path.join(tmpBase, "filter-test.config.js");
    await fs.mkdir(tmpBase, { recursive: true });

    const configContent = `
export default {
  repositories: [
    {
      name: "repo-alpha",
      repoUrl: "https://github.com/octocat/Hello-World.git",
      worktreeDir: "${path.join(tmpBase, "worktrees-alpha").replace(/\\/g, "/")}"
    },
    {
      name: "repo-beta",
      repoUrl: "https://github.com/github/gitignore.git",
      worktreeDir: "${path.join(tmpBase, "worktrees-beta").replace(/\\/g, "/")}"
    },
    {
      name: "repo-gamma",
      repoUrl: "https://github.com/octocat/Spoon-Knife.git",
      worktreeDir: "${path.join(tmpBase, "worktrees-gamma").replace(/\\/g, "/")}"
    }
  ]
};
`;

    await fs.writeFile(configPath, configContent);

    const output = execSync(`node "${cliPath}" list --config "${configPath}" --filter "repo-beta"`, {
      encoding: "utf-8",
    });

    expect(output).toContain("Configured repositories:");
    expect(output).toContain("repo-beta");
    expect(output).not.toContain("repo-alpha");
    expect(output).not.toContain("repo-gamma");
  });

  it("should filter repositories with wildcards", async () => {
    const configPath = path.join(tmpBase, "wildcard-test.config.js");
    await fs.mkdir(tmpBase, { recursive: true });

    const configContent = `
export default {
  repositories: [
    {
      name: "frontend-app",
      repoUrl: "https://github.com/octocat/Hello-World.git",
      worktreeDir: "${path.join(tmpBase, "worktrees-frontend").replace(/\\/g, "/")}"
    },
    {
      name: "frontend-lib",
      repoUrl: "https://github.com/github/gitignore.git",
      worktreeDir: "${path.join(tmpBase, "worktrees-lib").replace(/\\/g, "/")}"
    },
    {
      name: "backend-api",
      repoUrl: "https://github.com/octocat/Spoon-Knife.git",
      worktreeDir: "${path.join(tmpBase, "worktrees-backend").replace(/\\/g, "/")}"
    }
  ]
};
`;

    await fs.writeFile(configPath, configContent);

    const output = execSync(`node "${cliPath}" list --config "${configPath}" --filter "frontend-*"`, {
      encoding: "utf-8",
    });

    expect(output).toContain("Configured repositories:");
    expect(output).toContain("frontend-app");
    expect(output).toContain("frontend-lib");
    expect(output).not.toContain("backend-api");
  });

  it("should handle config file with custom retry settings", async () => {
    const configPath = path.join(tmpBase, "retry-test.config.js");
    await fs.mkdir(tmpBase, { recursive: true });

    const configContent = `
export default {
  retry: {
    maxAttempts: 5,
    initialDelayMs: 2000,
    maxDelayMs: 30000,
    backoffMultiplier: 2
  },
  repositories: [
    {
      name: "retry-repo",
      repoUrl: "https://github.com/octocat/Hello-World.git",
      worktreeDir: "${path.join(tmpBase, "retry-worktrees").replace(/\\/g, "/")}"
    }
  ]
};
`;

    await fs.writeFile(configPath, configContent);

    const output = execSync(`node "${cliPath}" list --config "${configPath}"`, {
      encoding: "utf-8",
    });

    expect(output).toContain("retry-repo");
  });

  it("should handle config file with branchMaxAge", async () => {
    const configPath = path.join(tmpBase, "branch-age-test.config.js");
    await fs.mkdir(tmpBase, { recursive: true });

    const configContent = `
export default {
  defaults: {
    branchMaxAge: "30d"
  },
  repositories: [
    {
      name: "age-repo",
      repoUrl: "https://github.com/octocat/Hello-World.git",
      worktreeDir: "${path.join(tmpBase, "age-worktrees").replace(/\\/g, "/")}"
    }
  ]
};
`;

    await fs.writeFile(configPath, configContent);

    const output = execSync(`node "${cliPath}" list --config "${configPath}"`, {
      encoding: "utf-8",
    });

    expect(output).toContain("age-repo");
  });

  it("redacts credentials embedded in repoUrl from the list output", async () => {
    const configPath = path.join(tmpBase, "token-url.config.js");
    await fs.mkdir(tmpBase, { recursive: true });

    const configContent = `
export default {
  repositories: [
    {
      name: "token-repo",
      repoUrl: "https://ci-bot:s3cr3t-token@example.com/org/repo.git",
      worktreeDir: "${path.join(tmpBase, "worktrees-token").replace(/\\/g, "/")}"
    }
  ]
};
`;

    await fs.writeFile(configPath, configContent);

    const output = execSync(`node "${cliPath}" list --config "${configPath}"`, {
      encoding: "utf-8",
    });

    expect(output).toContain("token-repo");
    expect(output).toContain("URL: https://***@example.com/org/repo.git");
    expect(output).not.toContain("s3cr3t-token");
  });
  /**
   * `Failed to load config file: Unexpected token ']'` named neither the file
   * nor the line, and an auto-discovered config meant the person did not even
   * know which file that was. Run against a real `node` because that is the
   * whole point: Vitest resolves `import()` through its own pipeline, so the
   * in-process tests can only exercise the `require()` half.
   *
   * The two halves differ because Node's do. A module that fails to *parse*
   * under the ESM loader carries no position at all once the import is caught —
   * V8 keeps it on its message object, which Node prints for a fatal exception
   * and discards otherwise — so the file is what can be reported. A module that
   * parses and then throws carries a real frame, and that gives line and column.
   * Both were measured byte-identical on Node 20, 22 and 24.
   */
  it("names the config file a load failure came from, with the line when Node gives one", async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-config-loc-")));
    try {
      const unparseable = path.join(dir, "unparseable.config.mjs");
      await fs.writeFile(unparseable, 'export default {\n  repositories: [\n    { name: "a" ],\n  ],\n};\n');

      const parseRun = spawnSync("node", [cliPath, "list", "--config", unparseable], { encoding: "utf-8" });

      expect(parseRun.status).toBe(1);
      expect(parseRun.stderr).toContain("Unexpected token ']'");
      expect(parseRun.stderr).toContain(unparseable);
      // Every frame such an error carries is Node's own, and sending the person
      // to `node:internal/modules/esm/utils` instead of their config would be
      // worse than the bare message it replaced.
      expect(parseRun.stderr).not.toContain("node:internal");

      const throwing = path.join(dir, "throwing.config.mjs");
      await fs.writeFile(
        throwing,
        'export default {\n  repositories: [\n    { name: "a", worktreeDir: missingHelper() },\n  ],\n};\n',
      );

      const throwRun = spawnSync("node", [cliPath, "list", "--config", throwing], { encoding: "utf-8" });

      expect(throwRun.status).toBe(1);
      expect(throwRun.stderr).toContain("missingHelper is not defined");
      // Line 3 and a column, not just the file: the call is on the third line.
      expect(throwRun.stderr).toMatch(new RegExp(`${throwing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:3:\\d+`));
      // The loader appends a `?t=` cache-buster to the import URL and it travels
      // into the frame; what is printed has to be a path the person can open.
      expect(throwRun.stderr).not.toContain("?t=");
      expect(throwRun.stderr).not.toContain("file://");

      // A config is free to `import` its repository list from somewhere else,
      // and then the frame points at that module rather than at the config. The
      // config still has to be named: it is the file the person passed, and on
      // an auto-discovered run the only way they learn which one was picked.
      const helper = path.join(dir, "repositories.mjs");
      await fs.writeFile(helper, "export const repositories = [];\nthrow new Error('helper gave up');\n");
      const importing = path.join(dir, "importing.config.mjs");
      await fs.writeFile(
        importing,
        'import { repositories } from "./repositories.mjs";\nexport default { repositories };\n',
      );

      const importRun = spawnSync("node", [cliPath, "list", "--config", importing], { encoding: "utf-8" });

      expect(importRun.status).toBe(1);
      expect(importRun.stderr).toContain("helper gave up");
      expect(importRun.stderr).toContain(importing);
      expect(importRun.stderr).toMatch(new RegExp(`${helper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:2:\\d+`));

      // An ESM frame names the module by URL, and a URL keeps brackets literal.
      // Splitting the frame on its last bracket walked into the middle of the
      // path and handed back the tail with the `?t=` cache-buster still on it —
      // a path that does not exist and that the person cannot open.
      const bracketDir = path.join(dir, "configs (old)");
      await fs.mkdir(bracketDir, { recursive: true });
      const bracketed = path.join(bracketDir, "throwing.config.mjs");
      await fs.writeFile(
        bracketed,
        'export default {\n  repositories: [\n    { name: "a", worktreeDir: missingHelper() },\n  ],\n};\n',
      );

      const bracketRun = spawnSync("node", [cliPath, "list", "--config", bracketed], { encoding: "utf-8" });

      expect(bracketRun.status).toBe(1);
      expect(bracketRun.stderr).toMatch(new RegExp(`${bracketed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:3:\\d+`));
      expect(bracketRun.stderr).not.toContain("?t=");
      expect(bracketRun.stderr).not.toContain("file://");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

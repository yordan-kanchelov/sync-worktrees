import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";

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
    const configPath = path.join(tmpBase, "test.config.cjs");
    await fs.mkdir(tmpBase, { recursive: true });

    const configContent = `
module.exports = {
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

    const output = execSync(`node "${cliPath}" --config "${configPath}" --list`, {
      encoding: "utf-8",
    });

    expect(output).toContain("Configured repositories:");
    expect(output).toContain("test-repo-1");
    expect(output).toContain("test-repo-2");
    expect(output).toContain("https://github.com/octocat/Hello-World.git");
    expect(output).toContain("https://github.com/github/gitignore.git");
  });

  it.skip("should sync a single repository from config file with runOnce", async () => {
    const configPath = path.join(tmpBase, "single-repo.config.cjs");
    const worktreeDir = path.join(tmpBase, "single-worktrees");
    const bareRepoDir = path.join(tmpBase, "single-bare");

    await fs.mkdir(tmpBase, { recursive: true });

    const configContent = `
module.exports = {
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

    expect(output).toContain("Syncing 1 repositories");
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
    const configPath = path.join(configDir, "relative.config.cjs");
    await fs.mkdir(configDir, { recursive: true });

    const configContent = `
module.exports = {
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

    const output = execSync(`node "${cliPath}" --config "${configPath}" --list`, {
      encoding: "utf-8",
    });

    expect(output).toContain("relative-repo");
    const absoluteWorktreeDir = path.join(configDir, "relative-worktrees");
    expect(output).toContain(absoluteWorktreeDir);
  });

  it("should filter repositories by name", async () => {
    const configPath = path.join(tmpBase, "filter-test.config.cjs");
    await fs.mkdir(tmpBase, { recursive: true });

    const configContent = `
module.exports = {
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

    const output = execSync(`node "${cliPath}" --config "${configPath}" --filter "repo-beta" --list`, {
      encoding: "utf-8",
    });

    expect(output).toContain("Configured repositories:");
    expect(output).toContain("repo-beta");
    expect(output).not.toContain("repo-alpha");
    expect(output).not.toContain("repo-gamma");
  });

  it("should filter repositories with wildcards", async () => {
    const configPath = path.join(tmpBase, "wildcard-test.config.cjs");
    await fs.mkdir(tmpBase, { recursive: true });

    const configContent = `
module.exports = {
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

    const output = execSync(`node "${cliPath}" --config "${configPath}" --filter "frontend-*" --list`, {
      encoding: "utf-8",
    });

    expect(output).toContain("Configured repositories:");
    expect(output).toContain("frontend-app");
    expect(output).toContain("frontend-lib");
    expect(output).not.toContain("backend-api");
  });

  it("should handle config file with custom retry settings", async () => {
    const configPath = path.join(tmpBase, "retry-test.config.cjs");
    await fs.mkdir(tmpBase, { recursive: true });

    const configContent = `
module.exports = {
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

    const output = execSync(`node "${cliPath}" --config "${configPath}" --list`, {
      encoding: "utf-8",
    });

    expect(output).toContain("retry-repo");
  });

  it("should handle config file with branchMaxAge", async () => {
    const configPath = path.join(tmpBase, "branch-age-test.config.cjs");
    await fs.mkdir(tmpBase, { recursive: true });

    const configContent = `
module.exports = {
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

    const output = execSync(`node "${cliPath}" --config "${configPath}" --list`, {
      encoding: "utf-8",
    });

    expect(output).toContain("age-repo");
  });
});

import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const shouldSkip = process.env.SKIP_E2E_TESTS === "true";
const describeOrSkip = shouldSkip ? describe.skip : describe;

const HELLO_WORLD = "https://github.com/octocat/Hello-World.git";
const GITIGNORE = "https://github.com/github/gitignore.git";

describeOrSkip("Clone-mode E2E tests", () => {
  const cliPath = path.join(process.cwd(), "dist", "index.js");
  const tmpBase = path.join(process.cwd(), "tmp-e2e-clone-mode");

  beforeAll(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
    await fs.mkdir(tmpBase, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  async function createLocalRemote(name: string): Promise<string> {
    const remoteBare = path.join(tmpBase, `${name}.git`);
    const seedDir = path.join(tmpBase, `${name}-seed`);

    await fs.mkdir(seedDir, { recursive: true });
    execSync(`git init --bare "${remoteBare}"`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" init`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" config user.name "Test User"`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" config user.email "test@example.com"`, { encoding: "utf-8" });

    await fs.writeFile(path.join(seedDir, "README.md"), "# Test Repository\n");
    execSync(`git -C "${seedDir}" add README.md`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" commit -m "Initial commit"`, { encoding: "utf-8" });

    await fs.writeFile(path.join(seedDir, "one.txt"), "one\n");
    execSync(`git -C "${seedDir}" add one.txt`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" commit -m "Add one"`, { encoding: "utf-8" });

    await fs.writeFile(path.join(seedDir, "two.txt"), "two\n");
    execSync(`git -C "${seedDir}" add two.txt`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" commit -m "Add two"`, { encoding: "utf-8" });

    execSync(`git -C "${seedDir}" branch -M main`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" remote add origin "${remoteBare}"`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" push origin main`, { encoding: "utf-8" });
    execSync(`git -C "${remoteBare}" symbolic-ref HEAD refs/heads/main`, { encoding: "utf-8" });

    return remoteBare;
  }

  async function writeSingleCloneConfig(
    name: string,
    repoUrl: string,
    worktreeDir: string,
    branch: string,
  ): Promise<string> {
    const configDir = path.dirname(worktreeDir);
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, `${name}.config.js`);
    const configContent = `
export default {
  defaults: { runOnce: true },
  repositories: [
    {
      name: "${name}",
      repoUrl: "${repoUrl}",
      worktreeDir: "${worktreeDir.replace(/\\/g, "/")}",
      mode: "clone",
      branch: "${branch}"
    }
  ]
};
`;
    await fs.writeFile(configPath, configContent);
    return configPath;
  }

  function writeCloneDepthConfig(
    configPath: string,
    repoUrl: string,
    worktreeDir: string,
    depthLine = "",
  ): Promise<void> {
    const configContent = `
export default {
  defaults: { runOnce: true },
  repositories: [
    {
      name: "depth-local",
      repoUrl: "${repoUrl}",
      worktreeDir: "${worktreeDir.replace(/\\/g, "/")}",
      mode: "clone",
      branch: "main"${depthLine}
    }
  ]
};
`;
    return fs.writeFile(configPath, configContent);
  }

  it("clones directly into worktreeDir (no /branch subfolder, no .bare)", async () => {
    const worktreeDir = path.join(tmpBase, "single-clone", "wt");
    const configPath = await writeSingleCloneConfig("single", HELLO_WORLD, worktreeDir, "master");

    execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });

    const entries = await fs.readdir(worktreeDir);
    expect(entries).toContain(".git");
    expect(entries).toContain("README");
    expect(entries).not.toContain("master");
    expect(entries).not.toContain(".bare");

    const headBranch = execSync(`git -C "${worktreeDir}" rev-parse --abbrev-ref HEAD`, {
      encoding: "utf-8",
    }).trim();
    expect(headBranch).toBe("master");

    const remoteUrl = execSync(`git -C "${worktreeDir}" remote get-url origin`, {
      encoding: "utf-8",
    }).trim();
    expect(remoteUrl).toBe(HELLO_WORLD);
  }, 90000);

  it("keeps shallow clone-mode remote-tracking refs open to all remote branches", async () => {
    const remoteBare = await createLocalRemote("remote-branches");
    const seedDir = path.join(tmpBase, "remote-branches-seed");
    execSync(`git -C "${seedDir}" switch -c "feat/cloudflare-deploys"`, { encoding: "utf-8" });
    await fs.writeFile(path.join(seedDir, "cloudflare.txt"), "cloudflare\n");
    execSync(`git -C "${seedDir}" add cloudflare.txt`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" commit -m "Add cloudflare deploys"`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" push origin "feat/cloudflare-deploys"`, { encoding: "utf-8" });

    const worktreeDir = path.join(tmpBase, "remote-branches", "wt");
    const configPath = path.join(tmpBase, "remote-branches", "remote-branches.config.js");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await writeCloneDepthConfig(configPath, `file://${remoteBare}`, worktreeDir, ",\n      depth: 1");

    execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });

    const fetchRefspec = execSync(`git -C "${worktreeDir}" config --get-all remote.origin.fetch`, {
      encoding: "utf-8",
    }).trim();
    const remoteBranches = execSync(`git -C "${worktreeDir}" branch -r --list`, { encoding: "utf-8" });
    const cloneHead = execSync(`git -C "${worktreeDir}" rev-parse --abbrev-ref HEAD`, { encoding: "utf-8" }).trim();
    const isShallow = execSync(`git -C "${worktreeDir}" rev-parse --is-shallow-repository`, {
      encoding: "utf-8",
    }).trim();
    const featureCommitCount = execSync(`git -C "${worktreeDir}" rev-list --count origin/feat/cloudflare-deploys`, {
      encoding: "utf-8",
    }).trim();

    expect(fetchRefspec).toBe("+refs/heads/*:refs/remotes/origin/*");
    expect(remoteBranches).toContain("origin/feat/cloudflare-deploys");
    expect(cloneHead).toBe("main");
    expect(isShallow).toBe("true");
    expect(featureCommitCount).toBe("1");
  }, 60000);

  it("widens legacy single-branch clone refspecs and fetches missing remote branches", async () => {
    const remoteBare = await createLocalRemote("legacy-remote-branches");
    const seedDir = path.join(tmpBase, "legacy-remote-branches-seed");
    execSync(`git -C "${seedDir}" switch -c "feat/cloudflare-deploys"`, { encoding: "utf-8" });
    await fs.writeFile(path.join(seedDir, "cloudflare.txt"), "cloudflare\n");
    execSync(`git -C "${seedDir}" add cloudflare.txt`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" commit -m "Add cloudflare deploys"`, { encoding: "utf-8" });
    execSync(`git -C "${seedDir}" push origin "feat/cloudflare-deploys"`, { encoding: "utf-8" });

    const worktreeDir = path.join(tmpBase, "legacy-remote-branches", "wt");
    execSync(`git clone --branch main --single-branch "file://${remoteBare}" "${worktreeDir}"`, {
      encoding: "utf-8",
    });

    const configPath = path.join(tmpBase, "legacy-remote-branches", "legacy.config.js");
    await writeCloneDepthConfig(configPath, `file://${remoteBare}`, worktreeDir);

    const beforeBranch = execSync(`git -C "${worktreeDir}" branch -r --list "origin/feat/cloudflare-deploys"`, {
      encoding: "utf-8",
    });
    execSync(`node "${cliPath}" --config "${configPath}"`, { encoding: "utf-8", timeout: 60000 });

    const fetchRefspec = execSync(`git -C "${worktreeDir}" config --get-all remote.origin.fetch`, {
      encoding: "utf-8",
    }).trim();
    const remoteBranches = execSync(`git -C "${worktreeDir}" branch -r --list`, { encoding: "utf-8" });

    expect(beforeBranch).toBe("");
    expect(fetchRefspec).toBe("+refs/heads/*:refs/remotes/origin/*");
    expect(remoteBranches).toContain("origin/feat/cloudflare-deploys");
  }, 60000);

  it("is idempotent on subsequent runs (no re-clone, fetch-only sync)", async () => {
    const worktreeDir = path.join(tmpBase, "idempotent-clone", "wt");
    const configPath = await writeSingleCloneConfig("idempotent", HELLO_WORLD, worktreeDir, "master");
    const command = `node "${cliPath}" --config "${configPath}"`;

    execSync(command, { encoding: "utf-8", timeout: 60000 });

    const secondRun = execSync(command, { encoding: "utf-8", timeout: 60000 });

    expect(secondRun).not.toContain("Cloning ");
    expect(secondRun).toContain("up to date with origin/master");
  }, 120000);

  it("errors with branch mismatch during initialize when checkout is on a different branch", async () => {
    const worktreeDir = path.join(tmpBase, "mismatch-clone", "wt");
    const configPath = await writeSingleCloneConfig("mismatch", HELLO_WORLD, worktreeDir, "master");
    const command = `node "${cliPath}" --config "${configPath}"`;

    execSync(command, { encoding: "utf-8", timeout: 60000 });

    execSync(`git -C "${worktreeDir}" checkout -b sidebranch`, { encoding: "utf-8" });

    let stderr = "";
    try {
      execSync(command, { encoding: "utf-8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const err = error as { stderr?: Buffer | string; stdout?: Buffer | string; status?: number };
      stderr = String(err.stderr ?? "") + String(err.stdout ?? "");
      expect(err.status).not.toBe(0);
    }

    expect(stderr).toMatch(/branch 'sidebranch', expected 'master'/);
    expect(stderr).toContain("CONFIG_CLONE_BRANCH_MISMATCH");
  }, 120000);

  it("supports mixed config: one clone-mode repo + one worktree-mode repo", async () => {
    const configDir = path.join(tmpBase, "mixed-config");
    await fs.mkdir(configDir, { recursive: true });

    const cloneDir = path.join(configDir, "clone-repo");
    const worktreeRoot = path.join(configDir, "worktree-repo");
    const bareDir = path.join(configDir, ".bare-worktree");

    const configPath = path.join(configDir, "mixed.config.js");
    const configContent = `
export default {
  defaults: { cronSchedule: "0 * * * *", runOnce: true },
  repositories: [
    {
      name: "clone-side",
      repoUrl: "${HELLO_WORLD}",
      worktreeDir: "${cloneDir.replace(/\\/g, "/")}",
      mode: "clone",
      branch: "master"
    },
    {
      name: "worktree-side",
      repoUrl: "${GITIGNORE}",
      worktreeDir: "${worktreeRoot.replace(/\\/g, "/")}",
      bareRepoDir: "${bareDir.replace(/\\/g, "/")}",
      branchInclude: ["main"]
    }
  ]
};
`;
    await fs.writeFile(configPath, configContent);

    execSync(`node "${cliPath}" --config "${configPath}"`, {
      encoding: "utf-8",
      timeout: 180000,
      env: { ...process.env, NODE_ENV: "production" },
    });

    const cloneEntries = await fs.readdir(cloneDir);
    expect(cloneEntries).toContain(".git");
    expect(cloneEntries).toContain("README");
    expect(cloneEntries).not.toContain("master");
    const cloneHead = execSync(`git -C "${cloneDir}" rev-parse --abbrev-ref HEAD`, { encoding: "utf-8" }).trim();
    expect(cloneHead).toBe("master");

    const bareExists = await fs
      .access(bareDir)
      .then(() => true)
      .catch(() => false);
    expect(bareExists).toBe(true);

    const worktreeEntries = await fs.readdir(worktreeRoot);
    expect(worktreeEntries).toContain("main");
    const mainWorktreePath = path.join(worktreeRoot, "main");
    const mainHead = execSync(`git -C "${mainWorktreePath}" rev-parse --abbrev-ref HEAD`, {
      encoding: "utf-8",
    }).trim();
    expect(mainHead).toBe("main");

    const lockDir = path.join(configDir, ".sync-worktrees-state");
    const lockExists = await fs
      .access(lockDir)
      .then(() => true)
      .catch(() => false);
    expect(lockExists).toBe(true);
  }, 240000);

  it("creates a shallow clone from config depth and unshallows when depth is removed", async () => {
    const remoteBare = await createLocalRemote("depth-remote");
    const configDir = path.join(tmpBase, "depth-config");
    const worktreeDir = path.join(configDir, "clone");
    const configPath = path.join(configDir, "depth.config.js");
    const repoUrl = `file://${remoteBare}`;
    await fs.mkdir(configDir, { recursive: true });

    await writeCloneDepthConfig(configPath, repoUrl, worktreeDir, ",\n      depth: 1");

    execSync(`node "${cliPath}" --config "${configPath}"`, {
      encoding: "utf-8",
      timeout: 60000,
    });

    const shallowAfterClone = execSync(`git -C "${worktreeDir}" rev-parse --is-shallow-repository`, {
      encoding: "utf-8",
    }).trim();
    expect(shallowAfterClone).toBe("true");
    expect(execSync(`git -C "${worktreeDir}" rev-list --count HEAD`, { encoding: "utf-8" }).trim()).toBe("1");

    await writeCloneDepthConfig(configPath, repoUrl, worktreeDir);

    const secondRun = execSync(`node "${cliPath}" --config "${configPath}"`, {
      encoding: "utf-8",
      timeout: 60000,
    });

    const shallowAfterDepthRemoval = execSync(`git -C "${worktreeDir}" rev-parse --is-shallow-repository`, {
      encoding: "utf-8",
    }).trim();
    const commitCount = Number(execSync(`git -C "${worktreeDir}" rev-list --count HEAD`, { encoding: "utf-8" }).trim());
    expect(secondRun).toContain("[deepen]");
    expect(shallowAfterDepthRemoval).toBe("false");
    expect(commitCount).toBeGreaterThan(1);
  }, 120000);

  it("rejects clone mode combined with branchInclude (validation error)", async () => {
    const configPath = path.join(tmpBase, "bad-config.config.js");
    const configContent = `
export default {
  repositories: [
    {
      name: "bad-repo",
      repoUrl: "${HELLO_WORLD}",
      worktreeDir: "${path.join(tmpBase, "bad-repo-wt").replace(/\\/g, "/")}",
      mode: "clone",
      branchInclude: ["main"]
    }
  ]
};
`;
    await fs.writeFile(configPath, configContent);

    let stderr = "";
    try {
      execSync(`node "${cliPath}" list --config "${configPath}"`, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const err = error as { stderr?: Buffer | string; stdout?: Buffer | string; status?: number };
      stderr = String(err.stderr ?? "") + String(err.stdout ?? "");
      expect(err.status).not.toBe(0);
    }

    expect(stderr).toMatch(/branchInclude.*not supported when mode is 'clone'/);
  }, 30000);
});

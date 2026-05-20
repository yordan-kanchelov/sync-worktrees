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

  it("clones directly into worktreeDir (no /branch subfolder, no .bare)", async () => {
    const worktreeDir = path.join(tmpBase, "single-clone");

    execSync(
      `node "${cliPath}" --repoUrl ${HELLO_WORLD} --worktreeDir "${worktreeDir}" --mode clone --branch master --runOnce`,
      { encoding: "utf-8", timeout: 60000 },
    );

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

  it("is idempotent on subsequent runs (no re-clone, fetch-only sync)", async () => {
    const worktreeDir = path.join(tmpBase, "idempotent-clone");

    execSync(
      `node "${cliPath}" --repoUrl ${HELLO_WORLD} --worktreeDir "${worktreeDir}" --mode clone --branch master --runOnce`,
      { encoding: "utf-8", timeout: 60000 },
    );

    const secondRun = execSync(
      `node "${cliPath}" --repoUrl ${HELLO_WORLD} --worktreeDir "${worktreeDir}" --mode clone --branch master --runOnce`,
      { encoding: "utf-8", timeout: 60000 },
    );

    expect(secondRun).not.toContain("Cloning ");
    expect(secondRun).toContain("up to date with origin/master");
  }, 120000);

  it("errors with branch mismatch during initialize when checkout is on a different branch", async () => {
    const worktreeDir = path.join(tmpBase, "mismatch-clone");

    execSync(
      `node "${cliPath}" --repoUrl ${HELLO_WORLD} --worktreeDir "${worktreeDir}" --mode clone --branch master --runOnce`,
      { encoding: "utf-8", timeout: 60000 },
    );

    execSync(`git -C "${worktreeDir}" checkout -b sidebranch`, { encoding: "utf-8" });

    let stderr = "";
    try {
      execSync(
        `node "${cliPath}" --repoUrl ${HELLO_WORLD} --worktreeDir "${worktreeDir}" --mode clone --branch master --runOnce`,
        { encoding: "utf-8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] },
      );
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

    execSync(`node "${cliPath}" --config "${configPath}" --runOnce`, {
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
      execSync(`node "${cliPath}" --config "${configPath}" --list`, {
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

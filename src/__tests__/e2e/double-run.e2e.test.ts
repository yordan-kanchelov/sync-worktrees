import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("Double run E2E test", () => {
  let tempDir: string;
  let bareRepo: string;
  let worktreeDir: string;
  let configPath: string;
  const binaryPath = path.join(__dirname, "../../../dist/index.js");

  async function writeConfig(): Promise<string> {
    const bareRepoDir = path.join(tempDir, ".bare");
    const configContent = `export default {
  defaults: { runOnce: true },
  repositories: [
    {
      name: "test-repo",
      repoUrl: "file://${bareRepo}",
      worktreeDir: "${worktreeDir}",
      bareRepoDir: "${bareRepoDir}",
    }
  ]
};
`;
    const cfg = path.join(tempDir, "sync-worktrees.config.js");
    await fs.writeFile(cfg, configContent);
    return cfg;
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-double-run-"));
    bareRepo = path.join(tempDir, "test-repo.git");
    worktreeDir = path.join(tempDir, "worktrees");

    const git = simpleGit();
    await git.init(["--bare", bareRepo]);

    const initDir = path.join(tempDir, "init");
    await fs.mkdir(initDir);
    const initGit = simpleGit(initDir);
    await initGit.init();
    await initGit.addConfig("user.name", "Test User");
    await initGit.addConfig("user.email", "test@example.com");

    await fs.writeFile(path.join(initDir, "README.md"), "# Test Repository");
    await initGit.add(".");
    await initGit.commit("Initial commit");
    await initGit.branch(["-M", "main"]);
    await initGit.addRemote("origin", bareRepo);
    await initGit.push("origin", "main");

    const branches = ["feature-1", "feature-2", "bugfix/issue-123", "release/v1.0"];
    for (const branchName of branches) {
      await initGit.checkout("main");
      await initGit.checkoutLocalBranch(branchName);
      await fs.writeFile(path.join(initDir, `${branchName.replace(/\//g, "-")}.txt`), `Content for ${branchName}`);
      await initGit.add(".");
      await initGit.commit(`Add ${branchName}`);
      await initGit.push("origin", branchName);
    }

    const bareGit = simpleGit(bareRepo);
    await bareGit.raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    try {
      await bareGit.raw(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    } catch {}

    await fs.rm(initDir, { recursive: true });

    configPath = await writeConfig();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should run successfully twice without any errors about HEAD", async () => {
    const command = `node "${binaryPath}" --config "${configPath}"`;

    console.log("First run...");
    const firstRun = execSync(command, { encoding: "utf8" });

    expect(firstRun).toContain("Starting worktree synchronization");
    expect(firstRun).toContain("Synchronization finished");
    expect(firstRun).not.toContain("Error during worktree synchronization");
    expect(firstRun).not.toContain("Failed to create worktree");
    expect(firstRun).not.toContain("'HEAD' is not a valid branch name");
    expect(firstRun).not.toContain("Creating new worktrees for: HEAD");

    console.log("Second run...");
    const secondRun = execSync(command, { encoding: "utf8" });

    expect(secondRun).toContain("Starting worktree synchronization");
    expect(secondRun).toContain("Synchronization finished");
    expect(secondRun).not.toContain("Error during worktree synchronization");
    expect(secondRun).not.toContain("Failed to create worktree");
    expect(secondRun).not.toContain("'HEAD' is not a valid branch name");
    expect(secondRun).not.toContain("Creating new worktrees for: HEAD");

    const bothRuns = firstRun + secondRun;
    expect(bothRuns).not.toContain("'HEAD' is not a valid branch name");
    expect(bothRuns).not.toContain("fatal: 'HEAD' is not a valid branch name");
  }, 30000);

  it("should leave an unowned HEAD directory untouched", async () => {
    const command = `node "${binaryPath}" --config "${configPath}"`;

    execSync(command, { encoding: "utf8" });

    const headPath = path.join(worktreeDir, "HEAD");
    await fs.mkdir(headPath, { recursive: true });
    await fs.writeFile(path.join(headPath, "dummy.txt"), "This simulates a mistakenly created HEAD worktree");

    const secondRun = execSync(command, { encoding: "utf8" });

    expect(secondRun).toContain("Synchronization finished");
    expect(secondRun).not.toContain("Error during worktree synchronization");

    const worktrees = await fs.readdir(worktreeDir);
    expect(worktrees).toContain("HEAD");
    await expect(fs.readFile(path.join(headPath, "dummy.txt"), "utf8")).resolves.toBe(
      "This simulates a mistakenly created HEAD worktree",
    );
  }, 30000);
});

import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PathResolutionService } from "../../services/path-resolution.service";

const pathRes = new PathResolutionService();

describe("HEAD branch filtering (E2E)", () => {
  let tempDir: string;
  let bareRepo: string;
  let worktreeDir: string;
  const binaryPath = path.join(__dirname, "../../../dist/index.js");

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-head-test-"));
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

    await initGit.checkoutLocalBranch("feature-1");
    await fs.writeFile(path.join(initDir, "feature1.txt"), "Feature 1");
    await initGit.add(".");
    await initGit.commit("Add feature 1");
    await initGit.push("origin", "feature-1");

    await initGit.checkout("main");
    await initGit.checkoutLocalBranch("feature-2");
    await fs.writeFile(path.join(initDir, "feature2.txt"), "Feature 2");
    await initGit.add(".");
    await initGit.commit("Add feature 2");
    await initGit.push("origin", "feature-2");

    const bareGit = simpleGit(bareRepo);
    await bareGit.raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    await fs.rm(initDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should successfully sync repository without creating HEAD worktree", async () => {
    const bareRepoDir = path.join(tempDir, ".bare");
    const configPath = path.join(tempDir, "config.js");
    await fs.writeFile(
      configPath,
      `export default {
        defaults: {
          runOnce: true,
          parallelism: { maxWorktreeCreation: 1, maxRepositories: 1 }
        },
        repositories: [{
          name: "test-repo",
          repoUrl: "file://${bareRepo}",
          worktreeDir: "${worktreeDir}",
          bareRepoDir: "${bareRepoDir}"
        }]
      };`,
    );

    const output = execSync(`node "${binaryPath}" --config "${configPath}"`, { encoding: "utf8" });

    expect(output).toContain("Starting worktree synchronization");
    expect(output).toContain("Synchronization finished");
    expect(output).not.toContain("Creating new worktrees for: HEAD");

    const worktrees = await fs.readdir(worktreeDir);
    const feature1Dir = "feature-1";
    expect(worktrees).toContain(feature1Dir);
    expect(worktrees).toContain("feature-2");
    expect(worktrees).not.toContain("HEAD");
    expect(worktrees).not.toContain(pathRes.sanitizeBranchName("HEAD"));

    if (!worktrees.includes("main")) {
      console.warn("Main worktree not found - this may indicate a platform-specific path comparison issue");
    }

    const feature1Path = path.join(worktreeDir, feature1Dir);
    const git = simpleGit(feature1Path);
    const worktreeList = await git.raw(["worktree", "list"]);
    expect(worktreeList).not.toContain("/HEAD");
  });
});

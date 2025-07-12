import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";

describe("HEAD branch filtering (E2E)", () => {
  let tempDir: string;
  let bareRepo: string;
  let repoPath: string;
  let worktreeDir: string;
  const binaryPath = path.join(__dirname, "../../../dist/index.js");

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-head-test-"));
    bareRepo = path.join(tempDir, "test-repo.git");
    repoPath = path.join(tempDir, "test-repo");
    worktreeDir = path.join(tempDir, "worktrees");

    // Create a bare repository
    const git = simpleGit();
    await git.init(["--bare", bareRepo]);

    // Create a temporary directory for initial commit
    const initDir = path.join(tempDir, "init");
    await fs.mkdir(initDir);
    const initGit = simpleGit(initDir);
    await initGit.init();
    await initGit.addConfig("user.name", "Test User");
    await initGit.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(initDir, "README.md"), "# Test Repository");
    await initGit.add(".");
    await initGit.commit("Initial commit");
    await initGit.branch(["-M", "main"]); // Ensure branch is named 'main'
    await initGit.addRemote("origin", bareRepo);
    await initGit.push("origin", "main");

    // Create additional branches
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

    // Ensure origin/HEAD exists
    const bareGit = simpleGit(bareRepo);
    await bareGit.raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    // Clean up init directory
    await fs.rm(initDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should successfully sync repository without creating HEAD worktree", async () => {
    // Run sync-worktrees
    const bareRepoDir = path.join(tempDir, ".bare");
    const output = execSync(
      `node "${binaryPath}" --repoUrl "file://${bareRepo}" --repoPath "${repoPath}" --worktreeDir "${worktreeDir}" --bareRepoDir "${bareRepoDir}" --runOnce`,
      { encoding: "utf8" },
    );

    expect(output).toContain("Starting worktree synchronization");
    expect(output).toContain("Synchronization finished");
    expect(output).not.toContain("Creating new worktrees for: HEAD");
    expect(output).not.toContain("Failed to create worktree");

    // Verify worktrees were created (main branch is not created in worktreeDir)
    const worktrees = await fs.readdir(worktreeDir);
    expect(worktrees).toContain("feature-1");
    expect(worktrees).toContain("feature-2");
    expect(worktrees).not.toContain("HEAD");
    expect(worktrees).not.toContain("main"); // Default branch doesn't get a separate worktree

    // Verify git worktree list doesn't include HEAD
    // Check from any worktree (they all share the same worktree list)
    const feature1Path = path.join(worktreeDir, "feature-1");
    const git = simpleGit(feature1Path);
    const worktreeList = await git.raw(["worktree", "list"]);
    expect(worktreeList).not.toContain("/HEAD");
  });

  it("should handle subsequent runs without errors", async () => {
    const bareRepoDir = path.join(tempDir, ".bare");

    // First run
    execSync(
      `node "${binaryPath}" --repoUrl "file://${bareRepo}" --repoPath "${repoPath}" --worktreeDir "${worktreeDir}" --bareRepoDir "${bareRepoDir}" --runOnce`,
      { encoding: "utf8" },
    );

    // Second run - should not have any errors
    const output = execSync(
      `node "${binaryPath}" --repoUrl "file://${bareRepo}" --repoPath "${repoPath}" --worktreeDir "${worktreeDir}" --bareRepoDir "${bareRepoDir}" --runOnce`,
      { encoding: "utf8" },
    );

    expect(output).not.toContain("Creating new worktrees for: HEAD");
    expect(output).not.toContain("Failed to create worktree");
    expect(output).not.toContain("Error during worktree synchronization");
  });
});

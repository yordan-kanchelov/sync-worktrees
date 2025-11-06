import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";

describe("Double run E2E test", () => {
  let tempDir: string;
  let bareRepo: string;
  let worktreeDir: string;
  const binaryPath = path.join(__dirname, "../../../dist/index.js");

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-double-run-"));
    bareRepo = path.join(tempDir, "test-repo.git");
    worktreeDir = path.join(tempDir, "worktrees");

    // Create a bare repository with origin/HEAD
    const git = simpleGit();
    await git.init(["--bare", bareRepo]);

    // Create a temporary directory for initial setup
    const initDir = path.join(tempDir, "init");
    await fs.mkdir(initDir);
    const initGit = simpleGit(initDir);
    await initGit.init();
    await initGit.addConfig("user.name", "Test User");
    await initGit.addConfig("user.email", "test@example.com");

    // Create main branch
    await fs.writeFile(path.join(initDir, "README.md"), "# Test Repository");
    await initGit.add(".");
    await initGit.commit("Initial commit");
    await initGit.branch(["-M", "main"]); // Ensure branch is named 'main'
    await initGit.addRemote("origin", bareRepo);
    await initGit.push("origin", "main");

    // Create multiple feature branches to make the test more realistic
    const branches = ["feature-1", "feature-2", "bugfix/issue-123", "release/v1.0"];
    for (const branchName of branches) {
      await initGit.checkout("main");
      await initGit.checkoutLocalBranch(branchName);
      await fs.writeFile(path.join(initDir, `${branchName.replace(/\//g, "-")}.txt`), `Content for ${branchName}`);
      await initGit.add(".");
      await initGit.commit(`Add ${branchName}`);
      await initGit.push("origin", branchName);
    }

    // Ensure origin/HEAD exists and points to main
    const bareGit = simpleGit(bareRepo);
    await bareGit.raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    // Also set origin/HEAD explicitly
    try {
      await bareGit.raw(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    } catch {
      // Ignore if this fails, as it's not always necessary
    }

    // Clean up init directory
    await fs.rm(initDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should run successfully twice without any errors about HEAD", async () => {
    const bareRepoDir = path.join(tempDir, ".bare");
    const command = `node "${binaryPath}" --repoUrl "file://${bareRepo}" --worktreeDir "${worktreeDir}" --bareRepoDir "${bareRepoDir}" --runOnce`;

    // First run
    console.log("First run...");
    const firstRun = execSync(command, { encoding: "utf8" });

    // Verify first run was successful
    expect(firstRun).toContain("Starting worktree synchronization");
    expect(firstRun).toContain("Synchronization finished");
    expect(firstRun).not.toContain("Error during worktree synchronization");
    expect(firstRun).not.toContain("Failed to create worktree");
    expect(firstRun).not.toContain("'HEAD' is not a valid branch name");
    expect(firstRun).not.toContain("Creating new worktrees for: HEAD");

    // Second run - this is the critical test
    console.log("Second run...");
    const secondRun = execSync(command, { encoding: "utf8" });

    // Verify second run was also successful with no errors
    expect(secondRun).toContain("Starting worktree synchronization");
    expect(secondRun).toContain("Synchronization finished");
    expect(secondRun).not.toContain("Error during worktree synchronization");
    expect(secondRun).not.toContain("Failed to create worktree");
    expect(secondRun).not.toContain("'HEAD' is not a valid branch name");
    expect(secondRun).not.toContain("Creating new worktrees for: HEAD");

    // The key test: no errors related to HEAD in either run
    const bothRuns = firstRun + secondRun;
    expect(bothRuns).not.toContain("'HEAD' is not a valid branch name");
    expect(bothRuns).not.toContain("fatal: 'HEAD' is not a valid branch name");
  }, 30000);

  it("should handle multiple rapid successive runs without errors", async () => {
    const bareRepoDir = path.join(tempDir, ".bare");
    const command = `node "${binaryPath}" --repoUrl "file://${bareRepo}" --worktreeDir "${worktreeDir}" --bareRepoDir "${bareRepoDir}" --runOnce`;

    // Run the command 5 times in succession
    for (let i = 1; i <= 5; i++) {
      console.log(`Run ${i}...`);
      const output = execSync(command, { encoding: "utf8" });

      // Every run should be successful
      expect(output).toContain("Synchronization finished");
      expect(output).not.toContain("Error during worktree synchronization");
      expect(output).not.toContain("'HEAD' is not a valid branch name");
      expect(output).not.toContain("Creating new worktrees for: HEAD");

      // The important thing is that it doesn't error on HEAD
    }

    // Final verification
    const worktrees = await fs.readdir(worktreeDir);
    expect(worktrees).not.toContain("HEAD");
  }, 30000);

  it("should recover gracefully if a HEAD worktree was manually created", async () => {
    const bareRepoDir = path.join(tempDir, ".bare");
    const command = `node "${binaryPath}" --repoUrl "file://${bareRepo}" --worktreeDir "${worktreeDir}" --bareRepoDir "${bareRepoDir}" --runOnce`;

    // First run to set up worktrees
    execSync(command, { encoding: "utf8" });

    // Manually create a HEAD directory (simulating the old bug)
    const headPath = path.join(worktreeDir, "HEAD");
    await fs.mkdir(headPath, { recursive: true });
    await fs.writeFile(path.join(headPath, "dummy.txt"), "This simulates a mistakenly created HEAD worktree");

    // Second run should handle this gracefully
    const secondRun = execSync(command, { encoding: "utf8" });

    expect(secondRun).toContain("Synchronization finished");
    expect(secondRun).not.toContain("Error during worktree synchronization");

    // The orphaned HEAD directory should be cleaned up
    expect(secondRun).toContain("orphaned directories");
    expect(secondRun).toContain("Removed orphaned directory: HEAD");

    // Verify HEAD directory was removed
    const worktrees = await fs.readdir(worktreeDir);
    expect(worktrees).not.toContain("HEAD");
  });
});

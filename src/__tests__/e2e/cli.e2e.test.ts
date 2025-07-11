import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";

// This test requires git to be installed and internet access
// By default, tests run unless in CI environment
// To skip: SKIP_E2E_TESTS=true pnpm test
// To force in CI: RUN_E2E_TESTS=true pnpm test
const shouldSkip =
  process.env.SKIP_E2E_TESTS === "true" || (process.env.CI === "true" && process.env.RUN_E2E_TESTS !== "true");

const describeOrSkip = shouldSkip ? describe.skip : describe;

describeOrSkip("sync-worktrees CLI E2E tests", () => {
  const cliPath = path.join(process.cwd(), "dist", "index.js");
  const tmpBase = path.join(process.cwd(), "tmp-e2e-test");

  beforeAll(async () => {
    // Clean up any existing test directories
    await fs.rm(tmpBase, { recursive: true, force: true });
    await fs.rm(".bare", { recursive: true, force: true });
  });

  afterAll(async () => {
    // Clean up test directories
    await fs.rm(tmpBase, { recursive: true, force: true });
    await fs.rm(".bare", { recursive: true, force: true });
  });

  it("should sync octocat/Hello-World repository successfully", async () => {
    const testDir = path.join(tmpBase, "hello-world-test");
    const worktreeDir = path.join(testDir, "worktrees");
    const bareRepoDir = path.join(testDir, "bare-repo");

    await fs.mkdir(testDir, { recursive: true });

    // Step 1: Run sync-worktrees
    console.log("Running sync-worktrees CLI...");
    const output = execSync(
      `node "${cliPath}" --repoUrl https://github.com/octocat/Hello-World.git --worktreeDir "${worktreeDir}" --bareRepoDir "${bareRepoDir}" --runOnce`,
      { encoding: "utf-8" },
    );

    expect(output).toContain("Clone successful");
    expect(output).toContain("Synchronization finished");

    // Step 2: Verify bare repository exists
    const bareExists = await fs
      .access(bareRepoDir)
      .then(() => true)
      .catch(() => false);
    expect(bareExists).toBe(true);

    // Step 3: Verify worktrees were created
    const worktrees = await fs.readdir(worktreeDir);
    console.log("Created worktrees:", worktrees);
    expect(worktrees.length).toBeGreaterThanOrEqual(2); // At least master and one other branch
    expect(worktrees).toContain("master"); // Hello-World uses master, not main

    // Step 4: Test git operations in master worktree
    const masterWorktreePath = path.join(worktreeDir, "master");

    // Check git status
    const status = execSync("git status --porcelain", {
      cwd: masterWorktreePath,
      encoding: "utf-8",
    });
    expect(status).toBe(""); // Should be clean

    // Check current branch
    const branch = execSync("git branch --show-current", {
      cwd: masterWorktreePath,
      encoding: "utf-8",
    }).trim();
    expect(branch).toBe("master");

    // Check README exists
    const readmeExists = await fs
      .access(path.join(masterWorktreePath, "README"))
      .then(() => true)
      .catch(() => false);
    expect(readmeExists).toBe(true);

    // Step 5: Test git pull
    const pullOutput = execSync("git pull", {
      cwd: masterWorktreePath,
      encoding: "utf-8",
    });
    expect(pullOutput).toMatch(/Already up to date|Already up-to-date/);

    // Step 6: Test git operations on non-default branch
    // Find a non-master branch
    const nonDefaultBranch = worktrees.find((w) => w !== "master");
    if (nonDefaultBranch) {
      console.log(`Testing git operations on non-default branch: ${nonDefaultBranch}`);
      const nonDefaultPath = path.join(worktreeDir, nonDefaultBranch);

      // Test git status
      const nonDefaultStatus = execSync("git status --porcelain", {
        cwd: nonDefaultPath,
        encoding: "utf-8",
      });
      expect(nonDefaultStatus).toBe(""); // Should be clean

      // Test current branch
      const currentBranch = execSync("git branch --show-current", {
        cwd: nonDefaultPath,
        encoding: "utf-8",
      }).trim();
      expect(currentBranch).toBe(nonDefaultBranch);

      // Test git pull
      const nonDefaultPull = execSync("git pull", {
        cwd: nonDefaultPath,
        encoding: "utf-8",
      });
      expect(nonDefaultPull).toMatch(/Already up to date|Already up-to-date/);

      // Test git log
      const logOutput = execSync("git log --oneline -n 1", {
        cwd: nonDefaultPath,
        encoding: "utf-8",
      });
      expect(logOutput).toBeTruthy(); // Should have at least one commit

      // Test file modification in non-default branch
      const testFileNonDefault = path.join(nonDefaultPath, "test-non-default.txt");
      await fs.writeFile(testFileNonDefault, "Test in non-default branch\n");

      const statusWithFile = execSync("git status --porcelain", {
        cwd: nonDefaultPath,
        encoding: "utf-8",
      });
      expect(statusWithFile).toContain("test-non-default.txt");

      // Clean up
      await fs.unlink(testFileNonDefault);
    }

    // Step 7: Test file modification detection in master
    const testFile = path.join(masterWorktreePath, "test-e2e.txt");
    await fs.writeFile(testFile, "E2E test content\n");

    const statusAfter = execSync("git status --porcelain", {
      cwd: masterWorktreePath,
      encoding: "utf-8",
    });
    expect(statusAfter).toContain("test-e2e.txt");

    // Clean up test file
    await fs.unlink(testFile);

    // Step 8: Test idempotency - run sync again
    console.log("Running sync again to test idempotency...");
    const output2 = execSync(
      `node "${cliPath}" --repoUrl https://github.com/octocat/Hello-World.git --worktreeDir "${worktreeDir}" --bareRepoDir "${bareRepoDir}" --runOnce`,
      { encoding: "utf-8" },
    );

    expect(output2).toContain("Synchronization finished");

    // Verify same number of worktrees
    const worktreesAfter = await fs.readdir(worktreeDir);
    expect(worktreesAfter.length).toBe(worktrees.length);
  });

  it("should handle github/gitignore repository with many branches", async () => {
    const testDir = path.join(tmpBase, "gitignore-test");
    const worktreeDir = path.join(testDir, "worktrees");
    const bareRepoDir = path.join(testDir, "bare-repo");

    await fs.mkdir(testDir, { recursive: true });

    // Run sync-worktrees
    const output = execSync(
      `node "${cliPath}" --repoUrl https://github.com/github/gitignore.git --worktreeDir "${worktreeDir}" --bareRepoDir "${bareRepoDir}" --runOnce`,
      { encoding: "utf-8" },
    );

    expect(output).toContain("Clone successful");
    expect(output).toContain("Synchronization finished");

    // Verify worktrees
    const worktrees = await fs.readdir(worktreeDir);
    console.log(`Created ${worktrees.length} worktrees for gitignore repo`);
    expect(worktrees.length).toBeGreaterThan(3); // Should have several branches
    expect(worktrees).toContain("main");

    // Check a worktree has .gitignore files
    const mainPath = path.join(worktreeDir, "main");
    const files = await fs.readdir(mainPath);
    const gitignoreFiles = files.filter((f) => f.endsWith(".gitignore"));
    expect(gitignoreFiles.length).toBeGreaterThan(0);

    // Test git operations on a non-main branch
    const nonMainBranch = worktrees.find((w) => w !== "main");
    if (nonMainBranch) {
      console.log(`Testing git operations on non-default branch: ${nonMainBranch}`);
      const nonMainPath = path.join(worktreeDir, nonMainBranch);

      // Test git status
      const status = execSync("git status --porcelain", {
        cwd: nonMainPath,
        encoding: "utf-8",
      });
      expect(status).toBe(""); // Should be clean

      // Test current branch
      const branch = execSync("git branch --show-current", {
        cwd: nonMainPath,
        encoding: "utf-8",
      }).trim();
      expect(branch).toBe(nonMainBranch);

      // Test git pull
      const pullOutput = execSync("git pull", {
        cwd: nonMainPath,
        encoding: "utf-8",
      });
      expect(pullOutput).toMatch(/Already up to date|Already up-to-date/);

      // Test git diff between branches
      try {
        const diffOutput = execSync(`git diff main..${nonMainBranch} --name-only`, {
          cwd: nonMainPath,
          encoding: "utf-8",
        });
        const diffFiles = diffOutput.trim().split("\n").slice(0, 5);
        console.log(
          `Files different between main and ${nonMainBranch}:`,
          diffFiles.length > 0 ? diffFiles.join(", ") : "(none)",
        );
      } catch {
        // Diff might fail if branches don't share history
        console.log(`Could not diff main..${nonMainBranch}`);
      }
    }
  });
});

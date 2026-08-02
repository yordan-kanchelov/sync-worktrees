import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// A worktree directory deleted out-of-band (rm -rf, a failed backup restore, a
// wiped external volume) leaves git's registration behind. Sync must notice the
// registration is stale and rebuild the worktree instead of treating the branch
// as already present.
describe("Stale worktree registration E2E test", () => {
  let tempDir: string;
  let bareRepo: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let configPath: string;
  const binaryPath = path.join(__dirname, "../../../dist/index.js");

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-stale-reg-"));
    bareRepo = path.join(tempDir, "test-repo.git");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare");

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
    await fs.writeFile(path.join(initDir, "feature-1.txt"), "Content for feature-1");
    await initGit.add(".");
    await initGit.commit("Add feature-1");
    await initGit.push("origin", "feature-1");

    const bareGit = simpleGit(bareRepo);
    await bareGit.raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    await fs.rm(initDir, { recursive: true });

    configPath = path.join(tempDir, "sync-worktrees.config.js");
    await fs.writeFile(
      configPath,
      `export default {
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
`,
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("recreates a worktree whose directory was deleted out-of-band", async () => {
    const command = `node "${binaryPath}" --config "${configPath}"`;

    execSync(command, { encoding: "utf8" });

    const dirs = await fs.readdir(worktreeDir);
    const featureDir = dirs.find((d) => d.startsWith("feature-1-"));
    expect(featureDir).toBeDefined();
    const featurePath = path.join(worktreeDir, featureDir!);
    await expect(fs.readFile(path.join(featurePath, "feature-1.txt"), "utf8")).resolves.toBe("Content for feature-1");

    // The user deletes the checkout by hand. Git still has the registration.
    await fs.rm(featurePath, { recursive: true, force: true });
    const bareGit = simpleGit(bareRepoDir);
    const listing = await bareGit.raw(["worktree", "list", "--porcelain"]);
    expect(listing).toContain("prunable");

    const secondRun = execSync(command, { encoding: "utf8" });
    expect(secondRun).toContain("Synchronization finished");

    await expect(fs.readFile(path.join(featurePath, "feature-1.txt"), "utf8")).resolves.toBe("Content for feature-1");
  }, 60000);
});

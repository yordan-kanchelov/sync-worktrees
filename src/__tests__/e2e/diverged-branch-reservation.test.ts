import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// A diverged worktree leaves a preserved copy behind. That copy reserves the
// branch so a later restore can put it back at its original path — but the
// reservation must lift once the original path is genuinely free again,
// otherwise the branch can never be synced anymore.
describe("Diverged branch reservation E2E test", () => {
  let tempDir: string;
  let bareRepo: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let configPath: string;
  let seedDir: string;
  const binaryPath = path.join(__dirname, "../../../dist/index.js");

  const run = (): string => execSync(`node "${binaryPath}" --config "${configPath}"`, { encoding: "utf8" });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-diverged-res-"));
    bareRepo = path.join(tempDir, "test-repo.git");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare");
    seedDir = path.join(tempDir, "seed");

    await simpleGit().init(["--bare", bareRepo]);

    await fs.mkdir(seedDir);
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(seedDir, "README.md"), "# Test Repository");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", bareRepo);
    await seed.push("origin", "main");

    await seed.checkoutLocalBranch("feature-1");
    await fs.writeFile(path.join(seedDir, "feature-1.txt"), "upstream v1");
    await seed.add(".");
    await seed.commit("Add feature-1");
    await seed.push("origin", "feature-1");

    await simpleGit(bareRepo).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

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
      trash: { enabled: false },
    }
  ]
};
`,
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("re-creates a branch worktree after its diverged copy stops occupying the path", async () => {
    run();

    const featureDir = (await fs.readdir(worktreeDir)).find((d) => d.startsWith("feature-1-"));
    expect(featureDir).toBeDefined();
    const featurePath = path.join(worktreeDir, featureDir!);

    // Diverge: an unpushed local commit here, a rewritten history upstream.
    const wt = simpleGit(featurePath);
    await wt.addConfig("user.name", "Test User");
    await wt.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(featurePath, "local-only.txt"), "never pushed");
    await wt.add(".");
    await wt.commit("local only work");

    const seed = simpleGit(seedDir);
    await seed.checkout("feature-1");
    await fs.writeFile(path.join(seedDir, "feature-1.txt"), "upstream v2");
    await seed.add(".");
    await seed.commit("upstream rewrite");
    await seed.push(["--force", "origin", "feature-1"]);

    const divergeRun = run();
    expect(divergeRun).toContain("Moving to diverged");
    const divergedEntries = await fs.readdir(path.join(worktreeDir, ".diverged"));
    expect(divergedEntries).toHaveLength(1);
    // A fresh worktree took the original path back.
    await expect(fs.readFile(path.join(featurePath, "feature-1.txt"), "utf8")).resolves.toBe("upstream v2");

    // The user drops the fresh worktree themselves — cleanly, so git keeps no
    // stale registration and the original path is genuinely free again.
    await simpleGit(bareRepoDir).raw(["worktree", "remove", "--force", featurePath]);
    await expect(fs.access(featurePath)).rejects.toThrow();

    // feature-1 is still a remote branch, so sync must rebuild its worktree.
    const finalRun = run();
    expect(finalRun).toContain("Synchronization finished");

    await expect(fs.readFile(path.join(featurePath, "feature-1.txt"), "utf8")).resolves.toBe("upstream v2");
  }, 90000);
});

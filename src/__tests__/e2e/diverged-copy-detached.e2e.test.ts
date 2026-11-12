import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// A diverged worktree moved aside (to trash, or to .diverged/ with trash off)
// must not stay linked to the admin dir its replacement re-registers: git run
// inside the copy would act on the live branch. The recovery text must not
// send the user there either, and restoring the copy must give a clean tree.
describe("Diverged copy is detached from the live worktree (E2E)", () => {
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let configPath: string;
  let featurePath: string;
  const binaryPath = path.join(__dirname, "../../../dist/index.js");

  const cli = (args: string[]): string =>
    execFileSync("node", [binaryPath, ...args, "--config", configPath], { encoding: "utf8" });

  const gitIn = (dir: string, args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CEILING_DIRECTORIES: tempDir },
    }).trim();

  async function setup(trashEnabled: boolean): Promise<void> {
    await fs.writeFile(
      configPath,
      `export default {
  defaults: { runOnce: true },
  repositories: [
    {
      name: "app",
      repoUrl: "file://${remote}",
      worktreeDir: "${worktreeDir}",
      bareRepoDir: "${bareRepoDir}",
      trash: { enabled: ${trashEnabled} },
    }
  ]
};
`,
    );
    cli([]);

    const wt = simpleGit(featurePath);
    await wt.addConfig("user.name", "Test User");
    await wt.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(featurePath, "local-only.txt"), "never pushed");
    await wt.add(".");
    await wt.commit("local only work");

    const seed = simpleGit(seedDir);
    await fs.writeFile(path.join(seedDir, "feature.txt"), "upstream v2");
    await seed.add(".");
    await seed.commit("upstream rewrite");
    await seed.push(["--force", "origin", "feature"]);
  }

  function assertNoGitInsideCopy(text: string): void {
    expect(text).not.toMatch(/git diff origin\//);
    expect(text).not.toMatch(/git push --force-with-lease/);
    expect(text).not.toMatch(/(^|\s)cd \S/m);
  }

  async function assertDetached(copyPath: string, localCommit: string, liveCommit: string): Promise<void> {
    await expect(fs.readFile(path.join(copyPath, "local-only.txt"), "utf8")).resolves.toBe("never pushed");
    expect(() => gitIn(copyPath, ["rev-parse", "--git-dir"])).toThrow();
    // The live worktree and the preserved commit are untouched.
    expect(gitIn(featurePath, ["rev-parse", "HEAD"])).toBe(liveCommit);
    expect(gitIn(bareRepoDir, ["cat-file", "-t", localCommit])).toBe("commit");
  }

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-diverged-detach-")));
    remote = path.join(tempDir, "remote.git");
    seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare");
    configPath = path.join(tempDir, "sync-worktrees.config.js");
    featurePath = path.join(worktreeDir, "feature");

    await simpleGit().init(["--bare", remote]);
    await fs.mkdir(seedDir);
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(seedDir, "README.md"), "# app");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");
    await seed.checkoutLocalBranch("feature");
    await fs.writeFile(path.join(seedDir, "feature.txt"), "upstream v1");
    await seed.add(".");
    await seed.commit("Add feature");
    await seed.push("origin", "feature");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("trash on: the payload is detached, the text names the real id, restore leaves a clean tree", async () => {
    await setup(true);
    const localCommit = gitIn(featurePath, ["rev-parse", "HEAD"]);

    const output = cli([]);
    expect(output).toContain("Moving to diverged");
    assertNoGitInsideCopy(output);

    const trashRoot = path.join(worktreeDir, ".trash");
    const [id] = await fs.readdir(trashRoot);
    const containerPath = path.join(trashRoot, id);
    const payloadPath = path.join(containerPath, "payload");
    const liveCommit = gitIn(featurePath, ["rev-parse", "HEAD"]);
    expect(liveCommit).not.toBe(localCommit);
    await assertDetached(payloadPath, localCommit, liveCommit);

    const infoRaw = await fs.readFile(path.join(containerPath, ".diverged-info.json"), "utf8");
    const info = JSON.parse(infoRaw) as { instruction: string };
    assertNoGitInsideCopy(info.instruction);
    expect(info.instruction).toContain(`sync-worktrees trash restore ${id}`);
    expect(info.instruction).toContain(`branch feature-recovered ${localCommit}`);
    expect(info.instruction).not.toContain("<id>");
    await expect(fs.access(path.join(payloadPath, ".diverged-info.json"))).rejects.toThrow();
    expect(output).toContain(`sync-worktrees trash restore ${id}`);

    // Make room for the restore: drop the replacement and its branch.
    gitIn(bareRepoDir, ["worktree", "remove", "--force", featurePath]);
    gitIn(bareRepoDir, ["branch", "-D", "feature"]);
    cli(["trash", "restore", id]);

    expect(gitIn(featurePath, ["rev-parse", "HEAD"])).toBe(localCommit);
    expect(gitIn(featurePath, ["status", "--porcelain"])).toBe("");
    await expect(fs.access(path.join(featurePath, ".git.detached"))).rejects.toThrow();
  }, 90000);

  it("trash off: the .diverged copy is detached and the text points at the keep ref", async () => {
    await setup(false);
    const localCommit = gitIn(featurePath, ["rev-parse", "HEAD"]);

    const output = cli([]);
    expect(output).toContain("Moving to diverged");
    assertNoGitInsideCopy(output);

    const divergedRoot = path.join(worktreeDir, ".diverged");
    const [name] = await fs.readdir(divergedRoot);
    const copyPath = path.join(divergedRoot, name);
    const liveCommit = gitIn(featurePath, ["rev-parse", "HEAD"]);
    expect(liveCommit).not.toBe(localCommit);
    await assertDetached(copyPath, localCommit, liveCommit);

    const keepRef = `refs/sync-worktrees/keep/${name}`;
    expect(gitIn(bareRepoDir, ["rev-parse", keepRef])).toBe(localCommit);
    const info = JSON.parse(await fs.readFile(path.join(copyPath, ".diverged-info.json"), "utf8")) as {
      instruction: string;
    };
    assertNoGitInsideCopy(info.instruction);
    expect(info.instruction).toContain(`branch feature-recovered ${keepRef}`);
    expect(output).toContain(`branch feature-recovered ${keepRef}`);
  }, 90000);
});

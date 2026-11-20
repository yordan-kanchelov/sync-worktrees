import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorktreeStatusService } from "../worktree-status.service";

import type { SimpleGit } from "simple-git";

describe("WorktreeStatusService with a tag shadowing the branch name", () => {
  const BRANCH = "release-1";

  let tempDir: string;
  let remote: string;
  let bareRepoDir: string;
  let worktreePath: string;
  let worktreeGit: SimpleGit;
  let service: WorktreeStatusService;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-ambiguous-ref-")));
    remote = path.join(tempDir, "remote", "app.git");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    worktreePath = path.join(tempDir, "worktrees", BRANCH);

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

    const seedDir = path.join(tempDir, "seed");
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
    await seed.addTag(BRANCH);
    await seed.pushTags("origin");

    await simpleGit().clone(remote, bareRepoDir, ["--bare"]);
    const bare = simpleGit(bareRepoDir);
    await bare.addConfig("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    await bare.fetch(["origin"]);
    await bare.raw(["branch", BRANCH, `refs/tags/${BRANCH}`]);
    await bare.raw(["worktree", "add", worktreePath, BRANCH]);

    worktreeGit = simpleGit(worktreePath);
    await worktreeGit.addConfig("user.name", "Test User");
    await worktreeGit.addConfig("user.email", "test@example.com");

    service = new WorktreeStatusService();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const commitLocally = async (): Promise<void> => {
    await fs.writeFile(path.join(worktreePath, "hotfix.txt"), "fix");
    await worktreeGit.add(".");
    await worktreeGit.commit("Hotfix nobody has pushed");
  };

  it("still counts commits the bare name would hide", async () => {
    await commitLocally();

    const byBareName = (await worktreeGit.raw(["rev-list", "--count", BRANCH, "--not", "--remotes"])).trim();
    const byBranchRef = (
      await worktreeGit.raw(["rev-list", "--count", `refs/heads/${BRANCH}`, "--not", "--remotes"])
    ).trim();
    expect(byBareName).toBe("0");
    expect(byBranchRef).toBe("1");

    const status = await service.getFullWorktreeStatus(worktreePath);
    expect(status.hasUnpushedCommits).toBe(true);
    expect(status.canRemove).toBe(false);
    expect(status.reasons).toContain("unpushed commits");
  });

  it("still reports a fully pushed branch as removable", async () => {
    await commitLocally();
    await worktreeGit.push(["origin", `refs/heads/${BRANCH}:refs/heads/${BRANCH}`]);

    const status = await service.getFullWorktreeStatus(worktreePath);
    expect(status.hasUnpushedCommits).toBe(false);
    expect(status.canRemove).toBe(true);
    expect(status.reasons).toEqual([]);
  });
});

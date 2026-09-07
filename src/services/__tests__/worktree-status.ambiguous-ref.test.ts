import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorktreeStatusService } from "../worktree-status.service";

import type { SimpleGit } from "simple-git";

// Real git, no mocks. Cutting a branch from a same-named tag
// (`git checkout -b 1.4.2 1.4.2`) is the standard hotfix workflow, and it used
// to hide the branch's unpushed commits: git resolves a bare name through
// refs/tags/<name> before refs/heads/<name>, so
// `rev-list --count <name> --not --remotes` counted from the tag — which is on
// the remote — and returned 0. Git reports the shadowing only as
// `warning: refname '<name>' is ambiguous.` on stderr with exit 0, which
// simple-git treats as success, so the worktree read as "clean, nothing
// unpushed" and the prune pipeline was free to remove it.
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
    // The release tag and the hotfix branch share a name, and the tag's commit
    // is on the remote.
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

    // The shadowing itself, so the fixture keeps proving the bug it guards.
    const byBareName = (await worktreeGit.raw(["rev-list", "--count", BRANCH, "--not", "--remotes"])).trim();
    const byBranchRef = (
      await worktreeGit.raw(["rev-list", "--count", `refs/heads/${BRANCH}`, "--not", "--remotes"])
    ).trim();
    expect(byBareName).toBe("0");
    expect(byBranchRef).toBe("1");

    expect(await service.hasUnpushedCommits(worktreePath)).toBe(true);

    const status = await service.getFullWorktreeStatus(worktreePath);
    expect(status.hasUnpushedCommits).toBe(true);
    expect(status.canRemove).toBe(false);
    expect(status.reasons).toContain("unpushed commits");
  });

  it("still reports a fully pushed branch as removable", async () => {
    await commitLocally();
    // Explicit refspec: `git push origin release-1` is itself ambiguous here.
    await worktreeGit.push(["origin", `refs/heads/${BRANCH}:refs/heads/${BRANCH}`]);

    expect(await service.hasUnpushedCommits(worktreePath)).toBe(false);

    const status = await service.getFullWorktreeStatus(worktreePath);
    expect(status.hasUnpushedCommits).toBe(false);
    expect(status.canRemove).toBe(true);
    expect(status.reasons).toEqual([]);
  });
});

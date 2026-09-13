import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { GitService } from "../git.service";

import type { GitServiceOptions } from "../git.service";

// Real git, no mocks. The three inventory listings decide which branches exist
// on origin; a name they drop has no worktree created and, worse, an existing
// worktree for it is planned for prune as stale. Two ways a name used to be
// lost: "feature/HEAD" is a legal branch name that an endsWith("/HEAD") filter
// removes along with the origin/HEAD symref, and %(refname:short) is
// ambiguity-dependent — git prints refs/remotes/origin/x as "remotes/origin/x"
// once a local branch literally named "origin/x" exists, and shortens
// refs/remotes/origin/feature/HEAD to "origin/feature", a branch that does not
// exist at all.
describe("GitService remote branch inventory (real git)", () => {
  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let gitService: GitService;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-remote-refs-")));
    remote = path.join(tempDir, "remote", "app.git");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");

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
    // Every name git can print in a surprising shape: a branch ending in
    // "/HEAD", one literally named "origin", one carrying "|", and one whose
    // short form collides with a local branch created below.
    for (const branch of ["feature/HEAD", "origin", "feature|wip", "topic"]) {
      await seed.raw(["push", "origin", `refs/heads/main:refs/heads/${branch}`]);
    }
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    gitService = new GitService(
      { repoUrl: `file://${remote}`, worktreeDir, bareRepoDir } satisfies GitServiceOptions,
      createMockLogger(),
    );
    await gitService.initialize();

    const bare = simpleGit(bareRepoDir);
    // The symref sync must skip — and the only ref under refs/remotes/origin
    // that is not a branch.
    await bare.raw(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    // A local branch literally named "origin/topic": git now has to
    // disambiguate refs/remotes/origin/topic and prints "remotes/origin/topic"
    // for %(refname:short).
    await bare.raw(["branch", "origin/topic", "refs/remotes/origin/main"]);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const expected = ["feature/HEAD", "feature|wip", "main", "origin", "topic"];

  it("getRemoteBranches lists every remote branch and only skips the origin/HEAD symref", async () => {
    const branches = await gitService.getRemoteBranches();

    expect([...branches].sort()).toEqual(expected);
    expect(branches).not.toContain("HEAD");
  });

  it("getRemoteBranchesWithActivity lists the same branches", async () => {
    const withActivity = await gitService.getRemoteBranchesWithActivity();

    expect(withActivity.map((b) => b.branch).sort()).toEqual(expected);
    expect(withActivity.every((b) => !isNaN(b.lastActivity.getTime()))).toBe(true);
  });

  it("getRemoteBranchTips maps the same branches to their tips", async () => {
    const tips = await gitService.getRemoteBranchTips();
    const mainTip = (await simpleGit(bareRepoDir).revparse(["refs/remotes/origin/main"])).trim();

    expect([...tips.keys()].sort()).toEqual(expected);
    expect(tips.get("feature/HEAD")).toBe(mainTip);
    expect(tips.get("topic")).toBe(mainTip);
    expect(tips.has("HEAD")).toBe(false);
  });
});

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { GitService } from "../git.service";

import type { SimpleGit } from "simple-git";
import type { GitServiceOptions } from "../git.service";

// Real git, no mocks. This is the primitive two safety decisions rest on —
// whether a trash entry gets a bundle, and whether a reaped entry gets a
// permanent keep ref — so what it answers for a squash merge, for a re-push and
// for a remote-tracking ref git has not pruned yet is pinned here rather than
// assumed.
describe("GitService.countCommitsNotOnAnyRemote (real git)", () => {
  let tempDir: string;
  let remote: string;
  let seed: SimpleGit;
  let gitService: GitService;
  let featureTip: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-not-on-remote-")));
    remote = path.join(tempDir, "remote", "app.git");
    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

    const seedDir = path.join(tempDir, "seed");
    await fs.mkdir(seedDir);
    seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(seedDir, "README.md"), "# app");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");

    // A feature branch, pushed: two commits the remote has seen.
    await seed.checkoutLocalBranch("feature");
    await fs.writeFile(path.join(seedDir, "one.txt"), "1");
    await seed.add(".");
    await seed.commit("feature one");
    await fs.writeFile(path.join(seedDir, "two.txt"), "2");
    await seed.add(".");
    await seed.commit("feature two");
    featureTip = (await seed.revparse(["HEAD"])).trim();
    await seed.push("origin", "feature");

    gitService = new GitService(
      {
        repoUrl: `file://${remote}`,
        worktreeDir: path.join(tempDir, "worktrees"),
        bareRepoDir: path.join(tempDir, ".bare", "app"),
      } satisfies GitServiceOptions,
      createMockLogger(),
    );
    await gitService.initialize();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("counts zero while the branch is still on the remote", async () => {
    expect(await gitService.countCommitsNotOnAnyRemote(featureTip)).toBe(0);
  });

  // The case the keep-ref policy exists for, and the reason the reap-time
  // re-check is NOT a cure for keep refs piling up: a squash merge puts the
  // branch's CONTENT on main as one new commit, so the original commits are
  // reachable from no remote-tracking ref and still need an anchor.
  it("still counts the original commits after a squash merge and branch deletion", async () => {
    await seed.checkout("main");
    await seed.raw(["merge", "--squash", "feature"]);
    await seed.commit("squash: feature");
    await seed.push("origin", "main");
    await seed.push(["origin", "--delete", "feature"]);
    await gitService.fetchAll();

    expect(await gitService.countCommitsNotOnAnyRemote(featureTip)).toBe(2);
  });

  // The case the re-check does catch: the same commits reach the remote again
  // under another name, so a permanent ref of our own adds nothing.
  it("counts zero once the same commits reach the remote under another name", async () => {
    await seed.push(["origin", "--delete", "feature"]);
    await gitService.fetchAll();
    expect(await gitService.countCommitsNotOnAnyRemote(featureTip)).toBe(2);

    await seed.push(["origin", "feature:refs/heads/feature-again"]);
    await gitService.fetchAll();

    expect(await gitService.countCommitsNotOnAnyRemote(featureTip)).toBe(0);
  });

  // Why callers may only act on a zero when they can vouch for the ref set: a
  // remote-tracking ref git has not pruned yet keeps its commits reachable, so
  // this reads zero for a branch the remote has already dropped.
  it("reads zero from a remote-tracking ref the fetch has not pruned yet", async () => {
    await seed.push(["origin", "--delete", "feature"]);

    expect(await gitService.countCommitsNotOnAnyRemote(featureTip)).toBe(0);

    await gitService.fetchAll();

    expect(await gitService.countCommitsNotOnAnyRemote(featureTip)).toBe(2);
  });

  it("throws rather than answering zero for an oid git cannot resolve", async () => {
    await expect(gitService.countCommitsNotOnAnyRemote("0".repeat(40))).rejects.toThrow();
  });
});

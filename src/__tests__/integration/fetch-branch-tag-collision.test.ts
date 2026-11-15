import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitService } from "../../services/git.service";
import { createMockLogger } from "../test-utils";

import type { SimpleGit } from "simple-git";

// `git fetch origin v1` resolves a short name through refs/tags/ first, so a
// branch that shares its name with a tag was never fetched: FETCH_HEAD got the
// tag and refs/remotes/origin/v1 stayed where it was.
describe("fetchBranch with a tag of the same name (E2E)", () => {
  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let seed: SimpleGit;
  let seedDir: string;
  let gitService: GitService;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-fetch-tag-")));
    remote = path.join(tempDir, "remote", "app.git");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

    seedDir = path.join(tempDir, "seed");
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
    await seed.raw(["tag", "v1"]);
    await seed.push("origin", "refs/tags/v1");
    await seed.checkout(["-b", "v1", "main"]);
    await fs.writeFile(path.join(seedDir, "v1.txt"), "one");
    await seed.add(".");
    await seed.commit("v1 work");
    await seed.push("origin", "refs/heads/v1");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    gitService = new GitService(
      { repoUrl: `file://${remote}`, worktreeDir, bareRepoDir, skipLfs: true },
      createMockLogger(),
    );
    await gitService.initialize();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("updates refs/remotes/origin/v1 to the remote branch tip", async () => {
    await fs.writeFile(path.join(seedDir, "v1.txt"), "two");
    await seed.add(".");
    await seed.commit("more v1 work");
    await seed.push("origin", "refs/heads/v1");
    const remoteTip = (await simpleGit(remote).raw(["rev-parse", "refs/heads/v1"])).trim();

    await gitService.fetchBranch("v1");

    const tracked = (await simpleGit(bareRepoDir).raw(["rev-parse", "refs/remotes/origin/v1"])).trim();
    expect(tracked).toBe(remoteTip);
  });
});

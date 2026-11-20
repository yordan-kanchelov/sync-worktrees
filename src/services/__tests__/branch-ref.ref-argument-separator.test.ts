import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { GitService } from "../git.service";

import type { GitServiceOptions } from "../git.service";
import type { SimpleGit } from "simple-git";

describe("git wrappers that pass a ref read out of a manifest (real git)", () => {
  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let gitService: GitService;
  let bare: SimpleGit;
  let mainOid: string;

  async function localRefs(): Promise<string[]> {
    const raw = await bare.raw(["for-each-ref", "--format=%(refname)", "refs/heads/"]);
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async function headBranch(): Promise<string> {
    return (await bare.raw(["symbolic-ref", "HEAD"])).trim();
  }

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-ref-separator-")));
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
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    gitService = new GitService(
      { repoUrl: `file://${remote}`, worktreeDir, bareRepoDir } satisfies GitServiceOptions,
      createMockLogger(),
    );
    await gitService.initialize();
    bare = simpleGit(bareRepoDir);
    mainOid = (await bare.raw(["rev-parse", "refs/heads/main"])).trim();

    expect(await headBranch()).toBe("refs/heads/main");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("createBranchAt", () => {
    it.each(["-m", "--delete", "-D"])(
      "refuses the option-shaped branch name %s instead of renaming the bare repo's HEAD branch",
      async (branchName) => {
        await expect(gitService.createBranchAt(branchName, mainOid)).rejects.toThrow();

        expect(await localRefs()).toEqual(["refs/heads/main"]);
        expect(await headBranch()).toBe("refs/heads/main");
      },
    );

    it("refuses an option-shaped start point instead of renaming the bare repo's HEAD branch", async () => {
      await expect(gitService.createBranchAt("restored", "-m")).rejects.toThrow();

      expect(await localRefs()).toEqual(["refs/heads/main"]);
      expect(await headBranch()).toBe("refs/heads/main");
    });

    it.each(["feature/x.y", "release-1.0", "team/area/sub", "fonctionnalité", "@"])(
      "still creates the branch %s",
      async (branchName) => {
        await gitService.createBranchAt(branchName, mainOid);

        expect(await localRefs()).toContain(`refs/heads/${branchName}`);
        expect((await bare.raw(["rev-parse", `refs/heads/${branchName}`])).trim()).toBe(mainOid);
      },
    );
  });

  describe("addWorktreeNoCheckout", () => {
    it.each(["--force", "--detach", "-q", "--lock"])(
      "refuses the option-shaped branch %s instead of registering some other worktree",
      async (branchName) => {
        const target = path.join(worktreeDir, "restored");

        await expect(gitService.addWorktreeNoCheckout(branchName, target)).rejects.toThrow();

        expect(await localRefs()).toEqual(["refs/heads/main"]);
        const registered = await bare.raw(["worktree", "list", "--porcelain"]);
        expect(registered).not.toContain(target);
        await expect(fs.access(path.join(target, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
      },
    );

    it("still registers a worktree for a branch whose name only looks odd", async () => {
      await gitService.createBranchAt("feature/x.y", mainOid);
      const target = path.join(worktreeDir, "feature-x.y");

      await gitService.addWorktreeNoCheckout("feature/x.y", target);

      expect(await bare.raw(["worktree", "list", "--porcelain"])).toContain("branch refs/heads/feature/x.y");
    });
  });

  describe("updateRef", () => {
    it("refuses an option-shaped value instead of deleting the ref it was asked to write", async () => {
      await bare.raw(["update-ref", "--", "refs/sync-worktrees/keep/entry", mainOid]);

      await expect(gitService.updateRef("refs/sync-worktrees/keep/entry", "-d")).rejects.toThrow();

      expect((await bare.raw(["rev-parse", "refs/sync-worktrees/keep/entry"])).trim()).toBe(mainOid);
    });

    it("still writes a ref with an ordinary oid", async () => {
      await gitService.updateRef("refs/sync-worktrees/keep/ordinary", mainOid);

      expect((await bare.raw(["rev-parse", "refs/sync-worktrees/keep/ordinary"])).trim()).toBe(mainOid);
    });
  });

  describe("deleteLocalBranch", () => {
    it("treats an option-shaped argument as a branch name to look up, not as an option", async () => {
      await expect(gitService.deleteLocalBranch("-m")).rejects.toThrow(/branch '-m' not found/);

      expect(await localRefs()).toEqual(["refs/heads/main"]);
      expect(await headBranch()).toBe("refs/heads/main");
    });

    it("still deletes a branch whose name only looks odd", async () => {
      await gitService.createBranchAt("feature/x.y", mainOid);

      await gitService.deleteLocalBranch("feature/x.y");

      expect(await localRefs()).toEqual(["refs/heads/main"]);
    });
  });
});

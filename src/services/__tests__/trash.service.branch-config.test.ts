import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { GitService } from "../git.service";
import { TrashService } from "../trash.service";

import type { GitServiceOptions } from "../git.service";
import type { Config } from "../../types";
import type { RemovalAuditService } from "../removal-audit.service";
import type { SimpleGit } from "simple-git";

// Real git, no mocks. `git branch -D` removes the branch's `[branch "<name>"]`
// config section along with the ref; the compare-and-swap delete the trash
// pipeline uses — `update-ref -d refs/heads/<b> <oid>` — removes only the ref.
// Measured on git 2.43: after the CAS delete `branch.<b>.remote`/`.merge` are
// still in the bare repo's config, so every pruned worktree used to leave a
// dead section behind and the file grew without bound. These tests pin the
// cleanup, and pin that it never fires when the CAS delete was refused.
describe("branch config sections after a trashed worktree's branch ref is deleted (real git)", () => {
  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let gitService: GitService;
  let trash: TrashService;
  let bare: SimpleGit;

  async function branchConfig(branchName: string): Promise<string> {
    // `--get-regexp` exits 1 with an empty stderr when nothing matches, which
    // simple-git resolves to "" rather than rejecting — exactly the "no keys
    // left" answer these assertions want.
    const escaped = branchName.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    return (await bare.raw(["config", "--get-regexp", `^branch\\.${escaped}\\.`])).trim();
  }

  // The section HEADER, which `--get-regexp` cannot see: an implementation
  // that unsets the two upstream keys individually leaves `[branch "x"]`
  // behind with nothing under it, and every key-level assertion still passes.
  async function rawConfigText(): Promise<string> {
    return fs.readFile(path.join(bareRepoDir, "config"), "utf-8");
  }

  async function localRefs(): Promise<string[]> {
    const raw = await bare.raw(["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async function addWorktreeFor(branchName: string): Promise<string> {
    const dirPath = path.join(worktreeDir, branchName.replace(/\//g, "-"));
    await bare.raw(["worktree", "add", "--track", "-b", branchName, dirPath, `origin/${branchName}`]);
    return dirPath;
  }

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-branch-config-")));
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
    for (const branchName of ["x", "v1", "v1.2", "untracked", "Feature-X"]) {
      await seed.raw(["push", "origin", `refs/heads/main:refs/heads/${branchName}`]);
    }
    // A second, genuinely different commit: the compare-and-swap test needs an
    // oid that is not the one every branch above was created from.
    await fs.writeFile(path.join(seedDir, "later.txt"), "later");
    await seed.add(".");
    await seed.commit("A later commit");
    await seed.raw(["push", "origin", "refs/heads/main:refs/heads/sideline"]);
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    const logger = createMockLogger();
    gitService = new GitService(
      { repoUrl: `file://${remote}`, worktreeDir, bareRepoDir } satisfies GitServiceOptions,
      logger,
    );
    await gitService.initialize();
    bare = simpleGit(bareRepoDir);

    const config: Config = {
      repoUrl: `file://${remote}`,
      worktreeDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
    };
    trash = new TrashService(config, gitService, logger, {
      record: async () => {},
    } as unknown as RemovalAuditService);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("leaves no branch.<name>.* keys in the bare repo config after trashing the worktree", async () => {
    const dirPath = await addWorktreeFor("x");
    // The fixture is git's own doing, not hand-written: `worktree add --track`
    // writes the upstream keys the CAS delete used to strand.
    expect(await branchConfig("x")).toContain("branch.x.remote");
    expect(await branchConfig("x")).toContain("branch.x.merge");

    const { branchRefError } = await trash.trashAndUnregisterWorktree({
      dirPath,
      branch: "x",
      reason: "prune",
    });

    expect(branchRefError).toBeUndefined();
    expect(await localRefs()).not.toContain("x");
    expect(await branchConfig("x")).toBe("");
  });

  it("keeps the config section when the compare-and-swap delete is refused, because the branch is still live", async () => {
    const dirPath = await addWorktreeFor("x");
    const verifiedOid = (await bare.raw(["rev-parse", "refs/heads/x"])).trim();
    const movedOid = (await bare.raw(["rev-parse", "refs/remotes/origin/sideline"])).trim();
    expect(movedOid).not.toBe(verifiedOid);
    // Same shape as a commit landing between the HEAD verification and the
    // delete: the manifest's oid no longer matches the ref, so git refuses.
    await bare.raw(["update-ref", "refs/heads/x", movedOid, verifiedOid]);

    await expect(
      trash.deleteTrashedBranchRef({
        branch: "x",
        id: "trash-1",
        pinRef: "refs/sync-worktrees/trash/trash-1",
        headOid: verifiedOid,
      }),
    ).rejects.toThrow();

    expect(await localRefs()).toContain("x");
    expect(await branchConfig("x")).toContain("branch.x.remote");

    await fs.rm(dirPath, { recursive: true, force: true });
  });

  it("still reports the removal as successful when the branch has no config section to remove", async () => {
    const dirPath = await addWorktreeFor("untracked");
    // git reports `--remove-section` on an absent section as a hard failure
    // (exit 128 with stderr, which simple-git rejects). Tolerating that is
    // what keeps a branch deletion that did succeed from reading as failed.
    await bare.raw(["config", "--remove-section", "branch.untracked"]);
    expect(await branchConfig("untracked")).toBe("");

    const { branchRefError } = await trash.trashAndUnregisterWorktree({
      dirPath,
      branch: "untracked",
      reason: "prune",
    });

    expect(branchRefError).toBeUndefined();
    expect(await localRefs()).not.toContain("untracked");
  });

  it("removes the whole section, not just the two upstream keys", async () => {
    const dirPath = await addWorktreeFor("x");
    // `git branch -D` drops the entire `[branch "<name>"]` section, keys it
    // never wrote included — measured on git 2.43 against `.description` and
    // `.rebase`. Matching that is the whole claim, and unsetting
    // `branch.x.remote`/`.merge` one at a time would satisfy every key-level
    // assertion in this file while leaving an empty header and this key behind.
    await bare.raw(["config", "branch.x.description", "notes about x"]);
    expect(await rawConfigText()).toContain('[branch "x"]');

    const { branchRefError } = await trash.trashAndUnregisterWorktree({
      dirPath,
      branch: "x",
      reason: "prune",
    });

    expect(branchRefError).toBeUndefined();
    expect(await branchConfig("x")).toBe("");
    expect(await rawConfigText()).not.toContain('[branch "x"]');
  });

  it("matches the branch name's case exactly, so a mixed-case branch loses its section too", async () => {
    // Config subsections are case-SENSITIVE: `--remove-section branch.feature-x`
    // against `[branch "Feature-X"]` is `fatal: no such section` (exit 128),
    // which this code swallows — so a lower-cased name would silently leak the
    // section of every branch that is not already lowercase. `JIRA-123` and
    // `Release/2.0` are ordinary names in the repositories this tool syncs.
    const dirPath = await addWorktreeFor("Feature-X");
    expect(await branchConfig("Feature-X")).toContain("branch.Feature-X.remote");

    const { branchRefError } = await trash.trashAndUnregisterWorktree({
      dirPath,
      branch: "Feature-X",
      reason: "prune",
    });

    expect(branchRefError).toBeUndefined();
    expect(await localRefs()).not.toContain("Feature-X");
    expect(await branchConfig("Feature-X")).toBe("");
    expect(await rawConfigText()).not.toContain('[branch "Feature-X"]');
  });

  it("removes only the trashed branch's section when another branch name is a dotted prefix of it", async () => {
    // `git config --remove-section branch.v1.2` splits at the FIRST dot and
    // treats "v1.2" as the whole subsection name, so the sibling `branch.v1`
    // section must survive untouched. Verified against git 2.43.
    const dirPath = await addWorktreeFor("v1.2");
    await addWorktreeFor("v1");
    expect(await branchConfig("v1")).toContain("branch.v1.remote");

    const { branchRefError } = await trash.trashAndUnregisterWorktree({
      dirPath,
      branch: "v1.2",
      reason: "prune",
    });

    expect(branchRefError).toBeUndefined();
    expect(await branchConfig("v1.2")).toBe("");
    expect(await localRefs()).not.toContain("v1.2");
    expect(await branchConfig("v1")).toContain("branch.v1.remote");
    expect(await localRefs()).toContain("v1");
  });
});

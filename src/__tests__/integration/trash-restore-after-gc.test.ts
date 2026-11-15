import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GIT_CONSTANTS } from "../../constants";
import { PathResolutionService } from "../../services/path-resolution.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { createMockLogger } from "../test-utils";

import type { RepositoryConfig } from "../../types";

// Real git, real trash, real `gc`. The pin ref is the only reason a restore
// is possible at all once the removal pipeline has deleted the branch ref and
// `fetch --prune` has dropped the remote-tracking one: from that moment the
// trashed HEAD is reachable from nothing else in the object store. Every other
// restore test stops before a garbage collector ever runs, so the pin's whole
// purpose — and the sequence restore rebuilds the worktree with — is asserted
// here against a repository that has actually been collected.
describe("Restoring a trashed worktree after a gc (E2E)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let featurePath: string;

  function bare(args: string[]): string {
    return execFileSync("git", ["-C", bareRepoDir, ...args], { encoding: "utf-8" }).trim();
  }

  function objectExists(oid: string): boolean {
    try {
      execFileSync("git", ["-C", bareRepoDir, "cat-file", "-e", `${oid}^{commit}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  function registeredWorktrees(): string[] {
    return bare(["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim());
  }

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-restore-gc-")));
    remote = path.join(tempDir, "remote", "app.git");
    seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

    await fs.mkdir(seedDir);
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(seedDir, "README.md"), "# app\n");
    await fs.writeFile(path.join(seedDir, ".gitignore"), "node_modules/\n");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");

    // `feature` carries a commit of its own, so once its remote branch is gone
    // the only ref left anywhere pointing at it is the trash pin.
    await seed.checkoutLocalBranch("feature");
    await fs.writeFile(path.join(seedDir, "feature-only.txt"), "work that only this branch has\n");
    await seed.add(".");
    await seed.commit("Work only this branch has");
    await seed.push("origin", "feature");
    await seed.checkout("main");

    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    featurePath = pathResolution.getBranchWorktreePath(worktreeDir, "feature");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeService(): WorktreeSyncService {
    const config: RepositoryConfig = {
      name: "app",
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      logger: createMockLogger(),
      retry: { maxAttempts: 1, initialDelayMs: 0 },
      __configFileDir: tempDir,
    } as RepositoryConfig;
    return new WorktreeSyncService(config);
  }

  /**
   * Syncs once to create the worktrees, drops `feature` on the remote, and
   * syncs again so the prune path trashes it through the real removal
   * pipeline — payload to trash, registration cleared, branch ref deleted.
   * Returns the trash id and the commit the worktree was on.
   */
  async function trashFeatureByPruning(service: WorktreeSyncService): Promise<{ id: string; headOid: string }> {
    await service.initialize();
    await service.sync();
    expect(registeredWorktrees()).toContain(featurePath);
    const headOid = (await simpleGit(featurePath).revparse(["HEAD"])).trim();

    // Ignored build output: not a reason to keep the worktree (the prune path
    // needs a clean one), but it has to come back with the payload — it is the
    // part a `git checkout` could never reproduce.
    await fs.mkdir(path.join(featurePath, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(featurePath, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");

    await simpleGit(remote).raw(["update-ref", "-d", "refs/heads/feature"]);
    await service.sync();

    const { entries } = await service.listTrashEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].manifest.branch).toBe("feature");
    expect(entries[0].manifest.headOid).toBe(headOid);
    expect(entries[0].manifest.pinRef).not.toBeNull();

    // Nothing but the pin is holding the commit now.
    expect(registeredWorktrees()).not.toContain(featurePath);
    expect(bare(["for-each-ref", "--format=%(refname)", "refs/heads/feature"])).toBe("");
    expect(bare(["for-each-ref", "--format=%(refname)", "refs/remotes/origin/feature"])).toBe("");
    expect(await service.listKeepRefs()).toEqual([]);

    return { id: entries[0].manifest.id, headOid };
  }

  it("rebuilds the worktree on the pinned commit, with the payload's files, after gc has collected everything else", async () => {
    const service = makeService();
    const { id, headOid } = await trashFeatureByPruning(service);

    // The garbage collector every restore test so far has been spared. With
    // the branch ref deleted and the remote-tracking ref pruned, the pin is
    // the last thing standing between this commit and `--prune=now`.
    bare(["gc", "--prune=now"]);
    expect(objectExists(headOid)).toBe(true);
    expect(bare(["for-each-ref", "--format=%(refname)", GIT_CONSTANTS.TRASH_REF_PREFIX])).toContain(id);

    await expect(service.restoreFromTrash(id)).resolves.toMatchObject({ id, branch: "feature" });

    // Registered, on the commit the manifest pinned, and on its own branch.
    expect(registeredWorktrees()).toContain(featurePath);
    const restored = simpleGit(featurePath);
    await expect(restored.revparse(["HEAD"])).resolves.toBe(headOid);
    await expect(restored.raw(["rev-parse", "--abbrev-ref", "HEAD"])).resolves.toBe("feature\n");
    // `reset` ran: the index matches HEAD, so the checkout reads as clean
    // rather than as a tree full of untracked files.
    await expect(restored.raw(["status", "--porcelain"])).resolves.toBe("");
    await expect(fs.readFile(path.join(featurePath, "feature-only.txt"), "utf-8")).resolves.toBe(
      "work that only this branch has\n",
    );
    // The ignored payload git would never have checked out.
    await expect(fs.readFile(path.join(featurePath, "node_modules", "pkg", "index.js"), "utf-8")).resolves.toBe(
      "module.exports = 1;\n",
    );

    // The entry and its pin are released once the files are back.
    await expect(service.listTrashEntries()).resolves.toMatchObject({ entries: [], invalid: [] });
    expect(bare(["for-each-ref", "--format=%(refname)", GIT_CONSTANTS.TRASH_REF_PREFIX])).toBe("");
  });

  it("keeps the payload in the trash when the pinned commit did not survive the gc", async () => {
    const service = makeService();
    const { id, headOid } = await trashFeatureByPruning(service);

    // What a failed pin-ref delete during an earlier restore, or a hand-emptied
    // ref namespace, leaves behind: a manifest that still names its commit and
    // an object store that no longer has it.
    const pinRef = (await service.listTrashEntries()).entries[0].manifest.pinRef!;
    bare(["update-ref", "-d", "--", pinRef]);
    bare(["gc", "--prune=now"]);
    expect(objectExists(headOid)).toBe(false);

    // Surfaced as git's own "not a valid branch point" today: `createBranchAt`
    // sits outside restoreAsWorktree's try/catch, so the failure is not dressed
    // in the "trash entry left intact" wrapper the later steps get. What is
    // asserted here is the part that matters either way — the error names the
    // commit that is missing, and nothing was destroyed reaching it.
    await expect(service.restoreFromTrash(id)).rejects.toThrow(headOid);

    // Nothing was moved and nothing was registered: the destructive half of
    // restore never starts when the branch cannot be recreated.
    expect(registeredWorktrees()).not.toContain(featurePath);
    await expect(fs.access(featurePath)).rejects.toMatchObject({ code: "ENOENT" });
    const { entries } = await service.listTrashEntries();
    expect(entries.map((entry) => entry.manifest.id)).toEqual([id]);
    await expect(fs.readFile(path.join(entries[0].payloadPath, "feature-only.txt"), "utf-8")).resolves.toBe(
      "work that only this branch has\n",
    );
    await expect(
      fs.readFile(path.join(entries[0].payloadPath, "node_modules", "pkg", "index.js"), "utf-8"),
    ).resolves.toBe("module.exports = 1;\n");
  });
});

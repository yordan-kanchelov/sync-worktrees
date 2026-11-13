import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GIT_CONSTANTS, METADATA_CONSTANTS } from "../../constants";
import { PathResolutionService } from "../../services/path-resolution.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { createMockLogger } from "../test-utils";

import type { RepositoryConfig } from "../../types";

// Real git, real trash, real `gc`. Force clean is the only operation in the
// tool that is meant to be irreversible, and it gets there in three steps that
// only make sense together: purge the selected trash entries (releasing their
// pin refs), delete the selected keep refs except the ones a `.diverged/`
// directory still needs, then collect. Tests that mock the purge can say the
// counts came out right; only a real object store can say which commits are
// actually gone afterwards and which survived on purpose.
describe("Force clean object reclamation (E2E)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;

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

  /**
   * A commit reachable from nothing, standing in for work a developer made in a
   * worktree and never pushed. `commit-tree` rather than a branch-and-delete
   * dance so the only thing that ever points at it is the ref the test puts
   * there.
   */
  function makeUnreferencedCommit(message: string): string {
    const tree = bare(["rev-parse", "main^{tree}"]);
    return bare([
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.com",
      "commit-tree",
      tree,
      "-p",
      bare(["rev-parse", "main"]),
      "-m",
      message,
    ]);
  }

  /** The pre-trash diverge flow's two halves: the backup directory and the keep ref holding its commits. */
  async function makeLegacyDivergedBackup(name: string, message: string): Promise<string> {
    const oid = makeUnreferencedCommit(message);
    const dirPath = path.join(worktreeDir, GIT_CONSTANTS.DIVERGED_DIR_NAME, name);
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(path.join(dirPath, "work.txt"), "never pushed\n");
    await fs.writeFile(
      path.join(dirPath, METADATA_CONSTANTS.DIVERGED_INFO_FILE),
      JSON.stringify({ originalBranch: name, localCommit: oid, keepRef: `${GIT_CONSTANTS.KEEP_REF_PREFIX}${name}` }),
    );
    bare(["update-ref", "--", `${GIT_CONSTANTS.KEEP_REF_PREFIX}${name}`, oid]);
    return oid;
  }

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-force-clean-reclaim-")));
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
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");

    // `gone` carries a commit of its own, so once its remote branch is deleted
    // the trash pin is the only ref in the repository that reaches it.
    await seed.checkoutLocalBranch("gone");
    await fs.writeFile(path.join(seedDir, "gone-only.txt"), "work that only this branch has\n");
    await seed.add(".");
    await seed.commit("Work only this branch has");
    await seed.push("origin", "gone");
    await seed.checkout("main");

    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
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
      // Legacy adoption would move the `.diverged/` backup below into the trash
      // and retire its keep ref, which is the other flow entirely. This test is
      // about the backup force clean finds still sitting there.
      trash: { migrateLegacy: false },
      // `gc --prune=now`: the default forced run prunes on a one-hour window
      // measured from each object's mtime, which is covered by the maintenance
      // E2E. Here the question is only which commits were still reachable when
      // the collector ran, so nothing should turn on file timestamps.
      maintenance: { aggressive: true },
      __configFileDir: tempDir,
    } as RepositoryConfig;
    return new WorktreeSyncService(config);
  }

  it("collects the purged entry's commits and the deleted keep ref's, and keeps the ones a .diverged/ backup still needs", async () => {
    const gonePath = pathResolution.getBranchWorktreePath(worktreeDir, "gone");

    const service = makeService();
    await service.initialize();
    await service.sync();
    const goneOid = (await simpleGit(gonePath).revparse(["HEAD"])).trim();

    await simpleGit(remote).raw(["update-ref", "-d", "refs/heads/gone"]);
    await service.sync();

    const { entries } = await service.listTrashEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].manifest.keepPinOnReap).toBe(true);
    expect(entries[0].manifest.headOid).toBe(goneOid);

    // Two keep refs from the pre-trash diverge flow. Only one still has the
    // `.diverged/` directory whose recovery instructions point at it.
    const keptOid = await makeLegacyDivergedBackup("kept-backup", "Backup the user can still see");
    const strandedOid = makeUnreferencedCommit("Backup whose directory is long gone");
    bare(["update-ref", "--", `${GIT_CONSTANTS.KEEP_REF_PREFIX}stranded-backup`, strandedOid]);

    expect(objectExists(goneOid)).toBe(true);
    expect(objectExists(keptOid)).toBe(true);
    expect(objectExists(strandedOid)).toBe(true);

    const preview = await service.getForceCleanPreview();
    expect(preview.trashEntries).toBe(1);
    expect([...preview.keepRefNames].sort()).toEqual([
      `${GIT_CONSTANTS.KEEP_REF_PREFIX}kept-backup`,
      `${GIT_CONSTANTS.KEEP_REF_PREFIX}stranded-backup`,
    ]);

    const result = await service.forceClean(preview);

    expect(result.errors).toEqual([]);
    expect(result.trashDeleted).toBe(1);
    expect(result.keepRefsDeleted).toBe(1);
    expect(result.keepRefsRetained).toBe(1);
    expect(result.gcSkipped).toBe(false);
    expect(result.gcSucceeded).toBe(true);

    // The trash entry is gone, and so is the pin that was its commits' only
    // protection — the purge path deliberately mints no replacement keep ref.
    await expect(service.listTrashEntries()).resolves.toMatchObject({ entries: [], invalid: [] });
    expect(bare(["for-each-ref", "--format=%(refname)", GIT_CONSTANTS.TRASH_REF_PREFIX])).toBe("");
    expect(objectExists(goneOid)).toBe(false);

    // The keep ref nothing points at anymore went with it.
    expect(objectExists(strandedOid)).toBe(false);

    // The one whose `.diverged/` directory is still on disk survived both the
    // ref sweep and the collector: the files and the commits they were made on
    // are the two halves of one backup.
    await expect(service.listKeepRefs()).resolves.toEqual([`${GIT_CONSTANTS.KEEP_REF_PREFIX}kept-backup`]);
    expect(objectExists(keptOid)).toBe(true);
    await expect(
      fs.readFile(path.join(worktreeDir, GIT_CONSTANTS.DIVERGED_DIR_NAME, "kept-backup", "work.txt"), "utf-8"),
    ).resolves.toBe("never pushed\n");
  });
});

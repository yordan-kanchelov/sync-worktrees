import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PathResolutionService } from "../../services/path-resolution.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { createMockLogger } from "../test-utils";

import type { RepositoryConfig } from "../../types";

// Real git, real trash, real `gc --prune=now`. The force-clean modal takes its
// preview outside the repo mutex and then waits for a keypress; a cron tick in
// that window trashes more worktrees. Before the selection snapshot, confirming
// a preview that said "1 trash" purged everything present at run time —
// including a fully-pushed-then-deleted branch whose pin ref was the last thing
// keeping its commits out of the garbage collector.
describe("Force clean purges only the previewed set (E2E)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-force-clean-")));
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
    await fs.writeFile(path.join(seedDir, "README.md"), "# app");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");

    // shown-first carries no commits of its own: it is only there to be trashed
    // before the preview, so the preview has something to count.
    await seed.checkoutLocalBranch("shown-first");
    await seed.push("origin", "shown-first");

    // unseen-later carries a commit that exists nowhere else once its remote
    // branch is deleted. Its trash pin is the only thing that survives gc.
    await seed.checkout("main");
    await seed.checkoutLocalBranch("unseen-later");
    await fs.writeFile(path.join(seedDir, "only-copy.txt"), "work that lives nowhere else");
    await seed.add(".");
    await seed.commit("Work only this branch has");
    await seed.push("origin", "unseen-later");
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
      __configFileDir: tempDir,
    } as RepositoryConfig;
    return new WorktreeSyncService(config);
  }

  async function commitExists(oid: string): Promise<boolean> {
    try {
      await simpleGit(bareRepoDir).raw(["cat-file", "-e", `${oid}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  it("leaves an entry a sync trashed after the preview, and its commits, alone", async () => {
    const onlyCopyOid = (await simpleGit(seedDir).revparse(["unseen-later"])).trim();

    const service = makeService();
    await service.initialize();
    await service.sync();
    expect(await fs.readdir(worktreeDir)).toEqual(
      expect.arrayContaining([
        path.basename(pathResolution.getBranchWorktreePath(worktreeDir, "shown-first")),
        path.basename(pathResolution.getBranchWorktreePath(worktreeDir, "unseen-later")),
      ]),
    );

    // The trash the user is about to be shown.
    await simpleGit(remote).raw(["update-ref", "-d", "refs/heads/shown-first"]);
    await service.sync();
    const preview = await service.getForceCleanPreview();
    expect(preview.trashEntries).toBe(1);
    const shownId = preview.trashEntryIds[0];

    // 10:00:00 — the cron tick fires while the modal waits for a keypress and
    // trashes a fully-pushed branch whose remote side has just been deleted.
    await simpleGit(remote).raw(["update-ref", "-d", "refs/heads/unseen-later"]);
    await service.sync();
    const { entries } = await service.listTrashEntries();
    const unseen = entries.find((entry) => entry.manifest.id !== shownId);
    expect(unseen?.manifest.keepPinOnReap).toBe(true);
    expect(await commitExists(onlyCopyOid)).toBe(true);

    // 10:00:40 — the user presses y on the preview above.
    const result = await service.forceClean(preview);

    expect(result.trashDeleted).toBe(1);
    expect(result.skippedNewEntries).toBe(1);
    expect(result.gcSucceeded).toBe(true);
    const remaining = await service.listTrashEntries();
    expect(remaining.entries.map((entry) => entry.manifest.id)).toEqual([unseen!.manifest.id]);
    expect(await commitExists(onlyCopyOid)).toBe(true);
  });
});

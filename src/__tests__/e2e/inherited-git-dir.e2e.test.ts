import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CloneSyncService } from "../../services/clone-sync.service";
import { GitService } from "../../services/git.service";
import { createMockLogger, setEnvVar } from "../test-utils";

import type { Config } from "../../types";
import type { Logger } from "../../services/logger.service";

// Real git, two unrelated repositories. A repository named in the environment
// outranks the cwd simple-git sets, so an inherited one decides what a tick
// operates on. A shell or CI job can export any of these; git itself hands an
// absolute GIT_DIR to hooks run inside a linked worktree, which is how a run
// started from such a hook inherits one with nobody exporting anything.
//
// What the strip buys differs by variable, and the two halves are worth keeping
// apart. GIT_DIR and GIT_COMMON_DIR are visible to assertPrimaryCheckout, which
// reads `rev-parse --git-dir`: without the strip THIS tree refuses the tick with
// a ConfigError naming the foreign repository, so there the strip turns a
// confusing refusal into a working sync rather than preventing damage. (Against
// the last released version, which has no such guard, it did prevent damage —
// which is what the changeset describes.) GIT_WORK_TREE, GIT_INDEX_FILE and the
// two object-store variables are the half the guard cannot see, and those are
// where the strip still stops a tick writing somewhere it was never pointed.
// Each is mutation-checked below.
//
// GIT_REPOSITORY_SELECTION_VARS in src/utils/git-env.ts records which hooks
// carry what, and why each variable is in the set; it is not restated here.
//
// The foreign repository here stands in for the inherited one: it is left with a
// wide refspec, two remote-tracking refs, a file and a clean index, and none of
// them may move while a clone-mode tick converges a different checkout.
describe("Clone-mode sync ignores an inherited GIT_DIR (E2E)", () => {
  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let foreignDir: string;
  let logger: Logger;

  const WIDE_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

  const originalEnv = new Map<string, string | undefined>();

  const config = (): Config =>
    ({
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir: path.join(tempDir, ".bare", "app"),
      cronSchedule: "0 * * * *",
      runOnce: true,
      mode: "clone",
      branch: "main",
      skipLfs: true,
    }) as Config;

  // Everything the tick does happens with the foreign repository named in the
  // environment; the assertions run after it is put back, so the probes below
  // are not themselves redirected by what they are testing.
  async function withForeignRepoInEnv(run: () => Promise<void>): Promise<void> {
    const foreign = {
      GIT_DIR: path.join(foreignDir, ".git"),
      GIT_WORK_TREE: foreignDir,
      GIT_INDEX_FILE: path.join(foreignDir, ".git", "index"),
      GIT_COMMON_DIR: path.join(foreignDir, ".git"),
      GIT_OBJECT_DIRECTORY: path.join(foreignDir, ".git", "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(foreignDir, ".git", "objects"),
    };
    for (const [name, value] of Object.entries(foreign)) {
      originalEnv.set(name, process.env[name]);
      process.env[name] = value;
    }
    try {
      await run();
    } finally {
      for (const [name, value] of originalEnv) setEnvVar(name, value);
      originalEnv.clear();
    }
  }

  const remoteTrackingRefs = async (dir: string): Promise<string[]> =>
    (await simpleGit(dir).raw(["for-each-ref", "--format=%(refname)", "refs/remotes"]))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();

  // Puts a commit on the remote's main that no local repository holds yet, so
  // the tick has to fetch real objects rather than finding everything present.
  // Without that there is nothing for a misdirected object store to swallow.
  const advanceRemote = async (): Promise<string> => {
    const pushDir = path.join(tempDir, "push");
    await simpleGit().clone(`file://${remote}`, pushDir, ["--branch", "main"]);
    const pusher = simpleGit(pushDir);
    await pusher.addConfig("user.name", "Remote User");
    await pusher.addConfig("user.email", "remote@example.com");
    await fs.writeFile(path.join(pushDir, "app.txt"), "advanced\n");
    await pusher.add(["app.txt"]);
    await pusher.commit("Remote commit");
    await pusher.push("origin", "main");
    const tip = (await pusher.revparse(["HEAD"])).trim();
    await fs.rm(pushDir, { recursive: true, force: true });
    return tip;
  };

  const fetchRefspecs = async (dir: string): Promise<string[]> =>
    (await simpleGit(dir).raw(["config", "--get-all", "remote.origin.fetch"]))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-inherited-git-dir-")));
    remote = path.join(tempDir, "remote", "app.git");
    worktreeDir = path.join(tempDir, "checkout");
    foreignDir = path.join(tempDir, "foreign");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

    const seedDir = path.join(tempDir, "seed");
    await fs.mkdir(seedDir);
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(seedDir, "app.txt"), "app\n");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.checkoutLocalBranch("feature");
    await fs.writeFile(path.join(seedDir, "feature.txt"), "feature\n");
    await seed.add(".");
    await seed.commit("Feature commit");
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");
    await seed.push("origin", "feature");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await fs.rm(seedDir, { recursive: true });

    // The checkout the tick has to converge: cloned wide on purpose, so this
    // run is the one that narrows the refspec and sweeps origin/feature.
    await simpleGit().clone(`file://${remote}`, worktreeDir, ["--branch", "main", "--no-tags"]);
    expect(await fetchRefspecs(worktreeDir)).toEqual([WIDE_REFSPEC]);
    expect(await remoteTrackingRefs(worktreeDir)).toContain("refs/remotes/origin/feature");

    // The repository a hook would have been running in. Same remote, still
    // wide, and with a working tree whose one file must survive the tick.
    await simpleGit().clone(`file://${remote}`, foreignDir, ["--branch", "main", "--no-tags"]);
    await fs.writeFile(path.join(foreignDir, "app.txt"), "foreign edit\n");
    await simpleGit(foreignDir).add(["app.txt"]);
    await simpleGit(foreignDir).addConfig("user.name", "Foreign User");
    await simpleGit(foreignDir).addConfig("user.email", "foreign@example.com");
    await simpleGit(foreignDir).commit("Foreign commit");

    logger = createMockLogger();
  });

  afterEach(async () => {
    for (const [name, value] of originalEnv) setEnvVar(name, value);
    originalEnv.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("converges the configured checkout and leaves the named repository untouched", async () => {
    const foreignHeadBefore = (await simpleGit(foreignDir).revparse(["HEAD"])).trim();
    const remoteTip = await advanceRemote();

    await withForeignRepoInEnv(async () => {
      const cfg = config();
      const service = new CloneSyncService(cfg, new GitService(cfg, logger), logger);
      await service.initialize();
      await service.runSyncAttempt();
    });

    // The checkout the config named is the one that converged.
    expect(await fetchRefspecs(worktreeDir)).toEqual(["+refs/heads/main:refs/remotes/origin/main"]);
    expect(await remoteTrackingRefs(worktreeDir)).toEqual(["refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

    // The repository the environment named kept its wide refspec and both of
    // its remote-tracking refs: nothing narrowed it, nothing swept it.
    expect(await fetchRefspecs(foreignDir)).toEqual([WIDE_REFSPEC]);
    expect(await remoteTrackingRefs(foreignDir)).toEqual([
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/feature",
      "refs/remotes/origin/main",
    ]);

    // ...and neither its working tree, its index nor its HEAD moved.
    expect(await fs.readFile(path.join(foreignDir, "app.txt"), "utf-8")).toBe("foreign edit\n");
    expect((await simpleGit(foreignDir).raw(["status", "--porcelain"])).trim()).toBe("");
    expect((await simpleGit(foreignDir).revparse(["HEAD"])).trim()).toBe(foreignHeadBefore);

    // The object store is its own kind of misdirection, and the one a
    // pre-receive hook hands over. The tick had to fetch the commit
    // advanceRemote pushed, and GIT_OBJECT_DIRECTORY above names the foreign
    // repository's object store: had it survived, that commit would have been
    // written there instead, leaving the checkout's own origin/main pointing at
    // an object it does not hold. Resolving it with the foreign store out of
    // the environment is what proves it landed in the checkout itself.
    const checkoutGit = simpleGit(worktreeDir);
    expect((await checkoutGit.revparse(["refs/remotes/origin/main"])).trim()).toBe(remoteTip);
    expect((await checkoutGit.raw(["cat-file", "-t", remoteTip])).trim()).toBe("commit");
    expect(await fs.readFile(path.join(worktreeDir, "app.txt"), "utf-8")).toBe("advanced\n");

    // And the foreign store did not grow the fetched commit either way round.
    // `cat-file -t` and not `-e`: simple-git resolves a non-zero exit whose
    // stderr is empty, which is exactly what `-e` produces for a missing
    // object, so the `-e` form would pass whatever happened.
    await expect(simpleGit(foreignDir).raw(["cat-file", "-t", remoteTip])).rejects.toThrow();
  });
});

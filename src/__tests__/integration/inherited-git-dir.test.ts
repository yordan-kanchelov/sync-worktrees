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

    await simpleGit().clone(`file://${remote}`, worktreeDir, ["--branch", "main", "--no-tags"]);
    expect(await fetchRefspecs(worktreeDir)).toEqual([WIDE_REFSPEC]);
    expect(await remoteTrackingRefs(worktreeDir)).toContain("refs/remotes/origin/feature");

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

    expect(await fetchRefspecs(worktreeDir)).toEqual(["+refs/heads/main:refs/remotes/origin/main"]);
    expect(await remoteTrackingRefs(worktreeDir)).toEqual(["refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

    expect(await fetchRefspecs(foreignDir)).toEqual([WIDE_REFSPEC]);
    expect(await remoteTrackingRefs(foreignDir)).toEqual([
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/feature",
      "refs/remotes/origin/main",
    ]);

    expect(await fs.readFile(path.join(foreignDir, "app.txt"), "utf-8")).toBe("foreign edit\n");
    expect((await simpleGit(foreignDir).raw(["status", "--porcelain"])).trim()).toBe("");
    expect((await simpleGit(foreignDir).revparse(["HEAD"])).trim()).toBe(foreignHeadBefore);

    const checkoutGit = simpleGit(worktreeDir);
    expect((await checkoutGit.revparse(["refs/remotes/origin/main"])).trim()).toBe(remoteTip);
    expect((await checkoutGit.raw(["cat-file", "-t", remoteTip])).trim()).toBe("commit");
    expect(await fs.readFile(path.join(worktreeDir, "app.txt"), "utf-8")).toBe("advanced\n");

    await expect(simpleGit(foreignDir).raw(["cat-file", "-t", remoteTip])).rejects.toThrow();
  });
});

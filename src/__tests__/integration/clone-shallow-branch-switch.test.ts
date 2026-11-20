import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { Config } from "../../types";

describe("Clone-mode branch switch on a shallow clone (E2E)", () => {
  let tempDir: string;
  let remote: string;
  let seed: string;
  let cloneDir: string;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();

  const commit = async (message: string, file: string): Promise<void> => {
    await fs.writeFile(path.join(seed, file), `${message}\n`);
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", message);
  };

  const makeConfig = (overrides: Partial<Config> = {}): Config =>
    ({
      repoUrl: `file://${remote}`,
      worktreeDir: cloneDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      mode: "clone",
      branch: "main",
      depth: 1,
      skipLfs: true,
      __configFileDir: tempDir,
      ...overrides,
    }) as Config;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-shallow-switch-")));
    remote = path.join(tempDir, "app.git");
    seed = path.join(tempDir, "app-seed");
    cloneDir = path.join(tempDir, "checkout");

    execFileSync("git", ["init", "--bare", "-q", remote]);
    await fs.mkdir(seed, { recursive: true });
    execFileSync("git", ["init", "-q", seed]);
    git(seed, "config", "user.name", "Test User");
    git(seed, "config", "user.email", "test@example.com");
    await commit("one", "one.txt");
    await commit("two", "two.txt");
    git(seed, "branch", "-M", "main");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-q", "origin", "main");
    git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("switches to a branch the remote moved past the shallow depth instead of refusing it", async () => {
    const service = new WorktreeSyncService(makeConfig());
    await service.initialize();
    expect(git(cloneDir, "rev-parse", "--is-shallow-repository")).toBe("true");

    await service.createAndPushBranch("main", "feature/race");

    git(seed, "switch", "-q", "-c", "feature/race", "main");
    await commit("three", "three.txt");
    await commit("four", "four.txt");
    git(seed, "push", "-q", "origin", "feature/race");
    const remoteTip = git(seed, "rev-parse", "feature/race");

    await service.checkoutBranch("feature/race");

    expect(git(cloneDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/race");
    expect(git(cloneDir, "rev-parse", "HEAD")).toBe(remoteTip);
    expect(await fs.readdir(cloneDir)).toEqual(expect.arrayContaining(["three.txt", "four.txt"]));
    expect(git(cloneDir, "config", "--get", "remote.origin.fetch")).toBe(
      "+refs/heads/feature/race:refs/remotes/origin/feature/race",
    );
  });

  it("still refuses a branch that genuinely diverged once the deepening can see it", async () => {
    const service = new WorktreeSyncService(makeConfig());
    await service.initialize();

    await service.createAndPushBranch("main", "feature/split");

    git(cloneDir, "switch", "-q", "feature/split");
    await fs.writeFile(path.join(cloneDir, "local.txt"), "local\n");
    git(cloneDir, "add", "-A");
    git(cloneDir, "-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-q", "-m", "local only");
    const localTip = git(cloneDir, "rev-parse", "HEAD");
    git(cloneDir, "switch", "-q", "main");

    git(seed, "switch", "-q", "-c", "feature/split", "main");
    await commit("three", "three.txt");
    await commit("four", "four.txt");
    git(seed, "push", "-q", "origin", "feature/split");

    await expect(service.checkoutBranch("feature/split")).rejects.toMatchObject({
      name: "FastForwardError",
      branchName: "feature/split",
    });

    expect(git(cloneDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(cloneDir, "rev-parse", "refs/heads/feature/split")).toBe(localTip);
  });
});

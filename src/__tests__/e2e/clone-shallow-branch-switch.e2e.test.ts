import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { Config } from "../../types";

// Switching a `depth: N` clone to a local branch whose remote counterpart has
// moved by more than N commits. The `--depth N` fetch cuts the history under
// the new tip, so `merge-base <local> <remote>` has nothing to walk and exits
// 1 — which used to read as "cannot fast-forward" and end the switch with
// FastForwardError, although the branch was a plain fast-forward the whole
// time. The switch now deepens first, exactly like a sync tick does, and only
// then decides.
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

    // The wizard's half: the branch is created in the clone at the tip of
    // origin/main and pushed. Both refs point at the shallow tip.
    await service.createAndPushBranch("main", "feature/race");

    // Somebody else pushes on top of it before the switch runs — two
    // commits, which a `--depth 1` fetch cannot bridge.
    git(seed, "switch", "-q", "-c", "feature/race", "main");
    await commit("three", "three.txt");
    await commit("four", "four.txt");
    git(seed, "push", "-q", "origin", "feature/race");
    const remoteTip = git(seed, "rev-parse", "feature/race");

    await service.checkoutBranch("feature/race", { allowConfigDrift: true });

    expect(git(cloneDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/race");
    // The fast-forward ran, rather than the switch stopping at the old tip.
    expect(git(cloneDir, "rev-parse", "HEAD")).toBe(remoteTip);
    expect(await fs.readdir(cloneDir)).toEqual(expect.arrayContaining(["three.txt", "four.txt"]));
    // And the checkout finished: the remote is narrowed to the new branch.
    expect(git(cloneDir, "config", "--get", "remote.origin.fetch")).toBe(
      "+refs/heads/feature/race:refs/remotes/origin/feature/race",
    );
  });

  it("still refuses a branch that genuinely diverged once the deepening can see it", async () => {
    const service = new WorktreeSyncService(makeConfig());
    await service.initialize();

    await service.createAndPushBranch("main", "feature/split");

    // A commit of the clone's own on the branch it is not standing on...
    git(cloneDir, "switch", "-q", "feature/split");
    await fs.writeFile(path.join(cloneDir, "local.txt"), "local\n");
    git(cloneDir, "add", "-A");
    git(cloneDir, "-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-q", "-m", "local only");
    const localTip = git(cloneDir, "rev-parse", "HEAD");
    git(cloneDir, "switch", "-q", "main");

    // ...and two of somebody else's on the remote. The shallow clone cannot
    // tell those apart from a fast-forward until it deepens; once it can, this
    // is a real divergence and the switch has to refuse it.
    git(seed, "switch", "-q", "-c", "feature/split", "main");
    await commit("three", "three.txt");
    await commit("four", "four.txt");
    git(seed, "push", "-q", "origin", "feature/split");

    await expect(service.checkoutBranch("feature/split", { allowConfigDrift: true })).rejects.toMatchObject({
      name: "FastForwardError",
      branchName: "feature/split",
    });

    expect(git(cloneDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(cloneDir, "rev-parse", "refs/heads/feature/split")).toBe(localTip);
  });
});

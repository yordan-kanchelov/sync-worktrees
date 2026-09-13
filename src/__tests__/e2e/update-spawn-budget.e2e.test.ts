import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { createMockLogger } from "../test-utils";

import type { RepositoryConfig } from "../../types";

// Real git, real processes, counted. The update phase used to spend a
// `git status` walk of the whole working tree plus a merge-base pair and a
// rev-list on every registered worktree, every tick, only to conclude that
// nothing had changed — so the git processes per sync grew with the number of
// worktrees and a few hundred of them held the repository lock long enough for
// the next scheduled tick to be skipped. It now compares the HEAD oid git
// prints in its own registration listing against origin's tip from one
// for-each-ref, and a worktree already at that tip costs no process at all.
//
// Counting is done with a `git` shim first on PATH: every simple-git client is
// built with the parent environment (see sanitizeGitEnv), so a shim installed
// before the service is constructed sees every spawn the sync makes.
describe("Update phase spawn budget (E2E)", () => {
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let shimLog: string;
  let originalPath: string | undefined;

  const realGit = execSync("command -v git", { shell: "/bin/sh" }).toString().trim();

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-spawn-budget-")));
    remote = path.join(tempDir, "remote", "app.git");
    seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    shimLog = path.join(tempDir, "spawns.log");

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
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
  });

  afterEach(async () => {
    if (originalPath !== undefined) process.env.PATH = originalPath;
    originalPath = undefined;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function publishBranches(count: number, prefix: string): Promise<void> {
    const seed = simpleGit(seedDir);
    for (let index = 0; index < count; index++) {
      const branch = `${prefix}-${index}`;
      await seed.checkout("main");
      await seed.checkoutLocalBranch(branch);
      await fs.writeFile(path.join(seedDir, `${branch}.txt`), "v1");
      await seed.add(".");
      await seed.commit(`${branch} v1`);
      await seed.push(["-u", "origin", branch]);
    }
    await seed.checkout("main");
  }

  // Puts a counting `git` first on PATH. Every spawn appends one line to
  // shimLog, whose path is baked into the script rather than read from the
  // environment: simple-git snapshots the environment when it builds a client,
  // so a variable set later would never reach the child.
  async function installGitShim(): Promise<void> {
    const shimDir = path.join(tempDir, "shim");
    await fs.mkdir(shimDir, { recursive: true });
    const shim = path.join(shimDir, "git");
    await fs.writeFile(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${shimLog}'\nexec '${realGit}' "$@"\n`, {
      mode: 0o755,
    });
    originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ""}`;
  }

  async function countedSpawns(run: () => Promise<void>): Promise<string[]> {
    await fs.writeFile(shimLog, "");
    await run();
    const log = await fs.readFile(shimLog, "utf-8");
    return log.split("\n").filter((line) => line.length > 0);
  }

  function makeConfig(): RepositoryConfig {
    return {
      name: "budget",
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      updateExistingWorktrees: true,
      logger: createMockLogger(),
      // `git gc` is throttled by a persisted timestamp, so leaving it on would
      // put a one-off process in whichever tick happened to run first.
      maintenance: { enabled: false },
    };
  }

  it("spends the same handful of git processes on a tick where nothing changed, whatever the worktree count", async () => {
    await publishBranches(2, "first");
    await installGitShim();

    const service = new WorktreeSyncService(makeConfig());
    await service.initialize();
    // Creates the worktrees for the branches published so far.
    await service.sync();

    const small = await countedSpawns(async () => {
      await service.sync();
    });
    const smallOutcome = service.getLastOutcome();
    expect(smallOutcome?.counts).toEqual(expect.objectContaining({ noop: 3, updated: 0, failed: 0, skipped: 0 }));

    // Six more branches, so the next steady tick has four times the worktrees.
    await publishBranches(6, "second");
    await service.sync();

    const large = await countedSpawns(async () => {
      await service.sync();
    });
    const largeOutcome = service.getLastOutcome();
    expect(largeOutcome?.counts).toEqual(expect.objectContaining({ noop: 9, updated: 0, failed: 0, skipped: 0 }));

    // The whole point: three worktrees and nine cost the same. Four processes:
    // the fetch, the remote-branch listing, the worktree registration listing
    // and the tip listing the update phase compares against.
    expect(large.length).toBe(small.length);
    expect(large.length).toBeLessThanOrEqual(5);

    // And none of what used to run per worktree runs at all.
    const perWorktreeCommands = large.filter((command) =>
      /^(status|rev-list|merge-base|rev-parse|branch|stash|submodule)\b/.test(command),
    );
    expect(perWorktreeCommands).toEqual([]);
  });

  // The fast path must not cost accuracy: the one branch whose tip moved is
  // still found, fast-forwarded and reported, while its neighbours stay noops.
  it("still fast-forwards the one worktree whose remote tip moved", async () => {
    await publishBranches(3, "b");
    await installGitShim();

    const service = new WorktreeSyncService(makeConfig());
    await service.initialize();
    await service.sync();

    const seed = simpleGit(seedDir);
    await seed.checkout("b-1");
    await fs.writeFile(path.join(seedDir, "b-1.txt"), "v2");
    await seed.add(".");
    await seed.commit("b-1 v2");
    await seed.push("origin", "b-1");
    const movedTip = (await seed.revparse(["b-1"])).trim();

    const spawns = await countedSpawns(async () => {
      await service.sync();
    });

    const outcome = service.getLastOutcome();
    expect(outcome?.counts).toEqual(expect.objectContaining({ updated: 1, noop: 3, failed: 0, skipped: 0 }));
    expect(outcome?.actions).toContainEqual(
      expect.objectContaining({ kind: "updated", branch: "b-1", reason: "fast_forward" }),
    );

    const worktreePath = outcome?.actions.find((action) => action.branch === "b-1")?.path;
    expect(worktreePath).toBeDefined();
    expect((await simpleGit(worktreePath!).revparse(["HEAD"])).trim()).toBe(movedTip);

    // Exactly one worktree was looked at: one status walk and one ahead/behind
    // count, not one per registered worktree.
    expect(spawns.filter((command) => command.startsWith("status"))).toHaveLength(1);
    expect(spawns.filter((command) => command.startsWith("rev-list --left-right"))).toHaveLength(1);
  });
});

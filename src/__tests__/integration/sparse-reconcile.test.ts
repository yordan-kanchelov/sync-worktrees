import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PathResolutionService } from "../../services/path-resolution.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { createMockLogger } from "../test-utils";

import type { RepositoryConfig, SparseCheckoutConfig, SyncOutcome } from "../../types";

// Worktree-mode sparse reconcile against real git: a mode switch with an
// unchanged include list must reach existing worktrees, and a directory git
// C-quotes in `sparse-checkout list` must not be re-applied on every sync.
describe("Worktree-mode sparse-checkout reconcile (E2E)", () => {
  const pathResolution = new PathResolutionService();

  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-sparse-reconcile-")));
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
    await fs.writeFile(path.join(seedDir, "root.txt"), "root\n");
    await fs.mkdir(path.join(seedDir, "pkg", "nested"), { recursive: true });
    await fs.writeFile(path.join(seedDir, "pkg", "a.txt"), "a\n");
    await fs.writeFile(path.join(seedDir, "pkg", "nested", "b.txt"), "b\n");
    await fs.mkdir(path.join(seedDir, "other"));
    await fs.writeFile(path.join(seedDir, "other", "c.txt"), "c\n");
    await fs.mkdir(path.join(seedDir, "a\\b"));
    await fs.writeFile(path.join(seedDir, "a\\b", "d.txt"), "d\n");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");
    await seed.checkoutLocalBranch("feature/a");
    await seed.push("origin", "feature/a");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeConfig(sparseCheckout: SparseCheckoutConfig): RepositoryConfig {
    return {
      name: "app",
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      logger: createMockLogger(),
      retry: { maxAttempts: 1, initialDelayMs: 0 },
      trash: { enabled: false },
      sparseCheckout,
      __configFileDir: tempDir,
    };
  }

  async function syncOnce(config: RepositoryConfig): Promise<SyncOutcome> {
    const result = await new WorktreeSyncService(config).sync();
    expect(result.started).toBe(true);
    if (!result.started) throw new Error("sync did not start");
    return result.outcome;
  }

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  }

  function trackedFiles(cwd: string): string[] {
    return git(cwd, "ls-files", "-t")
      .split("\n")
      .filter((line) => line.startsWith("H "))
      .map((line) => line.slice(2))
      .sort();
  }

  function sparseUpdates(outcome: SyncOutcome): unknown[] {
    return outcome.actions.filter((a) => a.kind === "updated" && "reason" in a && a.reason === "sparse_checkout");
  }

  it("moves an existing worktree to the new mode when only sparseCheckout.mode changes", async () => {
    const first = await syncOnce(makeConfig({ include: ["pkg/nested"], mode: "cone" }));
    expect(first.counts.failed).toBe(0);
    const existing = pathResolution.getBranchWorktreePath(worktreeDir, "feature/a");
    expect(git(existing, "config", "--bool", "core.sparseCheckoutCone")).toBe("true");

    const seed = simpleGit(seedDir);
    await seed.checkoutLocalBranch("feature/b");
    await seed.push("origin", "feature/b");

    const second = await syncOnce(makeConfig({ include: ["pkg/nested"], mode: "no-cone" }));
    expect(second.counts.failed).toBe(0);
    const fresh = pathResolution.getBranchWorktreePath(worktreeDir, "feature/b");

    expect(git(fresh, "config", "--bool", "core.sparseCheckoutCone")).toBe("false");
    expect(git(existing, "config", "--bool", "core.sparseCheckoutCone")).toBe("false");
    expect(trackedFiles(existing)).toEqual(trackedFiles(fresh));
    expect(trackedFiles(existing)).toEqual(["pkg/nested/b.txt"]);
  }, 60_000);

  it("does not re-apply a cone directory git prints C-quoted", async () => {
    const config = makeConfig({ include: ["a\\b"] });
    const first = await syncOnce(config);
    expect(first.counts.failed).toBe(0);

    const second = await syncOnce(makeConfig({ include: ["a\\b"] }));
    expect(second.counts.failed).toBe(0);
    expect(sparseUpdates(second)).toEqual([]);
  }, 60_000);
});

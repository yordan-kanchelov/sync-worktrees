import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PathResolutionService } from "../../services/path-resolution.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { createMockLogger } from "../test-utils";

import type { Logger } from "../../services/logger.service";
import type { RepositoryConfig, SyncOutcome } from "../../types";
import type { Mock } from "vitest";

// Real git, no mocks. The default branch's worktree is the directory every
// remote-facing command runs in (fetch, the branch listings, the tip probes),
// and the planner never plans a create for that branch. A long-lived process
// (daemon, TUI, MCP server) whose `worktrees/main` was deleted out-of-band —
// `rm -rf`, an unmounted volume — therefore failed *every* later sync with
// `spawn git ENOENT`, which reads as "git is not installed": the heal lives in
// GitService.initialize(), sync() only initializes while isInitialized() is
// false, and that flips true on the first run and never back. Only a restart
// recovered. The sync now re-checks and rebuilds the anchor on every attempt.
describe("Default-branch worktree deleted out-of-band (E2E)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let mainPath: string;
  let featPath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-missing-anchor-")));
    remote = path.join(tempDir, "remote", "app.git");
    seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    // The default branch's worktree sits at its plain name (GitService), every
    // other branch at the sanitized+hashed one (PathResolutionService).
    mainPath = path.join(worktreeDir, "main");
    featPath = pathResolution.getBranchWorktreePath(worktreeDir, "feat");

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
    await seed.checkoutLocalBranch("feat");
    await fs.writeFile(path.join(seedDir, "feat.txt"), "feat work");
    await seed.add(".");
    await seed.commit("Add feat");
    await seed.push("origin", "feat");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeConfig(logger: Logger): RepositoryConfig {
    return {
      name: "app",
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      logger,
      // A failing attempt must not be retried three times over three seconds
      // before the test can look at it.
      retry: { maxAttempts: 1, initialDelayMs: 0 },
      __configFileDir: tempDir,
    };
  }

  async function syncOnce(service: WorktreeSyncService): Promise<SyncOutcome> {
    const result = await service.sync();
    expect(result.started).toBe(true);
    if (!result.started) throw new Error("sync did not start");
    return result.outcome;
  }

  const registeredWorktrees = async (): Promise<string> =>
    simpleGit(bareRepoDir).raw(["worktree", "list", "--porcelain"]);

  const headOf = async (dir: string): Promise<string> => (await simpleGit(dir).revparse(["HEAD"])).trim();

  const originTip = async (branch: string): Promise<string> =>
    (await simpleGit(bareRepoDir).revparse([`refs/remotes/origin/${branch}`])).trim();

  it("rebuilds the default-branch worktree and keeps syncing in the same process", async () => {
    const logger = createMockLogger();
    const service = new WorktreeSyncService(makeConfig(logger));

    const first = await syncOnce(service);
    expect(first.counts.failed).toBe(0);
    expect(await registeredWorktrees()).toContain(mainPath);
    expect(await registeredWorktrees()).toContain(featPath);

    // The user (or a volume unmount) removes the default branch's worktree.
    await fs.rm(mainPath, { recursive: true, force: true });

    // Same service instance, next tick: this used to reject with
    // "spawn git ENOENT", and so did every tick after it.
    const second = await syncOnce(service);

    expect(second.counts.failed).toBe(0);
    expect(second.actions.filter((action) => action.kind === "failed")).toEqual([]);
    expect(second.actions.some((action) => "reason" in action && action.reason === "sync_failed")).toBe(false);
    expect(second.actions).toContainEqual({ kind: "created", branch: "main", path: mainPath });

    // main is back on disk, registered with the bare repo, and at origin's tip.
    await expect(fs.access(path.join(mainPath, "README.md"))).resolves.toBeUndefined();
    expect(await registeredWorktrees()).toContain(mainPath);
    expect(await headOf(mainPath)).toBe(await originTip("main"));

    // The other worktree was never touched.
    expect(await registeredWorktrees()).toContain(featPath);
    await expect(fs.readFile(path.join(featPath, "feat.txt"), "utf8")).resolves.toBe("feat work");

    // The log says which directory went missing, rather than blaming git.
    const logged = [
      ...(logger.warn as Mock).mock.calls.map((call) => String(call[0])),
      ...(logger.info as Mock).mock.calls.map((call) => String(call[0])),
    ];
    expect(logged.some((line) => line.includes(mainPath) && line.includes("missing"))).toBe(true);

    // And the process stays healthy afterwards.
    const third = await syncOnce(service);
    expect(third.counts.failed).toBe(0);
    expect(third.actions.filter((action) => action.kind === "created")).toEqual([]);
  });
});

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitService } from "../../services/git.service";
import { RemovalAuditService } from "../../services/removal-audit.service";
import { TrashService } from "../../services/trash.service";
import { createMockLogger } from "../test-utils";

import type { GitServiceOptions } from "../../services/git.service";
import type { Logger } from "../../services/logger.service";
import type { Config } from "../../types";
import type { GitClientCache } from "../../utils/git-client-cache";

// Both services cache one simple-git client per worktree path, and a worktree
// path is only as long-lived as its branch. On a real repository this is what
// the leak looked like: 30 create/status/remove cycles left 60 clients in
// GitService and 30 in the status service behind a single live worktree, ~7 KB
// each, for as long as the daemon ran. Driving the real removal flows against
// real git is the only check that covers what the caches are keyed by *and*
// every path that unregisters a worktree.
describe("Cached git clients follow the worktrees they belong to (E2E)", () => {
  const BRANCHES = 4;

  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let logger: Logger;
  let gitService: GitService;

  const clientCache = (service: GitService): GitClientCache =>
    (service as unknown as { gitInstances: GitClientCache }).gitInstances;

  const statusClientCache = (service: GitService): GitClientCache =>
    (service as unknown as { statusService: { gitInstances: GitClientCache } }).statusService.gitInstances;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-client-cache-")));
    remote = path.join(tempDir, "remote", "app.git");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

    const seedDir = path.join(tempDir, "seed");
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
    for (let i = 0; i < BRANCHES; i++) {
      await seed.checkout(["-b", `feature-${i}`, "main"]);
      await fs.writeFile(path.join(seedDir, `feature-${i}.txt`), `work ${i}`);
      await seed.add(".");
      await seed.commit(`feature ${i}`);
      await seed.push("origin", `feature-${i}`);
    }
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    logger = createMockLogger();
    const options: GitServiceOptions = {
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir,
      skipLfs: true,
    };
    gitService = new GitService(options, logger);
    await gitService.initialize();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("leaves no client behind after a branch is created, checked and removed", async () => {
    // The bare repository's and the anchor worktree's clients, which outlive
    // every branch: the cache must come back to exactly these.
    const baseline = clientCache(gitService).size;

    for (let i = 0; i < BRANCHES; i++) {
      const worktreePath = path.join(worktreeDir, `feature-${i}`);
      await gitService.addWorktree(`feature-${i}`, worktreePath);
      await gitService.getFullWorktreeStatus(worktreePath, false);
      await gitService.getCurrentCommit(worktreePath);
      expect(clientCache(gitService).countFor(worktreePath)).toBeGreaterThan(0);
      expect(statusClientCache(gitService).countFor(worktreePath)).toBe(1);

      await gitService.removeWorktree(worktreePath);

      expect(clientCache(gitService).countFor(worktreePath)).toBe(0);
      expect(statusClientCache(gitService).countFor(worktreePath)).toBe(0);
    }

    // One live worktree (the anchor) is left, so the caches are back to what
    // the live worktrees need rather than to what every branch ever needed.
    expect(await gitService.getWorktrees()).toHaveLength(1);
    expect(clientCache(gitService).size).toBe(baseline);
    expect(statusClientCache(gitService).size).toBe(0);
  });

  it("forgets a worktree the trash flow moved away and unregistered", async () => {
    const worktreePath = path.join(worktreeDir, "feature-0");
    await gitService.addWorktree("feature-0", worktreePath);
    await gitService.getFullWorktreeStatus(worktreePath, false);
    await gitService.getCurrentCommit(worktreePath);
    expect(clientCache(gitService).countFor(worktreePath)).toBeGreaterThan(0);

    const config = {
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
    } as Config;
    const trashService = new TrashService(
      config,
      gitService,
      logger,
      new RemovalAuditService(path.join(tempDir, "removal-audit.jsonl")),
    );

    const { entry } = await trashService.trashAndUnregisterWorktree({
      dirPath: worktreePath,
      branch: "feature-0",
      reason: "prune",
    });

    // The directory now lives under .trash/<id>/payload, so nothing may still
    // hold a client pointed at where it used to be.
    expect(entry.payloadPath.startsWith(trashService.getTrashRoot())).toBe(true);
    expect(clientCache(gitService).countFor(worktreePath)).toBe(0);
    expect(statusClientCache(gitService).countFor(worktreePath)).toBe(0);
  });
});

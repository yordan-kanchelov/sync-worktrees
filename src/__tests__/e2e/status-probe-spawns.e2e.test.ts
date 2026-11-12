import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorktreeMetadataService } from "../../services/worktree-metadata.service";
import { RefScanScope, WorktreeStatusService } from "../../services/worktree-status.service";
import { createMockLogger } from "../test-utils";

// Real git, counted with a `git` shim first on PATH (see
// untracked-ignored-status.e2e.test.ts). refs/stash lives in the common git
// dir, so one `stash list` answers for every worktree of a repository; the
// current branch needs no `git branch -v -a` walk of every branch; and a
// rev-list asked twice with the same range is spawned once.
describe("Status probe spawn count (E2E)", () => {
  let tempDir: string;
  let bareRepo: string;
  let worktrees: string[];
  let shimLog: string;
  let originalPath: string | undefined;

  const realGit = execSync("command -v git", { shell: "/bin/sh" }).toString().trim();

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-probe-spawns-")));
    shimLog = path.join(tempDir, "spawns.log");

    const seedDir = path.join(tempDir, "seed");
    await fs.mkdir(seedDir);
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(seedDir, "README.md"), "# app\n");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.branch(["a"]);
    await seed.branch(["b"]);

    bareRepo = path.join(tempDir, "app.git");
    await simpleGit().clone(seedDir, bareRepo, ["--bare"]);
    const bare = simpleGit(bareRepo);
    const head = (await bare.revparse(["main"])).trim();
    await bare.raw(["update-ref", "refs/remotes/origin/main", head]);

    worktrees = [];
    for (const branch of ["main", "a", "b"]) {
      const worktreePath = path.join(tempDir, "worktrees", branch);
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      await bare.raw(["worktree", "add", worktreePath, branch]);
      worktrees.push(worktreePath);
    }
    const wt = simpleGit(worktrees[0]);
    await wt.addConfig("user.name", "Test User");
    await wt.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(worktrees[0], "README.md"), "# changed\n");
    await wt.raw(["stash", "push", "-m", "wip"]);
  });

  afterEach(async () => {
    if (originalPath !== undefined) process.env.PATH = originalPath;
    originalPath = undefined;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function installGitShim(): Promise<void> {
    const shimDir = path.join(tempDir, "shim");
    await fs.mkdir(shimDir, { recursive: true });
    const shim = path.join(shimDir, "git");
    await fs.writeFile(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${shimLog}'\nexec '${realGit}' "$@"\n`, {
      mode: 0o755,
    });
    await fs.writeFile(shimLog, "");
    originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ""}`;
  }

  async function spawnedCommands(): Promise<string[]> {
    return (await fs.readFile(shimLog, "utf-8")).split("\n").filter((line) => line.length > 0);
  }

  it("lists the stashes once per repository in a scoped pass", async () => {
    await installGitShim();
    const service = new WorktreeStatusService({}, createMockLogger());
    const refScans = new RefScanScope();

    const results = await Promise.all(worktrees.map((wt) => service.getFullWorktreeStatus(wt, true, { refScans })));

    expect(results.map((r) => r.hasStashedChanges)).toEqual([true, false, false]);
    const commands = await spawnedCommands();
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.filter((c) => c.startsWith("stash list"))).toHaveLength(1);
  });

  it("spawns the since-sync and recorded-tip rev-list once when both name the same oid", async () => {
    const oid = (await simpleGit(worktrees[1]).revparse(["HEAD"])).trim();
    await installGitShim();
    const service = new WorktreeStatusService({}, createMockLogger());

    const status = await service.getFullWorktreeStatus(worktrees[1], false, {
      lastSyncCommit: oid,
      lastKnownRemoteTip: { ref: "origin/a", oid, recordedAt: new Date().toISOString() },
    });

    expect(status.hasUnpushedCommits).toBe(false);
    const commands = await spawnedCommands();
    expect(commands.filter((c) => c === `rev-list --count ${oid}..HEAD`)).toHaveLength(1);
  });

  it("reads the current branch without `git branch -v -a`", async () => {
    await installGitShim();
    const service = new WorktreeStatusService({}, createMockLogger());

    await expect(service.hasStashedChanges(worktrees[0])).resolves.toBe(true);
    await expect(service.hasStashedChanges(worktrees[1])).resolves.toBe(false);

    const metadata = new WorktreeMetadataService(createMockLogger());
    const head = (await simpleGit(worktrees[2]).revparse(["HEAD"])).trim();
    await metadata.updateLastSyncFromPath(bareRepo, worktrees[2], head, "updated", "main");
    const created = await metadata.loadMetadataFromPath(bareRepo, worktrees[2]);
    expect(created?.upstreamBranch).toBe("origin/b");

    const commands = await spawnedCommands();
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.filter((c) => c.startsWith("branch"))).toEqual([]);
  });
});

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorktreeStatusService } from "../../services/worktree-status.service";
import { createMockLogger } from "../test-utils";

import type { SimpleGit } from "simple-git";

// Real git, no mocks. A paused rebase makes `git status -b` print
// `## HEAD (no branch)`, which simple-git parses as a detached HEAD. The
// unpushed-commit gate is waived for a plain detached HEAD, but a paused
// rebase's HEAD carries the branch's own replayed commits: reading it as a
// plain detached HEAD would report a worktree with local-only commits as
// having none.
describe("Unpushed commits during a paused rebase (E2E)", () => {
  let tempDir: string;
  let clonePath: string;

  async function commitFile(git: SimpleGit, dir: string, file: string, content: string): Promise<void> {
    await fs.writeFile(path.join(dir, file), content);
    await git.add(file);
    await git.commit(`${file}: ${content.trim()}`);
  }

  beforeAll(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-paused-rebase-")));
    const remote = path.join(tempDir, "remote.git");
    const seedPath = path.join(tempDir, "seed");
    clonePath = path.join(tempDir, "clone");

    await simpleGit().init(["--bare", remote]);
    await fs.mkdir(seedPath);
    const seed = simpleGit(seedPath);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await commitFile(seed, seedPath, "a.txt", "base\n");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");
    await seed.push("origin", "main:refs/heads/feature");

    await simpleGit().clone(remote, clonePath, ["--branch", "feature"]);
    const clone = simpleGit(clonePath);
    await clone.addConfig("user.name", "Test User");
    await clone.addConfig("user.email", "test@example.com");
    // Two local-only commits: the first replays cleanly, the second conflicts.
    await commitFile(clone, clonePath, "b.txt", "local\n");
    await commitFile(clone, clonePath, "a.txt", "local\n");

    // main moves on under the same file the second local commit touches.
    await commitFile(seed, seedPath, "a.txt", "remote\n");
    await seed.push("origin", "main");
    await clone.fetch("origin");

    await expect(clone.raw(["rebase", "origin/main"])).rejects.toThrow();
  }, 60_000);

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("keeps reporting the replayed local-only commit as unpushed", async () => {
    const clone = simpleGit(clonePath);
    // Preconditions: the rebase is paused and git reports HEAD as detached.
    expect((await clone.status()).detached).toBe(true);
    await expect(fs.access(path.join(clonePath, ".git", "rebase-merge"))).resolves.toBeUndefined();
    expect((await clone.raw(["rev-list", "--count", "HEAD", "--not", "--remotes"])).trim()).toBe("1");

    const status = await new WorktreeStatusService({}, createMockLogger()).getFullWorktreeStatus(clonePath, true);

    expect(status.hasUnpushedCommits).toBe(true);
    expect(status.details?.unpushedCommitCount).toBe(1);
    expect(status.details?.operationType).toBe("rebase");
    expect(status.reasons).toEqual(
      expect.arrayContaining(["unpushed commits", "operation in progress", "detached HEAD"]),
    );
    expect(status.canRemove).toBe(false);
  }, 60_000);
});

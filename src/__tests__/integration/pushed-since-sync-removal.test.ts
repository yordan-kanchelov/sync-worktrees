import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorktreeStatusService } from "../../services/worktree-status.service";
import { createMockLogger } from "../test-utils";

import type { SimpleGit } from "simple-git";

describe("Commits made since the last sync and pushed (E2E)", () => {
  let tempDir: string;
  let remote: string;

  async function commitFile(git: SimpleGit, dir: string, file: string, content: string): Promise<void> {
    await fs.writeFile(path.join(dir, file), content);
    await git.add(file);
    await git.commit(`${file}: ${content.trim()}`);
  }

  async function cloneFeature(name: string): Promise<{ git: SimpleGit; dir: string; lastSyncCommit: string }> {
    const dir = path.join(tempDir, name);
    await simpleGit().clone(remote, dir, ["--branch", "feature"]);
    const git = simpleGit(dir);
    await git.addConfig("user.name", "Test User");
    await git.addConfig("user.email", "test@example.com");
    return { git, dir, lastSyncCommit: (await git.revparse(["HEAD"])).trim() };
  }

  async function countRevs(git: SimpleGit, args: string[]): Promise<number> {
    return Number((await git.raw(["rev-list", "--count", ...args])).trim());
  }

  beforeAll(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-pushed-since-sync-")));
    remote = path.join(tempDir, "remote.git");
    const seedPath = path.join(tempDir, "seed");

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
  }, 60_000);

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("allows removal when every commit since the last sync is on the branch's upstream", async () => {
    const { git, dir, lastSyncCommit } = await cloneFeature("pushed-to-upstream");
    await commitFile(git, dir, "b.txt", "work\n");
    await git.push("origin", "feature");

    expect(await countRevs(git, ["HEAD", "--not", "--remotes"])).toBe(0);
    expect(await countRevs(git, [`${lastSyncCommit}..HEAD`])).toBe(1);

    const status = await new WorktreeStatusService({}, createMockLogger()).getFullWorktreeStatus(dir, false, {
      lastSyncCommit,
    });

    expect(status.hasUnpushedCommits).toBe(false);
    expect(status.reasons).toEqual([]);
    expect(status.canRemove).toBe(true);
  }, 60_000);

  it("still blocks removal when the commits since the last sync reached another branch, not the upstream", async () => {
    const { git, dir, lastSyncCommit } = await cloneFeature("pushed-elsewhere");
    await commitFile(git, dir, "c.txt", "work\n");
    await git.push("origin", "HEAD:refs/heads/elsewhere");

    expect(await countRevs(git, ["HEAD", "--not", "--remotes"])).toBe(0);
    expect((await git.status()).ahead).toBe(1);

    const status = await new WorktreeStatusService({}, createMockLogger()).getFullWorktreeStatus(dir, false, {
      lastSyncCommit,
    });

    expect(status.hasUnpushedCommits).toBe(true);
    expect(status.reasons).toContain("unpushed commits");
    expect(status.canRemove).toBe(false);
  }, 60_000);

  it("still blocks removal when the branch has no upstream to be on", async () => {
    const { git, dir, lastSyncCommit } = await cloneFeature("no-upstream");
    await commitFile(git, dir, "d.txt", "work\n");
    await git.push("origin", "HEAD:refs/heads/elsewhere-2");
    await git.raw(["branch", "--unset-upstream"]);

    expect(await countRevs(git, ["HEAD", "--not", "--remotes"])).toBe(0);
    expect((await git.status()).tracking).toBeNull();

    const status = await new WorktreeStatusService({}, createMockLogger()).getFullWorktreeStatus(dir, false, {
      lastSyncCommit,
    });

    expect(status.hasUnpushedCommits).toBe(true);
    expect(status.canRemove).toBe(false);
  }, 60_000);

  it("allows removal when HEAD is behind its upstream", async () => {
    const { git, dir, lastSyncCommit } = await cloneFeature("behind-upstream");
    await commitFile(git, dir, "e.txt", "work\n");
    await commitFile(git, dir, "e.txt", "more\n");
    await git.push("origin", "feature");
    await git.raw(["reset", "--hard", "HEAD~1"]);

    expect(await countRevs(git, [`${lastSyncCommit}..HEAD`])).toBe(1);
    const { ahead, behind } = await git.status();
    expect({ ahead, behind }).toEqual({ ahead: 0, behind: 1 });

    const status = await new WorktreeStatusService({}, createMockLogger()).getFullWorktreeStatus(dir, false, {
      lastSyncCommit,
    });

    expect(status.hasUnpushedCommits).toBe(false);
    expect(status.canRemove).toBe(true);
  }, 60_000);
});

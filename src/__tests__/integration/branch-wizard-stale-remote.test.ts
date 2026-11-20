import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ink", () => ({
  render: vi.fn(() => ({ unmount: vi.fn(), waitUntilExit: vi.fn(() => new Promise<void>(() => {})) })),
}));

import { InteractiveUIService } from "../../services/InteractiveUIService";
import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { createMockLogger } from "../test-utils";

import type { RepositoryConfig } from "../../types";

describe("Branch wizard against a branch only the remote still has (E2E)", () => {
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let hotfixTip: string;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();

  const remoteTip = (branch: string): string => git(remote, "rev-parse", `refs/heads/${branch}`);

  const remoteBranches = (): string[] =>
    git(remote, "for-each-ref", "--format=%(refname:strip=2)", "refs/heads").split("\n").filter(Boolean);

  const isAncestor = (ancestor: string, descendant: string): boolean => {
    try {
      execFileSync("git", ["-C", bareRepoDir, "merge-base", "--is-ancestor", ancestor, descendant], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  };

  const localHeadExists = (branch: string): boolean => {
    try {
      execFileSync("git", ["-C", bareRepoDir, "show-ref", "--verify", `refs/heads/${branch}`], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  };

  const commit = (message: string, daysAgo: number): void => {
    const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    execFileSync("git", ["-C", seedDir, "add", "-A"]);
    execFileSync("git", ["-C", seedDir, "commit", "-q", "-m", message], {
      env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    });
  };

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-stale-remote-")));
    remote = path.join(tempDir, "remote", "app.git");
    seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    execFileSync("git", ["init", "--bare", "-q", remote]);

    await fs.mkdir(seedDir, { recursive: true });
    execFileSync("git", ["init", "-q", seedDir]);
    git(seedDir, "config", "user.name", "Test User");
    git(seedDir, "config", "user.email", "test@example.com");

    await fs.writeFile(path.join(seedDir, "README.md"), "# app\n");
    commit("old work", 45);
    git(seedDir, "branch", "-M", "main");
    git(seedDir, "branch", "hotfix");
    git(seedDir, "remote", "add", "origin", remote);
    git(seedDir, "push", "-q", "origin", "main", "hotfix");

    await fs.writeFile(path.join(seedDir, "today.txt"), "today\n");
    commit("recent work", 0);
    git(seedDir, "push", "-q", "origin", "main");
    git(remote, "symbolic-ref", "HEAD", "refs/heads/main");

    hotfixTip = remoteTip("hotfix");
    expect(hotfixTip).not.toBe(remoteTip("main"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const makeConfig = (overrides: Partial<RepositoryConfig> = {}): RepositoryConfig =>
    ({
      name: "app",
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      branchMaxAge: "30d",
      logger: createMockLogger(),
      retry: { maxAttempts: 1, initialDelayMs: 0 },
      trash: { enabled: false },
      __configFileDir: tempDir,
      ...overrides,
    }) as RepositoryConfig;

  let syncService: WorktreeSyncService;

  const buildUI = async (config: RepositoryConfig = makeConfig()): Promise<InteractiveUIService> => {
    const service = new WorktreeSyncService(config);
    await service.initialize();
    const synced = await service.sync();
    expect(synced.started).toBe(true);
    syncService = service;
    return new InteractiveUIService([service]);
  };

  it("suffixes instead of moving a remote branch that branchMaxAge filtered out", async () => {
    const ui = await buildUI();
    try {
      expect(remoteBranches()).toContain("hotfix");
      expect(await ui.operations.getBranchesForRepo(0)).toContain("hotfix");
      expect(localHeadExists("hotfix")).toBe(false);

      const created = await ui.operations.createAndPushBranch(0, "main", "hotfix");

      expect(remoteTip("hotfix")).toBe(hotfixTip);

      expect(created.success).toBe(true);
      expect(created.finalName).toBe("hotfix-1");
      expect(remoteBranches()).toContain("hotfix-1");
      expect(remoteTip("hotfix-1")).toBe(remoteTip("main"));

      expect(git(bareRepoDir, "config", "branch.hotfix-1.remote")).toBe("origin");
      expect(git(bareRepoDir, "config", "branch.hotfix-1.merge")).toBe("refs/heads/hotfix-1");
    } finally {
      await ui.destroy(true);
    }
  });

  it("leaves no local branch behind when the push is refused", async () => {
    const hookDir = path.join(remote, "hooks");
    await fs.mkdir(hookDir, { recursive: true });
    const hook = path.join(hookDir, "pre-receive");
    await fs.writeFile(hook, "#!/bin/sh\necho 'refusing this ref' >&2\nexit 1\n");
    await fs.chmod(hook, 0o755);

    const ui = await buildUI();
    try {
      const created = await ui.operations.createAndPushBranch(0, "main", "feature/x");

      expect(created.success).toBe(false);
      expect(created.error).toMatch(/push/i);
      expect(localHeadExists("feature/x")).toBe(false);
      expect(remoteBranches()).not.toContain("feature/x");
    } finally {
      await ui.destroy(true);
    }
  });

  it("refuses to advance a remote branch when the push is the only thing standing in the way", async () => {
    const ui = await buildUI();
    try {
      const gitService = syncService.getGitService();

      git(bareRepoDir, "branch", "--no-track", "hotfix", "origin/main");
      expect(localHeadExists("hotfix")).toBe(true);
      expect(isAncestor(hotfixTip, git(bareRepoDir, "rev-parse", "refs/heads/hotfix"))).toBe(true);

      await expect(gitService.pushBranch("hotfix")).rejects.toThrow(/stale info/);

      expect(remoteTip("hotfix")).toBe(hotfixTip);
      expect(() => git(bareRepoDir, "config", "branch.hotfix.merge")).toThrow();

      git(bareRepoDir, "branch", "--no-track", "brand-new", "origin/main");
      await expect(gitService.pushBranch("brand-new")).resolves.toBeUndefined();
      expect(remoteTip("brand-new")).toBe(remoteTip("main"));
    } finally {
      await ui.destroy(true);
    }
  });
});

import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the terminal renderer is stubbed. Everything the wizard calls below it —
// InteractiveUIService, WorktreeSyncService, GitService, simple-git and git
// itself — is the real thing, against a real local bare remote.
vi.mock("ink", () => ({
  render: vi.fn(() => ({ unmount: vi.fn(), waitUntilExit: vi.fn(() => new Promise<void>(() => {})) })),
}));

import { InteractiveUIService } from "../../services/InteractiveUIService";
import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { createMockLogger } from "../test-utils";

import type { RepositoryConfig } from "../../types";

// A branch the age/name filters hide has a remote-tracking ref but no local
// head in the bare repository, so the collision check `git branch` performs
// sees nothing. The plain `git push origin <name>:<name> -u` that followed then
// FAST-FORWARDED the branch that was already on origin whenever its tip was an
// ancestor of the base — moving a branch nobody asked to move, and with it any
// open PR or CI run pinned to that ref, while the wizard reported success.
//
// Nothing here can be shown with a mocked git: the claim is that a remote ref
// does not move, so the remote has to be real.
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

    // One 45-day-old commit, which `hotfix` is left pointing at: an ancestor of
    // everything main gains afterwards, which is exactly the shape a plain push
    // fast-forwards.
    await fs.writeFile(path.join(seedDir, "README.md"), "# app\n");
    commit("old work", 45);
    git(seedDir, "branch", "-M", "main");
    git(seedDir, "branch", "hotfix");
    git(seedDir, "remote", "add", "origin", remote);
    git(seedDir, "push", "-q", "origin", "main", "hotfix");

    // main moves on, today.
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

  // The synced service behind the last buildUI(), for the tests that need to
  // reach past the wizard to one defence on its own.
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
      // The premise: origin still has `hotfix`, the wizard's picker still lists
      // it (so it displays "will create: hotfix-1"), and the age filter left no
      // local head for `git branch` to collide with.
      expect(remoteBranches()).toContain("hotfix");
      expect(await ui.operations.getBranchesForRepo(0)).toContain("hotfix");
      expect(localHeadExists("hotfix")).toBe(false);

      const created = await ui.operations.createAndPushBranch(0, "main", "hotfix");

      // The branch that was already on origin is untouched — this is the whole
      // claim, and the reason the remote here is real.
      expect(remoteTip("hotfix")).toBe(hotfixTip);

      expect(created.success).toBe(true);
      expect(created.finalName).toBe("hotfix-1");
      expect(remoteBranches()).toContain("hotfix-1");
      expect(remoteTip("hotfix-1")).toBe(remoteTip("main"));

      // The lease is carried on a fully-qualified refspec, so `-u` still has to
      // set the upstream it always did — a mocked push cannot show that.
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
      // The retry the user makes with the same name must not be diverted to
      // `feature/x-1` by this attempt's own leftover.
      expect(localHeadExists("feature/x")).toBe(false);
      expect(remoteBranches()).not.toContain("feature/x");
    } finally {
      await ui.destroy(true);
    }
  });

  // The two defences are independent, and both tests above are satisfied by
  // EITHER of them: the probe suffixes before the push is ever reached, so the
  // push never gets the chance to demonstrate anything. The lease is the one
  // that has to hold when the probe cannot — offline, where the probe's
  // failure is deliberately not fatal, or a ref that appears between the probe
  // and the push — and on its own it was pinned by nothing but an argv
  // comparison against a mock. So this drives it with the probe out of the
  // picture entirely: the local branch is made with raw git exactly as
  // `createBranch` would have made it, and handed straight to `pushBranch`.
  it("refuses to advance a remote branch when the push is the only thing standing in the way", async () => {
    const ui = await buildUI();
    try {
      const gitService = syncService.getGitService();

      // `hotfix` at main's tip, its remote tip an ancestor of it: the exact
      // shape a plain `git push origin hotfix:hotfix -u` fast-forwards.
      git(bareRepoDir, "branch", "--no-track", "hotfix", "origin/main");
      expect(localHeadExists("hotfix")).toBe(true);
      expect(isAncestor(hotfixTip, git(bareRepoDir, "rev-parse", "refs/heads/hotfix"))).toBe(true);

      await expect(gitService.pushBranch("hotfix")).rejects.toThrow(/stale info/);

      // Byte-identical: the ref that was already on origin did not move.
      expect(remoteTip("hotfix")).toBe(hotfixTip);
      // And the rejection did not set an upstream for a push that never landed.
      expect(() => git(bareRepoDir, "config", "branch.hotfix.merge")).toThrow();

      // The control: the same push of a name origin does not have still works,
      // so what the lease refuses above is the existing ref and not the push.
      git(bareRepoDir, "branch", "--no-track", "brand-new", "origin/main");
      await expect(gitService.pushBranch("brand-new")).resolves.toBeUndefined();
      expect(remoteTip("brand-new")).toBe(remoteTip("main"));
    } finally {
      await ui.destroy(true);
    }
  });
});

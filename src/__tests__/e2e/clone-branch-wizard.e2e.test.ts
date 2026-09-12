import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the terminal renderer is stubbed. Everything the wizard calls below it —
// InteractiveUIService, WorktreeSyncService, CloneSyncService, simple-git and
// git itself — is the real thing.
vi.mock("ink", () => ({ render: vi.fn(() => ({ unmount: vi.fn() })) }));

import { InteractiveUIService } from "../../services/InteractiveUIService";
import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { Config } from "../../types";

// The TUI's branch wizard on a clone-mode repository. It always ran
// GitService.createBranch/pushBranch, which work in a bare repository a
// clone-mode repo does not have: `bareRepoPath` fell back to the RELATIVE
// '.bare/<repo name>', so the wizard either died with simple-git's
// "Cannot use simple-git on a directory that does not exist" or — when a bare
// store of the same repository NAME happened to sit under the daemon's working
// directory — reported success after creating and pushing the branch in a
// different repository entirely.
describe("Clone-mode branch wizard (E2E)", () => {
  let tempDir: string;
  let remote: string;
  let cloneDir: string;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();

  const makeRemote = async (name: string, files: string[]): Promise<string> => {
    const bare = path.join(tempDir, `${name}.git`);
    const seed = path.join(tempDir, `${name}-seed`);
    await fs.mkdir(seed, { recursive: true });
    execFileSync("git", ["init", "--bare", "-q", bare]);
    execFileSync("git", ["init", "-q", seed]);
    git(seed, "config", "user.name", "Test User");
    git(seed, "config", "user.email", "test@example.com");
    for (const file of files) {
      await fs.writeFile(path.join(seed, file), `${file}\n`);
      git(seed, "add", "-A");
      git(seed, "commit", "-q", "-m", `add ${file}`);
    }
    git(seed, "branch", "-M", "main");
    git(seed, "checkout", "-q", "-b", "release");
    await fs.writeFile(path.join(seed, "release.txt"), "release\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "release only");
    git(seed, "checkout", "-q", "main");
    git(seed, "remote", "add", "origin", bare);
    git(seed, "push", "-q", "origin", "main", "release");
    git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
    return bare;
  };

  const makeConfig = (overrides: Partial<Config> = {}): Config =>
    ({
      repoUrl: `file://${remote}`,
      worktreeDir: cloneDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      mode: "clone",
      branch: "main",
      skipLfs: true,
      __configFileDir: tempDir,
      ...overrides,
    }) as Config;

  const buildUI = async (
    config: Config = makeConfig(),
  ): Promise<{ ui: InteractiveUIService; service: WorktreeSyncService }> => {
    const service = new WorktreeSyncService(config);
    await service.initialize();
    return { ui: new InteractiveUIService([service]), service };
  };

  const remoteBranches = (bare: string): string[] =>
    git(bare, "for-each-ref", "--format=%(refname:strip=2)", "refs/heads").split("\n").filter(Boolean);

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-branch-wizard-")));
    remote = await makeRemote("app", ["one.txt", "two.txt"]);
    cloneDir = path.join(tempDir, "checkout");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates the branch in the clone, pushes it, and switches the checkout in place", async () => {
    const { ui } = await buildUI();
    try {
      const created = await ui.createAndPushBranch(0, "main", "feature/wizard");
      expect(created).toEqual({ success: true, finalName: "feature/wizard" });

      // The branch exists on the remote at the tip of the base branch...
      expect(remoteBranches(remote)).toContain("feature/wizard");
      expect(git(remote, "rev-parse", "feature/wizard")).toBe(git(remote, "rev-parse", "main"));

      // ...and the wizard's follow-up switches the clone to it in place, which
      // is the clone-mode branch switching CHANGELOG 5.0.0 describes.
      await ui.createWorktreeForBranch(0, "feature/wizard");
      expect(git(cloneDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/wizard");
      expect(await fs.readdir(path.join(tempDir))).not.toContain("feature-wizard");
    } finally {
      await ui.destroy(true);
    }
  });

  it("never reaches a bare store that merely sits under the process working directory", async () => {
    // A worktree-mode entry of a DIFFERENT repository that happens to share
    // this one's name keeps its bare store at '<config dir>/.bare/app'. With
    // the daemon started from that directory, the relative fallback path
    // resolved onto it: the branch was created and pushed there, against the
    // wrong remote, and the wizard reported success.
    const strangerRemote = await makeRemote("stranger", ["stranger.txt"]);
    const cwd = path.join(tempDir, "config-dir");
    await fs.mkdir(path.join(cwd, ".bare"), { recursive: true });
    execFileSync("git", ["clone", "-q", "--bare", strangerRemote, path.join(cwd, ".bare", "app")]);

    const originalCwd = process.cwd();
    process.chdir(cwd);
    try {
      const { ui } = await buildUI();
      try {
        const created = await ui.createAndPushBranch(0, "main", "feature/wizard");
        expect(created.success).toBe(true);

        expect(remoteBranches(remote)).toContain("feature/wizard");
        expect(remoteBranches(strangerRemote)).not.toContain("feature/wizard");
        expect(remoteBranches(path.join(cwd, ".bare", "app"))).not.toContain("feature/wizard");
      } finally {
        await ui.destroy(true);
      }
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("creates from a base branch the narrowed refspec never fetches", async () => {
    const { ui } = await buildUI();
    try {
      const created = await ui.createAndPushBranch(0, "release", "feature/from-release");
      expect(created.success).toBe(true);
      expect(git(remote, "rev-parse", "feature/from-release")).toBe(git(remote, "rev-parse", "release"));

      await ui.createWorktreeForBranch(0, "feature/from-release");
      expect(git(cloneDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/from-release");
      expect(await fs.readdir(cloneDir)).toContain("release.txt");
    } finally {
      await ui.destroy(true);
    }
  });

  it("creates and pushes from a shallow clone", async () => {
    const { ui } = await buildUI(makeConfig({ depth: 1 }));
    try {
      expect(git(cloneDir, "rev-parse", "--is-shallow-repository")).toBe("true");

      const created = await ui.createAndPushBranch(0, "main", "feature/shallow");
      expect(created.success).toBe(true);
      expect(git(remote, "rev-parse", "feature/shallow")).toBe(git(remote, "rev-parse", "main"));

      await ui.createWorktreeForBranch(0, "feature/shallow");
      expect(git(cloneDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/shallow");
    } finally {
      await ui.destroy(true);
    }
  });

  it("suffixes the name instead of fast-forwarding a branch the remote already has", async () => {
    const { ui } = await buildUI();
    try {
      // A branch somebody else pushed, sitting on an ancestor of the base: a
      // plain `push` would have fast-forwarded it onto main's tip.
      const olderCommit = git(remote, "rev-parse", "main~1");
      git(remote, "update-ref", "refs/heads/feature/taken", olderCommit);

      const created = await ui.createAndPushBranch(0, "main", "feature/taken");

      expect(created).toEqual({ success: true, finalName: "feature/taken-1" });
      expect(git(remote, "rev-parse", "feature/taken")).toBe(olderCommit);
      expect(git(remote, "rev-parse", "feature/taken-1")).toBe(git(remote, "rev-parse", "main"));
    } finally {
      await ui.destroy(true);
    }
  });

  it("leaves no local branch behind when the remote rejects the push", async () => {
    const hook = path.join(remote, "hooks", "pre-receive");
    await fs.writeFile(hook, "#!/bin/sh\necho 'refusing: branch is protected' >&2\nexit 1\n");
    await fs.chmod(hook, 0o755);

    const { ui } = await buildUI();
    try {
      const created = await ui.createAndPushBranch(0, "main", "feature/protected");

      expect(created.success).toBe(false);
      expect(created.error).toContain("feature/protected");
      expect(created.error).toContain("branch is protected");
      expect(created.error).not.toContain("simple-git");
      expect(remoteBranches(remote)).not.toContain("feature/protected");
      // The half-created branch is rolled back, so retrying the same name does
      // not collide with this repository's own leftover.
      expect(git(cloneDir, "for-each-ref", "--format=%(refname)", "refs/heads/feature")).toBe("");
    } finally {
      await ui.destroy(true);
    }
  });

  it("refuses a dirty checkout before anything reaches the remote", async () => {
    const { ui } = await buildUI();
    try {
      await fs.writeFile(path.join(cloneDir, "one.txt"), "local edit\n");

      const created = await ui.createAndPushBranch(0, "main", "feature/dirty");

      expect(created.success).toBe(false);
      expect(created.error).toMatch(/local changes/);
      expect(remoteBranches(remote)).not.toContain("feature/dirty");
      expect(git(cloneDir, "for-each-ref", "--format=%(refname)", "refs/heads/feature")).toBe("");
    } finally {
      await ui.destroy(true);
    }
  });
});

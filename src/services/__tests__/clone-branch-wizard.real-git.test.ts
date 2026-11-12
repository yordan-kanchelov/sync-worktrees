import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the terminal renderer is stubbed; the services below it and git are real.
vi.mock("ink", () => ({
  render: vi.fn(() => ({ unmount: vi.fn(), waitUntilExit: vi.fn(() => new Promise<void>(() => {})) })),
}));

import { InteractiveUIService } from "../InteractiveUIService";
import { WorktreeSyncService } from "../worktree-sync.service";

import type { Config } from "../../types";

// The clone-mode branch wizard against real git: how its failures are worded
// and whether the suffix retry runs on them.
describe("Clone-mode branch wizard failures (real git)", () => {
  let tempDir: string;
  let remote: string;
  let cloneDir: string;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();

  const remoteBranches = (): string[] =>
    git(remote, "for-each-ref", "--format=%(refname:strip=2)", "refs/heads").split("\n").filter(Boolean);
  const localBranches = (): string[] =>
    git(cloneDir, "for-each-ref", "--format=%(refname:strip=2)", "refs/heads").split("\n").filter(Boolean);

  let service: WorktreeSyncService;

  const buildUI = async (overrides: Partial<Config> = {}): Promise<InteractiveUIService> => {
    service = new WorktreeSyncService({
      repoUrl: `file://${remote}`,
      worktreeDir: cloneDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      mode: "clone",
      branch: "main",
      skipLfs: true,
      __configFileDir: tempDir,
      ...overrides,
    } as Config);
    await service.initialize();
    return new InteractiveUIService([service]);
  };

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-wizard-failures-")));
    remote = path.join(tempDir, "app.git");
    const seed = path.join(tempDir, "seed");
    await fs.mkdir(seed);
    execFileSync("git", ["init", "--bare", "-q", remote]);
    execFileSync("git", ["init", "-q", seed]);
    git(seed, "config", "user.name", "Test User");
    git(seed, "config", "user.email", "test@example.com");
    await fs.writeFile(path.join(seed, "one.txt"), "one\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "init");
    git(seed, "branch", "-M", "main");
    git(seed, "push", "-q", remote, "main");
    git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
    cloneDir = path.join(tempDir, "checkout");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("stops after one attempt and names the blocking ref when a local branch is a prefix of the name", async () => {
    const ui = await buildUI();
    try {
      git(cloneDir, "branch", "feat");
      const attempts = vi.spyOn(service, "createAndPushBranch");

      const created = await ui.operations.createAndPushBranch(0, "main", "feat/sub");

      expect(attempts).toHaveBeenCalledTimes(1);
      expect(created.success).toBe(false);
      expect(created.finalName).toBe("feat/sub");
      expect(created.error).toContain("refs/heads/feat");
      expect(created.error).not.toContain("already exists");
      expect(localBranches().sort()).toEqual(["feat", "main"]);
      expect(remoteBranches()).toEqual(["main"]);
    } finally {
      await ui.destroy(true);
    }
  });

  it("still suffixes past a local branch nested under the requested name", async () => {
    const ui = await buildUI();
    try {
      git(cloneDir, "branch", "feat/sub");

      const created = await ui.operations.createAndPushBranch(0, "main", "feat");

      expect(created).toEqual({ success: true, finalName: "feat-1" });
      expect(remoteBranches()).toContain("feat-1");
    } finally {
      await ui.destroy(true);
    }
  });

  it("does not suffix past a branch the push rollback could not remove", async () => {
    // The hook moves the clone's new branch while the push is in flight, so
    // the compare-and-swap rollback fails, and rejects with wording that
    // would otherwise send the loop round again.
    const hook = path.join(remote, "hooks", "pre-receive");
    await fs.writeFile(
      hook,
      [
        "#!/bin/sh",
        "unset GIT_DIR GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES",
        `c=$(git -C "${cloneDir}" -c user.name=t -c user.email=t@e commit-tree -m moved HEAD^{tree})`,
        `git -C "${cloneDir}" update-ref refs/heads/feature/x "$c"`,
        "echo 'branch already exists' >&2",
        "exit 1",
        "",
      ].join("\n"),
    );
    await fs.chmod(hook, 0o755);

    const ui = await buildUI();
    try {
      const created = await ui.operations.createAndPushBranch(0, "main", "feature/x");

      expect(created.success).toBe(false);
      expect(created.finalName).toBe("feature/x");
      expect(created.error).toContain("The local branch 'feature/x' is still in the clone");
      expect(localBranches()).not.toContain("feature/x-1");
      expect(remoteBranches()).toEqual(["main"]);
    } finally {
      await ui.destroy(true);
    }
  });

  it("does not warn about missing worktrees when copying files after a clone-mode create", async () => {
    const ui = await buildUI({ filesToCopyOnBranchCreate: [".env.local"] });
    try {
      const addLog = vi.spyOn(ui, "addLog");

      expect((await ui.operations.createAndPushBranch(0, "main", "feature/copy")).success).toBe(true);
      await ui.operations.createWorktreeForBranch(0, "feature/copy");
      await ui.operations.copyBranchFiles(0, "main", "feature/copy");

      expect(addLog.mock.calls.filter(([message]) => message.includes("file copy"))).toEqual([]);
    } finally {
      await ui.destroy(true);
    }
  });
});

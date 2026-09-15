import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { GitService } from "../git.service";
import { TrashService } from "../trash.service";

import type { GitServiceOptions } from "../git.service";
import type { Config } from "../../types";
import type { RemovalAuditService } from "../removal-audit.service";
import type { SimpleGit } from "simple-git";

// Real git, no mocks. Restore registers the worktree with `worktree add
// --no-checkout` and then renames the trashed payload into the directory git
// just made — removing that directory and putting another one at its path.
// Whether git minds is not a thing to reason about: `worktree list`, `status`
// and `reset` have to keep working afterwards, against a real repository.
describe("restoring a trashed worktree by renaming the payload back (real git)", () => {
  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let gitService: GitService;
  let trash: TrashService;
  let bare: SimpleGit;

  async function addWorktreeFor(branchName: string, dirPath: string): Promise<void> {
    await bare.raw(["worktree", "add", "--track", "-b", branchName, dirPath, `origin/${branchName}`]);
  }

  async function worktreePaths(): Promise<string[]> {
    const raw = await bare.raw(["worktree", "list", "--porcelain"]);
    return raw
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim());
  }

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-restore-rename-")));
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
    for (const branchName of ["feature", "decoy"]) {
      await seed.raw(["push", "origin", `refs/heads/main:refs/heads/${branchName}`]);
    }
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    const logger = createMockLogger();
    gitService = new GitService(
      { repoUrl: `file://${remote}`, worktreeDir, bareRepoDir } satisfies GitServiceOptions,
      logger,
    );
    await gitService.initialize();
    bare = simpleGit(bareRepoDir);

    const config: Config = {
      repoUrl: `file://${remote}`,
      worktreeDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
    };
    trash = new TrashService(config, gitService, logger, {
      record: async () => {},
    } as unknown as RemovalAuditService);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * A worktree with something worth preserving in it: a tracked file edited
   * but not committed, and an untracked directory standing in for the build
   * output and `node_modules` that make a payload expensive to copy.
   */
  async function makeDirtyWorktree(): Promise<string> {
    const dirPath = path.join(worktreeDir, "feature");
    await addWorktreeFor("feature", dirPath);
    await fs.writeFile(path.join(dirPath, "README.md"), "# app\nedited, never committed\n");
    await fs.mkdir(path.join(dirPath, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(dirPath, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    return dirPath;
  }

  /**
   * Takes the admin directory name `feature` before restore runs, so the
   * `worktree add` inside it is forced onto `feature1` and the link it writes
   * differs from the stale one the payload carries. Without this the two are
   * byte-identical — the trashed worktree had the same path and so the same
   * admin name — and every assertion about which link survived would hold
   * whether or not restore rewrote anything.
   */
  async function occupyAdminName(): Promise<void> {
    const decoyPath = path.join(tempDir, "elsewhere", "feature");
    await fs.mkdir(path.dirname(decoyPath), { recursive: true });
    await bare.raw(["worktree", "add", "--track", "-b", "decoy", decoyPath, "origin/decoy"]);
  }

  it("moves the payload back into place and leaves a worktree git still recognizes", async () => {
    const dirPath = await makeDirtyWorktree();
    const { entry } = await trash.trashAndUnregisterWorktree({ dirPath, branch: "feature", reason: "prune" });
    const payloadInode = (await fs.stat(entry.payloadPath)).ino;
    const staleLink = await fs.readFile(path.join(entry.payloadPath, ".git"), "utf-8");
    await occupyAdminName();

    // Exactly what `worktree add --no-checkout` wrote, captured as it wrote it.
    let freshLink: string | null = null;
    const addWorktreeNoCheckout = gitService.addWorktreeNoCheckout.bind(gitService);
    vi.spyOn(gitService, "addWorktreeNoCheckout").mockImplementation(async (branchName, worktreePath) => {
      await addWorktreeNoCheckout(branchName, worktreePath);
      expect(await fs.readdir(worktreePath)).toEqual([".git"]);
      freshLink = await fs.readFile(path.join(worktreePath, ".git"), "utf-8");
    });

    await trash.restore(entry.manifest.id);

    expect(freshLink).not.toBeNull();
    expect(freshLink).not.toBe(staleLink);
    await expect(fs.readFile(path.join(dirPath, ".git"), "utf-8")).resolves.toBe(freshLink);
    // The directory itself was moved, not copied file by file.
    expect((await fs.stat(dirPath)).ino).toBe(payloadInode);
    await expect(fs.access(entry.containerPath)).rejects.toMatchObject({ code: "ENOENT" });

    // Git is unbothered that the directory under its registration was replaced.
    await expect(worktreePaths()).resolves.toContain(dirPath);
    const restored = simpleGit(dirPath);
    await expect(restored.raw(["rev-parse", "--abbrev-ref", "HEAD"])).resolves.toBe("feature\n");
    const status = await restored.raw(["status", "--porcelain"]);
    expect(status).toContain(" M README.md");
    expect(status).toContain("?? node_modules/");
    await expect(fs.readFile(path.join(dirPath, "node_modules", "pkg", "index.js"), "utf-8")).resolves.toBe(
      "module.exports = 1;\n",
    );
    // The admin directory still points back at the link that now sits there.
    const adminDir = (await restored.raw(["rev-parse", "--absolute-git-dir"])).trim();
    await expect(fs.readFile(path.join(adminDir, "gitdir"), "utf-8")).resolves.toBe(`${path.join(dirPath, ".git")}\n`);
  });

  // The rollback for a restore that fails after the move renames the payload
  // back into the container, so `git worktree remove --force` runs against a
  // path that no longer exists. Measured on git 2.43: it succeeds and clears
  // the registration, which is what lets the next attempt register the path
  // again rather than hitting "missing but already registered".
  it("clears the registration and leaves the entry restorable when a step after the move fails", async () => {
    const dirPath = await makeDirtyWorktree();
    const { entry } = await trash.trashAndUnregisterWorktree({ dirPath, branch: "feature", reason: "prune" });
    const reset = vi.spyOn(gitService, "resetWorktreeIndex").mockRejectedValue(new Error("index.lock exists"));

    await expect(trash.restore(entry.manifest.id)).rejects.toThrow(/trash entry left intact/);

    await expect(fs.readFile(path.join(entry.payloadPath, "README.md"), "utf-8")).resolves.toBe(
      "# app\nedited, never committed\n",
    );
    await expect(fs.access(dirPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(worktreePaths()).resolves.not.toContain(dirPath);

    reset.mockRestore();
    await trash.restore(entry.manifest.id);

    await expect(worktreePaths()).resolves.toContain(dirPath);
    await expect(simpleGit(dirPath).raw(["status", "--porcelain"])).resolves.toContain(" M README.md");
  });
});
